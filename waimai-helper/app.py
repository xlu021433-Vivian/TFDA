"""外卖助手 · 本地软件面板。运行后浏览器打开 http://127.0.0.1:8765"""
import collections
import hashlib
import logging
import hmac
import os
import re
import socket
import threading
import time
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, g, jsonify, redirect, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.serving import ThreadedWSGIServer

import core
import recommender
import privacy_auth
import meituan_ordering
import browser_notifications
from browser_package import EXTENSION_FILES, extension_archive
from privacy_logging import PrivacyFilter, redact

# ---------- 日志收集到面板 ----------
LOGS = collections.deque(maxlen=400)


class PanelHandler(logging.Handler):
    def emit(self, r):
        LOGS.append(f"{datetime.now():%H:%M:%S} {redact(r.getMessage())}")


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                    handlers=[logging.StreamHandler(), PanelHandler(),
                              logging.FileHandler(core.DATA / "run.log", encoding="utf-8")])
logging.getLogger("werkzeug").setLevel(logging.WARNING)
for handler in logging.getLogger().handlers:
    handler.addFilter(PrivacyFilter())
logging.getLogger('urllib3').setLevel(logging.WARNING)
log = logging.getLogger("app")

app = Flask(__name__, static_folder="static")
app.config['MAX_CONTENT_LENGTH'] = 256 * 1024
browser_notifications.register(app)
LOGIN_COOKIE = 'waimai_private_auth'
PANEL_PROTOCOL = 2
# 启动时固定版本指纹；磁盘文件更新后，旧进程仍保留原指纹。
_SOURCE_ROOT = Path(__file__).resolve().parent
PANEL_BUILD = hashlib.sha256(b''.join(
    (_SOURCE_ROOT / name).read_bytes()
    for name in ('app.py', 'core.py', 'privacy_auth.py', 'privacy_logging.py', 'meituan_ordering.py',
                 'static/index.html', 'static/ordering.js', 'browser_package.py', 'browser_notifications.py', 'static/browser-help.html',
                 *(f'browser-extension/{name}' for name in EXTENSION_FILES))
)).hexdigest()[:16]


def panel_status():
    return {'application': 'waimai-helper', 'protocol': PANEL_PROTOCOL, 'build': PANEL_BUILD}


class PanelServer(ThreadedWSGIServer):
    # Windows 的 SO_REUSEADDR 允许两个进程同时绑定同一端口，旧进程可能继续接收请求。
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_panel_server():
    return PanelServer('127.0.0.1', 8765, app)


@app.before_request
def protect_local_panel():
    if (not re.fullmatch(r'(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?', request.host)
            or request.remote_addr not in ('127.0.0.1', '::1')):
        return jsonify(ok=False, message='操作面板仅允许本机访问'), 403
    origin = request.headers.get('Origin')
    if origin and origin != request.scheme + '://' + request.host and not (
            request.path == '/api/browser-events' and browser_notifications.EXTENSION_ORIGIN.fullmatch(origin)):
        return jsonify(ok=False, message='已拒绝其他网站发起的操作'), 403
    if request.method == 'POST' and request.mimetype != 'application/json':
        return jsonify(ok=False, message='请使用本软件页面提交操作'), 415
    if request.path.startswith('/api/auth/') and request.query_string:
        if not (request.path == '/api/auth/security-qr.png' and set(request.args) == {'v'}
                and request.args.get('v', '').isdigit()):
            return jsonify(ok=False, message='登录信息不能放在网址中'), 400
    if request.path.startswith('/api/ordering/') and request.query_string:
        if (request.path != '/api/ordering/oauth/callback'
                or set(request.args) - {'code', 'state', 'error', 'error_description'}
                or any(len(request.args.getlist(key)) != 1 for key in request.args)):
            return jsonify(ok=False, message='不支持的订餐网址参数'), 400


