import copy
import json
import logging
import sys
import tempfile
import threading
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
with patch('logging.FileHandler', return_value=logging.NullHandler()):
    import app
import core
import engine
import recommender


class RegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config_path = self.directory / 'config.yaml'
        self.config_path.write_text(json.dumps(core.DEFAULT_CONFIG, ensure_ascii=False), 'utf-8')
        for name, path in [('CONFIG', self.config_path), ('HISTORY', self.directory / 'history.json'),
                           ('RECS', self.directory / 'recommendations.json')]:
            p = patch.object(core, name, path)
            p.start()
            self.addCleanup(p.stop)
        self.cfg = core.load_config()
        self.client = app.app.test_client()

    def price(self, texts):
        reader = engine.Engine.__new__(engine.Engine)
        reader.texts = lambda: texts
        return reader._read_price()

    def test_fresh_checkout_uses_defaults_without_writing_a_private_config(self):
        self.config_path.unlink()
        cfg = core.load_config()
        self.assertEqual(cfg['connection_mode'], 'web')
        self.assertFalse(cfg['schedule']['enabled'])
        self.assertEqual(cfg['bark']['key'], '')
        self.assertFalse(self.config_path.exists())

    def test_price_ignores_quantity_before_currency(self):
        self.assertEqual(self.price(['合计 共2件 ¥35.50']), 35.5)

    def test_price_accepts_inline_label_without_currency(self):
        self.assertEqual(self.price(['实付28.50元']), 28.5)

    def test_price_prefers_final_amount_to_subtotal(self):
        self.assertEqual(self.price(['合计', '¥55', '实付', '¥35']), 35)

    def test_price_does_not_read_nearby_delivery_fee_as_total(self):
        self.assertIsNone(self.price(['合计', '配送费 ¥5', '预计30分钟送达']))

    def test_disabled_meal_cannot_be_requested(self):
        self.cfg['meals'][0]['enabled'] = False
        with self.assertRaisesRegex(RuntimeError, '停用'):
            core.pick_meal(self.cfg, self.cfg['meals'][0]['name'])

    def test_random_meal_skips_blocked_dishes(self):
        unsafe = copy.deepcopy(self.cfg['meals'][0])
        unsafe.update(name='猪肉餐', dishes=['红烧肉'])
        safe = self.cfg['meals'][0]
        self.cfg['meals'] = [unsafe, safe]
        with patch.object(core.random, 'choice', side_effect=lambda meals: meals[0]):
            self.assertEqual(core.pick_meal(self.cfg)['name'], safe['name'])

    def test_no_device_connection_for_empty_meal_list(self):
        self.cfg['meals'] = []
        with patch.object(core, 'get_engine', side_effect=AssertionError('device touched')):
            with self.assertRaisesRegex(RuntimeError, '清单'):
                core.run_order(self.cfg)

    def test_failed_order_does_not_count_as_eaten(self):
        old = self.cfg['meals'][0]
        core.record(old, None, 'failed')
        with patch.object(core.random, 'choice', side_effect=lambda meals: meals[0]):
            self.assertEqual(core.pick_meal(self.cfg)['name'], old['name'])

    def test_partial_settings_preserve_other_values(self):
        response = self.client.post('/api/config', json={'order': {'max_price': 25}})
        self.assertEqual(response.status_code, 200)
        order = core.load_config()['order']
        self.assertEqual(order['max_price'], 25)
        self.assertEqual(order['note'], self.cfg['order']['note'])

    def test_invalid_budget_rejected_without_saving(self):
        before = self.config_path.read_bytes()
        response = self.client.post('/api/config', json={'order': {'max_price': -1}})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_invalid_meal_rejected_without_saving(self):
        before = self.config_path.read_bytes()
        response = self.client.post('/api/meals', json={'meals': [{'name': '牛肉面'}]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_run_rejects_non_object_request(self):
        with patch.object(app, 'start_job', return_value=True) as start:
            response = self.client.post('/api/run/order', json=[])
        self.assertEqual(response.status_code, 400)
        start.assert_not_called()

    def test_invalid_platform_object_rejected(self):
        with patch.object(app, 'start_job') as start:
            response = self.client.post('/api/run/open_app', json={'platform': {}})
        self.assertEqual(response.status_code, 400)
        start.assert_not_called()

    def test_invalid_meal_platform_rejected_without_saving(self):
        before = self.config_path.read_bytes()
        meal = copy.deepcopy(self.cfg['meals'][0])
        meal['platform'] = []
        response = self.client.post('/api/meals', json={'meals': [meal]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_recommend_failure_keeps_previous_results(self):
        core.RECS.write_text('{"shops": [{"shop": "旧结果"}]}', 'utf-8')
        before = core.RECS.read_bytes()
        with patch.object(core, 'get_engine', return_value=Mock()), \
             patch.object(core, 'notify'), \
             patch.object(recommender, 'browse', side_effect=RuntimeError('搜索按钮未找到')):
            result = recommender.run_recommend(self.cfg, keywords=['牛肉'], platforms=['meituan'])
        self.assertFalse(result['ok'])
        self.assertIn('失败', result['message'])
        self.assertEqual(core.RECS.read_bytes(), before)

    def test_next_shop_discount_does_not_leak_into_previous_shop(self):
        shops = recommender.parse_shops(['甲店', '月售100', '牛肉面', '¥20',
                                         '乙店', '评分4.9', '满40减20', '月售200', '鸡肉饭', '¥18'])
        self.assertEqual(shops[0]['deals'], [])
        self.assertEqual(shops[1]['deals'], [(40, 20)])

    def test_explicit_empty_keywords_do_not_fall_back(self):
        with patch.object(core, 'get_engine') as connect:
            result = recommender.run_recommend(self.cfg, keywords=[], platforms=['meituan'])
        self.assertFalse(result['ok'])
        connect.assert_not_called()

    def test_failed_adb_connection_does_not_start_ui_wait(self):
        import adbutils
        with patch.object(adbutils.adb, 'connect', return_value='cannot connect'), \
             patch.object(adbutils.adb, 'list', return_value=[]), \
             patch.object(engine.u2, 'connect') as ui_connect:
            with self.assertRaisesRegex(RuntimeError, '设备|连接'):
                engine.Engine('127.0.0.1:16384', core.make_guard(self.cfg))
        ui_connect.assert_not_called()

    def test_authorized_device_connects(self):
        import adbutils
        with patch.object(adbutils.adb, 'connect', return_value='already connected'), \
             patch.object(adbutils.adb, 'list', return_value=[SimpleNamespace(serial='127.0.0.1:16384', state='device')]), \
             patch.object(engine.u2, 'connect') as ui_connect:
            engine.Engine('127.0.0.1:16384', core.make_guard(self.cfg), logs_dir=self.directory / 'shots')
        ui_connect.assert_called_once_with('127.0.0.1:16384')

    def test_optional_missing_button_skipped_but_required_button_fails(self):
        runner = engine.Engine.__new__(engine.Engine)
        runner.dry_run = False
        runner.pause = Mock()
        runner.screenshot = Mock(return_value='fail.png')
        runner._do = Mock(side_effect=engine.u2.exceptions.UiObjectNotFoundError())
        self.assertEqual(runner.run_flow([{'click': '不存在', 'optional': True}], {}), {})
        with self.assertRaises(engine.StepFailed):
            runner.run_flow([{'click': '不存在'}], {})

    def test_budget_exceeded_never_submits(self):
        device = Mock()
        device.run_flow.return_value = {'price': 100}
        with patch.object(core, 'get_engine', return_value=device), patch.object(core, 'notify'):
            result = core.run_order(self.cfg, claim_first=False)
        self.assertFalse(result['ok'])
        self.assertEqual(result['message'].count('超过预算'), 1)
        self.assertNotIn('提交', [c.args[2] for c in device.run_flow.call_args_list])

    def test_missing_price_never_submits(self):
        self.cfg['dry_run'] = False
        device = Mock()
        device.run_flow.return_value = {}
        with patch.object(core, 'get_engine', return_value=device), patch.object(core, 'notify'):
            result = core.run_order(self.cfg, claim_first=False)
        self.assertFalse(result['ok'])
        self.assertNotIn('提交', [c.args[2] for c in device.run_flow.call_args_list])

    def test_dry_run_does_not_submit(self):
        device = Mock()
        device.run_flow.return_value = {'price': 20}
        with patch.object(core, 'get_engine', return_value=device), patch.object(core, 'notify'):
            result = core.run_order(self.cfg, claim_first=False)
        self.assertTrue(result['ok'])
        self.assertNotIn('提交', [c.args[2] for c in device.run_flow.call_args_list])

    def test_disabled_coupon_platforms_do_not_connect(self):
        self.cfg['claim_coupons'] = []
        with patch.object(core, 'get_engine') as connect, patch.object(core, 'notify'):
            result = core.run_coupons(self.cfg)
        self.assertTrue(result['ok'])
        connect.assert_not_called()

    def test_atomic_write_failure_preserves_old_config(self):
        before = self.config_path.read_bytes()
        with patch.object(core.os, 'replace', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):
                core.update_config({'device': 'emulator-5554'})
        self.assertEqual(self.config_path.read_bytes(), before)
        self.assertEqual(list(self.directory.glob('*.tmp')), [])

    def test_concurrent_updates_preserve_both_changes(self):
        failures = []
        def change(body):
            try:
                core.update_config(body)
            except Exception as error:
                failures.append(error)
        threads = [threading.Thread(target=change, args=(body,)) for body in
                   ({'device': 'emulator-5554'}, {'order': {'max_price': 22}})]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(failures, [])
        cfg = core.load_config()
        self.assertEqual(cfg['device'], 'emulator-5554')
        self.assertEqual(cfg['order']['max_price'], 22)

    def test_scheduler_retries_busy_job_after_scheduled_minute(self):
        self.cfg['schedule'].update(enabled=True, weekdays=[3], recommend_time='10:00', order_time='10:00')
        core.save_config(self.cfg)
        with patch.object(app, 'FIRED', set()), patch.object(app, 'PENDING', app.collections.OrderedDict()), \
             patch.object(app, 'start_job', side_effect=[False, True, False, True]) as start:
            app.scheduler_tick(datetime(2026, 10, 14, 10, 0, 0))
            app.scheduler_tick(datetime(2026, 10, 14, 10, 1, 0))
            app.scheduler_tick(datetime(2026, 10, 14, 10, 2, 0))
            app.scheduler_tick(datetime(2026, 10, 14, 10, 2, 20))
            self.assertEqual([c.args[0] for c in start.call_args_list], ['recommend', 'recommend', 'order', 'order'])
            self.assertEqual(len(app.FIRED), 2)

    def test_scheduler_discards_pending_when_disabled(self):
        with patch.object(app, 'FIRED', set()), \
             patch.object(app, 'PENDING', app.collections.OrderedDict({'2026-10-14-order_time': ('order_time', '10:00', 'order')})), \
             patch.object(app, 'start_job') as start:
            app.scheduler_tick(datetime(2026, 10, 14, 10, 1, 0))
            self.assertFalse(app.PENDING)
            start.assert_not_called()

    def test_job_failure_releases_lock(self):
        with patch.object(app, '_job', side_effect=RuntimeError('offline')), \
             patch.object(app, 'LOCK', threading.Lock()):
            self.assertTrue(app.start_job('dump'))
            self.assertTrue(app.LOCK.acquire(timeout=2))
            app.LOCK.release()
            self.assertFalse(app.JOB['result']['ok'])

    def test_invalid_job_result_does_not_deadlock(self):
        with patch.object(app, '_job', return_value=None), patch.object(app, 'LOCK', threading.Lock()):
            self.assertTrue(app.start_job('dump'))
            self.assertTrue(app.LOCK.acquire(timeout=2))
            app.LOCK.release()
            self.assertFalse(app.JOB['result']['ok'])

    def test_duplicate_start_opens_existing_panel_without_scheduler(self):
        response = Mock(ok=True)
        response.json.return_value = app.panel_status()
        with patch.object(app, 'make_panel_server', side_effect=SystemExit(1)), \
             patch.object(core.requests, 'get', return_value=response), \
             patch.object(app.webbrowser, 'open') as browser, patch.object(app.threading, 'Thread') as thread:
            app.run_panel()
        browser.assert_called_once_with('http://127.0.0.1:8765')
        thread.assert_not_called()

    def test_duplicate_start_rejects_old_backend(self):
        response = Mock(ok=True)
        response.json.return_value = {'config': {}, 'job': {}, 'platforms': {}}
        with patch.object(app, 'make_panel_server', side_effect=SystemExit(1)), \
             patch.object(core.requests, 'get', return_value=response), \
             patch.object(app.webbrowser, 'open') as browser, patch.object(app.threading, 'Thread') as thread:
            with self.assertRaisesRegex(RuntimeError, '后台不是当前版本'):
                app.run_panel()
        browser.assert_not_called()
        thread.assert_not_called()

    def test_duplicate_start_rejects_stale_build(self):
        response = Mock(ok=True)
        response.json.return_value = dict(app.panel_status(), build='old-build')
        with patch.object(app, 'make_panel_server', side_effect=SystemExit(1)), \
             patch.object(core.requests, 'get', return_value=response), \
             patch.object(app.webbrowser, 'open') as browser:
            with self.assertRaisesRegex(RuntimeError, '后台不是当前版本'):
                app.run_panel()
        browser.assert_not_called()

    def test_bark_error_response_is_not_reported_as_success(self):
        self.cfg['bark']['key'] = 'test-key'
        response = Mock(ok=True)
        response.json.return_value = {'code': 400, 'message': 'invalid key'}
        with patch.object(core.requests, 'get', return_value=response):
            self.assertFalse(core.notify(self.cfg, 'test', 'test'))

    def test_bark_path_special_characters_encoded(self):
        self.cfg['bark']['key'] = 'test-key'
        response = Mock(ok=True)
        response.json.return_value = {'code': 200}
        with patch.object(core.requests, 'get', return_value=response) as get:
            self.assertTrue(core.notify(self.cfg, 'title/part', 'body/part'))
        self.assertTrue(get.call_args.args[0].endswith('/title%2Fpart/body%2Fpart'))

    def test_partial_recommendation_reports_failures_and_keeps_successful_shops(self):
        shops = {'牛肉面店': {'shop': '牛肉面店', 'deals': [(30, 10)], 'dishes': ['牛肉面']}}
        with patch.object(core, 'get_engine', return_value=Mock()), patch.object(core, 'notify'), \
             patch.object(recommender, 'browse', side_effect=[shops, RuntimeError('failed')]):
            result = recommender.run_recommend(self.cfg, keywords=['牛肉'], platforms=['meituan', 'eleme'])
        self.assertFalse(result['ok'])
        saved = json.loads(core.RECS.read_text('utf-8'))
        self.assertEqual(len(saved['shops']), 1)
        self.assertEqual(len(saved['errors']), 1)

    def test_ambiguous_profile_is_not_reported_as_logged_in(self):
        device = Mock()
        device.texts.return_value = ['我的', '加载中']
        with patch.object(core, 'get_engine', return_value=device):
            result = core.check_accounts(self.cfg)
        self.assertTrue(all(a['logged_in'] is None for a in result.values()))

    def test_inspection_failure_is_not_reported_as_uninstalled(self):
        device = Mock()
        device.d.app_info.side_effect = RuntimeError('设备掉线')
        with patch.object(core, 'get_engine', return_value=device):
            result = core.check_accounts(self.cfg)
        self.assertTrue(all(a['installed'] is None for a in result.values()))

    def test_account_status_survives_other_jobs(self):
        accounts = {'meituan': {'installed': True, 'logged_in': False, 'message': '未登录'}}
        with patch.object(app, 'ACCOUNTS', copy.deepcopy(accounts)), \
             patch.object(app, 'JOB', {'name': 'dump', 'result': None}):
            response = self.client.get('/api/state')
        self.assertEqual(response.json['accounts'], accounts)


if __name__ == '__main__':
    unittest.main()
