import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { realExec } from '../src/exec.js';

const sourcePath = join(process.cwd(), 'src', 'rooms-tasks', 'cli.ts');
const cliPath = join(process.cwd(), 'dist', 'cli.js');
let home: string;

beforeAll(() => {
  if (!existsSync(cliPath)) throw new Error('dist/cli.js missing — global setup should have built it');
});
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ours-fleet-json-failure-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function jsonBranches(functionName: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName);
  if (!declaration || !ts.isFunctionDeclaration(declaration)) throw new Error(`${functionName} missing`);
  const branches: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.expression.getText(file) === 'opts.json') {
      const text = node.getText(file).replace(/\r\n?/g, '\n');
      if (!text.includes('JSON.stringify')) {
        ts.forEachChild(node, visit);
        return;
      }
      branches.push(text);
      expect(text).not.toMatch(/renderMarkdown|taskActionMarkdown|roomActionMarkdown/);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return branches;
}

function markdownCatchPaths(functionName: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName);
  if (!declaration || !ts.isFunctionDeclaration(declaration)) throw new Error(`${functionName} missing`);
  const catches: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.getText(file).includes('dieTaskRoom(e)')) {
      const text = node.getText(file).replace(/\r\n?/g, '\n');
      catches.push(text);
      expect(text).toMatch(/if \(opts\.json\) die\(e\);[\s\S]*dieTaskRoom\(e\)/u);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return catches;
}

function legacyDieCalls(functionName: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName);
  if (!declaration || !ts.isFunctionDeclaration(declaration)) throw new Error(`${functionName} missing`);
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'die') {
      calls.push(node.getText(file));
      expect(node.arguments.map(arg => arg.getText(file))).toEqual(['e']);
      let cursor: ts.Node | undefined = node.parent;
      let guarded = false;
      let caught = false;
      while (cursor && cursor !== declaration) {
        if (ts.isIfStatement(cursor) && cursor.expression.getText(file) === 'opts.json') guarded = true;
        if (ts.isCatchClause(cursor)) caught = true;
        cursor = cursor.parent;
      }
      expect({ guarded, caught }).toEqual({ guarded: true, caught: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return calls;
}

describe('task/room JSON presentation contract', () => {
  it('pins every task --json serializer branch exactly and before Markdown rendering', () => {
    const branches = jsonBranches('registerTaskCommands');
    expect(branches).toHaveLength(21);
    expect(branches).toMatchSnapshot();
  });

  it('pins every room --json serializer branch exactly and before Markdown rendering', () => {
    const branches = jsonBranches('registerRoomCommands');
    expect(branches).toHaveLength(7);
    expect(branches).toMatchSnapshot();
  });

  it('routes every JSON-capable Markdown catch through the legacy failure path first', () => {
    expect(markdownCatchPaths('registerTaskCommands').length).toBeGreaterThan(0);
    expect(markdownCatchPaths('registerRoomCommands').length).toBeGreaterThan(0);
  });

  it('permits legacy die(e) only inside JSON catch guards, never action-body validation', () => {
    expect(legacyDieCalls('registerTaskCommands').length).toBeGreaterThan(0);
    expect(legacyDieCalls('registerRoomCommands').length).toBeGreaterThan(0);
  });

  it('preserves exact legacy task and room --json failure output without Markdown', async () => {
    const env = { ...process.env, OURS_FLEET_HOME: home };
    const task = await realExec('node', [cliPath, 'task', 'show', 'definitely-missing', '--json'], { env });
    expect(task).toMatchObject({ code: 1, stdout: '', stderr: 'error: task not found: definitely-missing\n' });
    expect(`${task.stdout}${task.stderr}`).not.toMatch(/##|renderMarkdown/u);

    const missingConfig = join(home, 'missing-fleet.yaml');
    const room = await realExec('node', [cliPath, 'room', 'list', '--json', '-c', missingConfig], { env });
    expect(room).toMatchObject({ code: 1, stdout: '', stderr: `error: config not found: ${missingConfig}\n` });
    expect(`${room.stdout}${room.stderr}`).not.toMatch(/##|renderMarkdown/u);

    for (const [args, expected] of [
      [['task', 'delete', 'task-a', 'task-b', '--json'], 'error: confirmation ID must match task ID\n'],
      [['room', 'delete', 'room-a', 'room-b', '--json'], 'error: confirmation ID must match room ID\n'],
    ] as const) {
      const result = await realExec('node', [cliPath, ...args], { env });
      expect(result).toMatchObject({ code: 1, stdout: '', stderr: expected });
      expect(`${result.stdout}${result.stderr}`).not.toContain('##');
    }
  });
});