@app.after_request
def private_response(response):
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
    if request.path == '/' or request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, private'
    if hasattr(g, 'login_cookie'):
        response.set_cookie(LOGIN_COOKIE, g.login_cookie, httponly=True, samesite='Strict')
    return response


@app.errorhandler(privacy_auth.AuthError)
@app.errorhandler(meituan_ordering.OrderError)
def auth_error(error):
    return jsonify(ok=False, message=str(error)), error.status


def login_session():
    if not hasattr(g, 'login_session'):
        cookie, current = privacy_auth.AUTH.session(request.cookies.get(LOGIN_COOKIE))
        g.login_session = current
        g.login_key = cookie
        if cookie != request.cookies.get(LOGIN_COOKIE):
            g.login_cookie = cookie
    return g.login_session


def auth_body(allowed):
    if request.query_string:
        raise privacy_auth.AuthError('登录信息只能通过请求正文提交，不能放在网址中')
    body = json_body()
    if set(body) - set(allowed):
        raise privacy_auth.AuthError('提交了不支持的登录字段')
    current = login_session()
    csrf = request.headers.get('X-Login-CSRF', '')
    if not hmac.compare_digest(csrf, current.csrf):
        raise privacy_auth.AuthError('登录页面已更新，请刷新后重新操作', 403)
    return current, body


@app.errorhandler(ValueError)
def invalid_input(error):
    return jsonify(ok=False, message=str(error)), 400


@app.errorhandler(HTTPException)
def http_error(error):
    return jsonify(ok=False, message=error.description), error.code


def json_body(optional=False):
    if optional and not request.data:
        return {}
    body = request.get_json()
    if not isinstance(body, dict):
        raise ValueError('请求内容必须是对象')
    return body

# ---------- 后台任务（同一时间只跑一个，避免抢设备） ----------
JOB = {"name": None, "started": None, "result": None, "finished": None}
LOCK = threading.Lock()
JOB_NAMES = {"order": "下单", "coupons": "领券", "recommend": "抓取推荐",
             "accounts": "检查账号", "open_app": "打开 App", "dump": "读取屏幕"}
ACCOUNTS = {}


def _job(name, **kw):
    cfg = core.load_config()
    if cfg.get('connection_mode') == 'web':
        return {'ok': False, 'message': '当前使用网页助手模式。请从“网页点餐”下载浏览器扩展，在本人登录的美团网页操作；此处原有任务需要安卓设备。'}
    if name == "order":
        return core.run_order(cfg, kw.get("meal"))
    if name == "coupons":
        return core.run_coupons(cfg)
    if name == "recommend":
        return recommender.run_recommend(cfg, kw.get("keywords"), kw.get("platforms"), kw.get("deep"))
    if name == "accounts":
        res = core.check_accounts(cfg)
        return {"ok": True, "message": "；".join(f"{v['name']}：{v['message']}" for v in res.values()),
                "data": res}
    if name == "open_app":
        return core.open_app(cfg, kw["platform"])
    if name == "dump":
        eng = core.get_engine(cfg)
        root = ET.fromstring(eng.d.dump_hierarchy())
        rows = [{"text": n.get("text"), "desc": n.get("content-desc"), "id": n.get("resource-id")}
                for n in root.iter("node") if n.get("text") or n.get("content-desc")]
        return {"ok": True, "message": f"读取到 {len(rows)} 个元素", "data": rows}
    raise ValueError(name)


def start_job(name, **kw):
    if not LOCK.acquire(blocking=False):
        return False

    JOB.update(name=name, started=datetime.now().strftime("%H:%M:%S"), result=None, finished=None)

    def runner():
        try:
            log.info(f"▶ 开始：{JOB_NAMES.get(name, name)}")
            result = _job(name, **kw)
            if not isinstance(result, dict):
                raise ValueError('后台任务没有返回有效结果')
            JOB["result"] = result
            if name == 'accounts' and result.get('data'):
                ACCOUNTS.clear()
                ACCOUNTS.update(result['data'])
        except Exception as e:
            log.exception("任务出错")
            JOB["result"] = {"ok": False, "message": str(e)}
        finally:
            JOB["finished"] = datetime.now().strftime("%H:%M:%S")
            try:
                log.info(f"■ 结束：{JOB_NAMES.get(name, name)} — {(JOB['result'] or {}).get('message', '')}")
            finally:
                LOCK.release()

    try:
        threading.Thread(target=runner, daemon=True).start()
    except Exception:
        LOCK.release()
        raise
    return True


