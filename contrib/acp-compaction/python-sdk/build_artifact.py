#!/usr/bin/env python3
"""Build the reviewed pure-Python SDK backport deterministically, without installs."""
import argparse
import base64
import csv
import hashlib
import io
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
VERSION = '0.9.0+ours.compaction1'
DIST_INFO = f'agent_client_protocol-{VERSION}.dist-info'
WHEEL_NAME = f'agent_client_protocol-{VERSION}-py3-none-any.whl'


def build(output=None):
    members = {}
    for path in sorted((ROOT / 'src' / 'acp').rglob('*')):
        if path.is_file() and (path.suffix == '.py' or path.name == 'py.typed'):
            members[path.relative_to(ROOT / 'src').as_posix()] = path.read_bytes()
    metadata = ROOT / 'packaging' / 'baseline-dist-info'
    for path in sorted(metadata.rglob('*')):
        if path.is_file():
            members[f'{DIST_INFO}/{path.relative_to(metadata).as_posix()}'] = path.read_bytes()
    old_metadata = members[f'{DIST_INFO}/METADATA']
    assert old_metadata.count(b'\nVersion: 0.9.0\n') == 1
    members[f'{DIST_INFO}/METADATA'] = old_metadata.replace(
        b'\nVersion: 0.9.0\n', f'\nVersion: {VERSION}\n'.encode(), 1)
    members[f'{DIST_INFO}/WHEEL'] = (
        'Wheel-Version: 1.0\nGenerator: ours-isolated-compaction-backport\n'
        'Root-Is-Purelib: true\nTag: py3-none-any\n').encode()
    records = io.StringIO(newline='')
    writer = csv.writer(records, lineterminator='\n')
    for name, data in sorted(members.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
        writer.writerow([name, f'sha256={digest}', len(data)])
    record_name = f'{DIST_INFO}/RECORD'
    writer.writerow([record_name, '', ''])
    members[record_name] = records.getvalue().encode()
    output = Path(output).resolve() if output else ROOT / 'dist'
    output.mkdir(parents=True, exist_ok=True)
    wheel = output / WHEEL_NAME
    with zipfile.ZipFile(wheel, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(members.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 12, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    (output / 'SHA256SUMS').write_text(f'{digest}  {WHEEL_NAME}\n')
    print(f'{digest}  {wheel}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    build(parser.parse_args().output)
