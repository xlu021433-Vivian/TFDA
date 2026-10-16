"""核心逻辑：软件面板和命令行共用。"""
import json
import logging
import math
import os
import random
import re
import tempfile
import threading
from copy import deepcopy
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import requests
import yaml

from pork_guard import PorkGuard

BASE = Path(__file__).parent
DATA = BASE / "data"
DATA.mkdir(exist_ok=True)
CONFIG = BASE / "config.yaml"
SELECTORS = BASE / "selectors.yaml"
HISTORY = DATA / "history.json"
RECS = DATA / "recommendations.json"

log = logging.getLogger("core")

PLATFORM_NAMES = {"meituan": "美团外卖", "eleme": "饿了么/淘宝闪购"}


# ---------- 读写配置 ----------
CONFIG_LOCK = threading.RLock()
DEFAULT_CONFIG = {
    "connection_mode": "web",
    "device": "127.0.0.1:16384", "bark": {"server": "https://api.day.app", "key": ""},
    "dry_run": True, "claim_coupons": ["meituan", "eleme"], "meals": [],
    "order": {"address": "", "delivery_time": "12:00", "note": "", "max_price": 40,
              "avoid_repeat_days": 2},
    "guard": {"extra_block": [], "allow": [], "scan_ignore": []},
    "schedule": {"enabled": False, "weekdays": [1, 2, 3, 4, 5], "order_time": "10:00",
                 "coupons_time": "", "recommend_time": ""},
    "recommend": {"keywords": ["牛肉", "清真", "鸡公煲", "轻食"],
                  "platforms": ["meituan", "eleme"], "deep": False, "max_shops": 5},
}


def merge_config(base, changes):
    result = deepcopy(base)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_config(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def validate_config(cfg):
    if cfg.get('connection_mode') not in ('web', 'android'):
        raise ValueError('使用方式只能选择官方登录或安卓设备')
    for key in ("order", "guard", "schedule", "recommend", "bark"):
        if not isinstance(cfg.get(key), dict):
            raise ValueError(f"{key} 设置必须是对象")
    for value, label in ((cfg.get("device"), "设备地址"), (cfg['bark'].get('key'), 'Bark key'),
                         (cfg['bark'].get('server'), 'Bark 服务地址'),
                         *[(cfg['order'].get(k), k) for k in ('address', 'delivery_time', 'note')]):
        if not isinstance(value, str):
            raise ValueError(f"{label} 必须是文字")
    for value, label in ((cfg.get('dry_run'), '试运行'), (cfg['schedule'].get('enabled'), '定时'),
                         (cfg['recommend'].get('deep'), '进店读菜单')):
        if not isinstance(value, bool):
            raise ValueError(f"{label} 必须是开关值")
    for value, label, minimum, integer in (
            (cfg['order'].get('max_price'), '预算上限', 0, False),
            (cfg['order'].get('avoid_repeat_days'), '不重复天数', 0, True),
            (cfg['recommend'].get('max_shops'), '进店数量', 1, True)):
        if (type(value) not in (int, float) or not math.isfinite(value) or value < minimum
                or (integer and type(value) is not int)):
            raise ValueError(f"{label} 必须是大于等于 {minimum} 的{'整数' if integer else '数字'}")
    for value, label in (
            (cfg.get('claim_coupons'), '领券平台'), (cfg['recommend'].get('platforms'), '推荐平台'),
            (cfg['recommend'].get('keywords'), '搜索关键词'),
            *[(cfg['guard'].get(k), k) for k in ('extra_block', 'allow', 'scan_ignore')]):
        if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
            raise ValueError(f"{label} 必须是非空文字组成的列表")
    if any(p not in PLATFORM_NAMES for p in cfg['claim_coupons'] + cfg['recommend']['platforms']):
        raise ValueError('平台只能选择美团或饿了么')
    weekdays = cfg['schedule'].get('weekdays')
    if not isinstance(weekdays, list) or any(type(d) is not int or not 1 <= d <= 7 for d in weekdays):
        raise ValueError('定时日期必须是 1 到 7 的星期列表')
    for key in ('recommend_time', 'coupons_time', 'order_time'):
        value = cfg['schedule'].get(key)
        if not isinstance(value, str) or (value and not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value)):
            raise ValueError('定时时间必须是 HH:MM 格式，或留空')
    meals = cfg.get('meals')
    if not isinstance(meals, list):
        raise ValueError('安全清单必须是列表')
    for i, meal in enumerate(meals, 1):
        if not isinstance(meal, dict):
            raise ValueError(f'安全清单第 {i} 行格式错误')
        if any(not isinstance(meal.get(k), str) or not meal[k].strip() for k in ('name', 'shop')):
            raise ValueError(f'安全清单第 {i} 行需填写名称和店名')
        if not isinstance(meal.get('platform'), str) or meal['platform'] not in PLATFORM_NAMES:
            raise ValueError(f'安全清单第 {i} 行平台无效')
        dishes = meal.get('dishes')
        if not isinstance(dishes, list) or not dishes or any(not isinstance(d, str) or not d.strip() for d in dishes):
            raise ValueError(f'安全清单第 {i} 行需填写菜品列表')
        if not isinstance(meal.get('enabled', True), bool) or not isinstance(meal.get('address', ''), str):
            raise ValueError(f'安全清单第 {i} 行启用状态或地址无效')


