(function (root) {
  'use strict';
  const rules = typeof module !== 'undefined' && module.exports ? require('./guard-data.js') : root.ShenqiGuardData;
  function cents(value) {
    const match = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) return null;
    const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(amount) ? amount : null;
  }
  function price(text) {
    const match = String(text).match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)(?![\d.])/);
    return match ? cents(match[1]) : null;
  }
  function inspectName(name) {
    for (const word of rules.HARD) if (name.includes(word)) return `含「${word}」，请换一道`;
    for (const word of rules.NEAR_QUALIFIED) {
      let start = 0, index;
      while ((index = name.indexOf(word, start)) !== -1) {
        if (!rules.SAFE.some(safe => name.slice(Math.max(0, index - 2), index).includes(safe))) return `「${word}」未注明来源`;
        start = index + 1;
      }
    }
    for (const word of rules.NAME_QUALIFIED) {
      if (name.includes(word) && !rules.SAFE.some(safe => name.includes(safe))) return `「${word}」需核对原料`;
    }
    return '';
  }
  function supported(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'h5.waimai.meituan.com'; }
    catch { return false; }
  }
  function checkPlan(items, budget) {
    if (!Number.isSafeInteger(budget) || budget <= 0) throw Error('请填写有效的预算上限');
    if (!items.length) throw Error('请先勾选菜品');
    let total = 0;
    for (const item of items) {
      if (item.blocked) throw Error(`${item.name}：${item.blocked}`);
      if (item.soldOut) throw Error(`${item.name}：当前已售罄`);
      if (!Number.isSafeInteger(item.cents) || item.cents < 0) throw Error(`${item.name}：价格无法核对`);
      if (!Number.isInteger(item.desired) || item.desired < 1 || item.desired > 10) throw Error('每道菜请选择 1–10 份');
      total += item.cents * item.desired;
    }
    if (!Number.isSafeInteger(total) || total > budget) throw Error('所选菜品已超过预算，请调整');
    return total;
  }
  const categories = {
    '奶茶': /奶茶|奶绿|奶青|珍珠奶|波霸奶|奶盖茶|轻乳茶|茶拿铁|鲜乳茶/,
    '咖啡': /咖啡|美式|拿铁|卡布奇诺|摩卡|浓缩|馥芮白/,
    '果茶': /果茶|柠檬茶|葡萄|杨枝甘露|多肉|满杯水果|莓莓|橙橙|桃桃/,
    '面条': /面条|拉面|拌面|汤面|刀削面|牛肉面|烩面|油泼面/,
    '米饭': /饭|盖浇|便当/,
    '鸡肉': /鸡肉|鸡腿|鸡排|鸡公煲|黄焖鸡/,
    '牛肉': /牛肉|牛腩|牛排/,
    '羊肉': /羊肉|羊排/,
    '轻食': /轻食|沙拉|蔬菜碗/,
  };
  function intent(value) {
    const input = String(value).trim();
    if (input.length > 160) throw Error('请用 160 字以内说明想吃什么');
    if (/不要用券|不用券|允许猪肉|吃猪肉|红烧肉/.test(input.replace(/不吃猪肉|不要猪肉|不想吃猪肉/g, ''))) throw Error('这与已保存的“不吃猪肉、必须用券”偏好冲突');
    const budgetMatch = input.match(/(?:预算|不超过|最多|上限)\s*(\d+(?:\.\d{1,2})?)\s*元?/);
    const quantityMatch = input.match(/([一二两三四五六七八九十]|\d+)\s*(?:杯|份|碗)(?!以)/);
    const chinese = {一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
    const quantity = quantityMatch ? chinese[quantityMatch[1]] || Number(quantityMatch[1]) : 1;
    if (quantity < 1 || quantity > 10) throw Error('本次支持 1–10 份');
    if (/(?:预算|不超过|最多|上限)/.test(input) && !budgetMatch) throw Error('预算请写成“预算30元”');
    const named=Object.keys(categories).filter(name=>input.includes(name));
    if(named.length>1 || /不(?:想)?(?:吃|喝)/.test(input.replace(/不(?:想)?吃猪肉/g,''))) throw Error('每次请说明一个想吃的品类；额外忌口请在官方配料中核对');
    const category = named[0] || (/奶绿|珍珠|轻乳茶|鲜乳茶/.test(input) ? '奶茶' : '');
    const residual = input.replace(/(?:预算|不超过|最多|上限)\s*\d+(?:\.\d{1,2})?\s*元?/g,'').replace(/([一二两三四五六七八九十]|\d+)\s*(?:杯|份|碗)/g,'').replace(/我想|我要|帮我|给我|今天|随机|随便|挑选|选|点|餐|吃|喝|来|一个|必须用券|用券|不要猪肉|不吃猪肉|不要肉|不想吃猪肉|[，。！、\s]/g,'');
    if (!category && residual && !['都行','什么都行'].includes(residual)) throw Error('暂不理解这句话。可写“我想喝奶茶，预算30元，一杯”，或直接点击随机选');
    const exclusions = [...input.matchAll(/(?:不要|不加)([^，。\s]{1,8})/g)].map(m=>m[1]).filter(x=>!['猪肉','肉'].includes(x));
    // Options such as sugar/ice are not silently treated as satisfied by a product name.
    if (/少糖|无糖|半糖|去冰|少冰|常温|热饮|不要肉/.test(input) || exclusions.length) throw Error('口味、冰量或额外忌口需要在官方规格中确认；请先仅输入品类、份数和预算');
    return {category, quantity, budget: budgetMatch ? cents(budgetMatch[1]) : null};
  }
  function randomPlan(menu, request, budget, random = Math.random) {
    const candidates = menu.filter(item => !item.blocked && !inspectName(item.name) && !item.soldOut && Number.isSafeInteger(item.cents) && item.cents >= 0 && item.cents * request.quantity <= budget && (!request.category || categories[request.category].test(item.name)) && (!['奶茶','果茶','咖啡'].includes(request.category) || !/挞|蛋糕|面包|曲奇|饼干|冰淇淋|雪糕|卷|套餐|礼盒/.test(item.name)));
    if (!candidates.length) throw Error(`已加载菜单没有符合${request.category || '忌口和预算'}的在售商品；请在官方页换分类或换店后重试。不会用甜点代替饮品`);
    const chosen = candidates[Math.min(candidates.length-1, Math.max(0, Math.floor(random()*candidates.length)))];
    const result = [{...chosen, desired:request.quantity}]; checkPlan(result,budget); return result;
  }
  function previewVerdict(total, budget, coupons) {
    if (total === null) return {ok:false,message:'未读到平台最终合计，无法判断是否在预算内'};
    if (!Number.isSafeInteger(budget) || budget <= 0) return {ok:false,message:'填写有效的本餐预算以核对金额'};
    if (total > budget) return {ok:false,message:'官方合计超过预算，请返回调整'};
    if (!coupons?.some(row=>row.discount > 0)) return {ok:false,message:'尚未确认优惠券实际抵扣，必须用券才可创建订单；配送立减不算用券'};
    return {ok:true,message:'已核对券实际抵扣，当前官方合计在预算内'};
  }
  const api = {cents, price, inspectName, supported, checkPlan, intent, randomPlan, previewVerdict, money: value => value === null ? '待核对' : `¥${(value / 100).toFixed(2)}`};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShenqiPolicy = api;
})(globalThis);
