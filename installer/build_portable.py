"""Publish only the original public payload inventory plus the repaired launcher assets."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE_DIGEST = '1a6b3bed12e1e008290fbaf0114e52d1045aee88b41316a04f6c385903c725ba'


def build(installation, output):
    original = ROOT / 'dist/windows-0.3.0/shenqi-waimai-windows-x64.zip'
    assert hashlib.sha256(original.read_bytes()).hexdigest() == BASE_DIGEST
    with zipfile.ZipFile(original) as source:
        expected = {name.removeprefix('Shenqi-Waimai/') for name in source.namelist()}
    expected.add('INSTALL-HELP.txt')
    manifest = json.loads((installation / 'files.sha256.json').read_text('utf-8'))
    assert {item['path'] for item in manifest} == expected - {'files.sha256.json'}
    for item in manifest:
        assert hashlib.sha256((installation / item['path']).read_bytes()).hexdigest() == item['sha256'], item['path']
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'shenqi-waimai-windows-x64.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as result:
        for name in sorted(expected):
            result.write(installation / name, 'Shenqi-Waimai/' + name)
    sums = []
    for name in ('Shenqi-Waimai-Setup.exe', archive.name):
        path = output / name
        sums.append(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + name)
    (output / 'SHA256SUMS.txt').write_text('\n'.join(sums) + '\n', encoding='ascii')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size,
                      'public_files': len(expected)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('installation', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/windows-0.3.2')
    args = parser.parse_args()
    build(args.installation.resolve(), args.output.resolve())
