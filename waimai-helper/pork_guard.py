"""防猪肉检查：宁可错杀，不可放过。

规则：
1. 命中明确含猪的词（HARD）→ 拦截
2. 出现"肉/里脊"但前两个字没注明是牛羊鸡鱼等 → 拦截（中餐里没说明的"肉"默认是猪肉）
3. 饺子、包子、馄饨、丸子、肠、汤底等常见猪肉载体，整个菜名里没注明其他肉类 → 拦截
"""

HARD = [
    "猪", "豚", "五花", "排骨", "小排", "肋排", "排条", "培根", "火腿", "叉烧",
    "腊肠", "腊肉", "腊味", "腊汁", "咸肉", "午餐肉", "肉松", "回锅", "红烧肉",
    "东坡", "扣肉", "锅包肉", "狮子头", "卤肉", "肘", "蹄", "肥肠", "大肠", "粉肠",
    "腰花", "血旺", "酥肉", "梅菜", "京酱", "鱼香", "木须", "珍珠丸", "油渣",
    "荤油", "皮冻", "肉皮", "白肉", "小炒肉", "咕噜", "鲜肉", "贡丸",
]

# 只看紧挨着的前两个字（如"牛肉"可以，"鲜肉""炒肉"不行）
NEAR_QUALIFIED = ["肉", "里脊"]

# 整个菜名里有其他肉类说明即可（如"牛肉水饺"可以，"三鲜水饺"不行）
NAME_QUALIFIED = [
    "饺", "包子", "馄饨", "抄手", "云吞", "烧卖", "烧麦", "小笼", "生煎", "锅贴",
    "丸", "肠", "骨汤", "高汤", "汤底", "臊子", "浇头", "馅", "卤",
]

SAFE = ["牛", "羊", "鸡", "鸭", "鹅", "鱼", "虾", "蟹", "贝", "鱿", "墨", "鳗",
        "驴", "兔", "鸽", "素", "斋", "菌", "清真"]


class PorkGuard:
    def __init__(self, extra_block=(), allow=(), ignore=()):
        self.hard = HARD + list(extra_block)
        self.allow = list(allow)
        self.ignore = list(ignore)

    def check(self, text):
        """返回 (是否安全, 原因)"""
        t = text
        for a in self.allow:
            t = t.replace(a, "")
        for w in self.hard:
            if w in t:
                return False, f"含「{w}」"
        for w in NEAR_QUALIFIED:
            start = 0
            while (i := t.find(w, start)) != -1:
                if not any(s in t[max(0, i - 2):i] for s in SAFE):
                    return False, f"「{w}」没注明是什么肉，默认按猪肉处理"
                start = i + 1
        for w in NAME_QUALIFIED:
            if w in t and not any(s in t for s in SAFE):
                return False, f"「{w}」类常用猪肉，且未注明其他肉类"
        return True, ""

    def scan(self, texts):
        """扫描一组页面文字，返回所有可疑项 [(文字, 原因)]"""
        hits = []
        for x in texts:
            if any(ig in x for ig in self.ignore):
                continue
            ok, why = self.check(x)
            if not ok:
                hits.append((x, why))
        return hits
