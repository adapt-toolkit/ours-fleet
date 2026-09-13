#!/usr/bin/env python3
"""Run actual SDK router and Hermes lifecycle regression suites in the selected target."""
import argparse
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--target', required=True, type=Path)
parser.add_argument('--jobs', type=int, default=4)
args = parser.parse_args()
target = args.target.expanduser().resolve()
checkout = target / 'hermes'
python = checkout / 'venv/bin/python'
evidence = target / 'evidence'
evidence.mkdir(exist_ok=True)

def run(name, command, **kwargs):
    with (evidence / name).open('w') as output:
        result = subprocess.run([str(x) for x in command], stdout=output, stderr=subprocess.STDOUT, **kwargs)
    print((evidence / name).read_text())
    result.check_returncode()

run('sdk-tests.txt', [python, '-I', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q', HERE.parent / 'python-sdk/tests'])
env = dict(os.environ, HERMES_PYTHON=str(python))
run('hermes-tests.txt', [checkout / 'scripts/run_tests.sh', 'tests/acp', 'tests/acp_adapter',
    'tests/agent/test_compaction_terminal_events.py', 'tests/agent/test_compression_attempt_lifecycle.py',
    '-j', args.jobs, '--file-retries', '0'], cwd=checkout, env=env)
