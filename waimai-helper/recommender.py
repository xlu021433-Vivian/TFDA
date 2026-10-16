"""自动抓取推荐：在 App 里按关键词搜索 → 读取屏幕上的店铺、优惠、菜品 → 防猪肉过滤 → 按优惠力度排序。

只读取你自己设备屏幕上显示的内容，不调用平台接口。
"""
import json
import logging
import re
import time
from datetime import datetime

import core

log = logging.getLogger("recommend")

PRICE = re.compile(r"^[¥￥]\s*\d+(\.\d+)?$|^\d+(\.\d+)?元$")
SALES = re.compile(r"(月售|已售|销量)\s*\d")
DEAL = re.compile(r"满\s*(\d+)\s*减\s*(\d+)")
NOT_NAME = re.compile(
    r"月售|已售|销量|分钟|起送|配送|km|公里|\d+m$|评分|^\d+(\.\d+)?分?$|[¥￥]|满\d|减\d|"
    r"折|券|红包|会员|广告|休息|距离|人均|超过|好评|推荐|^\d+$|^.{0,1}$"
)


def name_like(t):
    t = t.strip()
    return 2 <= len(t) <= 30 and not NOT_NAME.search(t)


def parse_shops(texts):
    """把搜索结果页的文字列表解析成店铺卡片。以「月售」为锚点往前找店名。"""
    anchors = [i for i, t in enumerate(texts) if SALES.search(t)]
    boundaries = []
    previous_anchor = -1
    for a in anchors:
        name_idx = None
        for j in range(a - 1, max(previous_anchor, a - 6), -1):
            if name_like(texts[j]):
                name_idx = j
                break
        previous_anchor = a
        if name_idx is None:
            continue
        boundaries.append(name_idx)
    shops = []
    for k, name_idx in enumerate(boundaries):
        end = boundaries[k + 1] if k + 1 < len(boundaries) else len(texts)
        seg = texts[name_idx + 1:end]
        shops.append({
            "shop": texts[name_idx].strip(),
            "deals": sorted({(int(x), int(y)) for t in seg for x, y in DEAL.findall(t)}),
            "dishes": parse_dishes(seg),
        })
    # 下一个店名可能被算进上一段的菜品里，去掉
    names = {s["shop"] for s in shops}
    for s in shops:
        s["dishes"] = [d for d in s["dishes"] if d not in names]
    return shops


def parse_dishes(texts):
    """菜名 = 后面 3 个文字以内出现价格的「像名字」的文字。"""
    out = []
    for i, t in enumerate(texts):
        if name_like(t) and any(PRICE.match(x.strip()) for x in texts[i + 1:i + 4]):
            if t.strip() not in out:
                out.append(t.strip())
    return out


def deal_score(deals):
    """最划算的满减比例，如 满30减15 → 0.5"""
    return max((y / x for x, y in deals if x), default=0)


def merge(into, shops):
    for s in shops:
        cur = into.get(s["shop"])
        if not cur:
            into[s["shop"]] = s
        else:
            cur["deals"] = sorted(set(map(tuple, cur["deals"])) | set(map(tuple, s["deals"])))
            cur["dishes"] += [d for d in s["dishes"] if d not in cur["dishes"]]


def _scroll_collect(engine, times, parser):
    found = {}
    for n in range(times + 1):
        merge(found, parser(engine.texts()))
        if n < times:
            engine.d.swipe_ext("up", scale=0.75)
            engine.pause(1.2, 2.2)
    return found


def browse(engine, sel, platform, keyword, address="", scrolls=3):
    p = sel[platform]
    engine.run_flow(p["flows"]["search"], {"package": p["package"], "keyword": keyword, "address": address},
                    f"{p['name']}搜索 {keyword}")
    return _scroll_collect(engine, scrolls, parse_shops)


def read_menu(engine, sel, platform, shop, address="", scrolls=4):
    p = sel[platform]
    engine.run_flow(p["flows"]["open_shop"],
                    {"package": p["package"], "shop": shop, "keyword": shop, "address": address},
                    f"进店 {shop}")
    dishes = []
    deals = set()
    for n in range(scrolls + 1):
        texts = engine.texts()
        dishes += [d for d in parse_dishes(texts) if d not in dishes]
        deals |= {(int(x), int(y)) for t in texts for x, y in DEAL.findall(t)}
        if n < scrolls:
            engine.d.swipe_ext("up", scale=0.7)
            engine.pause(1.0, 2.0)
    return dishes, sorted(deals)