def load_config():
    with CONFIG_LOCK:
        cfg = yaml.safe_load(CONFIG.read_text("utf-8"))
    if cfg is None:
        cfg = {}
    if not isinstance(cfg, dict):
        raise ValueError('配置文件必须是对象')
    cfg = merge_config(DEFAULT_CONFIG, cfg)
    validate_config(cfg)
    return cfg


def save_config(cfg):
    validate_config(cfg)
    with CONFIG_LOCK:
        write_text_atomic(CONFIG, yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False))


def update_config(changes):
    with CONFIG_LOCK:
        cfg = merge_config(load_config(), changes)
        save_config(cfg)
        return cfg


def write_text_atomic(path, text):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix=path.name + '.', suffix='.tmp', delete=False) as f:
            temp_path = Path(f.name)
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def load_selectors():
    return yaml.safe_load(SELECTORS.read_text("utf-8"))


def read_json(p, default):
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return default


def make_guard(cfg):
    g = cfg.get("guard", {})
    return PorkGuard(g.get("extra_block", []), g.get("allow", []), g.get("scan_ignore", []))


def get_engine(cfg):
    try:
        from engine import Engine
        return Engine(cfg["device"], make_guard(cfg), dry_run=cfg.get("dry_run", True),
                      logs_dir=DATA / "screenshots")
    except Exception as e:
        raise RuntimeError(f"连不上安卓设备 {cfg.get('device')}：{e}。"
                           "请确认模拟器/云手机已开机、ADB 已连接。") from e


# ---------- 推送 ----------
def notify(cfg, title, body, url=None, urgent=False):
    log.info(f"推送：{title} | {body}")
    b = cfg.get("bark", {})
    key = (b.get("key") or "").strip()
    if not key or "在这里" in key:
        log.warning("未配置 Bark key，跳过推送")
        return False
    api = f"{b.get('server', 'https://api.day.app').rstrip('/')}/{quote(key, safe='')}/{quote(title, safe='')}/{quote(body, safe='')}"
    params = {"group": "外卖助手"}
    if url:
        params["url"] = url
    if urgent:
        params["level"] = "timeSensitive"
    try:
        r = requests.get(api, params=params, timeout=10)
        return r.ok and r.json().get('code') == 200
    except Exception as e:
        log.warning('推送失败（%s）', type(e).__name__)
        return False


# ---------- 历史 & 选餐 ----------
def record(meal, price, status):
    hist = read_json(HISTORY, [])
    hist.append({"date": date.today().isoformat(), "time": f"{datetime.now():%H:%M}",
                 "meal": meal["name"], "platform": meal["platform"],
                 "price": price, "status": status})
    write_text_atomic(HISTORY, json.dumps(hist[-300:], ensure_ascii=False, indent=1))


def pick_meal(cfg, name=None):
    meals = [m for m in cfg["meals"] if m.get("enabled", True)]
    guard = make_guard(cfg)
    if name:
        matches = [m for m in cfg['meals'] if m['name'] == name]
        if not matches:
            raise RuntimeError(f"安全清单里没有「{name}」")
        if len(matches) > 1:
            raise RuntimeError(f'清单里有多个「{name}」，请修改为不同名称后重试')
        meal = matches[0]
        if not meal.get('enabled', True):
            raise RuntimeError(f'「{name}」已停用，请先启用')
        for dish in meal['dishes']:
            ok, reason = guard.check(dish)
            if not ok:
                raise RuntimeError(f'「{name}」菜品被拦截：{dish}（{reason}）')
        return meal
    meals = [m for m in meals if m['dishes'] and all(guard.check(d)[0] for d in m['dishes'])]
    if not meals:
        raise RuntimeError("安全清单没有已启用且通过规则检查的餐品，请先添加或启用")
    days = cfg["order"].get("avoid_repeat_days", 2)
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    recent = {h["meal"] for h in read_json(HISTORY, [])
              if h["date"] > cutoff and h.get('status') == 'pending_payment'}
    pool = [m for m in meals if m["name"] not in recent] or meals
    return random.choice(pool)


# ---------- 任务 ----------
def claim_coupons(cfg, engine=None):
    if not cfg.get('claim_coupons'):
        return [], []
    sel = load_selectors()
    engine = engine or get_engine(cfg)
    done, failed = [], []
    for p in cfg.get("claim_coupons", []):
        try:
            engine.run_flow(sel[p]["flows"]["claim_coupons"],
                            {"package": sel[p]["package"]}, f"{sel[p]['name']}领券")
            done.append(sel[p]["name"])
        except Exception as e:
            log.warning(f"{p} 领券失败：{e}")
            failed.append(sel[p]["name"])
    return done, failed


