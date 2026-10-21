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
    '面条': /面条|拉面|拌面|汤面|刀削面|牛肉面|烩面|油泼面|河粉|米粉|米线|粉丝|螺蛳粉/,
    '米饭': /饭|盖浇|便当/,
    '鸡肉': /鸡肉|鸡腿|鸡排|鸡公煲|黄焖鸡/,
    '牛肉': /牛肉|牛腩|牛排/,
    '羊肉': /羊肉|羊排/,
    '轻食': /轻食|沙拉|蔬菜碗/,
  };
  function number(value) {
    if (/^\d+(?:\.\d{1,2})?$/.test(value)) return Number(value);
    const digits={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
    if(value==='十')return 10;
    if(value.includes('十')){const [a,b]=value.split('十');return (a?digits[a]:1)*10+(b?digits[b]:0);}
    return digits[value];
  }
  const optionPatterns={
    sugar:{'少糖':/少糖|三分糖|3分糖/,'半糖':/半糖|五分糖|5分糖/,'无糖':/无糖|不加糖|不要糖|零糖|0糖/,'全糖':/全糖|正常糖/},
    temperature:{'去冰':/去冰|不要冰|不加冰/,'少冰':/少冰/,'常温':/常温/,'热':/热饮|热的|热(?=奶茶|咖啡)/,'正常冰':/正常冰|标准冰/},
    size:{'大杯':/大杯/,'中杯':/中杯/,'小杯':/小杯/}
  };
  function intent(value) {
    let input=String(value).normalize('NFKC').trim();
    if(input.length>160)throw Error('请用 160 字以内说明想吃什么');
    input=input.replace(/(?:不喜欢|讨厌|不爱|不想|不)?吃猪肉|不要猪肉|别放猪肉/g,match=>match==='吃猪肉'?match:'');
    if(/不用券|不要用券|不使用优惠券|允许猪肉|吃猪肉/.test(input))throw Error('这与“不吃猪肉、必须用券”偏好冲突');
    const n='(?:\\d+(?:\\.\\d{1,2})?|[零一二两三四五六七八九十]{1,3})';
    const budgetPattern=new RegExp('(?:预算(?:是|为|在)?|不超过|不能超过|最多|上限|控制在)\\s*('+n+')\\s*(?:元|块钱|块)?|('+n+')\\s*(?:元|块钱|块)\\s*(?:以内|以下|预算)?','g');
    const budgets=[...input.matchAll(budgetPattern)].map(m=>number(m[1]||m[2]));
    if(budgets.some(x=>!Number.isFinite(x)||x<=0||x>1000)||new Set(budgets).size>1)throw Error('请说明一个明确预算，范围0.01至1000元');
    input=input.replace(budgetPattern,'');
    if(/预算|不超过|最多|上限|控制在/.test(input))throw Error('预算未识别，可写“25元以内”或“预算二十五元”');
    const quantityPattern=new RegExp('('+n+')\\s*(?:杯|份|碗)(?!以)','g');
    const amounts=[...input.matchAll(quantityPattern)].map(m=>number(m[1]));
    if(amounts.length>1||amounts.some(x=>!Number.isInteger(x)||x<1||x>10))throw Error('每次请选择一种餐品，共1–10份；组合餐请分开点');
    input=input.replace(quantityPattern,'');
    const options={};
    for(const [group,values] of Object.entries(optionPatterns))for(const [label,regex] of Object.entries(values)){
      if(regex.test(input)){if(options[group]&&options[group]!==label)throw Error('同一规格有多个要求，请保留一种');options[group]=label;input=input.replace(new RegExp(regex.source,'g'),'');}
    }
    if(/不要|不加|不放|别放|不想吃|不想喝|不吃|不喝|忌口|过敏|不要肉|少辣|微辣|不辣/.test(input))throw Error('额外配料或辣度要求需要在官方规格中核对；支持明确糖度、冰量和杯型');
    if(/或者|还是|以及|加上|和|与|再来|另外/.test(input))throw Error('每次请说明一种餐品，例如“牛肉饭一份”或“奶茶两杯”');
    input=input.replace(/请|麻烦|帮我|给我|我想要|我想|想要|想吃|想喝|我要|我|今天|中午|午餐|晚餐|早餐|来点|来个|来|点一[个下]|点|吃|喝|买|推荐|挑选|选择|选|必须使用优惠券|必须用券|使用优惠券|用优惠券|优惠券|用券|含配送费|含配送|含包装|券后|总共|一共|随机|随便|什么都行|都可以|都行|正餐|一个|一下|就好|吧|呀|啊|的|[,，。！!、:：;；?？\s]/g,'');
    const drinks=Object.keys(categories).filter(x=>['奶茶','咖啡','果茶'].includes(x)&&categories[x].test(input));
    // A protein and a staple describe one dish; tea-latte belongs to milk tea, not coffee.
    const category=drinks.includes('奶茶')?'奶茶':drinks[0]||(/饭|便当|盖浇/.test(input)?'米饭':/面|粉|米线|馄饨/.test(input)?'面条':Object.keys(categories).find(x=>categories[x].test(input))||'');
    if(drinks.length>1&&!/茶拿铁/.test(input))throw Error('每次请说明一种饮品');
    if(inspectName(input))throw Error('餐品触发不吃猪肉或肉类来源核对规则：'+inspectName(input));
    const result={category,quantity:amounts[0]||1,budget:budgets.length?Math.round(budgets[0]*100):null};
    const generic=['奶茶','咖啡','果茶','面条','米饭','饭','鸡肉','牛肉','羊肉','轻食','沙拉'];
    if(input&&!generic.includes(input)){
      if(input.length>24||!/^[\p{L}\p{N}·]+$/u.test(input))throw Error('请用简短餐品名称描述，例如“珍珠奶茶”或“牛肉饭”');
      const dish=input.match(/^(牛肉|牛腩|鸡肉|鸡腿|鸡排|羊肉)(?:盖浇|盖|拌|炒)?(饭|面)$/);
      result.keywords=dish?[dish[1],dish[2]]:[input];
    }
    if(Object.keys(options).length){if(!['奶茶','咖啡','果茶'].includes(category))throw Error('糖度、冰量、杯型目前只支持饮品规格');result.options=options;}
    return result;
  }
  function describe(request, fallbackBudget) {
    const choices=request.keywords?.join('')||request.category||'随机正餐';
    return `已识别：${choices} × ${request.quantity}；含配送预算 ${money(request.budget??fallbackBudget)}${request.options?'；'+Object.values(request.options).join('、'):''}。不吃猪肉，必须用券。`;
  }
  function matches(item,request){
    if(request.category&&!categories[request.category].test(item.name))return false;
    if(request.keywords?.some(word=>!item.name.includes(word)))return false;
    return !(['奶茶','果茶','咖啡'].includes(request.category)&&/挞|蛋糕|面包|曲奇|饼干|冰淇淋|雪糕|卷|套餐|礼盒/.test(item.name));
  }
  function optionMatches(kind,label,value){
    return kind==='temperature'&&label==='热'?/^热(?:饮|的|$)/.test(value):!!optionPatterns[kind]?.[label]?.test(value);
  }
  function randomPlan(menu, request, budget, random = Math.random) {
    const candidates = menu.filter(item => !item.blocked && !inspectName(item.name) && !item.soldOut && Number.isSafeInteger(item.cents) && item.cents >= 0 && item.cents * request.quantity <= budget && matches(item,request));
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
  const money = value => value === null ? '待核对' : `¥${(value / 100).toFixed(2)}`;
  const api = {cents, price, inspectName, supported, checkPlan, intent, describe, matches, optionPatterns, optionMatches, randomPlan, previewVerdict, money};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShenqiPolicy = api;
})(globalThis);
