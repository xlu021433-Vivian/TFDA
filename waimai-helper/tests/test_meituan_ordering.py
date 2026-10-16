import copy
import hashlib
import json
import logging
import time
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import Mock, patch

import meituan_ordering as business
import privacy_auth
with patch('logging.FileHandler', return_value=logging.NullHandler()):
    import app
from pork_guard import PorkGuard


SHOP = {'wm_poi_id': 91, 'name': '清真牛肉饭店', 'status': 1, 'shipping_fee': 2, 'min_price': 10}
MENU = {'food_spu_tags': [{'tag': '1', 'tagType': 0, 'spus': [{
    'name': '牛肉饭', 'status': 0, 'attrs': [], 'skus': [{'id': 101, 'spec': '标准份',
    'price': 18, 'status': 0, 'stock': 10, 'min_order_count': 1}]}]}]}
BODY = {'consent': True, 'food_confirmed': True, 'items': [{'sku_id': '101', 'count': 1, 'attr_ids': []}],
        'receiver': {'name': '测试收货人', 'phone': '13800138000', 'address': '测试楼一层',
                     'longitude': '116.49', 'latitude': '40.00', 'note': ''}}


def quote(total=20, **changes):
    value = {'code': 0, 'token': 'private-preview-token',
             'wm_ordering_preview_order_vo': {'wm_poi_id': 91, 'poi_name': SHOP['name'], 'total': total,
                'recipient_name': BODY['receiver']['name'], 'recipient_phone': BODY['receiver']['phone'],
                'recipient_address': BODY['receiver']['address']},
             'wm_ordering_preview_detail_vo_list': [{'wm_food_sku_id': 101, 'food_name': '牛肉饭',
                 'spec': '标准份', 'count': 1, 'wm_ordering_preview_food_spu_attr_list': []}]}
    value.update(changes)
    return value


def response(data):
    return {'code': 0, 'data': data}