# ---------- 定时 ----------
FIRED = set()
PENDING = collections.OrderedDict()


def scheduler_tick(now):
    s = core.load_config()['schedule']
    today = now.strftime('%Y-%m-%d')
    FIRED.intersection_update(tag for tag in tuple(FIRED) if tag.startswith(today))
    for tag in list(PENDING):
        if not tag.startswith(today):
            del PENDING[tag]
    if not s['enabled'] or now.isoweekday() not in s['weekdays']:
        PENDING.clear()
        return
    for key, job in (('recommend_time', 'recommend'), ('coupons_time', 'coupons'), ('order_time', 'order')):
        tag = f'{today}-{key}'
        if s[key] == now.strftime('%H:%M') and tag not in FIRED:
            PENDING.setdefault(tag, (key, s[key], job))
    for tag, (key, scheduled_time, job) in list(PENDING.items()):
        if s[key] != scheduled_time:
            del PENDING[tag]
            continue
        if not start_job(job):
            break
        FIRED.add(tag)
        del PENDING[tag]
        log.info(f'⏰ 定时触发：{JOB_NAMES[job]}')


def scheduler():
    while True:
        try:
            scheduler_tick(datetime.now())
        except Exception as e:
            log.warning(f"定时检查出错：{e}")
        time.sleep(20)


# ---------- 接口 ----------
@app.get('/api/health')
def health():
    # 无需访问账号、配置或登录会话即可检查运行版本。
    return jsonify(panel_status())


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get('/api/browser-extension.zip')
def download_browser_extension():
    return send_file(extension_archive(), mimetype='application/zip', as_attachment=True,
                     download_name='shenqi-browser-assistant.zip')


@app.get("/api/state")
def state():
    cfg = core.load_config()
    return jsonify(config=cfg, history=core.read_json(core.HISTORY, [])[-30:][::-1],
                   recs=core.read_json(core.RECS, {}), job=JOB, busy=LOCK.locked(),
                   logs=list(LOGS)[-150:], platforms=core.PLATFORM_NAMES, accounts=ACCOUNTS.copy(),
                   auth=login_session().public(), official_entries=privacy_auth.OFFICIAL_ENTRIES,
                   auth_terms=privacy_auth.TERMS, server=panel_status(),
                   ordering=login_session().ordering.public(),
                   ordering_callback=request.host_url.rstrip('/') + '/api/ordering/oauth/callback')


@app.post("/api/config")
def save_config():
    body = json_body()
    core.update_config({k: body[k] for k in ("connection_mode", "device", "bark", "dry_run", "claim_coupons", "order",
                                           "guard", "schedule", "recommend") if k in body})
    return jsonify(ok=True)


@app.post("/api/meals")
def save_meals():
    body = json_body()
    if 'meals' not in body:
        raise ValueError('缺少安全清单')
    cfg = core.update_config({'meals': body['meals']})
    guard = core.make_guard(cfg)
    warn = [f"{m['name']}·{d}：{guard.check(d)[1]}" for m in cfg["meals"] for d in m["dishes"]
            if not guard.check(d)[0]]
    return jsonify(ok=True, warnings=warn)


@app.post("/api/guard/check")
def guard_check():
    names = json_body().get('names')
    if not isinstance(names, list) or any(not isinstance(n, str) for n in names):
        raise ValueError('请提供菜名列表')
    guard = core.make_guard(core.load_config())
    return jsonify([{"name": n, "ok": guard.check(n)[0], "reason": guard.check(n)[1]}
                    for n in names if n.strip()])


