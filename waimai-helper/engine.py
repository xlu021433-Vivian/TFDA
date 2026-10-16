"""执行 selectors.yaml 里定义的操作流程。"""
import logging
import random
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

import uiautomator2 as u2

log = logging.getLogger("engine")


class StepFailed(Exception):
    """某一步找不到按钮等，流程失败"""


class Abort(Exception):
    """主动中止（疑似猪肉、超预算等）"""


def fmt(obj, vars):
    if isinstance(obj, str):
        return obj.format(**vars)
    if isinstance(obj, list):
        return [fmt(x, vars) for x in obj]
    if isinstance(obj, dict):
        return {k: fmt(v, vars) for k, v in obj.items()}
    return obj


class Engine:
    def __init__(self, serial, guard, dry_run=True, logs_dir="logs"):
        import adbutils
        serial = (serial or '').strip()
        if not serial:
            raise RuntimeError('设备地址为空，请在设置中填写模拟器或云手机的 ADB 地址')
        detail = ''
        if ":" in serial:
            try:
                detail = adbutils.adb.connect(serial, timeout=5)
            except Exception as e:
                detail = str(e)
        devices = adbutils.adb.list()
        info = next((d for d in devices if d.serial == serial), None)
        if info is None or info.state != 'device':
            state = info.state if info is not None else '未连接'
            hint = ('请在安卓设备上允许 USB 调试授权' if state == 'unauthorized'
                    else '请开启模拟器及 ADB 调试，并确认设置中的设备地址和端口')
            online = ', '.join(d.serial for d in devices if d.state == 'device')
            raise RuntimeError(f'设备 {serial} {state}。{hint}。'
                               + (f'当前在线设备：{online}。' if online else '')
                               + (f'连接信息：{detail}' if detail else ''))
        self.d = u2.connect(serial)
        self.guard = guard
        self.dry_run = dry_run
        self.logs = Path(logs_dir)
        self.logs.mkdir(parents=True, exist_ok=True)

    # ---------- 工具 ----------
    def pause(self, a=0.8, b=2.0):
        time.sleep(random.uniform(a, b))  # 模拟人手速度，降低风控

    def texts(self):
        root = ET.fromstring(self.d.dump_hierarchy())
        out = []
        for n in root.iter("node"):
            for k in ("text", "content-desc"):
                v = (n.get(k) or "").strip()
                if v:
                    out.append(v)
        return out

    def screenshot(self, tag):
        p = self.logs / f"{datetime.now():%m%d_%H%M%S}_{tag}.png"
        try:
            self.d.screenshot(str(p))
        except Exception:
            pass
        return p

    def _click(self, sel, timeout):
        if sel.wait(timeout=timeout):
            sel.click()
            return True
        return False

    # ---------- 执行流程 ----------
    def run_flow(self, steps, vars, label=""):
        if self.dry_run and label == '提交':
            raise StepFailed('试运行模式禁止提交订单')
        result = {}
        for raw in steps:
            step = fmt(dict(raw), vars)
            optional = step.pop("optional", False)
            timeout = step.pop("timeout", 8 if not optional else 3)
            (action, arg), = step.items()
            log.info(f"[{label}] {action}: {'[输入内容已隐藏]' if action == 'input' else arg}")
            try:
                ok = self._do(action, arg, timeout, result)
            except Abort:
                self.screenshot("abort")
                raise
            except u2.exceptions.UiObjectNotFoundError:
                ok = False
            if not ok:
                if optional:
                    log.info("  ↳ 没找到，跳过")
                else:
                    shot = self.screenshot("fail")
                    raise StepFailed(f"{label} 卡在「{action}: {arg}」，截图 {shot}")
            if action not in ("sleep",):
                self.pause()
        return result

    def _do(self, action, arg, timeout, result):
        d = self.d
        if action == "app_start":
            d.app_start(arg, stop=True)
            return True
        if action == "sleep":
            time.sleep(float(arg))
            return True
        if action == "press":
            d.press(arg)
            return True
        if action == "click":
            return self._click(d(text=arg), timeout)
        if action == "click_contains":
            return self._click(d(textContains=arg), timeout)
        if action == "click_desc":
            return self._click(d(descriptionContains=arg), timeout)
        if action == "click_id":
            return self._click(d(resourceId=arg), timeout)
        if action == "click_any":
            end = time.time() + timeout
            while time.time() < end:
                for t in arg:
                    for sel in (d(text=t), d(textContains=t), d(descriptionContains=t)):
                        if sel.exists:
                            sel.click()
                            return True
                time.sleep(0.5)
            return False
        if action == "scroll_to":
            if d(textContains=arg).exists:
                return True
            try:
                d(scrollable=True).scroll.to(textContains=arg)
            except Exception:
                pass
            return d(textContains=arg).exists
        if action == "input":
            box = d(focused=True, className="android.widget.EditText")
            if not box.exists:
                box = d(className="android.widget.EditText")
            if not box.wait(timeout=timeout):
                return False
            box.set_text(arg)
            return True
        if action == "back_until":
            for _ in range(2):
                if d(textContains=arg).exists:
                    return True
                d.press("back")
                time.sleep(1.5)
            return d(textContains=arg).exists
        if action == "pork_scan":
            hits = self.guard.scan(self.texts())
            if hits:
                desc = "；".join(f"{t}（{w}）" for t, w in hits[:5])
                raise Abort(f"确认页发现疑似猪肉：{desc}")
            return True
        if action == "read_price":
            result["price"] = self._read_price()
            return result["price"] is not None
        if action == "ensure_address":
            return self._ensure_address(arg, timeout)
        raise ValueError(f"未知动作 {action}")

    ADDRESS_ENTRIES = ["请选择收货地址", "选择收货地址", "收货地址", "送至", "我的地址", "定位"]

    def _ensure_address(self, keyword, timeout):
        """当前页面上能看到地址关键词就算对；否则点地址入口，从已保存地址里选它。"""
        if not keyword:
            return True
        d = self.d
        if any(keyword in t for t in self.texts()):
            return True
        for entry in self.ADDRESS_ENTRIES:
            sel = d(textContains=entry)
            if sel.exists:
                sel.click()
                time.sleep(2.5)
                break
        else:
            return False
        target = d(textContains=keyword)
        if target.wait(timeout=timeout):
            target.click()
            time.sleep(3)
            return any(keyword in t for t in self.texts())
        d.press("back")
        return False

    def _read_price(self):
        texts = self.texts()
        number = r'\d+(?:\.\d+)?'
        # 按最终实付优先，且只读取金额本身，不把件数、配送费等当作合计。
        for label in ('实付', '应付', '待支付', '合计'):
            found_label = False
            for i, text in enumerate(texts):
                if label not in text:
                    continue
                found_label = True
                tail = text.split(label, 1)[1].strip(' ：:')
                match = re.search(r'[¥￥]\s*(' + number + ')', tail)
                if match is None:
                    match = re.fullmatch(r'(' + number + r')\s*元?', tail)
                if match is not None:
                    return float(match.group(1))
                # 金额常拆成「实付」「¥」「35.50」，不能跨过费用或其他标签。
                if tail:
                    continue
                for width in (1, 2):
                    candidate = ''.join(texts[i + 1:i + 1 + width]).strip()
                    match = re.fullmatch(r'[¥￥]?\s*(' + number + r')\s*元?', candidate)
                    if match is not None:
                        return float(match.group(1))
            if found_label:
                return None
        return None