def classify(guard, shop):
    ok_shop, why_shop = guard.check(shop["shop"])
    safe, blocked = [], []
    for d in shop["dishes"]:
        ok, why = guard.check(d)
        (safe if ok else blocked).append(d if ok else {"dish": d, "reason": why})
    halal = "清真" in shop["shop"]
    deals = sorted({tuple(x) for x in shop["deals"]}, key=lambda d: (d[1] / d[0] if d[0] else 0, d[1]))
    score = deal_score(deals) * 100 + min(len(safe), 5) * 3 + (15 if halal else 0)
    return {**shop, "deals": [list(x) for x in deals],  # 最后一个是最划算的
            "shop_ok": ok_shop, "shop_reason": why_shop, "halal": halal,
            "safe": safe if ok_shop else [], "blocked": blocked,
            "best_deal": round(deal_score(deals), 2), "score": round(score if ok_shop else -1, 1)}


def run_recommend(cfg, keywords=None, platforms=None, deep=None):
    rc = cfg.get("recommend", {})
    keywords = rc.get("keywords", []) if keywords is None else keywords
    platforms = rc.get("platforms", ["meituan", "eleme"]) if platforms is None else platforms
    if (not isinstance(keywords, list) or not keywords
            or any(not isinstance(k, str) or not k.strip() for k in keywords)):
        return {'ok': False, 'message': '请至少填写一个搜索关键词'}
    if (not isinstance(platforms, list) or not platforms
            or any(not isinstance(p, str) or p not in core.PLATFORM_NAMES for p in platforms)):
        return {'ok': False, 'message': '请至少选择一个有效平台'}
    deep = rc.get("deep", False) if deep is None else deep
    max_shops = rc.get("max_shops", 5)
    address = (rc.get("address") or cfg.get("order", {}).get("address") or "").strip()

    sel = core.load_selectors()
    guard = core.make_guard(cfg)
    engine = core.get_engine(cfg)
    known = {(m["platform"], m["shop"]) for m in cfg.get("meals", [])}
    results = []
    failures = []
    searches_completed = 0

    for p in platforms:
        found = {}
        for kw in keywords:
            try:
                merge(found, list(browse(engine, sel, p, kw, address).values()))
                searches_completed += 1
            except Exception as e:
                log.warning(f"{p} 搜索「{kw}」失败：{e}")
                failures.append(f'{core.PLATFORM_NAMES[p]} 搜索「{kw}」失败：{e}')
        shops = [classify(guard, s) for s in found.values()]
        shops.sort(key=lambda s: s["score"], reverse=True)

        if deep:  # 进店读取完整菜单（较慢）
            for s in [x for x in shops if x["shop_ok"]][:max_shops]:
                try:
                    dishes, deals = read_menu(engine, sel, p, s["shop"], address)
                    s.update(classify(guard, {"shop": s["shop"], "dishes": dishes,
                                              "deals": set(map(tuple, s["deals"])) | set(deals)}))
                except Exception as e:
                    log.warning(f"读取 {s['shop']} 菜单失败：{e}")
                    failures.append(f"读取 {s['shop']} 菜单失败：{e}")
            shops.sort(key=lambda s: s["score"], reverse=True)

        for s in shops:
            s["platform"] = p
            s["in_list"] = (p, s["shop"]) in known
        results += shops

    if not searches_completed:
        return {'ok': False, 'message': '抓取失败，已保留上次推荐。' + '；'.join(failures),
                'errors': failures}
    results.sort(key=lambda s: s["score"], reverse=True)
    data = {"time": datetime.now().strftime("%Y-%m-%d %H:%M"), "keywords": keywords,
            "address": address, "shops": results, "errors": failures}
    core.write_text_atomic(core.RECS, json.dumps(data, ensure_ascii=False, indent=1))
    good = [s for s in results if s["shop_ok"] and s["safe"]]
    msg = f"抓到 {len(results)} 家店，其中 {len(good)} 家有规则判定安全的菜"
    if good:
        top = good[0]
        msg += f"；优惠最好：{top['shop']}" + (f"（满{top['deals'][-1][0]}减{top['deals'][-1][1]}）" if top["deals"] else "")
    if failures:
        msg += f'；部分抓取失败（{len(failures)} 项），详情见推荐页'
    core.notify(cfg, "今日推荐已更新", msg)
    return {"ok": not failures, "message": msg, "errors": failures}
