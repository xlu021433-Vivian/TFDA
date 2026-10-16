"""Package only the reviewed browser extension assets; never include local account data."""
import io
import zipfile
from pathlib import Path

EXTENSION_FILES = ('manifest.json', 'guard-data.js', 'policy.js', 'adapter.js', 'styles.js',
                   'content.js', 'state.js', 'schedule.js', 'watch.js', 'options.html', 'options.css',
                   'options.js', 'icon.png', 'popup.html', 'popup.css', 'popup.js', 'README.md')
EXTENSION_ROOT = Path(__file__).resolve().parent / 'browser-extension'


def extension_archive():
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in EXTENSION_FILES:
            archive.writestr(name, (EXTENSION_ROOT / name).read_bytes())
    output.seek(0)
    return output
