"""官方账号入口及美团短信授权。凭证只在当前进程内保留，不读取用户资料。"""
import hashlib
import hmac
import io
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import requests
from meituan_ordering import WaimaiSession

OFFICIAL_BASE = 'https://peppermall.meituan.com'
SMS_SEND = '/eds/claw/login/sms/code/get'
SMS_VERIFY = '/eds/claw/login/sms/code/verify'
TOKEN_VERIFY = '/eds/claw/login/token/verify'
TERMS = [
    {'name': '美团红包助手服务规则', 'url': 'https://open-pepper.meituan.com/eds/rules/meituan-coupon-skill-service-rule.html'},
    {'name': '美团用户服务协议', 'url': 'https://rules-center.meituan.com/rule-detail/4/1'},
    {'name': '美团隐私政策', 'url': 'https://rules-center.meituan.com/m/detail/guize/2'},
]
OFFICIAL_ENTRIES = {
    'meituan': {'name': '美团官方登录', 'url': 'https://passport.meituan.com/useraccount/ilogin',
                'methods': '手机号、微信快捷登录（以官方页面为准）'},
    'taobao': {'name': '淘宝官方登录', 'url': 'https://login.taobao.com/member/login.jhtml',
              'methods': '淘宝扫码、手机号及其他官方提供的方式'},
    'alipay': {'name': '支付宝官方登录', 'url': 'https://auth.alipay.com/login/index.htm',
              'methods': '支付宝扫码或官方账号登录'},
    'shangou': {'name': '淘宝闪购官网', 'url': 'https://taobaoshangou.ele.me/',
               'methods': '查看平台提供的消费者入口'},
}


class AuthError(Exception):
    """消息只能使用预定义文字，不包含原始请求、响应或凭证。"""
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


@dataclass(repr=False)
class LoginSession:
    csrf: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    device: str = field(default_factory=lambda: secrets.token_hex(16))
    digest_key: bytes = field(default_factory=lambda: secrets.token_bytes(32))
    created: float = field(default_factory=time.time)
    token: str = ''
    authenticated: float = 0
    pending_digest: str = ''
    pending_until: float = 0
    retry_after: float = 0
    attempts: int = 0
    challenge_url: str = ''
    terms_accepted: bool = False
    expiry_timer: object = None
    lock: object = field(default_factory=threading.RLock)
    ordering: object = field(default_factory=WaimaiSession)

    def digest(self, phone):
        return hmac.new(self.digest_key, phone.encode('ascii'), hashlib.sha256).hexdigest()

    def clear_credentials(self):
        if self.expiry_timer is not None:
            self.expiry_timer.cancel()
            self.expiry_timer = None
        self.token = ''
        self.authenticated = 0
        self.pending_digest = ''
        self.pending_until = 0
        self.challenge_url = ''
        self.attempts = 0

    def expire_auth(self, authenticated):
        with self.lock:
            if self.authenticated == authenticated:
                self.clear_credentials()

    def public(self):
        with self.lock:
            now = time.time()
            if self.authenticated and now - self.authenticated >= 7200:
                self.clear_credentials()
            if self.pending_until and now >= self.pending_until:
                self.pending_digest = ''
                self.pending_until = 0
                self.challenge_url = ''
            return {
                'connected': bool(self.token), 'csrf': self.csrf,
                'pending': bool(self.pending_digest), 'retry_after': max(0, int(self.retry_after - now + 0.99)),
                'security_required': bool(self.challenge_url),
                'capabilities': {'login': True, 'recommend': False, 'coupons': False, 'order': False},
                'storage': 'memory_only',
            }