@app.post("/api/run/<name>")
def run(name):
    if name not in JOB_NAMES:
        return jsonify(ok=False, message="未知任务"), 400
    body = json_body(optional=True)
    if name == 'open_app' and (not isinstance(body.get('platform'), str)
                               or body['platform'] not in core.PLATFORM_NAMES):
        raise ValueError('请选择有效平台')
    if name == 'order' and 'meal' in body and not isinstance(body['meal'], str):
        raise ValueError('餐品名称必须是文字')
    if name == 'recommend':
        if 'deep' in body and not isinstance(body['deep'], bool):
            raise ValueError('进店读菜单必须是开关值')
        for key in ('keywords', 'platforms'):
            if key in body and (not isinstance(body[key], list) or not body[key]
                                or any(not isinstance(x, str) or not x.strip() for x in body[key])):
                raise ValueError('请填写关键词并选择平台')
        if any(p not in core.PLATFORM_NAMES for p in body.get('platforms', [])):
            raise ValueError('请选择有效平台')
    ok = start_job(name, **body)
    return jsonify(ok=ok, message="已开始" if ok else f"正在执行「{JOB_NAMES.get(JOB['name'])}」，请稍等")


@app.post("/api/test_push")
def test_push():
    ok = core.notify(core.load_config(), "外卖助手", "推送测试成功 🎉")
    return jsonify(ok=ok, message="已发送，看看 iPhone 有没有收到" if ok else "发送失败，检查 Bark key")


@app.post('/api/auth/meituan/send-sms')
def login_send_sms():
    current, body = auth_body(('phone', 'terms_accepted'))
    return jsonify(privacy_auth.AUTH.send_sms(current, body.get('phone'), body.get('terms_accepted')))


@app.post('/api/auth/meituan/verify')
def login_verify_sms():
    current, body = auth_body(('phone', 'sms_code'))
    return jsonify(privacy_auth.AUTH.verify_sms(current, body.get('phone'), body.get('sms_code')))


@app.post('/api/auth/check')
def login_check():
    current, _ = auth_body(())
    return jsonify(privacy_auth.AUTH.check(current))


@app.post('/api/auth/logout')
def login_logout():
    current, _ = auth_body(())
    return jsonify(privacy_auth.AUTH.logout(current))


@app.get('/api/auth/security-qr.png')
def login_security_qr():
    return Response(privacy_auth.AUTH.qr_image(login_session()), mimetype='image/png')


@app.get('/api/auth/security-page')
def login_security_page():
    current = login_session()
    with current.lock:
        current.public()
        if not current.challenge_url:
            raise privacy_auth.AuthError('当前没有美团官方验证页面', 404)
        return redirect(privacy_auth.AUTH.official_challenge(current.challenge_url), 303)


@app.get('/api/auth/official/<provider>')
def official_login(provider):
    entry = privacy_auth.OFFICIAL_ENTRIES.get(provider)
    if entry is None or request.query_string:
        raise privacy_auth.AuthError('不支持的官方登录入口', 404)
    # 打开官方页面不读取其 Cookie，也不更改本软件的授权状态。
    return redirect(entry['url'], 303)


@app.post('/api/ordering/configure')
def configure_ordering():
    current, body = auth_body(('app_id', 'app_secret', 'secret_sign'))
    callback = request.host_url.rstrip('/') + '/api/ordering/oauth/callback'
    current.ordering.configure(body, callback)
    return jsonify(ok=True, message='应用凭证仅在本机服务内存中保留两小时；下一步需在美团官方页面完成消费者授权。')


@app.post('/api/ordering/authorize')
def authorize_ordering():
    current, _ = auth_body(())
    url, guard = current.ordering.begin_authorization()
    response = jsonify(ok=True, url=url, message='请点击美团官方授权链接，由你本人确认权限。回调地址必须已在平台登记。')
    # 原会话 Cookie 为 Strict；专用 Lax Cookie 只用于绑定这次跨站 OAuth 回调。
    response.set_cookie('waimai_ordering_oauth', g.login_key + '.' + guard,
                        max_age=600, httponly=True, samesite='Lax', secure=request.is_secure,
                        path='/api/ordering/oauth/callback')
    return response


