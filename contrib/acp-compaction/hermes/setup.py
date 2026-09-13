#!/usr/bin/env python3
"""Acquire exact reviewed Hermes and install only into a new isolated target."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SDK = HERE.parent / 'python-sdk'
PIN = json.loads((HERE / 'provenance.json').read_text())
WHEEL = 'agent_client_protocol-0.9.0+ours.compaction1-py3-none-any.whl'
WHEEL_HASH = 'c71ebab39ef7f779135cc93bb00bf434dcaf1740e6e54849062f9546d69d152c'

def run(*args, **kwargs):
    subprocess.run([str(x) for x in args], check=True, **kwargs)

def prepare(target, source):
    if target.exists():
        raise SystemExit('Target already exists; select a new directory (never modifies an existing installation).')
    # The accepted native shim quotes paths; reject characters that Bash expands inside quotes.
    if any(c in str(target) for c in '\n\r"`$\\'):
        raise SystemExit('Target path contains unsupported shell characters.')
    target.mkdir(parents=True)
    checkout = target / 'hermes'
    patch = HERE / 'hermes-compaction.patch'
    if hashlib.sha256(patch.read_bytes()).hexdigest() != PIN['patch_sha256']:
        raise SystemExit('Hermes patch hash mismatch')
    run('git', 'clone', '--no-checkout', '--no-hardlinks', source, checkout)
    run('git', '-C', checkout, 'checkout', '--detach', PIN['baseline'])
    run('git', '-C', checkout, 'apply', '--check', patch)
    run('git', '-C', checkout, 'bundle', 'verify', HERE / 'reviewed.bundle')
    run('git', '-C', checkout, 'fetch', HERE / 'reviewed.bundle', 'refs/heads/feat/acp-compaction-lifecycle')
    # The readable patch and bundled commit must represent exactly the same custom code.
    actual = subprocess.check_output(['git', '-C', str(checkout), 'diff', '--binary', PIN['baseline'], PIN['reviewed_tip']])
    if actual != patch.read_bytes():
        raise SystemExit('Bundle and cumulative patch disagree')
    run('git', '-C', checkout, 'checkout', '--detach', PIN['reviewed_tip'])
    run(sys.executable, SDK / 'verify_source.py')
    run(sys.executable, SDK / 'build_artifact.py', '--output', target / 'wheels')
    if hashlib.sha256((target / 'wheels' / WHEEL).read_bytes()).hexdigest() != WHEEL_HASH:
        raise SystemExit('SDK wheel hash mismatch')
    return checkout

def install(target, checkout):
    # Use the upstream lock for the base runtime; ACP's reviewed wheel replaces only
    # the separately selected SDK. No global Python or currently installed Hermes changes.
    env = dict(os.environ, UV_PROJECT_ENVIRONMENT=str(checkout / 'venv'))
    run('uv', 'sync', '--frozen', '--python', '3.11', cwd=checkout, env=env)
    python = checkout / 'venv/bin/python'
    run('uv', 'pip', 'install', '--python', python, '--no-deps', '--no-index', '--require-hashes',
        '--find-links', target / 'wheels', '-r', SDK / 'requirements-artifact.txt')
    run('uv', 'pip', 'install', '--python', python, 'pytest==9.1.1', 'pytest-asyncio==1.3.0')
    bindir = target / 'bin'
    bindir.mkdir()
    launcher = bindir / 'hermes-acp'
    launcher.write_text('#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\n'
                        f'exec "{checkout}/venv/bin/python" "{checkout}/hermes" acp "$@"\n')
    launcher.chmod(0o755)
    print(f'Isolated launcher: {launcher}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--source', default=PIN['upstream'], help='Git URL or cached upstream repository')
    parser.add_argument('--prepare-only', action='store_true', help='Acquire/verify/build without dependency installation')
    args = parser.parse_args()
    target = args.target.expanduser().resolve()
    checkout = prepare(target, args.source)
    if not args.prepare_only:
        install(target, checkout)
