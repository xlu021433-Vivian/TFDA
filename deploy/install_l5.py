"""Install only the Shenqi blueprint and an owner-only navigation link into L5.

Run against an explicitly selected L5 project. Existing source is backed up;
accounts, databases, tunnel settings and secrets are never read or copied.
"""
import argparse
import shutil
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def install(project):
    project = project.resolve()
    app_path = project / 'app.py'
    navigation = project / 'templates' / '_navigation.html'
    source = app_path.read_text(encoding='utf-8')
    if not all(text in source for text in ['def is_admin(', 'def csrf_token(', 'configure_music(app, db, collection_owner, reserve_limits)']):
        raise ValueError('The selected directory is not the expected L5 host.')
    backup = ROOT / '.tool-cache' / ('l5-integration-backup-' + uuid.uuid4().hex)
    backup.mkdir(parents=True)
    shutil.copy2(app_path, backup / 'app.py')
    shutil.copy2(navigation, backup / '_navigation.html')
    module = project / 'shenqi_web'
    assets = module / 'static'
    assets.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'web' / 'l5_plugin.py', module / '__init__.py')
    shutil.copy2(ROOT / 'web' / 'README.md', module / 'README.md')
    for name in ['index.html', 'app.css', 'app.js']:
        shutil.copy2(ROOT / 'web' / 'static' / name, assets / name)
    for name in ['guard-data.js', 'policy.js']:
        shutil.copy2(ROOT / 'desktop' / 'engine' / name, assets / name)
    insertion = '\n# Owner-only Shenqi controller; Meituan login stays in the desktop app.\nfrom shenqi_web import install_shenqi\ninstall_shenqi(app, is_admin, csrf_token)\n'
    marker = 'configure_music(app, db, collection_owner, reserve_limits)'
    if 'from shenqi_web import install_shenqi' not in source:
        if source.count(marker) != 1:
            raise ValueError('Ambiguous host initialization point.')
        app_path.write_text(source.replace(marker, marker + insertion), encoding='utf-8')
    links = navigation.read_text(encoding='utf-8')
    if '/shenqi/' not in links:
        marker = '<div class="nav-private" aria-label="站主专属">'
        if links.count(marker) != 1:
            raise ValueError('Ambiguous navigation macro; no navigation change made.')
        links = links.replace(marker, marker + '\n  <a href="/shenqi/"><span aria-hidden="true">♨</span><span>神器</span></a>')
        navigation.write_text(links, encoding='utf-8')
    print('Installed /shenqi/ blueprint and owner-only navigation. Source backup: ' + str(backup))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    install(parser.parse_args().project)
