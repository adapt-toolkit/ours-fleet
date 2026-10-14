import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { RoomLayoutService } from '../src/rooms-tasks/layout-service.js';
import { readRoomLayout, validateRoomLayout } from '../src/rooms-tasks/layout-config.js';
import { writeV2Fixture } from './v2-fixture.js';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'layout-yaml-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const definition = () => ({ version: 1, participants: { worker: { agent_template: 'Agent' } },
  rooms: { product: { goal: 'Scope', members: ['worker'] },
    design: { goal: 'Design', members: ['worker'] } } });
function file(text = stringify(definition())) { const path = join(root, 'layout.yaml'); writeFileSync(path, text, { mode: 0o600 }); return path; }
describe('room layout YAML authoring', () => {
  it.each(['layout', 'room'])('accepts instance_scope %s without expanding the authorable definition', scope => {
    const def = definition();
    Object.assign(def.participants.worker, { instance_scope: scope });
    const result = readRoomLayout(file(stringify(def)));
    expect(result.participants).toEqual(def.participants);
    expect(result.rooms.design.members).toEqual(['worker']);
  });
  it.each(['shared', 'fresh', '', null, true, 42])('rejects unsupported instance_scope %s', scope => {
    const def = definition(); Object.assign(def.participants.worker, { instance_scope: scope });
    expect(() => validateRoomLayout(def)).toThrow('invalid instance_scope');
  });
  it('requires an agent template for room-scoped participants', () => {
    const def: any = definition(); def.participants.worker = { instance_scope: 'room' };
    expect(() => validateRoomLayout(def)).toThrow('requires agent_template');
    def.participants.worker = {};
    expect(() => validateRoomLayout(def)).not.toThrow();
  });
  it('loads split YAML beside legacy templates and records the source', () => {
    const config = join(root, 'fleet.yaml'); writeV2Fixture(config, { roles: {} });
    const layouts = join(root, 'fleet', 'room_layouts'); mkdirSync(layouts, { mode: 0o700 });
    writeFileSync(join(layouts, 'delivery.yaml'), stringify(definition()), { mode: 0o600 });
    const cfg = loadConfig(config);
    expect(new RoomLayoutService(config).definition('delivery').rooms.design.members).toEqual(['worker']);
    expect(cfg.agentTemplates?.Agent).toBeDefined();
  });
  it('validates layout references only for layout authoring, keeping ordinary Fleet config independent', () => {
    const config = join(root, 'fleet.yaml'); writeV2Fixture(config, { roles: {} });
    const layouts = join(root, 'fleet', 'room_layouts'); mkdirSync(layouts, { mode: 0o700 });
    const def = definition(); def.participants.worker.agent_template = 'missing';
    writeFileSync(join(layouts, 'bad.yaml'), stringify(def), { mode: 0o600 });
    expect(() => new RoomLayoutService(config).list()).toThrow('agent template not found');
    expect(() => loadConfig(config)).not.toThrow();
  });
  it.each(['version: 1\nversion: 1', 'version: 1\n---\nversion: 1', 'version: 1\nentry: &name product'])('rejects ambiguous YAML %s', text => {
    expect(() => readRoomLayout(file(text))).toThrow();
  });
  it('rejects symlinks and writable config', () => {
    const path = file(); symlinkSync(path, join(root, 'link.yaml'));
    expect(() => readRoomLayout(join(root, 'link.yaml'))).toThrow('untrusted');
  });
  it.each([
    (d: any) => { d.rooms.design.after = ['design']; },
    (d: any) => { d.entry = 'product'; },
    (d: any) => { d.rooms.design.members = ['missing']; },
    (d: any) => { d.rooms.product.members.push('worker'); },
    (d: any) => { d.rooms.product.goal = 4; },
    (d: any) => { d.rooms.product.duration = '30m'; },
    (d: any) => { d.participants.worker.mode = 'fresh'; },
  ])('rejects invalid schema before runtime effects', mutate => {
    const def = definition(); mutate(def); expect(() => validateRoomLayout(def)).toThrow();
  });
});
