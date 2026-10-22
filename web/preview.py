"""Loopback-only visual preview with an isolated, disconnected desktop bridge."""
import argparse
import secrets
from pathlib import Path
from flask import Flask, session
from waitress import serve
from l5_plugin import install_shenqi

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8768)
    args = parser.parse_args()
    if not args.data_dir.resolve().is_relative_to(Path(__file__).resolve().parents[1] / 'dist'):
        raise SystemExit('Preview data must be isolated inside dist/.')
    app = Flask(__name__)
    app.secret_key = secrets.token_hex(32)
    install_shenqi(app, lambda: True, lambda: session.setdefault('csrf', secrets.token_hex(16)), args.data_dir)
    @app.after_request
    def preview_label(response):
        if response.mimetype == 'text/html':
            response.direct_passthrough = False
            response.set_data(response.get_data().replace('仅管理员可见'.encode(), '本地界面预览 · 未连接点餐'.encode()))
        return response
    serve(app, host='127.0.0.1', port=args.port, threads=2)