class OrderingTests(unittest.TestCase):
    def setUp(self):
        self.session = business.WaimaiSession()
        self.addCleanup(self.session.clear)
        self.session.configure({'app_id': 'test-app', 'app_secret': 'private-oauth-secret',
                                'secret_sign': 'private-sign-secret'}, 'http://127.0.0.1:8765/api/ordering/oauth/callback')
        self.session.access_token = 'private-consumer-token'
        self.session.expires_at = time.time() + 3600
        self.guard = PorkGuard()

    def menu(self, menu=None):
        with patch.object(business, 'remote_json', side_effect=[response({'openPoiBaseInfoList': [SHOP]}), response(menu or MENU)]):
            self.session.search('116.49', '40.00', '牛肉', True)
            self.session.menu('91', self.guard)

    def preview(self):
        self.menu()
        with patch.object(business, 'remote_json', return_value=response(quote())):
            return self.session.preview(copy.deepcopy(BODY), 40, self.guard)

    def test_signature_matches_documented_unencoded_sorted_preimage(self):
        params = {'timestamp': 100, 'keyword': '牛肉', 'app_id': 'example'}
        actual = business.signed_form(business.PATHS['shops'], params, 'test-secret')
        expected = hashlib.md5('https://openapi.waimai.meituan.com/openapi/v1/poilist?app_id=example&keyword=牛肉&timestamp=100test-secret'.encode()).hexdigest()
        self.assertEqual(actual['sign'], expected)
        self.assertEqual(actual['keyword'], '牛肉')
        self.assertNotIn('secret_sign', actual)

    def test_foreign_endpoint_or_secret_parameter_is_rejected(self):
        for path, params in (('https://evil.example/', {}), (business.PATHS['shops'], {'secret': 'x'})):
            with self.assertRaises(business.OrderError):
                business.signed_form(path, params, 'x')

    def test_tls_redirect_and_proxy_policy(self):
        with patch.object(business.requests, 'Session') as factory:
            client = factory.return_value.__enter__.return_value
            client.post.return_value = Mock(ok=True, is_redirect=False)
            client.post.return_value.json.return_value = response({})
            business.remote_json(business.PATHS['shops'], form={'sign': 'test'})
        self.assertFalse(client.trust_env)
        self.assertTrue(client.post.call_args.kwargs['verify'])
        self.assertFalse(client.post.call_args.kwargs['allow_redirects'])

    def test_network_exception_does_not_expose_credentials(self):
        with patch.object(business.requests, 'Session') as factory:
            factory.return_value.__enter__.return_value.get.side_effect = business.requests.RequestException('secret=private-oauth-secret')
            with self.assertRaises(business.TransportError) as error:
                business.remote_json('/oauth/access_token', query={'secret': 'private-oauth-secret'})
        self.assertNotIn('private-oauth-secret', str(error.exception))

    def test_coordinates_are_gcj02_degrees_to_integer_microdegrees(self):
        self.assertEqual(business.coordinates('116.49', '40'), {'longitude': 116490000, 'latitude': 40000000})
        for longitude, latitude in (('nan', 40), (181, 40), (116, 91), (True, 40)):
            with self.assertRaises(business.OrderError):
                business.coordinates(longitude, latitude)

    def test_oauth_requires_both_state_and_browser_guard_and_is_one_time(self):
        self.session.access_token = ''
        url, guard = self.session.begin_authorization()
        values = parse_qs(urlsplit(url).query, keep_blank_values=True)
        state = values['state'][0]
        self.assertEqual(values['scope'], [''])
        with patch.object(business, 'remote_json') as remote:
            with self.assertRaises(business.OrderError):
                self.session.complete_authorization(state, 'wrong-browser', 'test-code')
            remote.assert_not_called()
        with patch.object(business, 'remote_json', return_value={
                'access_token': 'new-private-token', 'refresh_token': 'never-retained', 'expires_in': 7200}) as remote:
            self.session.complete_authorization(state, guard, 'test-code')
            with self.assertRaises(business.OrderError):
                self.session.complete_authorization(state, guard, 'test-code')
        remote.assert_called_once()
        self.assertTrue(self.session.public()['connected'])
        self.assertNotIn('never-retained', vars(self.session).values())

    def test_secrets_and_order_tokens_are_not_public(self):
        public = self.preview()
        all_public = json.dumps([public, self.session.public()]) + repr(self.session)
        for secret in ('private-oauth-secret', 'private-sign-secret', 'private-consumer-token', 'private-preview-token', BODY['receiver']['phone']):
            self.assertNotIn(secret, all_public)

    def test_missing_consent_or_oauth_never_sends_search(self):
        with patch.object(business, 'remote_json') as remote:
            with self.assertRaises(business.OrderError):
                self.session.search('116', '40', '牛肉', False)
            self.session.access_token = ''
            with self.assertRaises(business.OrderError):
                self.session.search('116', '40', '牛肉', True)
        remote.assert_not_called()

    def test_shop_name_cannot_make_ambiguous_food_pass_guard(self):
        menu = copy.deepcopy(MENU)
        menu['food_spu_tags'][0]['spus'][0]['name'] = '三鲜水饺'
        self.menu(menu)
        with patch.object(business, 'remote_json') as remote:
            with self.assertRaisesRegex(business.OrderError, '忌口'):
                self.session.preview(copy.deepcopy(BODY), 40, self.guard)
        remote.assert_not_called()

    def test_large_sku_and_attribute_identifiers_are_transported_as_strings_to_browser(self):
        sku_id, attr_id = 9007199254740993, 9007199254740995
        menu = copy.deepcopy(MENU)
        spu = menu['food_spu_tags'][0]['spus'][0]
        spu['skus'][0]['id'] = sku_id
        spu['attrs'] = [{'name': '口味', 'values': [{'id': attr_id, 'value': '正常', 'unexpected': 'not-forwarded'}]}]
        with patch.object(business, 'remote_json', side_effect=[response({'openPoiBaseInfoList': [SHOP]}), response(menu)]):
            self.session.search('116', '40', '牛肉', True)
            rows = self.session.menu(91, self.guard)
        self.assertEqual(rows[0]['id'], str(sku_id))
        self.assertEqual(rows[0]['attrs'][0]['values'][0]['id'], str(attr_id))
        self.assertNotIn('unexpected', rows[0]['attrs'][0]['values'][0])
        body = copy.deepcopy(BODY)
        body['items'] = [{'sku_id': str(sku_id), 'count': 1, 'attr_ids': [str(attr_id)]}]
        payload = self.session._payload(body, self.guard)
        self.assertEqual(payload['wm_ordering_list']['food_list'][0]['food_spu_attr_ids'], [attr_id])

    def test_submit_missing_business_status_is_unknown_not_retryable(self):
        preview = self.preview()
        with patch.object(business, 'remote_json', side_effect=[response(quote()), response({})]):
            with self.assertRaisesRegex(business.OrderError, '缺少明确状态'):
                self.session.submit(preview['ticket'], True, False, 40, self.guard)
        self.assertTrue(self.session.public()['uncertain'])

    def test_payload_rejects_unknown_nested_fields(self):
        self.menu()
        for body in (dict(BODY, items=['invalid']), dict(BODY, receiver=dict(BODY['receiver'], password='never-needed'))):
            with patch.object(business, 'remote_json') as remote:
                with self.assertRaises(business.OrderError): self.session.preview(body, 40, self.guard)
            remote.assert_not_called()

    def test_menu_must_be_from_current_search_and_delivery_available(self):
        with patch.object(business, 'remote_json') as remote:
            with self.assertRaises(business.OrderError):
                self.session.menu(99, self.guard)
        remote.assert_not_called()

    def test_preview_uses_documented_payload_only(self):
        self.menu()
        with patch.object(business, 'remote_json', return_value=response(quote())) as remote:
            self.session.preview(copy.deepcopy(BODY), 40, self.guard)
        form = remote.call_args.kwargs['form']
        self.assertEqual(remote.call_args.args[0], business.PATHS['preview'])
        payload = json.loads(form['payload'])
        self.assertEqual(payload['wm_ordering_list']['pay_type'], 2)
        self.assertEqual(payload['wm_ordering_user']['user_longitude'], 116490000)
        self.assertNotIn('risk_param', payload)

    def test_pork_stock_attributes_and_required_categories_stop_before_preview(self):
        for change in ('pork', 'stock', 'attributes', 'required'):
            self.menu()
            if change == 'pork': self.session.catalog[101]['guard_text'] = '猪肉饭'
            if change == 'stock': self.session.catalog[101]['stock'] = 0
            if change == 'attributes': self.session.catalog[101]['attrs'] = [{'name': '口味', 'values': [{'id': 4, 'value': '正常'}]}]
            if change == 'required': self.session.required_tags = {'not-selected'}
            with patch.object(business, 'remote_json') as remote:
                with self.assertRaises(business.OrderError): self.session.preview(copy.deepcopy(BODY), 40, self.guard)
            remote.assert_not_called()

    def test_bad_upstream_price_or_items_never_produces_ticket(self):
        for data in (quote(total='NaN'), quote(total=-1), quote(total=41), quote(code=20), quote(wm_ordering_preview_detail_vo_list=[])):
            self.menu()
            with patch.object(business, 'remote_json', return_value=response(data)):
                with self.assertRaises(business.OrderError): self.session.preview(copy.deepcopy(BODY), 40, self.guard)
            self.assertIsNone(self.session.quote)

    def test_dry_run_never_sends_order_submit(self):
        preview = self.preview()
        with patch.object(business, 'remote_json') as remote:
            result = self.session.submit(preview['ticket'], True, True, 40, self.guard)
        self.assertFalse(result['created'])
        remote.assert_not_called()

    def test_confirmation_and_current_ticket_are_required(self):
        preview = self.preview()
        with patch.object(business, 'remote_json') as remote:
            for ticket, confirmed in (('other-ticket', True), (preview['ticket'], False)):
                with self.assertRaises(business.OrderError): self.session.submit(ticket, confirmed, False, 40, self.guard)
        remote.assert_not_called()

    def test_submit_rechecks_price_and_prevents_double_submit(self):
        preview = self.preview()
        with patch.object(business, 'remote_json', side_effect=[response(quote()), response({
                'code': 0, 'order_id': 1234, 'payUrl': 'https://pay.meituan.com/cashier?pay_token=private-pay-token'})]) as remote:
            result = self.session.submit(preview['ticket'], True, False, 40, self.guard)
            with self.assertRaises(business.OrderError): self.session.submit(preview['ticket'], True, False, 40, self.guard)
        self.assertEqual(remote.call_count, 2)
        submit_payload = json.loads(remote.call_args.kwargs['form']['payload'])
        self.assertEqual(submit_payload['token'], 'private-preview-token')
        self.assertEqual(submit_payload['pay_source'], 3)
        self.assertTrue(result['created'])
        self.assertNotIn('private-pay-token', json.dumps(result))

    def test_price_change_demands_another_preview(self):
        preview = self.preview()
        with patch.object(business, 'remote_json', return_value=response(quote(total=21))) as remote:
            with self.assertRaisesRegex(business.OrderError, '发生变化'):
                self.session.submit(preview['ticket'], True, False, 40, self.guard)
        self.assertEqual(remote.call_count, 1)
        self.assertIsNone(self.session.quote)

    def test_timeout_blocks_retry_and_new_preview(self):
        preview = self.preview()
        with patch.object(business, 'remote_json', side_effect=[response(quote()), business.TransportError('timeout', 502)]) as remote:
            with self.assertRaisesRegex(business.OrderError, '提交结果未知'):
                self.session.submit(preview['ticket'], True, False, 40, self.guard)
            with self.assertRaises(business.OrderError): self.session.preview(copy.deepcopy(BODY), 40, self.guard)
            with self.assertRaises(business.OrderError): self.session.submit(preview['ticket'], True, False, 40, self.guard)
        self.assertEqual(remote.call_count, 2)
        self.assertTrue(self.session.public()['uncertain'])

    def test_quote_expiry_and_expired_auth_are_rejected(self):
        preview = self.preview()
        self.session.quote['until'] = time.time() - 1
        with patch.object(business, 'remote_json') as remote:
            with self.assertRaises(business.OrderError): self.session.submit(preview['ticket'], True, False, 40, self.guard)
        remote.assert_not_called()
        self.session.expires_at = time.time() - 1
        self.assertFalse(self.session.public()['connected'])
        self.assertIsNone(self.session.quote)

    def test_payment_is_only_official_https_without_userinfo(self):
        for url in ('http://pay.meituan.com/', 'https://meituan.com.evil.example/', 'https://evil.example/',
                    'https://user:pass@pay.meituan.com/', 'https://pay.meituan.com:8080/'):
            self.assertIsNone(business.pay_url(url))
        self.assertEqual(business.pay_url('https://pay.sankuai.com/'), 'https://pay.sankuai.com/')

    def test_expiry_generation_cannot_clear_new_configuration(self):
        old = self.session.generation
        self.session.clear()
        self.session.configure({'app_id': 'new-app', 'app_secret': 'new-secret', 'secret_sign': 'new-sign'}, 'http://127.0.0.1/')
        self.session._expire(old)
        self.assertTrue(self.session.public()['configured'])
        self.session._expire(self.session.generation)
        self.assertFalse(self.session.public()['configured'])


