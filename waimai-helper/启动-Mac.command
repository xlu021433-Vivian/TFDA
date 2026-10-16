#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "第一次启动，正在安装依赖，大约需要 1-2 分钟..."
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import flask, yaml, requests, uiautomator2, qrcode; from importlib.metadata import version; assert int(version("flask").split(".")[0]) >= 3; assert int(version("uiautomator2").split(".")[0]) >= 3; assert 8 <= int(version("qrcode").split(".")[0]) < 9'; then
  .venv/bin/python -m ensurepip --upgrade
  .venv/bin/python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
fi
.venv/bin/python app.py
