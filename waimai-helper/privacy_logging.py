"""日志仅展示已脱敏的诊断信息，不输出登录请求或授权凭证。"""
import logging
import re

PHONE = re.compile(r'(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)')
SECRET = re.compile(r'''(?ix)(["']?(?:access_token|user_token|device_token|refresh_token|token|pay_token|secret_sign|app_secret|sign|state|smsVerifyCode|sms_code|code|password|secret|appsecret|csrf|csrf_token|authorization|cookie)["']?\s*[:=]\s*)["']?[^\s&,'"\}\]]+''')


def redact(text):
    text = PHONE.sub(r'\1****\3', str(text))
    return SECRET.sub(r'\1[已隐藏]', text)


class PrivacyFilter(logging.Filter):
    def filter(self, record):
        record.msg = redact(record.getMessage())
        record.args = ()
        if record.exc_info:
            # 只保留异常类别，避免异常对象的 URL 或响应内容包含凭证。
            record.msg += '（' + record.exc_info[0].__name__ + '）'
            record.exc_info = None
            record.exc_text = None
        return True