class OrderingApiTests(unittest.TestCase):
    def setUp(self):
        self.manager = privacy_auth.PrivacyAuth()
        manager_patch = patch.object(privacy_auth, 'AUTH', self.manager)
        manager_patch.start()
        self.addCleanup(manager_patch.stop)
        self.addCleanup(lambda: [s.ordering.clear() for s in self.manager.sessions.values()])
        self.client = app.app.test_client()
        state = self.client.get('/api/state').json
        self.csrf = state['auth']['csrf']
        self.callback = state['ordering_callback']

    def post(self, path, body=None):
        return self.client.post('/api/ordering/' + path, json=body or {}, headers={'X-Login-CSRF': self.csrf})

    def configure(self):
        return self.post('configure', {'app_id': 'test-app', 'app_secret': 'private-oauth-secret', 'secret_sign': 'private-sign-secret'})

    def test_config_requires_csrf_and_accepts_only_documented_fields(self):
        response = self.client.post('/api/ordering/configure', json={})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.post('configure', {'password': 'never-send'}).status_code, 400)

    def test_configuration_is_not_written_or_returned(self):
        with patch.object(app.core, 'write_text_atomic') as save:
            self.assertEqual(self.configure().status_code, 200)
        save.assert_not_called()
        state = self.client.get('/api/state')
        self.assertTrue(state.json['ordering']['configured'])
        self.assertFalse(state.json['ordering']['connected'])
        self.assertNotIn('private-oauth-secret', state.get_data(as_text=True))
        self.assertNotIn('private-sign-secret', state.get_data(as_text=True))

    def test_oauth_callback_works_without_strict_cookie_using_lax_guard(self):
        self.configure()
        start = self.post('authorize')
        self.assertIn('SameSite=Lax', start.headers.get('Set-Cookie'))
        self.assertIn('HttpOnly', start.headers.get('Set-Cookie'))
        self.assertIn('Path=/api/ordering/oauth/callback', start.headers.get('Set-Cookie'))
        state = parse_qs(urlsplit(start.json['url']).query)['state'][0]
        self.client.delete_cookie(app.LOGIN_COOKIE)
        with patch.object(business, 'remote_json', return_value={'access_token': 'private-consumer-token', 'expires_in': 7200}) as remote:
            result = self.client.get('/api/ordering/oauth/callback', query_string={'code': 'test-code', 'state': state})
        self.assertEqual(result.status_code, 303)
        self.assertEqual(result.headers['Location'], '/')
        self.assertEqual(remote.call_args.args[0], '/oauth/access_token')
        current = self.client.get('/api/state')
        self.assertTrue(current.json['ordering']['connected'])
        self.assertNotIn('private-consumer-token', current.get_data(as_text=True))

    def test_foreign_browser_or_duplicate_callback_arguments_are_rejected(self):
        with patch.object(business, 'remote_json') as remote:
            response = app.app.test_client().get('/api/ordering/oauth/callback?code=fake&state=fake')
            duplicate = self.client.get('/api/ordering/oauth/callback?code=a&code=b&state=fake')
        self.assertEqual(response.status_code, 403)
        self.assertEqual(duplicate.status_code, 400)
        remote.assert_not_called()

    def test_search_needs_explicit_consent_and_consumer_oauth(self):
        self.configure()
        with patch.object(business, 'remote_json') as remote:
            response = self.post('shops', {'longitude': '116', 'latitude': '40', 'keyword': '牛肉', 'consent': False})
            unauthorized = self.post('shops', {'longitude': '116', 'latitude': '40', 'keyword': '牛肉', 'consent': True})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(unauthorized.status_code, 401)
        remote.assert_not_called()

    def test_clear_erases_application_and_authorization(self):
        self.configure()
        response = self.post('logout')
        self.assertEqual(response.status_code, 200)
        state = self.client.get('/api/state').json['ordering']
        self.assertFalse(state['configured'])
        self.assertFalse(state['connected'])

    def test_no_payment_redirect_without_created_order(self):
        response = self.client.get('/api/ordering/payment')
        self.assertEqual(response.status_code, 404)
        self.assertNotIn('Location', response.headers)

    def test_order_data_cannot_be_supplied_in_url(self):
        response = self.client.post('/api/ordering/preview?phone=private', json={}, headers={'X-Login-CSRF': self.csrf})
        self.assertEqual(response.status_code, 400)

    def test_session_expiry_cleans_consumer_authorization(self):
        self.configure()
        session = next(iter(self.manager.sessions.values()))
        session.created = time.time() - 9 * 3600
        self.client.get('/api/state')
        self.assertFalse(session.ordering.public()['configured'])


if __name__ == '__main__':
    unittest.main()
