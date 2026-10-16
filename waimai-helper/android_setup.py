"""将已启动的本机安卓模拟器连接到外卖助手；不读取平台账号数据。"""
import argparse
import ipaddress
import re
import sys

import adbutils
import core


def local_emulator(serial):
    if re.fullmatch(r'emulator-\d+', serial):
        return True
    host, separator, port = serial.rpartition(':')
    if not separator or not port.isdigit() or not 1 <= int(port) <= 65535:
        return False
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host.strip('[]')).is_loopback
    except ValueError:
        return False


def connect_emulator(client=None):
    client = client if client is not None else adbutils.adb
    candidates = [entry.serial for entry in client.list()
                  if entry.state == 'device' and local_emulator(entry.serial)]
    if not candidates:
        raise RuntimeError('未发现在线的本机模拟器。请先启动雷电、等待安卓桌面出现，并在模拟器中开启本地 ADB 调试；若提示 VT 未开启，需先在 BIOS 中启用。')
    if len(candidates) != 1:
        raise RuntimeError('发现多个在线模拟器，请关闭暂时不用的实例后重试；没有自动选择设备，也没有修改设置。')
    serial = candidates[0]
    ready = client.device(serial=serial).shell('getprop sys.boot_completed', timeout=10).strip()
    if ready != '1':
        raise RuntimeError('安卓系统尚未启动完成，请等桌面出现后再次连接。')
    # 首次连接只允许试运行，关闭定时任务，避免模式切换后触发遗留任务。
    core.update_config({'connection_mode': 'android', 'device': serial,
                        'dry_run': True, 'schedule': {'enabled': False}})
    return serial


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        serial = connect_emulator()
    except Exception as error:
        # 不输出 ADB 原始异常，避免未来包含设备或平台敏感内容。
        message = str(error) if isinstance(error, RuntimeError) else '无法检查模拟器连接，请确认模拟器和本地 ADB 已开启。'
        print(message)
        return 1
    print(f'已连接本机模拟器：{serial}')
    print('已切换安卓设备模式，保留试运行并关闭定时任务。刷新外卖助手页面后，可在“账号与登录”检查模拟器 App。')
    print('请在模拟器里的官方 App 中亲自登录；不要在聊天中提供密码或验证码。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
