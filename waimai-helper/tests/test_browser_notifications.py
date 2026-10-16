import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import browser_notifications as bridge


class BrowserNotificationsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'token.txt'
        self.mock = patch.object(bridge, 'TOKEN_PATH', self.path)
        self.mock.start()
        self.client = app.app.test_client()
        self.origin = 'chrome-extension://' + 'a' * 32

    def tearDown(self):
        self.mock.stop()
        self.tmp.cleanup()

    def test_pairing_is_only_same_origin_and_never_exports_bark_key(self):
        for origin in (None, 'https://evil.example', self.origin):
            headers = {'Origin': origin} if origin else {}
            self.assertEqual(self.client.post('/api/extension/pairing', json={}, headers=headers).status_code, 403)
        with patch.object(bridge.core, 'load_config', return_value={'bark': {'key': 'private-device-key'}}):
            response = self.client.post('/api/extension/pairing', json={}, headers={'Origin': 'http://localhost'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json['token']), 64)
        self.assertNotIn('private-device-key', response.get_data(as_text=True))
        self.assertEqual(response.json['token'], bridge.token())

    def test_extension_preflight_only_grants_the_notify_route(self):
        response = self.client.options('/api/browser-events', headers={'Origin': self.origin})
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], self.origin)
        self.assertEqual(self.client.get('/api/state', headers={'Origin': self.origin}).status_code, 403)
        self.assertEqual(self.client.post('/api/browser-events', json={}, headers={'Origin': 'https://evil.example'}).status_code, 403)

    def test_pairing_token_required_before_any_push(self):
        with patch.object(bridge.core, 'notify') as push:
            response = self.client.post('/api/browser-events', json={'kind': 'test'}, headers={'Origin': self.origin})
            self.assertEqual(response.status_code, 401)
            push.assert_not_called()

    def test_valid_order_push_uses_existing_configuration_and_exact_order_id(self):
        headers = {'Origin': self.origin, 'X-Shenqi-Notify-Token': bridge.token()}
        body = {'kind': 'unpaid', 'orderId': 'TESTORDER12345', 'total': 2340,
                'url': 'https://h5.waimai.meituan.com/waimai/mindex/order-detail?orderId=TESTORDER12345'}
        with patch.object(bridge.core, 'load_config', return_value={'bark': {'key': 'local-only'}}), \
                patch.object(bridge.core, 'notify', return_value=True) as push:
            response = self.client.post('/api/browser-events', json=body, headers=headers)
        self.assertTrue(response.json['delivered'])
        self.assertIn('TESTORDER12345', push.call_args.args[2])
        self.assertIn('23.40', push.call_args.args[2])
        self.assertNotIn('local-only', response.get_data(as_text=True))

    def test_invalid_order_and_external_payment_url_are_rejected(self):
        headers = {'Origin': self.origin, 'X-Shenqi-Notify-Token': bridge.token()}
        with patch.object(bridge.core, 'notify') as push:
            for body in ({'kind': 'unknown'}, {'kind': 'unpaid', 'orderId': '123', 'total': 2000, 'url': 'https://example.com'},
                         {'kind': 'unpaid', 'orderId': 'TESTORDER12345', 'total': 2000, 'url': 'https://h5.waimai.meituan.com.evil.example/waimai/mindex/pay'}):
                self.assertEqual(self.client.post('/api/browser-events', json=body, headers=headers).status_code, 400)
            push.assert_not_called()
