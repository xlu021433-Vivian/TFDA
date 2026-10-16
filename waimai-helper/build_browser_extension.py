"""Generate shared food-name rules and a reviewable Chrome/Edge extension archive."""
import json
from pathlib import Path

import pork_guard
from browser_package import EXTENSION_ROOT, extension_archive


def build():
    rules = {name: getattr(pork_guard, name) for name in ('HARD', 'NEAR_QUALIFIED', 'NAME_QUALIFIED', 'SAFE')}
    (EXTENSION_ROOT / 'guard-data.js').write_text(
        '// Generated from pork_guard.py by build_browser_extension.py.\n'
        '(function(root){const rules=' + json.dumps(rules, ensure_ascii=False, separators=(',', ':')) +
        ';if(typeof module!=="undefined"&&module.exports)module.exports=rules;else root.ShenqiGuardData=rules;})(globalThis);\n',
        encoding='utf-8')
    destination = Path(__file__).resolve().parent.parent / '神器-网页点餐助手.zip'
    destination.write_bytes(extension_archive().getvalue())
    print(destination)


if __name__ == '__main__':
    build()
