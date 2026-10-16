import copy
import json
import logging
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
with patch('logging.FileHandler', return_value=logging.NullHandler()):
    import app
import core
import privacy_auth as auth
from privacy_logging import PrivacyFilter, redact

PHONE = '13800138000'
CODE = '123456'
TOKEN = 'test-private-token-never-output'


class PrivacyAuthTests(unittest.TestCase):
    def setUp(self):
        self.manager = auth.PrivacyAuth()
        self.addCleanup(lambda: [session.clear_credentials() for session in self.manager.sessions.values()])
        replacement = patch.object(auth, 'AUTH', self.manager)
        replacement.start()
        self.addCleanup(replacement.stop)
        self.client = app.app.test_client()
        self.state = self.client.get('/api/state').json
        self.csrf = self.state['auth']['csrf']

    def post(self, path, body=None, **kwargs):
        return self.client.post('/api/auth/' + path, json=body or {},
                                headers={'X-Login-CSRF': self.csrf}, **kwargs)

    def send(self):
        with patch.object(self.manager, '_post', return_value={'code': 0}) as upstream:
            response = self.post('meituan/send-sms', {'phone': PHONE, 'terms_accepted': True})
        self.assertEqual(response.status_code, 200)
        return upstream

    def authenticate(self):
        self.send()
        with patch.object(self.manager, '_post', return_value={'code': 0, 'data': {'token': TOKEN}}):
            response = self.post('meituan/verify', {'phone': PHONE, 'sms_code': CODE})
        self.assertEqual(response.status_code, 200)
        return response

    def test_auth_requests_need_csrf(self):
        with patch.object(self.manager, '_post') as upstream:
            response = self.client.post('/api/auth/meituan/send-sms', json={'phone': PHONE, 'terms_accepted': True})
        self.assertEqual(response.status_code, 403)
        upstream.assert_not_called()

    def test_health_checks_running_build_without_login_or_config(self):
        with patch.object(core, 'load_config') as config, patch.object(self.manager, 'session') as session:
            response = self.client.get('/api/health')
        self.assertEqual(response.json, app.panel_status())
        self.assertEqual(response.headers['Cache-Control'], 'no-store, private')
        config.assert_not_called()
        session.assert_not_called()

    def test_page_is_not_cached_across_backend_updates(self):
        with self.client.get('/') as response:
            self.assertEqual(response.headers['Cache-Control'], 'no-store, private')

    @unittest.skipUnless(sys.platform == 'win32', 'Windows 独占端口保护')
    def test_panel_server_requests_exclusive_windows_socket(self):
        with patch.object(app.ThreadedWSGIServer, 'server_bind') as bind:
            server = object.__new__(app.PanelServer)
            server.socket = Mock()
            server.server_bind()
        self.assertFalse(app.PanelServer.allow_reuse_address)
        server.socket.setsockopt.assert_called_once_with(
            app.socket.SOL_SOCKET, app.socket.SO_EXCLUSIVEADDRUSE, 1)
        bind.assert_called_once()

    def test_cross_site_requests_are_rejected(self):
        response = self.client.post('/api/auth/logout', json={}, headers={
            'Origin': 'https://unrelated.example', 'X-Login-CSRF': self.csrf})
        self.assertEqual(response.status_code, 403)

    def test_dns_rebinding_host_is_rejected(self):
        response = self.client.get('/api/state', headers={'Host': 'unrelated.example'})
        self.assertEqual(response.status_code, 403)

    def test_remote_client_is_rejected(self):
        response = self.client.get('/api/state', environ_overrides={'REMOTE_ADDR': '192.168.1.2'})
        self.assertEqual(response.status_code, 403)

    def test_form_cannot_trigger_post(self):
        response = self.client.post('/api/run/order', data={'meal': 'test'})
        self.assertEqual(response.status_code, 415)

    def test_consent_is_required_before_sms(self):
        with patch.object(self.manager, '_post') as upstream:
            response = self.post('meituan/send-sms', {'phone': PHONE, 'terms_accepted': False})
        self.assertEqual(response.status_code, 400)
        upstream.assert_not_called()

    def test_invalid_phone_is_not_transmitted(self):
        with patch.object(self.manager, '_post') as upstream:
            response = self.post('meituan/send-sms', {'phone': '138****8000', 'terms_accepted': True})
        self.assertEqual(response.status_code, 400)
        upstream.assert_not_called()

    def test_sms_payload_only_goes_to_documented_gateway(self):
        upstream = self.send()
        self.assertEqual(upstream.call_args.args[0], auth.SMS_SEND)
        self.assertEqual(set(upstream.call_args.kwargs['body']), {'mobile', 'uuid'})
        self.assertEqual(upstream.call_args.kwargs['body']['mobile'], PHONE)

    def test_repeat_sms_is_rate_limited(self):
        self.send()
        with patch.object(self.manager, '_post') as upstream:
            response = self.post('meituan/send-sms', {'phone': PHONE, 'terms_accepted': True})
        self.assertEqual(response.status_code, 429)
        upstream.assert_not_called()

    def test_login_requires_matching_sms_request(self):
        self.send()
        with patch.object(self.manager, '_post') as upstream:
            response = self.post('meituan/verify', {'phone': '13900139000', 'sms_code': CODE})
        self.assertEqual(response.status_code, 400)
        upstream.assert_not_called()

    def test_success_does_not_return_phone_code_or_token(self):
        response = self.authenticate()
        public = self.client.get('/api/state')
        self.assertTrue(public.json['auth']['connected'])
        for secret in (PHONE, CODE, TOKEN):
            self.assertNotIn(secret, response.get_data(as_text=True))
            self.assertNotIn(secret, public.get_data(as_text=True))
        self.assertNotIn('user_token', public.json['auth'])

    def test_provider_profile_is_not_read_or_forwarded(self):
        self.send()
        with patch.object(self.manager, '_post', return_value={'code': 0, 'data': {
                'token': TOKEN, 'nickname': 'private-name', 'address': 'private-address'}}) as upstream:
            response = self.post('meituan/verify', {'phone': PHONE, 'sms_code': CODE})
        self.assertEqual(upstream.call_count, 1)
        self.assertNotIn('private-name', response.get_data(as_text=True))
        self.assertNotIn('private-address', response.get_data(as_text=True))

    def test_credentials_are_never_written_to_config_or_history(self):
        with patch.object(core, 'write_text_atomic') as save:
            self.authenticate()
            self.post('logout')
        save.assert_not_called()

    def test_session_does_not_keep_raw_phone_or_otp(self):
        self.authenticate()
        session = next(iter(self.manager.sessions.values()))
        data = vars(session)
        self.assertNotIn(PHONE, data.values())
        self.assertNotIn(CODE, data.values())
        self.assertNotIn(TOKEN, repr(session))

    def test_logout_clears_token_and_rotates_csrf(self):
        self.authenticate()
        response = self.post('logout')
        self.assertEqual(response.status_code, 200)
        state = self.client.get('/api/state').json['auth']
        self.assertFalse(state['connected'])
        self.assertFalse(state['pending'])
        self.assertNotEqual(state['csrf'], self.csrf)
        self.assertTrue(all(not s.token and not s.pending_digest for s in self.manager.sessions.values()))

    def test_two_browsers_do_not_share_authorization(self):
        self.authenticate()
        other = app.app.test_client()
        self.assertFalse(other.get('/api/state').json['auth']['connected'])

    def test_expired_token_is_cleared(self):
        self.authenticate()
        with patch.object(self.manager, '_post', return_value={'code': 20005}):
            response = self.post('check')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json['connected'])
        self.assertFalse(self.client.get('/api/state').json['auth']['connected'])

    def test_two_hour_session_limit(self):
        self.authenticate()
        session = next(iter(self.manager.sessions.values()))
        with patch.object(auth.time, 'time', return_value=session.authenticated + 7201):
            self.assertFalse(session.public()['connected'])
        self.assertFalse(session.token)

    def test_credentials_expire_even_without_browser_polling(self):
        with patch.object(auth.threading, 'Timer') as timer_factory:
            self.authenticate()
            session = next(iter(self.manager.sessions.values()))
            args, kwargs = timer_factory.call_args
            self.assertEqual(args[0], 7200)
            timer_factory.return_value.start.assert_called_once()
            args[1](*kwargs['args'])
            self.assertFalse(session.token)

    def test_old_timer_cannot_clear_new_authorization(self):
        self.authenticate()
        session = next(iter(self.manager.sessions.values()))
        session.expire_auth(session.authenticated - 1)
        self.assertTrue(session.token)

    def test_network_errors_do_not_echo_request_details(self):
        with patch.object(auth.requests, 'Session') as session_class:
            session_class.return_value.__enter__.return_value.post.side_effect = auth.requests.RequestException(
                f'https://example?token={TOKEN}&phone={PHONE}&code={CODE}')
            response = self.post('meituan/send-sms', {'phone': PHONE, 'terms_accepted': True})
        self.assertEqual(response.status_code, 502)
        for secret in (PHONE, CODE, TOKEN):
            self.assertNotIn(secret, response.get_data(as_text=True))

    def test_login_secrets_cannot_be_submitted_in_url(self):
        response = self.client.post('/api/auth/meituan/verify?phone=' + PHONE, json={},
                                    headers={'X-Login-CSRF': self.csrf})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn(PHONE, response.get_data(as_text=True))

    def test_unknown_credentials_fields_are_rejected(self):
        with patch.object(self.manager, '_post') as upstream:
            response = self.post('meituan/send-sms', {'phone': PHONE, 'terms_accepted': True, 'password': 'secret'})
        self.assertEqual(response.status_code, 400)
        upstream.assert_not_called()

    def test_only_official_https_challenge_allowed(self):
        for url in ('http://verify.meituan.com/', 'https://meituan.com.evil.example/',
                    'https://evil.example/', 'https://user:pass@verify.meituan.com/',
                    'https://verify.meituan.com:8080/'):
            with self.subTest(url=url), self.assertRaises(auth.AuthError):
                self.manager.official_challenge(url)

    def test_security_qr_is_generated_locally(self):
        with patch.object(self.manager, '_post', return_value={'code': 20010, 'data': {
                'redirectUrl': 'https://verify.meituan.com/test'}}):
            response = self.post('meituan/send-sms', {'phone': PHONE, 'terms_accepted': True})
        self.assertTrue(response.json['security_required'])
        with patch.object(auth.requests, 'Session') as remote:
            qr = self.client.get('/api/auth/security-qr.png?v=1')
        self.assertEqual(qr.status_code, 200)
        self.assertTrue(qr.data.startswith(b'\x89PNG'))
        remote.assert_not_called()
        self.assertEqual(qr.headers['Cache-Control'], 'no-store, private')

    def test_official_page_does_not_fake_app_login(self):
        for provider, entry in auth.OFFICIAL_ENTRIES.items():
            response = self.client.get('/api/auth/official/' + provider)
            self.assertEqual(response.status_code, 303)
            self.assertEqual(response.headers['Location'], entry['url'])
        self.assertFalse(self.client.get('/api/state').json['auth']['connected'])

    def test_external_redirect_target_cannot_be_overridden(self):
        response = self.client.get('/api/auth/official/taobao?url=https://evil.example')
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('Location', response.headers)

    def test_cookies_and_response_headers_protect_auth(self):
        response = app.app.test_client().get('/api/state')
        cookie = response.headers['Set-Cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie)
        self.assertEqual(response.headers['Referrer-Policy'], 'no-referrer')
        self.assertEqual(response.headers['Cache-Control'], 'no-store, private')
        self.assertIn("frame-src 'none'", response.headers['Content-Security-Policy'])

    def test_web_mode_never_connects_to_android(self):
        cfg = core.load_config()
        cfg['connection_mode'] = 'web'
        with patch.object(core, 'load_config', return_value=cfg), patch.object(core, 'get_engine') as connect:
            result = app._job('open_app', platform='meituan')
        self.assertFalse(result['ok'])
        connect.assert_not_called()

    def test_gateway_enforces_tls_no_redirects_and_no_env_proxy(self):
        with patch.object(auth.requests, 'Session') as session_class:
            client = session_class.return_value.__enter__.return_value
            client.post.return_value = Mock(ok=True, is_redirect=False)
            client.post.return_value.json.return_value = {'code': 20005}
            self.manager._post(auth.TOKEN_VERIFY, params={'token': TOKEN})
        self.assertFalse(client.trust_env)
        self.assertTrue(client.post.call_args.kwargs['verify'])
        self.assertFalse(client.post.call_args.kwargs['allow_redirects'])
        self.assertTrue(client.post.call_args.args[0].startswith(auth.OFFICIAL_BASE + '/'))

    def test_log_redaction_hides_private_inputs(self):
        text = redact(f'phone={PHONE} token={TOKEN} sms_code={CODE}')
        for secret in (PHONE, CODE, TOKEN):
            self.assertNotIn(secret, text)
        self.assertIn('138****8000', text)

    def test_log_exceptions_do_not_expose_sensitive_urls(self):
        try:
            raise RuntimeError(f'url?token={TOKEN}&phone={PHONE}')
        except RuntimeError:
            record = logging.LogRecord('test', logging.ERROR, '', 0, '授权失败', (), sys.exc_info())
        PrivacyFilter().filter(record)
        self.assertIsNone(record.exc_info)
        self.assertNotIn(TOKEN, record.getMessage())


if __name__ == '__main__':
    unittest.main()