def run_coupons(cfg):
    done, failed = claim_coupons(cfg)
    msg = f"已领：{'、'.join(done) or '无'}" + (f"；失败：{'、'.join(failed)}" if failed else "")
    notify(cfg, "领券完成", msg)
    return {"ok": not failed, "message": msg}


def run_order(cfg, meal_name=None, claim_first=True):
    from engine import Abort, StepFailed

    sel = load_selectors()
    guard = make_guard(cfg)
    dry = cfg.get("dry_run", True)
    meal = pick_meal(cfg, meal_name)
    plat = sel[meal["platform"]]
    o = cfg["order"]
    vars = {"package": plat["package"], "shop": meal["shop"], "keyword": meal["shop"],
            "note": o["note"], "delivery_time": o["delivery_time"], "dish": "",
            "address": (meal.get("address") or o.get("address") or "").strip()}

    for dish in meal["dishes"]:
        ok, why = guard.check(dish)
        if not ok:
            msg = f"{meal['name']}·{dish}：{why}，今天不下单"
            notify(cfg, "⚠️ 安全清单有可疑菜", msg)
            record(meal, None, "blocked_by_list")
            return {"ok": False, "message": msg}

    engine = get_engine(cfg)
    if claim_first:
        claim_coupons(cfg, engine)

    try:
        f = plat["flows"]
        engine.run_flow(f["open_shop"], vars, "进店")
        for dish in meal["dishes"]:
            engine.run_flow(f["add_dish"], {**vars, "dish": dish}, f"加菜 {dish}")
        price = engine.run_flow(f["checkout"], vars, "结算").get("price")
        if type(price) not in (int, float) or not math.isfinite(price) or price < 0:
            raise StepFailed('没有读到有效的实付金额，未提交订单')

        if price is not None and price > o["max_price"]:
            msg = f"{meal['name']} 实付 ¥{price}，超过预算 ¥{o['max_price']}，未下单"
            notify(cfg, "超预算，未下单", msg, url=plat["app_url"])
            record(meal, price, "over_budget")
            return {"ok": False, "message": msg}

        if dry:
            msg = f"试运行成功：{meal['name']} @{plat['name']}，实付约 ¥{price}（未提交）"
            notify(cfg, "试运行成功（未提交）", msg)
            record(meal, price, "dry_run")
            return {"ok": True, "message": msg}

        engine.run_flow(f["submit"], vars, "提交")
        msg = f"{meal['name']} ¥{price} 已生成待支付订单，{o['delivery_time']} 送达"
        notify(cfg, f"🍱 待支付：{meal['name']} ¥{price}",
               f"{plat['name']} → 订单 → 待支付，约15分钟内付款", url=plat["app_url"], urgent=True)
        record(meal, price, "pending_payment")
        return {"ok": True, "message": msg}

    except Abort as e:
        notify(cfg, "🚫 已中止：疑似含猪肉", str(e), url=plat["app_url"], urgent=True)
        record(meal, None, "aborted_pork")
        return {"ok": False, "message": str(e)}
    except StepFailed as e:
        notify(cfg, "下单流程卡住了", f"{e}（可能 App 改版，需要校准）", url=plat["app_url"])
        record(meal, None, "failed")
        return {"ok": False, "message": str(e)}


LOGIN_HINTS = ("登录/注册", "立即登录", "请登录", "登录注册", "手机号登录", "点击登录")


def check_accounts(cfg):
    """检查两个平台：App 是否安装、是否已登录。账号密码不经过本软件。"""
    from uiautomator2.exceptions import AppNotFoundError
    sel = load_selectors()
    engine = get_engine(cfg)
    out = {}
    for p in ("meituan", "eleme"):
        pkg = sel[p]["package"]
        info = {"name": sel[p]["name"], "installed": False, "logged_in": None, "message": ""}
        try:
            engine.d.app_info(pkg)
            info["installed"] = True
        except AppNotFoundError:
            info["message"] = f"设备上没装 {sel[p]['name']}（{pkg}）"
            out[p] = info
            continue
        except Exception as e:
            info['installed'] = None
            info['message'] = f'无法检查应用是否安装：{e}'
            out[p] = info
            continue
        try:
            engine.run_flow(sel[p]["flows"]["profile"], {"package": pkg}, f"{sel[p]['name']}账号")
            texts = engine.texts()
            if any(any(h in t for h in LOGIN_HINTS) for t in texts):
                info['logged_in'] = False
                info['message'] = '未登录，请点「在设备上打开」后登录'
            elif any('退出登录' in t or '退出账号' in t for t in texts):
                info['logged_in'] = True
                info['message'] = '已登录'
            else:
                info['message'] = '未发现明确的登录状态，请在设备上确认；界面文字可能需要校准'
        except Exception as e:
            info["message"] = f"检查失败：{e}"
        out[p] = info
    return out


def open_app(cfg, platform):
    sel = load_selectors()
    engine = get_engine(cfg)
    engine.d.app_start(sel[platform]["package"])
    return {"ok": True, "message": f"已在设备上打开 {sel[platform]['name']}，请在模拟器/云手机画面里完成登录"}
