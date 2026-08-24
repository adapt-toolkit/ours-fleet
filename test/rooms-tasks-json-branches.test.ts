import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourcePath = join(process.cwd(), 'src', 'rooms-tasks', 'cli.ts');

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
      branches.push(text);
      expect(text).toContain('JSON.stringify');
      expect(text).not.toMatch(/renderMarkdown|taskActionMarkdown|roomActionMarkdown/);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return branches;
}

describe('task/room JSON presentation contract', () => {
  it('pins every task --json serializer branch exactly and before Markdown rendering', () => {
    const branches = jsonBranches('registerTaskCommands');
    expect(branches).toHaveLength(15);
    expect(branches).toMatchSnapshot();
  });

  it('pins every room --json serializer branch exactly and before Markdown rendering', () => {
    const branches = jsonBranches('registerRoomCommands');
    expect(branches).toHaveLength(9);
    expect(branches).toMatchSnapshot();
  });
});
