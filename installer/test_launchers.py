"""Run the packaged batch entry points with Windows CMD, without opening browsers or ordering."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import zipfile


def verify(directory):
    directory = directory.resolve()
    markers = {'START.bat': 'SHENQI_START_OK', 'INSTALL-EXTENSION.bat': 'SHENQI_EXTENSION_OK'}
    for name, marker in markers.items():
        content = (directory / name).read_bytes()
        content.decode('ascii')
        assert content.count(b'\n') == content.count(b'\r\n'), name + ': missing CRLF'
        for code_page in (936, 65001):
            command = f'chcp {code_page}>nul & call "{directory / name}" --check'
            # CMD uses its own quoting rules; list2cmdline would insert literal backslash-quotes.
            result = subprocess.run('cmd.exe /d /q /c ' + command,
                                    capture_output=True, timeout=30)
            output = result.stdout.decode('utf-8', errors='replace')
            assert result.returncode == 0 and marker in output, (name, code_page, output, result.stderr.decode('utf-8', errors='replace'))
            assert '不是内部或外部命令' not in output, output
            print(f'{name} / CMD code page {code_page}: PASS')
    manifest = json.loads((directory / 'files.sha256.json').read_text('utf-8'))
    for entry in manifest:
        assert hashlib.sha256((directory / entry['path']).read_bytes()).hexdigest() == entry['sha256'], entry['path']
    print('Installed file manifest after launcher replacement: PASS')


def verify_repair(setup, directory):
    target = Path(tempfile.mkdtemp(prefix='repair-check-', dir=directory.resolve().parent))
    (target / 'app/data').mkdir(parents=True)
    (target / 'runtime').mkdir()
    (target / 'browser-extension').mkdir()
    for name in ('app/app.py', 'runtime/python.exe', 'browser-extension/manifest.json'):
        (target / name).write_bytes(b'fixture')
    config = target / 'app/config.yaml'
    history = target / 'app/data/history.json'
    config.write_bytes(b'fixture-private-settings')
    history.write_bytes(b'fixture-private-history')
    payload = Path(__file__).resolve().parents[1] / 'dist/windows-0.3.0/shenqi-waimai-windows-x64.zip'
    with zipfile.ZipFile(payload) as original:
        for name in ('START.bat', 'INSTALL-EXTENSION.bat', 'files.sha256.json'):
            (target / name).write_bytes(original.read('Shenqi-Waimai/' + name))
    command = [str(setup.resolve()), '--repair-launchers', str(target)]
    assert subprocess.run(command, capture_output=True, timeout=30).returncode == 0
    assert config.read_bytes() == b'fixture-private-settings'
    assert history.read_bytes() == b'fixture-private-history'
    assert subprocess.run(command, capture_output=True, timeout=30).returncode == 0
    (target / 'START.bat').write_bytes(b'@echo user-modified-script\r\n')
    before = {p.name: p.read_bytes() for p in target.iterdir() if p.is_file()}
    assert subprocess.run(command, capture_output=True, timeout=30).returncode != 0
    assert before == {p.name: p.read_bytes() for p in target.iterdir() if p.is_file()}
    print('Repair preserves settings/history, is idempotent, refuses user-modified scripts: PASS')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('installation', type=Path)
    parser.add_argument('--setup', type=Path)
    args = parser.parse_args()
    verify(args.installation)
    if args.setup:
        verify_repair(args.setup, args.installation)
