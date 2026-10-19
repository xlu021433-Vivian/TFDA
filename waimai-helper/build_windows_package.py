"""Build an offline Windows portable package using explicit public assets only."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

from browser_package import EXTENSION_FILES

ROOT = Path(__file__).resolve().parent
APP_FILES = (
    'app.py', 'core.py', 'recommender.py', 'privacy_auth.py', 'privacy_logging.py',
    'meituan_ordering.py', 'browser_notifications.py', 'browser_package.py',
    'pork_guard.py', 'engine.py', 'android_setup.py', 'selectors.yaml',
    'config.example.yaml', 'requirements.txt', 'static/index.html',
    'static/ordering.js', 'static/browser-help.html',
    *(f'browser-extension/{name}' for name in EXTENSION_FILES),
)


def build(runtime, site_packages, destination):
    # Never copy the working app directory, its config, venv, history or logs.
    if destination.exists():
        raise FileExistsError(f'Choose a new output directory: {destination}')
    package = destination / 'Shenqi-Waimai'
    app = package / 'app'
    for name in APP_FILES:
        target = app / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)
    ignore = shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo')
    shutil.copytree(runtime, package / 'runtime', ignore=ignore)
    shutil.copytree(site_packages, package / 'runtime/Lib/site-packages',
                    ignore=ignore, dirs_exist_ok=True)
    for source in (ROOT / 'windows-package').iterdir():
        if source.is_file():
            shutil.copy2(source, package / source.name)
    # The installed extension has a simple, stable location beside the launcher.
    shutil.copytree(app / 'browser-extension', package / 'browser-extension')
    inventory = []
    for item in sorted(package.rglob('*')):
        if item.is_file():
            inventory.append({'path': item.relative_to(package).as_posix(),
                              'sha256': hashlib.sha256(item.read_bytes()).hexdigest()})
    (package / 'files.sha256.json').write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2), encoding='utf-8')
    archive = destination / 'shenqi-waimai-windows-x64.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for item in sorted(package.rglob('*')):
            if item.is_file():
                z.write(item, item.relative_to(destination))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (destination / 'SHA256SUMS.txt').write_text(f'{checksum}  {archive.name}\n', encoding='ascii')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size,
                      'files': len(inventory), 'sha256': checksum}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--site-packages', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.runtime.resolve(), args.site_packages.resolve(), args.output.resolve())
