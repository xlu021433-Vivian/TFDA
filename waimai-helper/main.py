"""命令行入口（软件面板请用 app.py / 启动脚本）。

  python main.py run [--meal 牛肉面]   领券 + 下单
  python main.py coupons              只领券
  python main.py recommend [--deep]   抓取推荐
  python main.py dump                 打印当前屏幕文字（校准用）
  python main.py check 菜名 ...        测试防猪肉规则
"""
import argparse
import logging
import xml.etree.ElementTree as ET

import core

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run").add_argument("--meal")
    sub.add_parser("coupons")
    sub.add_parser("recommend").add_argument("--deep", action="store_true")
    sub.add_parser("dump")
    sub.add_parser("check").add_argument("names", nargs="+")
    a = ap.parse_args()
    cfg = core.load_config()

    if a.cmd == "run":
        print(core.run_order(cfg, a.meal)["message"])
    elif a.cmd == "coupons":
        print(core.run_coupons(cfg)["message"])
    elif a.cmd == "recommend":
        import recommender
        print(recommender.run_recommend(cfg, deep=a.deep or None)["message"])
    elif a.cmd == "dump":
        d = core.get_engine(cfg).d
        for n in ET.fromstring(d.dump_hierarchy()).iter("node"):
            if n.get("text") or n.get("content-desc"):
                print(f"text={n.get('text')!r:30} desc={n.get('content-desc')!r}  id={n.get('resource-id')}")
    elif a.cmd == "check":
        g = core.make_guard(cfg)
        for n in a.names:
            ok, why = g.check(n)
            print(f"{'✅ 安全' if ok else '🚫 拦截'}  {n}  {why}")
