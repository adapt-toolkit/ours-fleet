// Source qualification only; does not alter package metadata or release pins.
import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
const source = resolve(process.argv[2] ?? '.source-deps/sdk');
const expected = '37bd5c481c5781cb9af44f51570222a4897955af';
const actual = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:source,encoding:'utf8'}).trim();
if (actual !== expected) throw new Error(`Expected SDK ${expected}, got ${actual}`);
let count = 0;
function overlay(directory) {
  for (const entry of readdirSync(directory, {withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (path.endsWith('/node_modules/@ours.network/sdk')) {
      rmSync(join(path, 'dist'), {recursive:true,force:true});
      cpSync(join(source, 'dist'), join(path, 'dist'), {recursive:true});
      count++;
    } else overlay(path);
  }
}
overlay(resolve(process.argv[3] ?? '.', 'node_modules'));
if (!count) throw new Error('No installed SDK consumers found');
console.log(`Source qualification: SDK ${expected}, ${count} installed SDK copies`);
