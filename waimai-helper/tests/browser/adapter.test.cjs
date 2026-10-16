const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = (()=>{try{return require('jsdom');}catch{return require(path.resolve(__dirname,'../../../.tool-cache/browser-tests/node_modules/jsdom'));}})();
const extension = path.resolve(__dirname, '../../browser-extension');
const P = require(path.join(extension, 'policy.js'));
const {create} = require(path.join(extension, 'adapter.js'));

function fixture(t, {mode = 'direct', extra = 0, name = '牛肉饭', amount = '12.00'} = {}) {
  const dom = new JSDOM(`<title>本地测试商家</title><article><dd data-tag="spu"><div class="name_fixture"></div><div data-tag="price"></div><div class="sqt-menu-add-buttons"></div></dd><button aria-label="购物车,没有商品"></button><div id="checkout">去结算</div><button id="submit">提交订单</button></article>`, {url:'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=test-shop', runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window, doc = w.document;
  t.after(() => w.close());
  w.HTMLElement.prototype.getClientRects = () => [{width:10, height:10}];
  w.HTMLElement.prototype.scrollIntoView = () => {};
  doc.querySelector('.name_fixture').textContent = name;
  doc.querySelector('[data-tag="price"]').textContent = `¥${amount}`;
  let quantity = 0, cartCount = extra, clicks = 0, checkoutClicks = 0, submitClicks = 0;
  function draw() {
    const group = doc.querySelector('.sqt-menu-add-buttons');
    group.replaceChildren();
    if (quantity) { const minus = doc.createElement('span'); minus.setAttribute('aria-label','查看已选规格'); group.append(minus, doc.createTextNode(String(quantity))); }
    const plus = doc.createElement('span'); plus.setAttribute('aria-label','选择规格');
    const target = doc.createElement('span'); target.className = 'clickArea_fixture'; plus.append(target); group.append(plus);
    target.onclick = () => {
      clicks++;
      if (mode === 'direct') { quantity++; cartCount++; draw(); }
      if (mode === 'navigate') w.history.pushState({}, '', '/waimai/mindex/menu?poi_id_str=other-shop');
      if (mode === 'specs') {
        const dialog = doc.createElement('div'); dialog.className = 'dContainer_fixture';
        dialog.innerHTML = '<dl data-tag="attribute"><dt>口味</dt><dd>请本人选择</dd></dl><button aria-label="关闭商品规格选择弹窗">关闭</button>';
        dialog.querySelector('button').onclick = () => dialog.remove(); doc.body.append(dialog);
      }
    };
    const button = doc.querySelector('button[aria-label^="购物车"]');
    button.setAttribute('aria-label', cartCount ? '购物车' : '购物车,没有商品'); button.textContent = cartCount || '';
  }
  draw();
  doc.getElementById('checkout').onclick = () => checkoutClicks++;
  doc.getElementById('submit').onclick = () => submitClicks++;
  return {w, doc, adapter:create(doc,{timeout:45,interval:2}), counts:()=>({quantity,cartCount,clicks,checkoutClicks,submitClicks}),
    manualAdd: () => { quantity++; cartCount++; draw(); }, addOther: () => { cartCount++; draw(); }};
}

test('money uses integer cents and refuses invalid values and partial decimals', () => {
  assert.equal(P.cents('35.40'),3540); assert.equal(P.price('¥22.5 ¥25'),2250);
  for (const value of ['-1','1.001','1e2','Infinity','', '1,000']) assert.equal(P.cents(value), null);
  assert.equal(P.price('¥1.999'),null);
  assert.throws(() => P.checkPlan([{name:'牛肉饭',cents:1200,desired:2}],2300), /超过预算/);
});
test('food-name checks preserve the canonical pork rule and do not promise ingredients', () => {
  assert.equal(P.inspectName('牛肉饭'),''); assert.match(P.inspectName('培根汉堡'),/培根/);
  assert.match(P.inspectName('三鲜饺子'),/原料/);
  assert.equal(P.supported('https://h5.waimai.meituan.com/waimai/mindex/menu'),true);
  assert.equal(P.supported('https://h5.waimai.meituan.com.evil.example/'),false);
  assert.equal(P.supported('http://h5.waimai.meituan.com/'),false);
});
test('a click is successful only after both dish and cart counts increase', async t => {
  const f=fixture(t), item=f.adapter.cards()[0];
  const result=await f.adapter.add(item.key,4000);
  assert.equal(result.status,'added'); assert.deepEqual(f.counts(),{quantity:1,cartCount:1,clicks:1,checkoutClicks:0,submitClicks:0});
});
test('a silent click fails closed and is never retried', async t => {
  const f=fixture(t,{mode:'noop'}), key=f.adapter.cards()[0].key;
  await assert.rejects(f.adapter.add(key,4000),/未确认/);
  await assert.rejects(f.adapter.add(key,4000),/上次加购结果未确认/);
  assert.equal(f.counts().clicks,1);
});
test('specification selection remains a manual step and verifies the exact dish', async t => {
  const f=fixture(t,{mode:'specs'}), result=await f.adapter.add(f.adapter.cards()[0].key,4000);
  assert.equal(result.status,'specs'); assert.equal(f.counts().quantity,0);
  f.addOther(); assert.throws(()=>f.adapter.verifyManual(result.pending),/尚未核对/);
  assert.equal(f.counts().quantity,0);
});
test('a completed manual specification add is acknowledged and its modal closes', async t => {
  const f=fixture(t,{mode:'specs'}), result=await f.adapter.add(f.adapter.cards()[0].key,4000);
  f.manualAdd(); assert.equal(f.adapter.verifyManual(result.pending),true);
  assert.equal(f.adapter.specDialog(),null); assert.equal(f.counts().clicks,1);
});
test('authorized default specifications click once and verify the same product count',async t=>{
  const f=fixture(t,{mode:'specs'}),result=await f.adapter.add(f.adapter.cards()[0].key,2500),dialog=f.adapter.specDialog();
  dialog.querySelector('dl').innerHTML='<dt>规格</dt><dd class="tag_fixture selected_fixture">标准</dd>';
  const price=f.doc.createElement('div');price.textContent='¥12';dialog.append(price);
  const add=f.doc.createElement('div');add.className='addToCartBtn_fixture';add.textContent='加入购物车';add.onclick=f.manualAdd;dialog.append(add);
  assert.equal(await f.adapter.confirmDefaultSpecs(result.pending,2500),true);
  assert.equal(f.counts().quantity,1);assert.equal(f.adapter.specDialog(),null);
});
test('default specifications reject missing choices, pork toppings and ambiguous prices without adding',async t=>{
  const f=fixture(t,{mode:'specs'}),result=await f.adapter.add(f.adapter.cards()[0].key,2500),dialog=f.adapter.specDialog();
  await assert.rejects(f.adapter.confirmDefaultSpecs(result.pending,2500),/未完整选中/);
  dialog.querySelector('dl').innerHTML='<dd class="tag_fixture selected_fixture">加培根</dd>';
  await assert.rejects(f.adapter.confirmDefaultSpecs(result.pending,2500),/忌口/);
  dialog.querySelector('dd').textContent='标准';dialog.append('¥12 ¥15');
  await assert.rejects(f.adapter.confirmDefaultSpecs(result.pending,2500),/无法唯一核对/);
  assert.equal(f.counts().quantity,0);
});
test('changing shops during a mutation stops the run', async t => {
  const f=fixture(t,{mode:'navigate'});
  await assert.rejects(f.adapter.add(f.adapter.cards()[0].key,4000),/商家已变化/);
  assert.equal(f.adapter.isUncertain(),true); assert.equal(f.counts().clicks,1);
});
test('sold-out, blocked, repriced and over-budget food cannot be added', async t => {
  const f=fixture(t), item=f.adapter.cards()[0];
  await assert.rejects(f.adapter.add(item.key,100),/超过预算/);
  f.doc.querySelector('dd').append('已售罄');
  await assert.rejects(f.adapter.add(item.key,4000),/售罄/); assert.equal(f.counts().clicks,0);
  const g=fixture(t,{name:'培根汉堡'});
  await assert.rejects(g.adapter.add(g.adapter.cards()[0].key,4000),/培根/);
  f.doc.querySelector('[data-tag="price"]').textContent='¥13';
  await assert.rejects(f.adapter.add(item.key,4000),/菜品已变化/);
});
test('an extra item in the cart prevents checkout', async t => {
  const f=fixture(t,{extra:1}); await f.adapter.add(f.adapter.cards()[0].key,4000);
  assert.throws(()=>f.adapter.checkout([{...f.adapter.cards()[0],desired:1}],4000),/其他商品/);
  assert.equal(f.counts().checkoutClicks,0); assert.equal(f.counts().submitClicks,0);
});
test('checkout validates quantity and never invokes submission', async t => {
  const f=fixture(t); await f.adapter.add(f.adapter.cards()[0].key,4000);
  const item=f.adapter.cards()[0];
  assert.throws(()=>f.adapter.checkout([{...item,desired:2}],4000),/实际数量/);
  f.adapter.checkout([{...item,desired:1}],4000);
  assert.equal(f.counts().checkoutClicks,1); assert.equal(f.counts().submitClicks,0);
});
test('unknown cart quantity blocks any mutation', async t => {
  const f=fixture(t); const b=f.doc.querySelector('button[aria-label^="购物车"]'); b.setAttribute('aria-label','购物车'); b.textContent='未知';
  await assert.rejects(f.adapter.add(f.adapter.cards()[0].key,4000),/真实数量/); assert.equal(f.counts().clicks,0);
});
test('official preview total is read without clicking its submit button', t => {
  const f=fixture(t); f.w.history.pushState({},'', '/waimai/mindex/preview');
  f.doc.body.innerHTML='<div><span class="actual_fixture">合计<i>¥35.4</i></span><button id="sqt-openh5-preview-submit-btn">提交订单</button></div><div class="promotion_fixture"><span>美团红包</span><span class="promotionSelect_fixture">-¥7</span></div>';
  let clicks=0; f.doc.querySelector('button').onclick=()=>clicks++;
  assert.equal(f.adapter.previewTotal(),3540); assert.equal(clicks,0);
  assert.throws(()=>f.adapter.checkout([],4000),/菜单页/);
});
test('the content panel treats script-like menu text as inert and is mounted only once', t => {
  const f=fixture(t,{name:'<img src=x onerror=alert(1)>牛肉饭'});
  for (const name of ['guard-data.js','policy.js','adapter.js','styles.js','content.js']) f.w.eval(fs.readFileSync(path.join(extension,name),'utf8'));
  const host=f.doc.getElementById('shenqi-waimai-assistant');
  assert.ok(host.shadowRoot); assert.equal(host.shadowRoot.querySelector('img'),null);
  f.w.eval(fs.readFileSync(path.join(extension,'content.js'),'utf8'));
  assert.equal(f.doc.querySelectorAll('#shenqi-waimai-assistant').length,1);
});
test('repeating the UI add action does not duplicate a fulfilled target quantity', async t => {
  const f=fixture(t);
  for (const name of ['guard-data.js','policy.js','adapter.js','styles.js','content.js']) f.w.eval(fs.readFileSync(path.join(extension,name),'utf8'));
  const ui=f.doc.getElementById('shenqi-waimai-assistant').shadowRoot;
  const check=ui.querySelector('.dish input[type=checkbox]'); check.checked=true; check.dispatchEvent(new f.w.Event('change'));
  ui.getElementById('ingredients').checked=true; ui.getElementById('add').click();
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(f.counts().quantity,1);
  ui.getElementById('add').click(); await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(f.counts().quantity,1); assert.equal(f.counts().clicks,1);
});
test('missing preview amount is never described as within budget', t => {
  const f=fixture(t); f.w.history.pushState({},'', '/waimai/mindex/preview');
  for (const name of ['guard-data.js','policy.js','adapter.js','styles.js','content.js']) f.w.eval(fs.readFileSync(path.join(extension,name),'utf8'));
  const ui=f.doc.getElementById('shenqi-waimai-assistant').shadowRoot;
  assert.match(ui.getElementById('status').textContent,/无法判断/);
  assert.equal(ui.getElementById('checkout').hidden,true);
});
test('a changing official preview amount refreshes the budget verdict', async t => {
  const f=fixture(t); f.w.history.pushState({},'', '/waimai/mindex/preview');
  f.doc.body.innerHTML='<div><span class="actual_fixture">合计<i>¥35.4</i></span><button id="sqt-openh5-preview-submit-btn">提交订单</button></div><div class="promotion_fixture"><span>美团红包</span><span class="promotionSelect_fixture">-¥7</span></div>';
  for (const name of ['guard-data.js','policy.js','adapter.js','styles.js','content.js']) f.w.eval(fs.readFileSync(path.join(extension,name),'utf8'));
  const ui=f.doc.getElementById('shenqi-waimai-assistant').shadowRoot;
  ui.getElementById('budget').value='40'; ui.getElementById('budget').dispatchEvent(new f.w.Event('input'));
  assert.match(ui.getElementById('status').textContent,/预算内/);
  f.doc.querySelector('i').textContent='¥45.4';
  await new Promise(resolve=>setTimeout(resolve,550));
  assert.match(ui.getElementById('status').textContent,/超过预算/);
  assert.equal(ui.getElementById('amount').textContent,'¥45.40');
});

test('an explicitly authorized self-service meal runs to one unpaid submission without a second confirmation',async t=>{
  const f=fixture(t);let submitted=0,reserved=0;
  f.w.chrome={runtime:{sendMessage:async msg=>{
    if(msg.type==='read')return{ok:true,preferences:{budget:'40',mode:'unpaid',expand:false},attempt:false};
    if(msg.type==='reserve'){reserved++;return{ok:reserved===1};}
    return{ok:true};
  }}};
  f.doc.getElementById('checkout').onclick=()=>{
    f.w.history.pushState({},'','/waimai/mindex/preview');
    f.doc.querySelector('article').innerHTML='<div class="spuInfoList_fixture"><span class="spuInfoSpan_fixture">牛肉饭</span><div class="spuAmount_fixture">x1</div></div><div class="promotion_fixture"><span>美团红包</span><span class="promotionSelect_fixture">-¥7</span></div><div><span class="actual_fixture">合计¥6.50</span><button id="sqt-openh5-preview-submit-btn">提交订单</button></div>';
    f.doc.querySelector('.promotion_fixture').onclick=()=>{
      const modal=f.doc.createElement('section');modal.innerHTML='<span>可使用红包</span><div class="cell-wrapper"><div class="coupon-wrapper"><span class="price-amount-container">¥7</span></div></div><button>确认</button>';modal.querySelector('button').onclick=()=>modal.remove();f.doc.body.append(modal);
    };
    f.doc.querySelector('#sqt-openh5-preview-submit-btn').onclick=()=>{submitted++;f.w.history.pushState({},'','/waimai/mindex/mock-unpaid');};
  };
  for(const name of ['guard-data.js','policy.js','adapter.js','styles.js','content.js']) f.w.eval(fs.readFileSync(path.join(extension,name),'utf8'));
  await new Promise(resolve=>setTimeout(resolve,10));
  const ui=f.doc.getElementById('shenqi-waimai-assistant').shadowRoot;
  ui.getElementById('random').click();await new Promise(resolve=>setTimeout(resolve,10));
  ui.getElementById('ingredients').checked=true;
  ui.getElementById('start').click();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.counts().quantity,0);assert.match(ui.getElementById('status').textContent,/本次自助授权/);
  ui.getElementById('autoConsent').checked=true;ui.getElementById('start').click();
  await new Promise(resolve=>setTimeout(resolve,650));
  assert.equal(f.counts().quantity,1);assert.equal(reserved,1);assert.equal(submitted,1);
  assert.equal(ui.getElementById('orderConsent').checked,false);
});
