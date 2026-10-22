"""Owner-only L5 web controller. The local desktop consumes a bounded file queue.

No Meituan cookies, credentials, addresses or Bark keys cross this boundary.
The host supplies its existing validated administrator session and CSRF check.
"""
import contextlib
import json
import os
import time
import uuid
from pathlib import Path

from flask import Blueprint, jsonify, redirect, request, send_from_directory

HERE = Path(__file__).resolve().parent


def install_shenqi(app, is_admin, csrf_token, bridge_dir=None):
    bridge = Path(bridge_dir or os.environ.get('SHENQI_BRIDGE_DIR') or
                  Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'ShenqiDesktop' / 'RemoteBridge')
    bp = Blueprint('shenqi', __name__, url_prefix='/shenqi')

    def read(name):
        try:
            path = bridge / name
            if path.stat().st_size > 65536:
                return {}
            value = json.loads(path.read_text(encoding='utf-8-sig'))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    @contextlib.contextmanager
    def locked():
        bridge.mkdir(parents=True, exist_ok=True)
        lock = bridge / 'bridge.lock'
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise ValueError('桌面正在同步，稍后重试；若持续出现，请在桌面核对连接。')
        try:
            os.close(fd)
            yield
        finally:
            lock.unlink(missing_ok=True)

    def status():
        value = read('status.json')
        now = int(time.time() * 1000)
        fresh = isinstance(value.get('updatedAt'), (int, float)) and 0 <= now - value['updatedAt'] <= 25000
        # Only explicitly enumerated display fields are allowed out of the desktop.
        allowed = ('version', 'enabled', 'ready', 'loginNeeded', 'busy', 'locked', 'stage',
                   'message', 'requestId', 'requestState', 'requestError', 'order')
        result = {k: value[k] for k in allowed if k in value}
        result.update(online=fresh, queued=(bridge / 'command.json').exists(),
                      unresolved=(bridge / 'claimed.json').exists())
        if not fresh:
            result['ready'] = False
        return result

    @bp.before_request
    def owner_only():
        if not is_admin():
            if request.path.startswith('/shenqi/api/'):
                return jsonify(ok=False, error='请使用 L5 管理员账号登录。', login='/admin/login?next=/shenqi/'), 401
            return redirect('/admin/login?next=/shenqi/')
        if request.method == 'POST':
            # Defense in depth; do not rely only on the host application's hook.
            import secrets
            from flask import session
            expected = session.get('csrf', '')
            supplied = request.headers.get('X-CSRF-Token', '')
            if not expected or not secrets.compare_digest(supplied, expected):
                return jsonify(ok=False, error='页面已过期，请刷新。'), 400
            origin = request.headers.get('Origin')
            if origin and origin != request.host_url.rstrip('/'):
                return jsonify(ok=False, error='请求来源不匹配。'), 403

    @bp.after_request
    def private(response):
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['X-Robots-Tag'] = 'noindex, nofollow'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return response

    @bp.get('/')
    def index():
        return send_from_directory(HERE / 'static', 'index.html')

    @bp.get('/assets/<name>')
    def assets(name):
        if name not in {'app.js', 'app.css', 'policy.js', 'guard-data.js'}:
            return '', 404
        directory = HERE / 'static'
        if name in {'policy.js', 'guard-data.js'} and not (directory / name).exists():
            directory = HERE.parent / 'desktop' / 'engine'
        return send_from_directory(directory, name)

    @bp.get('/api/status')
    def state():
        return jsonify(ok=True, status=status(), csrf=csrf_token())

    @bp.post('/api/command')
    def command():
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or data.get('kind') not in {'meal', 'stop'}:
            return jsonify(ok=False, error='不支持这个操作。'), 400
        kind = data['kind']
        try:
            request_id = str(uuid.UUID(data.get('id', '')))
            now = int(time.time() * 1000)
            issued = data.get('createdAt')
            if type(issued) is not int or not 0 <= now - issued + 5000 <= 65000:
                raise ValueError('本次请求已过期，请重新核对后发送。')
            if kind == 'meal':
                budget = data.get('budget')
                if type(budget) is not int or not 1 <= budget <= 100000:
                    raise ValueError('预算应为0.01至1000元。')
                if not isinstance(data.get('request'), str) or len(data['request']) > 160:
                    raise ValueError('需求文字过长。')
                if data.get('authorized') is not True:
                    raise ValueError('请先核对当前配送地址并授权本餐。')
            with locked():
                current = status()
                if current.get('requestId') == request_id:
                    return jsonify(ok=True, status=current, duplicate=True)
                queued = read('command.json' if kind == 'meal' else 'stop.json')
                if queued.get('id') == request_id:
                    return jsonify(ok=True, status=current, duplicate=True)
                if not current.get('online') or current.get('enabled') is not True:
                    raise ValueError('电脑上的神器未连接，或尚未启用远程控制。')
                if kind == 'meal':
                    if current.get('queued') or current.get('unresolved') or current.get('busy') or current.get('locked'):
                        raise ValueError('上一笔任务仍需核对，不能重复选餐。请查看桌面或官方订单。')
                    if not current.get('ready') or current.get('loginNeeded'):
                        raise ValueError('请先在电脑上的神器登录美团、核对配送地址并打开首页或商家菜单。')
                payload = {'version': 1, 'id': request_id, 'kind': kind, 'createdAt': issued, 'expiresAt': issued + 60000}
                if kind == 'meal':
                    payload.update(request=data['request'], budget=data['budget'], authorized=True)
                target = bridge / ('command.json' if kind == 'meal' else 'stop.json')
                # Exclusive creation is the idempotency boundary. Never overwrite.
                with target.open('x', encoding='utf-8') as out:
                    json.dump(payload, out, ensure_ascii=False)
            return jsonify(ok=True, queued=True, id=request_id), 202
        except (ValueError, TypeError, AttributeError, FileExistsError) as error:
            return jsonify(ok=False, error=str(error) or '已有一笔请求等待处理。'), 409

    app.register_blueprint(bp)

