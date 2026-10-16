"""Local, explicitly paired notification bridge. Never exports the Bark device key."""
import hmac
import re
import secrets
import threading
from urllib.parse import urlsplit

from flask import jsonify, request

import core

TOKEN_PATH = core.DATA / 'browser-notification-token.txt'
EXTENSION_ORIGIN = re.compile(r'chrome-extension://[a-p]{32}')
TOKEN_LOCK = threading.Lock()


def token():
    with TOKEN_LOCK:
        if not TOKEN_PATH.exists():
            core.write_text_atomic(TOKEN_PATH, secrets.token_hex(32))
        value = TOKEN_PATH.read_text('utf-8').strip()
    if not re.fullmatch(r'[a-f0-9]{64}', value):
        raise ValueError('通知连接码无效，请重新配对')
    return value


def register(app):
    @app.post('/api/extension/pairing')
    def pairing():
        if request.headers.get('Origin') != request.host_url.rstrip('/'):
            return jsonify(ok=False, message='请在本机助手页面生成连接码'), 403
        key = str(core.load_config()['bark']['key']).strip()
        return jsonify(ok=True, token=token(), bark_configured=bool(key and '在这里' not in key))

    @app.route('/api/browser-events', methods=['POST', 'OPTIONS'])
    def browser_event():
        origin = request.headers.get('Origin', '')
        if origin and not EXTENSION_ORIGIN.fullmatch(origin):
            return jsonify(ok=False, message='通知仅接受已配对的浏览器扩展'), 403
        if request.method == 'OPTIONS':
            return '', 204
        if not hmac.compare_digest(request.headers.get('X-Shenqi-Notify-Token', ''), token()):
            return jsonify(ok=False, message='通知连接码无效'), 401
        body = request.get_json(silent=True) or {}
        kind = body.get('kind')
        if kind == 'unpaid':
            number, amount, url = body.get('orderId'), body.get('total'), body.get('url')
            if (not isinstance(number, str) or not re.fullmatch(r'[A-Za-z0-9-]{8,40}', number)
                    or type(amount) is not int or not 0 <= amount <= 100000
                    or not isinstance(url, str)):
                return jsonify(ok=False, message='订单信息无效'), 400
            parsed = urlsplit(url)
            if (parsed.scheme != 'https' or parsed.netloc != 'h5.waimai.meituan.com'
                    or not re.search(r'/(order-detail|orderdetail|cashier|pay)(/|$)', parsed.path)):
                return jsonify(ok=False, message='非官方订单链接'), 400
            title = '神器 · 外卖待支付'
            text = f'订单号：{number}\n待支付：¥{amount / 100:.2f}\n请在平台有效期内付款。'
        elif kind in ('attention', 'test'):
            title = '神器 · 通知测试' if kind == 'test' else '神器 · 点餐需处理'
            text = str(body.get('message', ''))[:220]
            url = None
        else:
            return jsonify(ok=False, message='通知类型无效'), 400
        delivered = core.notify(core.load_config(), title, text, url=url, urgent=kind != 'test')
        return jsonify(ok=True, delivered=delivered)

    @app.after_request
    def extension_cors(response):
        if request.path == '/api/browser-events':
            origin = request.headers.get('Origin', '')
            if EXTENSION_ORIGIN.fullmatch(origin):
                response.headers['Access-Control-Allow-Origin'] = origin
                response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
                response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Shenqi-Notify-Token'
                response.headers['Vary'] = 'Origin'
        return response
