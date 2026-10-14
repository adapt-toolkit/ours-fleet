import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LayoutBindingGrants } from './layout-binding-grants.js';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { RoomLayoutService } from './layout-service.js';
import { layoutSupervisorId } from './layout-control.js';
import { assertLayoutFile, readRoomLayout } from './layout-config.js';
import { parseFleetDocument } from '../config-yaml.js';
import type { LayoutInstance } from './layout.js';

type Options = { configuration?: string; json?: boolean; bindings?: string; id?: string; file?: string; temporary?: boolean; serverUrl?: string; output?: string; participant?: string };
const emit = (value: Record<string, unknown>): void => {
  const output = { ...value };
  if (output.state) {
    const { agent_templates, ...state } = output.state as import('./layout.js').RoomLayoutState;
    output.state = { ...state, template_names: Object.keys(agent_templates ?? {}) };
  }
  console.log(JSON.stringify({ schema_version: 1, ...output }, null, 2));
};
function document(file: string): Record<string, unknown> {
  assertLayoutFile(file); return parseFleetDocument(file, readFileSync(file, 'utf8'), 'strict').value;
}
export function readLayoutBindings(file: string): Record<string, LayoutInstance> {
  const absolute = resolve(file);
  const bindings = document(absolute) as unknown as Record<string, LayoutInstance>;
  for (const instance of Object.values(bindings)) {
    if (instance.remote) instance.remote.credential_file = resolve(dirname(absolute), instance.remote.credential_file);
  }
  return bindings;
}
export function registerLayoutCommands(parent: Command, cOpt: (cmd: Command) => Command): void {
  const layout = parent.command('layout').description('YAML room composition and membership');
  const command = (signature: string, description: string) => cOpt(layout.command(signature).description(description)).option('--json', 'JSON output');
  const action = (work: (...args: any[]) => unknown) => async (...args: any[]) => {
    try { await work(...args); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  };
  command('list', 'list YAML room layouts').action(action((opts: Options) => emit({ layouts: new RoomLayoutService(opts.configuration).list() })));
  command('show <name>', 'show a layout as YAML').action(action((name: string, opts: Options) => {
    const { sourceFile, ...definition } = new RoomLayoutService(opts.configuration).definition(name);
    if (opts.json) emit({ definition, sourceFile }); else console.log(stringify(definition));
  }));
  command('validate [name]', 'validate layout YAML, and participant references')
    .option('--file <path>', 'validate a standalone layout YAML file')
    .action(action((name: string | undefined, opts: Options) => {
      if (opts.file) { readRoomLayout(opts.file); emit({ valid: true }); return; }
      const service = new RoomLayoutService(opts.configuration);
      if (name) service.definition(name);
      emit({ valid: true, layouts: name ? [name] : Object.keys(service.list()) });
    }));
  command('instance <agent>', 'inspect an exact live instance for a bindings YAML file')
    .option('--temporary', 'select a temporary agent')
    .action(action(async (agent: string, opts: Options) => emit({ instance: await new RoomLayoutService(opts.configuration).supervisor().inspect(agent, Boolean(opts.temporary)) })));
  command('share <agent>', 'grant room membership access to one exact local standalone instance')
    .option('--temporary', 'select a temporary agent')
    .requiredOption('--server-url <origin>', 'existing owner Fleet loopback HTTP origin')
    .requiredOption('--output <file>', 'create binding YAML and adjacent private credential file')
    .option('--participant <key>', 'logical layout participant key (default: agent name)')
    .action(action(async (agent: string, opts: Options) => {
      const supervisor = new RoomLayoutService(opts.configuration).supervisor();
      const instance = await supervisor.inspect(agent, Boolean(opts.temporary));
      emit(await new LayoutBindingGrants(supervisor).share(instance, opts.serverUrl!, resolve(opts.output!), opts.participant ?? agent));
    }));
  command('revoke-binding <grant-id>', 'revoke a room membership grant without stopping the agent')
    .action(action(async (id: string, opts: Options) => {
      await new LayoutBindingGrants(new RoomLayoutService(opts.configuration).supervisor()).revoke(id);
      emit({ grant_id: id, revoked: true });
    }));
  command('create <name>' , 'snapshot a layout without creating rooms or agents')
    .option('--id <id>', 'unique layout instance ID').option('--bindings <file>', 'YAML mapping participant keys to exact instance references')
    .action(action(async (name: string, opts: Options) => {
      const service = new RoomLayoutService(opts.configuration);
      const created = await service.create(name, opts.bindings ? readLayoutBindings(opts.bindings) : {}, opts.id);
      emit({ id: created.id, state: created.state });
    }));
  command('status <id>', 'inspect room membership and agent instances').action(action((id: string, opts: Options) => emit({ id, state: new RoomLayoutService(opts.configuration).open(id, true).snapshot() })));
  command('open <id> <room>', 'open any declared room, reusing its participant instances')
    .action(action(async (id: string, room: string, opts: Options) => {
      const engine = new RoomLayoutService(opts.configuration).open(id); await engine.activate(layoutSupervisorId(), room); emit({ id, state: engine.snapshot() });
    }));
  command('close-room <id> <room>', 'archive one room, keeping agents available to other rooms')
    .action(action(async (id: string, room: string, opts: Options) => {
      const engine = new RoomLayoutService(opts.configuration).open(id, true); await engine.closeRoom(layoutSupervisorId(), room); emit({ id, state: engine.snapshot() });
    }));
  command('close <id>', 'archive rooms and stop only agents created by this layout instance')
    .action(action(async (id: string, opts: Options) => {
      const engine = new RoomLayoutService(opts.configuration).open(id, true); await engine.close(layoutSupervisorId()); emit({ id, state: engine.snapshot() });
    }));
}
