import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import android_setup


class EmulatorSetupTests(unittest.TestCase):
    def client(self, *entries, boot='1'):
        client = Mock()
        client.list.return_value = [SimpleNamespace(serial=s, state=state) for s, state in entries]
        client.device.return_value.shell.return_value = boot
        return client

    def test_only_loopback_and_emulator_devices_are_eligible(self):
        for serial in ('emulator-5554', '127.0.0.1:5555', 'localhost:5555', '[::1]:5555'):
            self.assertTrue(android_setup.local_emulator(serial))
        for serial in ('physical-usb-device', '192.168.1.2:5555', 'example.com:5555', '127.0.0.1:99999'):
            self.assertFalse(android_setup.local_emulator(serial))

    def test_no_devices_or_physical_only_do_not_change_config(self):
        for client in (self.client(), self.client(('physical-usb-device', 'device'))):
            with patch.object(android_setup.core, 'update_config') as save:
                with self.assertRaisesRegex(RuntimeError, '未发现在线'):
                    android_setup.connect_emulator(client)
            save.assert_not_called()

    def test_multiple_devices_require_user_selection(self):
        client = self.client(('emulator-5554', 'device'), ('emulator-5556', 'device'))
        with patch.object(android_setup.core, 'update_config') as save:
            with self.assertRaisesRegex(RuntimeError, '多个在线'):
                android_setup.connect_emulator(client)
        save.assert_not_called()

    def test_system_must_finish_booting(self):
        client = self.client(('emulator-5554', 'device'), boot='')
        with patch.object(android_setup.core, 'update_config') as save:
            with self.assertRaisesRegex(RuntimeError, '尚未启动完成'):
                android_setup.connect_emulator(client)
        save.assert_not_called()

    def test_ready_emulator_updates_only_connection_and_safe_run_settings(self):
        client = self.client(('emulator-5554', 'device'), ('emulator-5556', 'offline'))
        with patch.object(android_setup.core, 'update_config') as save:
            self.assertEqual(android_setup.connect_emulator(client), 'emulator-5554')
        save.assert_called_once_with({'connection_mode': 'android', 'device': 'emulator-5554',
                                     'dry_run': True, 'schedule': {'enabled': False}})
        client.device.assert_called_once_with(serial='emulator-5554')


if __name__ == '__main__':
    unittest.main()
