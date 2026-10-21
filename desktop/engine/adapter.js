(function (root) {
  'use strict';
  const policy = typeof module !== 'undefined' && module.exports ? require('./policy.js') : root.ShenqiPolicy;
  function create(doc, options = {}) {
    const win = doc.defaultView;
    const timeout = options.timeout ?? 6500;
    const visible = options.visible || (el => !!el && el.getClientRects().length > 0 && win.getComputedStyle(el).visibility !== 'hidden');
    const text = el => (el?.textContent || '').trim();
    let uncertain = false;
    const scope = () => `${win.location.origin}${win.location.pathname}|${new URL(win.location.href).searchParams.get('poi_id_str') || ''}`;
    function ensure(expected) {
      if (!policy.supported(win.location.href) || !/\/waimai\/mindex\/menu\/?$/.test(win.location.pathname)) throw Error('请回到美团商家菜单页操作');
      if (expected && scope() !== expected) throw Error('页面或商家已变化，已停止后续操作');
    }
    function cards() {
      const found = new Map();
      for (const element of doc.querySelectorAll('dd[data-tag="spu"]')) {
        const name = text(element.querySelector('[class^="name_"], [class*=" name_"]'));
        if (!name) continue;
        const amount = policy.price(text(element.querySelector('[data-tag="price"]')));
        const key = `${name}\u001f${amount}`;
        const group = element.querySelector('.sqt-menu-add-buttons');
        const count = text(group?.querySelector('[class^="count_"], [class*=" count_"]')) || text(group);
        const quantity = /^\d+$/.test(count) ? Number(count) : group?.querySelector('[aria-label="查看已选规格"], [aria-label="移出购物车"]') ? null : 0;
        const item = {key, name, cents: amount, quantity, element,
          soldOut: /已售罄|售完|已下架/.test(text(element)), blocked: policy.inspectName(name)};
        const previous = found.get(key);
        if (!previous || (!visible(previous.element) && visible(element))) found.set(key, item);
      }
      return [...found.values()];
    }
    function cart() {
      const button = doc.querySelector('button[aria-label^="购物车"], [role="button"][aria-label^="购物车"]');
      if (!button) return {count: null, button: null};
      const label = button.getAttribute('aria-label') || '';
      const value = text(button);
      return {count: label.includes('没有商品') ? 0 : /^\d+$/.test(value) ? Number(value) : null, button};
    }
    function leaf(label, parent = doc) {
      return [...parent.querySelectorAll('button, a, span, div, webc-text, webc-view')].filter(el => visible(el) && text(el) === label && ![...el.children].some(child => text(child) === label)).at(-1) || null;
    }
    function specDialog() {
      const close = doc.querySelector('button[aria-label="关闭商品规格选择弹窗"]');
      return close && visible(close) ? close.parentElement : null;
    }
    async function waitFor(read, expected) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        ensure(expected);
        const value = read();
        if (value) return value;
        await new Promise(resolve => win.setTimeout(resolve, options.interval ?? 100));
      }
      return null;
    }
    function findItem(key) { return cards().find(item => item.key === key); }
    function verify(pending) {
      ensure(pending.scope);
      const item = findItem(pending.key), current = cart();
      return item?.quantity === pending.quantity + 1 && current.count === pending.cartCount + 1;
    }
    async function add(key, budget, {requireSpecs=false,shouldStop=()=>false}={}) {
      ensure();
      const checkStop=()=>{if(shouldStop())throw Error('已停止后续加购');};checkStop();
      if (uncertain) throw Error('上次加购结果未确认，请先在官方购物车核对；不要重复加购');
      if (specDialog()) throw Error('请先完成或关闭官方规格弹窗');
      let item = findItem(key);
      if (!item) throw Error('菜品已变化，请重新读取菜单');
      policy.checkPlan([{...item, desired: 1}], budget);
      const before = cart();
      if (before.count === null || item.quantity === null) throw Error('无法读到真实数量，请先检查官方购物车');
      const pending = {key, scope: scope(), quantity: item.quantity, cartCount: before.count};
      item.element.scrollIntoView?.({block: 'center', behavior: 'instant'});
      // Controls are mounted lazily when a card enters the viewport. Wait before clicking.
      const control = await waitFor(() => {
        checkStop();
        item = findItem(key);
        const group = item?.element.querySelector('.sqt-menu-add-buttons');
        const plus = group?.querySelector('[aria-label="选择规格"], [aria-label="加入购物车"]') ||
          (group?.matches('[class^="mBtnGroup_"], [class*=" mBtnGroup_"]') ? group : null);
        if (!plus || !visible(plus) || plus.getAttribute('aria-disabled') === 'true' || plus.disabled || /plusGrey_/.test(plus.className)) return null;
        return plus.querySelector('[class^="clickArea_"], [class*=" clickArea_"]') || plus;
      }, pending.scope);
      if (!control) throw Error('未识别到可用的加购控件。请在官方页面手动选择规格，再重新读取菜单');
      if(requireSpecs && control.closest('[aria-label="加入购物车"]')) throw Error('该商品未提供可核对的规格弹窗，不能确认糖度、冰量或杯型；请在官方页选择');
      item = findItem(key);
      policy.checkPlan([{...item, desired: 1}], budget);
      if (item.quantity !== pending.quantity || cart().count !== pending.cartCount) throw Error('购物车在操作前已变化，请先重新核对');
      let clicked = false;
      try {
        checkStop();
        clicked = true;
        control.click(); // Exactly one mutating click. A timeout is never retried.
        const result = await waitFor(() => verify(pending) ? 'added' : specDialog() ? 'specs' : null, pending.scope);
        if (!result) { uncertain = true; throw Error('未确认加购结果，已暂停。请到官方购物车核对，不会自动重试'); }
        return {status: result, pending};
      } catch (error) { if (clicked) uncertain = true; throw error; }
    }
    function verifyManual(pending) {
      if (!verify(pending)) throw Error('尚未核对到该菜品增加 1 份。请核对规格、菜名和数量，不要重复点击');
      const dialog = specDialog();
      dialog?.querySelector('button[aria-label="关闭商品规格选择弹窗"]')?.click();
      return true;
    }
    function checkout(items, budget, shouldStop=()=>false) {
      ensure();
      if(shouldStop())throw Error('已停止结算');
      if (uncertain || specDialog()) throw Error('请先核对加购结果并关闭官方规格弹窗');
      policy.checkPlan(items, budget);
      const current = cards(), basket = cart();
      for (const selected of items) {
        const actual = current.find(item => item.key === selected.key);
        if (!actual || actual.quantity !== selected.desired) throw Error(`${selected.name}：实际数量与选择不一致`);
        policy.checkPlan([{...actual, desired: selected.desired}], budget);
      }
      const expected = items.reduce((sum, item) => sum + item.desired, 0);
      if (basket.count !== expected) throw Error('购物车还有其他商品或数量不符，请先在官方购物车核对');
      const button = leaf('去结算');
      if (!button) throw Error('尚未达到起送价，或平台未提供结算入口');
      if(shouldStop())throw Error('已停止结算');
      button.click(); // This opens preview only. No submit/payment control is ever selected.
    }
    function previewTotal() {
      if (!policy.supported(win.location.href) || !/\/mindex\/preview\/?$/.test(win.location.pathname)) return null;
      const submit = doc.querySelector('#sqt-openh5-preview-submit-btn');
      return policy.price(text(submit?.parentElement.querySelector('[class^="actual_"], [class*=" actual_"]')));
    }
    function ensurePreview() {
      if (!policy.supported(win.location.href) || !/\/mindex\/preview\/?$/.test(win.location.pathname)) throw Error('请回到官方订单预览页');
    }
    function couponRows() {
      return ['美团红包','商家代金券'].map(label => {
        const node = leaf(label), row = node?.closest('[class^="promotion_"], [class*=" promotion_"]');
        const value = text(row?.querySelector('[class^="promotionSelect_"], [class*=" promotionSelect_"]'));
        return {label, discount:/^-\s*[¥￥]/.test(value) ? policy.price(value) || 0 : 0, value, element:row};
      });
    }
    async function waitPreview(read) {
      const expected=scope(), started=Date.now();
      while (Date.now()-started<timeout) {
        ensurePreview(); if(scope()!==expected) throw Error('页面已变化，停止选券');
        const result=read(); if(result) return result;
        await new Promise(resolve=>win.setTimeout(resolve,options.interval??100));
      }
      throw Error('未能确认平台选券结果，请在官方页核对，不自动重试');
    }
    // Every action is grounded in visible official labels. Never use private APIs or hidden coupon IDs.
    let expansionAttempted=false;
    async function applyCoupons({expand=false,shouldStop=()=>false}={}) {
      ensurePreview();
      const stop=()=>{if(shouldStop()) throw Error('已停止后续选券');};
      stop();
      let row=couponRows()[0].element;
      if(row){
      row.click();
      await waitPreview(()=>leaf('可使用红包') || leaf('不可使用红包'));
      stop();
      if(expand && !expansionAttempted) {
        const free=leaf('免费膨胀');
        if(free) {
          const cell=free.closest('.cell-wrapper');
          if(!cell || /支付|购买|开通|付费|元膨胀/.test(text(cell))) throw Error('膨胀条件无法确认免费，请本人核对');
          const before=text(cell);
          expansionAttempted=true; // At most one attempt per panel, including unknown results.
          free.click();
          await waitPreview(()=>!cell.isConnected || text(cell)!==before);
          stop();
        }
      }
      const unusable=leaf('不可使用红包');
      const candidates=[...doc.querySelectorAll('.cell-wrapper')].filter(cell=>visible(cell) && (!unusable || !!(cell.compareDocumentPosition(unusable)&win.Node.DOCUMENT_POSITION_FOLLOWING)) && !/本单不可用原因|免费膨胀/.test(text(cell))).map(cell=>({cell,amount:policy.price(text(cell.querySelector('.price-amount-container')))})).filter(x=>x.amount>0).sort((a,b)=>b.amount-a.amount);
      // Clicking an already selected card can toggle it off. Confirm first; if no discount was applied, select once.
      const target=candidates[0];
      const confirm=leaf('确认'); if(!confirm) throw Error('未识别红包确认入口');
      stop(); confirm.click();
      await waitPreview(()=>!leaf('可使用红包')&&!leaf('不可使用红包'));
      if(target && couponRows()[0].discount<target.amount) {
        stop(); couponRows()[0].element.click(); await waitPreview(()=>leaf('可使用红包'));
        const fresh=[...doc.querySelectorAll('.cell-wrapper')].find(cell=>text(cell.querySelector('.price-amount-container'))===text(target.cell.querySelector('.price-amount-container')) && text(cell.querySelector('.coupon-wrapper'))===text(target.cell.querySelector('.coupon-wrapper')));
        if(!fresh) throw Error('红包列表已变化，请重新核对');
        stop(); fresh.querySelector('.coupon-wrapper')?.click();
        const done=leaf('确认'); if(!done) throw Error('未识别红包确认入口'); stop();done.click();
        await waitPreview(()=>couponRows()[0].discount>=target.amount && !leaf('可使用红包'));
      }
      }
      stop();
      row=couponRows()[1];
      // Already applied vouchers are retained; opening and toggling could remove them.
      if(row.element && !row.discount && /\d+张可用/.test(text(row.element))) {
        row.element.click(); await waitPreview(()=>leaf('可用店铺券'));
        const available=leaf('可用店铺券')?.closest('article');
        const merchant=[...(available||doc.createElement('article')).querySelectorAll('[class^="topPart_"]')].filter(visible).map(cell=>({cell,amount:policy.price(text(cell.querySelector('[class^="disContainer_"]')))})).filter(x=>x.amount>0).sort((a,b)=>b.amount-a.amount)[0];
        if(!merchant) throw Error('未识别到可用商家券，请本人核对');
        const indicator=merchant.cell.querySelector('[class^="select_"]');
        if(!indicator) throw Error('无法核对商家券勾选状态');
        stop(); if(/canceled_/.test(indicator.className)) merchant.cell.click();
        const done=leaf('确定'); if(!done) throw Error('未识别商家券确认入口'); stop();done.click();
        await waitPreview(()=>!leaf('可用店铺券') && couponRows()[1].discount>0);
      }
      const coupons=couponRows();
      if(!coupons.some(item=>item.discount>0)) throw Error('没有确认到实际用券，已暂停下单');
      return {coupons,expanded:expansionAttempted,total:previewTotal()};
    }
    function previewFingerprint() {
      ensurePreview();
      const clone=doc.body.cloneNode(true);
      clone.querySelector('#shenqi-waimai-assistant')?.remove();
      clone.querySelectorAll('script,style').forEach(el=>el.remove());
      // Kept only in page memory; includes the current official address/items so any change revokes consent.
      return clone.textContent.replace(/\s+/g,' ').trim();
    }
    function previewItems() {
      return [...doc.querySelectorAll('[class^="spuInfoList_"], [class*=" spuInfoList_"]')].map(el=>({
        name:text(el.querySelector('[class^="spuInfoSpan_"]')),
        quantity:Number(text(el.querySelector('[class^="spuAmount_"]')).match(/^x(\d+)$/)?.[1])
      }));
    }
    function shops(budget,request,tried=[]){
      const category=policy.intent(request||'').category;
      return [...doc.querySelectorAll('.poilist-item')].map(element=>{
        const name=text(element.querySelector('.poilist-item-info1name')),body=text(element);
        const minimum=policy.price(body.match(/起送\s*[¥￥]\s*\d+(?:\.\d{1,2})?/)?.[0]||'');
        const delivery=policy.price(body.match(/配送\s*约?\s*[¥￥]\s*\d+(?:\.\d{1,2})?/)?.[0]||'');
        return {name,minimum,delivery,element,body};
      }).filter(item=>item.name&&!tried.includes(item.name)&&!policy.inspectName(item.name)&&! /药房|药店|药品|医院|门诊|快递电商|烟酒|鲜花|数码|日百|宠物|生日蛋糕/.test(item.name)&&!/休息中|暂停营业|超出配送/.test(item.body)&&item.minimum!==null&&item.delivery!==null&&item.minimum+item.delivery<=budget&&(category?true:!/奶茶|咖啡|茶姬|奶白|喜茶|奈雪|甜品|蛋糕|一点点|1点点/.test(item.name)))
        .filter(item=>!['奶茶','果茶','咖啡'].includes(category)||(category==='咖啡'?/咖啡|瑞幸|库迪|星巴克|Manner|Costa/i:/茶|奶|蜜雪|古茗|沪上|一点点|1点点|CoCo|益禾|甜啦/i).test(item.name));
    }
    async function confirmDefaultSpecs(pending,budget,request={},shouldStop=()=>false){
      const checkStop=()=>{if(shouldStop())throw Error('已停止规格选择和加购');};checkStop();
      ensure(pending.scope);const item=findItem(pending.key),dialog=specDialog();
      if(!item||!dialog||item.quantity!==pending.quantity||cart().count!==pending.cartCount)throw Error('规格或购物车已变化，停止默认规格加购');
      let groups=[...dialog.querySelectorAll('[data-tag="attribute"]')];
      const choices=[];
      for(const [kind,label] of Object.entries(request.options||{})){
        const matching=groups.flatMap(group=>[...group.querySelectorAll('[class^="tag_"], [class*=" tag_"]')].filter(el=>visible(el)&&policy.optionMatches(kind,label,text(el))&&!/disabled|soldoff|unavailable/i.test(el.className)&&!/不可|不支持|售罄|售完|已下架/.test(text(el))).map(el=>({group,el})));
        if(matching.length!==1)throw Error(`未唯一找到“${label}”规格，请在官方弹窗亲自选择；不会按默认口味加购`);
        choices.push({kind,label,...matching[0]});
      }
      for(const choice of choices){
        checkStop();
        ensure(pending.scope);
        if(!choice.el.isConnected||cart().count!==pending.cartCount)throw Error('规格列表或购物车已变化，请本人核对');
        if(!/\bselected_/.test(choice.el.className))choice.el.click();
      }
      if(choices.length){
        const confirmed=await waitFor(()=>{checkStop();return choices.every(choice=>{
          return [...choice.group.querySelectorAll('[class*="selected_"]')].filter(el=>policy.optionMatches(choice.kind,choice.label,text(el))).length===1;
        });},pending.scope);
        if(!confirmed)throw Error('指定规格未确认选中，请本人核对；没有点击确认加购');
      }
      groups=[...dialog.querySelectorAll('[data-tag="attribute"]')];
      if(!groups.length||groups.some(group=>group.querySelectorAll('[class*="selected_"]').length!==1))throw Error('规格未完整选中或需要额外选择，请本人处理');
      const selected=groups.map(group=>text(group.querySelector('[class*="selected_"]')));
      if(selected.some(name=>policy.inspectName(name)))throw Error('默认规格触发忌口规则，已停止');
      // The official price block contains both sale and struck-through original price.
      const priceBlock=dialog.querySelector('[class^="price_"], [class*=" price_"]')?.cloneNode(true);
      priceBlock?.querySelectorAll('[class^="oriPrice_"], [class*=" oriPrice_"], del, s').forEach(el=>el.remove());
      const amounts=[...text(priceBlock||dialog).matchAll(/[¥￥]\s*(\d+(?:\.\d{1,2})?)(?![\d.])/g)].map(m=>policy.cents(m[1]));
      if(!amounts.length||new Set(amounts).size!==1||amounts[0]>budget)throw Error('规格价格无法唯一核对或超过预算，请本人处理');
      const button=dialog.querySelector('[class^="addToCartBtn_"], [class*=" addToCartBtn_"]')||dialog.querySelector('[aria-label="加入购物车"]');
      if(!button||!visible(button)||(text(button)!=='加入购物车'&&button.getAttribute('aria-label')!=='加入购物车')||/plusGrey_/.test(button.className)||button.getAttribute('aria-disabled')==='true')throw Error('未识别到规格确认加购入口');
      checkStop();
      (button.querySelector('[class^="clickArea_"], [class*=" clickArea_"]')||button).click();
      const verified=await waitFor(()=>verify(pending),pending.scope);
      if(!verified){uncertain=true;throw Error('默认规格加购结果不明，不会重试');}
      checkStop();
      verifyManual(pending);return true;
    }
    let submitted=false;
    async function createUnpaid({budget,fingerprint,authorize,reserve,expected,shouldStop=()=>false}) {
      ensurePreview();
      if(leaf('可使用红包') || leaf('可用店铺券')) throw Error('请先完成官方选券并关闭券弹窗');
      if(submitted) throw Error('本页已尝试提交，请到官方订单列表核对，不会重复提交');
      if(!authorize || !fingerprint || fingerprint!==previewFingerprint()) throw Error('订单内容已变化，请重新核对地址、菜品、规格并授权本单');
      const verdict=policy.previewVerdict(previewTotal(),budget,couponRows());
      if(!verdict.ok) throw Error(verdict.message);
      const foods=previewItems();
      if(!foods.length || foods.some(item=>!item.name || !Number.isInteger(item.quantity) || item.quantity<1 || policy.inspectName(item.name))) throw Error('预览菜品无法核对或触发不吃猪肉规则，请在官方页调整');
      if(expected && (foods.length!==expected.length || expected.some(item=>foods.filter(food=>food.name===item.name).reduce((sum,food)=>sum+food.quantity,0)!==item.desired))) throw Error('预览商品与本次选择不一致，请返回核对');
      const button=doc.querySelector('#sqt-openh5-preview-submit-btn');
      if(!button || !visible(button) || button.disabled || button.getAttribute('aria-disabled')==='true' || text(button)!=='提交订单') throw Error('未识别可用的“提交订单”，请本人核对');
      if(typeof reserve!=='function') throw Error('提交防重记录不可用，已停止');
      await reserve(); // Persist the attempt before touching the site. Never auto-clear after navigation/errors.
      if(shouldStop()) throw Error('已停止提交。请核对官方订单后解除防重记录');
      ensurePreview();
      if(fingerprint!==previewFingerprint() || !policy.previewVerdict(previewTotal(),budget,couponRows()).ok) throw Error('订单在准备提交时已变化，请核对官方订单后再操作');
      submitted=true;
      button.click(); // Exactly one submission attempt; payment controls are never selected.
      return {status:'attempted'};
    }
    return {cards, cart, add, verifyManual, confirmDefaultSpecs,shops,checkout, scope, specDialog, ensure, previewTotal, couponRows, applyCoupons, previewFingerprint, previewItems, createUnpaid, isUncertain: () => uncertain};
  }
  const api = {create};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShenqiAdapter = api;
})(globalThis);