class PrivacyAuth:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.RLock()
        self.sms_retry_after = 0

    def session(self, cookie):
        with self.lock:
            now = time.time()
            for key, value in list(self.sessions.items()):
                if now - value.created > 8 * 3600:
                    value.clear_credentials()
                    value.ordering.clear()
                    del self.sessions[key]
            if isinstance(cookie, str) and cookie in self.sessions:
                return cookie, self.sessions[cookie]
            if len(self.sessions) >= 64:
                raise AuthError('本机登录会话过多，请关闭多余页面后重启软件', 429)
            key = secrets.token_urlsafe(32)
            value = LoginSession()
            self.sessions[key] = value
            return key, value

    @staticmethod
    def validate_phone(phone):
        if not isinstance(phone, str) or not re.fullmatch(r'1[3-9]\d{9}', phone):
            raise AuthError('请填写完整的 11 位中国大陆手机号')

    @staticmethod
    def official_challenge(url):
        if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 32 for c in url):
            raise AuthError('平台返回了无效的验证地址', 502)
        parsed = urlsplit(url)
        try:
            valid_port = parsed.port in (None, 443)
        except ValueError:
            valid_port = False
        host = parsed.hostname or ''
        if (parsed.scheme != 'https' or parsed.username or parsed.password or not valid_port
                or not (host == 'meituan.com' or host.endswith('.meituan.com'))):
            raise AuthError('验证地址不是美团官方 HTTPS 地址，已停止跳转', 502)
        return url

    @staticmethod
    def _post(path, *, body=None, params=None):
        if path not in (SMS_SEND, SMS_VERIFY, TOKEN_VERIFY):
            raise AuthError('不支持的授权操作')
        # 不读浏览器 Cookie、不沿用环境中的代理、不跟随跳转、不关闭 TLS 校验。
        try:
            with requests.Session() as client:
                client.trust_env = False
                response = client.post(OFFICIAL_BASE + path, json=body, params=params,
                                       timeout=(5, 10), allow_redirects=False, verify=True)
                if not response.ok or response.is_redirect:
                    raise AuthError('美团官方授权服务暂时不可用，请稍后重试', 502)
                data = response.json()
        except (requests.RequestException, ValueError):
            raise AuthError('无法连接美团官方授权服务，请检查网络后重试', 502) from None
        if not isinstance(data, dict) or type(data.get('code')) is not int:
            raise AuthError('美团官方授权服务返回了无效结果', 502)
        return data

    def send_sms(self, session, phone, consent):
        self.validate_phone(phone)
        if consent is not True:
            raise AuthError('请先阅读协议并确认仅向美团官方发送本次登录信息')
        with session.lock:
            session.public()
            if session.token:
                raise AuthError('本次运行已经授权，请先清除授权后再切换账号')
            now = time.time()
            with self.lock:
                if now < max(session.retry_after, self.sms_retry_after):
                    raise AuthError('验证码请求过于频繁，请等待一分钟后重试', 429)
                session.retry_after = now + 60
                self.sms_retry_after = now + 60
            session.pending_digest = ''
            session.challenge_url = ''
            session.terms_accepted = True
            result = self._post(SMS_SEND, body={'mobile': phone, 'uuid': session.device})
            code = result['code']
            if code in (0, 20010):
                challenge = ''
                if code == 20010:
                    data = result.get('data')
                    if not isinstance(data, dict) or not data.get('redirectUrl'):
                        raise AuthError('美团要求安全验证，但未提供有效验证页面，请稍后重试', 502)
                    challenge = self.official_challenge(data['redirectUrl'])
                session.pending_digest = session.digest(phone)
                session.pending_until = time.time() + 300
                session.attempts = 0
                session.challenge_url = challenge
                return {'ok': True, 'security_required': bool(challenge),
                        'message': '请在美团官方页面完成安全验证，再输入收到的短信验证码' if challenge else '验证码已由美团发送，请在有效期内完成验证'}
            messages = {
                20001: '美团短信服务暂时不可用，请稍后重试',
                20002: '美团已发送验证码，请稍后重试',
                20004: '该手机号尚未注册美团，请先在美团 App 中注册',
                20006: '该手机号今日验证码次数已达平台上限',
                20007: '美团短信服务今日次数已达上限',
            }
            raise AuthError(messages.get(code, '美团未能发送验证码，请稍后重试'), 429 if code in (20002, 20006, 20007) else 400)

    def verify_sms(self, session, phone, sms_code):
        self.validate_phone(phone)
        if not isinstance(sms_code, str) or not re.fullmatch(r'\d{4,8}', sms_code):
            raise AuthError('请填写短信验证码')
        with session.lock:
            session.public()
            if (not session.terms_accepted or not session.pending_digest
                    or not hmac.compare_digest(session.pending_digest, session.digest(phone))):
                raise AuthError('登录请求已过期或手机号已改变，请重新获取验证码')
            if session.attempts >= 5:
                raise AuthError('验证次数过多，请重新获取验证码', 429)
            session.attempts += 1
            result = self._post(SMS_VERIFY, body={'mobile': phone, 'smsVerifyCode': sms_code, 'uuid': session.device})
            if result['code'] != 0:
                raise AuthError('短信验证码错误或已过期，请重新获取' if result['code'] == 20003
                                else '美团未完成本次授权，请稍后重试', 400)
            data = result.get('data')
            token = data.get('token') if isinstance(data, dict) else None
            if not isinstance(token, str) or not token or len(token) > 8192:
                raise AuthError('美团未返回有效授权凭证，本次登录未完成', 502)
            session.token = token
            session.authenticated = time.time()
            session.expiry_timer = threading.Timer(7200, session.expire_auth, args=(session.authenticated,))
            session.expiry_timer.daemon = True
            session.expiry_timer.start()
            session.pending_digest = ''
            session.pending_until = 0
            session.challenge_url = ''
            return {'ok': True, 'message': '美团官方授权成功；凭证仅在本次运行的内存中保留'}

    def check(self, session):
        with session.lock:
            session.public()
            if not session.token:
                return {'ok': True, 'connected': False, 'message': '当前没有本软件的美团授权'}
            result = self._post(TOKEN_VERIFY, params={'token': session.token})
            if result['code'] == 20005:
                session.clear_credentials()
                return {'ok': True, 'connected': False, 'message': '美团授权已失效，请重新登录'}
            if result['code'] != 0:
                raise AuthError('美团暂时无法验证授权状态，请稍后重试', 502)
            return {'ok': True, 'connected': True, 'message': '本软件的美团官方授权仍然有效'}

    def logout(self, session):
        with session.lock:
            session.clear_credentials()
            session.ordering.clear()
            session.device = secrets.token_hex(16)
            session.digest_key = secrets.token_bytes(32)
            session.csrf = secrets.token_urlsafe(32)
            session.terms_accepted = False
            return {'ok': True, 'message': '本软件内存中的授权与验证信息已清除；官方网页的登录状态由浏览器管理'}

    def qr_image(self, session):
        with session.lock:
            session.public()
            if not session.challenge_url:
                raise AuthError('当前没有美团官方安全验证二维码', 404)
            url = self.official_challenge(session.challenge_url)
        import qrcode
        output = io.BytesIO()
        qrcode.make(url).save(output, format='PNG')
        return output.getvalue()


AUTH = PrivacyAuth()