@app.get('/api/ordering/oauth/callback')
def ordering_callback():
    cookie = request.cookies.get('waimai_ordering_oauth', '')
    if len(cookie) > 256 or '.' not in cookie:
        raise meituan_ordering.OrderError('授权回调不属于当前浏览器，请从软件重新发起', 403)
    key, guard = cookie.split('.', 1)
    with privacy_auth.AUTH.lock:
        current = privacy_auth.AUTH.sessions.get(key)
    if current is None:
        raise meituan_ordering.OrderError('本机授权会话已过期，请重新发起', 403)
    current.ordering.complete_authorization(request.args.get('state'), guard, request.args.get('code'))
    g.login_cookie = key
    response = redirect('/', 303)
    response.delete_cookie('waimai_ordering_oauth', path='/api/ordering/oauth/callback')
    return response


@app.post('/api/ordering/logout')
def clear_ordering():
    current, _ = auth_body(())
    current.ordering.clear()
    return jsonify(ok=True, message='外卖应用密钥、消费者授权及本次订餐信息已从内存清除。')


@app.post('/api/ordering/shops')
def ordering_shops():
    current, body = auth_body(('longitude', 'latitude', 'keyword', 'consent'))
    rows = current.ordering.search(body.get('longitude'), body.get('latitude'), body.get('keyword'), body.get('consent'))
    return jsonify(ok=True, shops=rows)


@app.post('/api/ordering/menu')
def ordering_menu():
    current, body = auth_body(('shop_id',))
    rows = current.ordering.menu(body.get('shop_id'), core.make_guard(core.load_config()))
    return jsonify(ok=True, items=rows)


@app.post('/api/ordering/preview')
def preview_ordering():
    current, body = auth_body(('items', 'receiver', 'consent', 'food_confirmed'))
    cfg = core.load_config()
    quote = current.ordering.preview(body, cfg['order']['max_price'], core.make_guard(cfg))
    return jsonify(ok=True, quote=quote, message='这是平台订单预览，尚未创建订单或支付。请核对金额、规格和收货信息。')


@app.post('/api/ordering/submit')
def submit_ordering():
    current, body = auth_body(('ticket', 'confirmed'))
    cfg = core.load_config()
    return jsonify(current.ordering.submit(body.get('ticket'), body.get('confirmed'), cfg['dry_run'],
                   cfg['order']['max_price'], core.make_guard(cfg)))


@app.get('/api/ordering/payment')
def ordering_payment():
    ordering = login_session().ordering
    with ordering.lock:
        ordering.public()
        target = meituan_ordering.pay_url(ordering.payment)
        if not target:
            raise meituan_ordering.OrderError('没有可用的官方收银台，请到美团官方 App 核对订单', 404)
        return redirect(target, 303)


def run_panel():
    url = "http://127.0.0.1:8765"
    try:
        server = make_panel_server()
    except SystemExit:
        # 重复双击时打开原来的面板，不再启动第二组定时任务。
        try:
            import requests
            response = requests.get(url + '/api/health', timeout=2)
            state = response.json()
            if response.ok and state == panel_status():
                print(f'外卖助手已经运行：{url}')
                webbrowser.open(url)
                return
        except (requests.RequestException, ValueError):
            pass
        raise RuntimeError('端口 8765 上的后台不是当前版本。请关闭旧的外卖助手运行窗口，再重新启动；仅刷新网页不会加载新的登录模块。若没有旧窗口，请检查端口占用。') from None
    try:
        threading.Thread(target=scheduler, daemon=True).start()
        print(f"\n  外卖助手已启动：{url}\n  关掉这个窗口软件就会停止，定时任务也会停止。\n")
        webbrowser.open(url)
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    run_panel()
