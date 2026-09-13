#!/usr/bin/env python3
"""Verify baseline hashes, clean patch application and exact patched source."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent

def manifest(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file() and (p.suffix == '.py' or p.name == 'py.typed')}

def verify():
    expected = json.loads((ROOT / 'original-manifest.json').read_text())['files']
    assert manifest(ROOT / 'original/acp') == {k: v['sha256'] for k, v in expected.items()}, 'Baseline source mismatch'
    with tempfile.TemporaryDirectory(prefix='acp-sdk-patch-') as directory:
        target = Path(directory)
        shutil.copytree(ROOT / 'original/acp', target / 'acp')
        subprocess.run(['git', 'apply', '--no-index', str(ROOT / 'proposed-compaction-sdk.patch')], cwd=target, check=True)
        assert manifest(target / 'acp') == manifest(ROOT / 'src/acp'), 'Patched source differs from patch'
    digest = hashlib.sha256(json.dumps(manifest(ROOT / 'src/acp'), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    print('SDK source digest:', digest)
    return digest

if __name__ == '__main__':
    verify()
