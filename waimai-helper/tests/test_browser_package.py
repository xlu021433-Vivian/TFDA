import io
import json
import unittest
import zipfile
from unittest.mock import patch

import app
import pork_guard
from browser_package import EXTENSION_FILES, EXTENSION_ROOT, extension_archive


class BrowserPackageTests(unittest.TestCase):
    def test_package_contains_only_reviewed_assets_and_minimal_permissions(self):
        with zipfile.ZipFile(extension_archive()) as archive:
            self.assertEqual(set(archive.namelist()), set(EXTENSION_FILES))
            manifest = json.loads(archive.read('manifest.json'))
            self.assertEqual(manifest['manifest_version'], 3)
            self.assertEqual(set(manifest['permissions']), {'activeTab', 'scripting', 'storage', 'alarms', 'notifications'})
            self.assertEqual(set(manifest['host_permissions']), {'https://h5.waimai.meituan.com/*', 'http://127.0.0.1:8765/*'})
            self.assertEqual(manifest['content_scripts'][0]['matches'], ['https://h5.waimai.meituan.com/*'])
            self.assertEqual(manifest['background'], {'service_worker': 'state.js'})

    def test_generated_rules_match_existing_canonical_guard(self):
        source = (EXTENSION_ROOT / 'guard-data.js').read_text('utf-8')
        rules = json.loads(source.split('const rules=', 1)[1].split(';if(', 1)[0])
        for name in ('HARD', 'NEAR_QUALIFIED', 'NAME_QUALIFIED', 'SAFE'):
            self.assertEqual(rules[name], getattr(pork_guard, name))

    def test_download_is_a_zip_and_does_not_read_account_or_config(self):
        with patch.object(app.core, 'load_config', side_effect=AssertionError('unexpected config read')), \
             patch.object(app, 'login_session', side_effect=AssertionError('unexpected account read')), \
             app.app.test_client().get('/api/browser-extension.zip') as response:
            self.assertEqual(response.status_code, 200)
            self.assertIn('attachment', response.headers['Content-Disposition'])
            with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
                self.assertIn('content.js', archive.namelist())

    def test_browser_entry_and_help_do_not_require_application_keys(self):
        client = app.app.test_client()
        with client.get('/') as response:
            page = response.get_data(as_text=True)
        self.assertIn('<section id="browser" class="on">', page)
        self.assertIn('/api/browser-extension.zip', page)
        with client.get('/static/browser-help.html') as response:
            self.assertEqual(response.status_code, 200)
            self.assertIn('/api/browser-extension.zip', response.get_data(as_text=True))


if __name__ == '__main__':
    unittest.main()
