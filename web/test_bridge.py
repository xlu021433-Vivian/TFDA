import importlib.util
import json
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from flask import Flask, session

spec = importlib.util.spec_from_file_location('l5_plugin', Path(__file__).with_name('l5_plugin.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BridgeTest(unittest.TestCase):
    def setUp(self):
        workspace = Path(__file__).resolve().parents[1]
        test_base = workspace / 'dist' / 'web-tests'
        test_base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=test_base)
        assert Path(self.temp.name).resolve().is_relative_to(workspace)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = Flask(__name__)
        self.app.secret_key = 'isolated-tests-only'
        module.install_shenqi(self.app, lambda: session.get('admin') is True, lambda: session.setdefault('csrf', 'test-csrf'), self.root)
        self.client = self.app.test_client()
        with self.client.session_transaction() as s:
            s['admin'] = True
            s['csrf'] = 'test-csrf'
        self.state()

    def state(self, **changes):
        state = dict(updatedAt=int(time.time()*1000), enabled=True, ready=True, busy=False, locked=False, loginNeeded=False, stage='idle')
        state.update(changes)
        (self.root / 'status.json').write_text(json.dumps(state), encoding='utf-8')

    def post(self, **changes):
        data = dict(id=str(uuid.uuid4()), createdAt=int(time.time()*1000), kind='meal', request='想吃河粉 25元预算 一份', budget=2500, authorized=True)
        data.update(changes)
        return self.client.post('/shenqi/api/command', json=data, headers={'X-CSRF-Token': 'test-csrf', 'Origin': 'http://localhost'})

    def test_only_validated_owner_can_read_or_send(self):
        with self.client.session_transaction() as s:
            s.clear()
            s['member_id'] = 1
        self.assertEqual(self.client.get('/shenqi/api/status').status_code, 401)
        self.assertEqual(self.client.get('/shenqi/').status_code, 302)
        self.assertEqual(self.post().status_code, 401)
        self.assertFalse((self.root / 'command.json').exists())

    def test_csrf_and_cross_origin_cannot_create_commands(self):
        self.assertEqual(self.client.post('/shenqi/api/command', json={'kind': 'stop'}).status_code, 400)
        self.assertEqual(self.client.post('/shenqi/api/command', json={'kind': 'stop'}, headers={'X-CSRF-Token':'test-csrf','Origin':'https://evil.example'}).status_code, 403)

    def test_offline_disabled_busy_or_unresolved_is_hard_stop(self):
        for change in [{'updatedAt':0}, {'enabled':False}, {'busy':True}, {'locked':True}, {'loginNeeded':True}, {'ready':False}]:
            self.state(**change)
            self.assertEqual(self.post().status_code, 409, change)
        self.state()
        (self.root/'claimed.json').write_text('{}')
        self.assertEqual(self.post().status_code, 409)

    def test_one_click_one_command_and_same_id_is_idempotent(self):
        request_id = str(uuid.uuid4())
        self.assertEqual(self.post(id=request_id).status_code, 202)
        first = (self.root/'command.json').read_bytes()
        self.assertEqual(self.post(id=request_id).status_code, 200)
        self.assertEqual(self.post().status_code, 409)
        self.assertEqual((self.root/'command.json').read_bytes(), first)
        command = json.loads(first)
        self.assertEqual(command['expiresAt']-command['createdAt'], 60000)
        self.assertEqual(command['budget'], 2500)

    def test_invalid_budget_consent_and_arbitrary_actions_never_enqueue(self):
        for changes in [{'budget':0}, {'budget':True}, {'budget':2500.1}, {'budget':100001}, {'authorized':False}, {'kind':'shell'}, {'request':'x'*161}, {'id':'../../bad'}]:
            self.assertEqual(self.post(**changes).status_code, 409 if changes.get('kind')!='shell' else 400)
        self.assertFalse((self.root/'command.json').exists())

    def test_pause_is_available_while_running_but_still_owner_only(self):
        self.state(busy=True, locked=True)
        self.assertEqual(self.post(kind='stop').status_code, 202)
        self.assertTrue((self.root/'stop.json').exists())

    def test_private_status_and_static_path_allowlist(self):
        self.state(barkKey='must-never-leave', cookies='must-never-leave', address='must-never-leave')
        result = self.client.get('/shenqi/api/status')
        self.assertNotIn('must-never-leave',result.text)
        self.assertIn('no-store',result.headers['Cache-Control'])
        self.assertEqual(self.client.get('/shenqi/assets/unknown.js').status_code, 404)


if __name__ == '__main__':
    unittest.main()
