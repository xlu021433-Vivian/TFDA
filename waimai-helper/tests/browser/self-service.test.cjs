const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require(path.resolve(__dirname,'../../../.tool-cache/browser-tests/node_modules/jsdom'));}})();
const root=path.resolve(__dirname,'../../browser-extension');
const P=require(path.join(root,'policy.js'));
const {create}=require(path.join(root,'adapter.js'));

test('natural language parses a milk tea request, amount and budget',()=>{
  assert.deepEqual(P.intent('我想喝奶茶，预算30元，一杯'),{category:'奶茶',quantity:1,budget:3000});
  assert.equal(P.intent('随机，两份，预算40元').quantity,2);
  for(const text of ['我想吃猪肉','我想喝奶茶，不用券','奶茶少糖','我想喝奶茶或者咖啡','预算abc','来20杯奶茶','我想喝奶茶，不要珍珠','我不想喝奶茶']) assert.throws(()=>P.intent(text),undefined,text);
});
test('random selection always respects pork, stock, price, quantity and requested category',()=>{
  const rows=[{name:'培根奶茶',cents:100},{name:'珍珠奶茶',cents:1200,soldOut:true},{name:'奶茶蛋糕',cents:800},{name:'鲜奶茶',cents:1200},{name:'肉饭',cents:100},{name:'牛肉饭',cents:1400},{name:'奶茶',cents:null}];
  const plan=P.randomPlan(rows,P.intent('奶茶，两杯'),2500,()=>0);
  assert.equal(plan[0].name,'鲜奶茶'); assert.equal(plan[0].desired,2);
  assert.throws(()=>P.randomPlan(rows,P.intent('奶茶，三杯'),2500),/没有符合/);
  assert.throws(()=>P.randomPlan([{name:'树莓挞',cents:100}],P.intent('奶茶'),4000),/不会用甜点/);
});
test('platform delivery discounts and available-but-unselected coupons never satisfy mandatory coupon',()=>{
  assert.equal(P.previewVerdict(2000,3000,[{discount:0,value:'1张可用'}]).ok,false);
  assert.equal(P.previewVerdict(null,3000,[{discount:700}]).ok,false);
  assert.equal(P.previewVerdict(3100,3000,[{discount:700}]).ok,false);
  assert.equal(P.previewVerdict(2000,3000,[{discount:700}]).ok,true);
});
function preview(t,{name='鲜奶茶',discount='-¥7',total='26.4'}={}) {
  const dom=new JSDOM(`<body><section id="goods"><div class="spuInfoList_fixture"><div class="spuInfo_fixture"><span class="spuInfoSpan_fixture">${name}</span><span>¥30</span></div><div class="spuAmount_fixture">x1</div></div></section><div class="promotion_fixture"><span>美团红包</span><span class="promotionSelect_fixture">${discount}</span></div><div><span class="actual_fixture">合计¥${total}</span><button id="sqt-openh5-preview-submit-btn">提交订单</button></div><button id="pay">立即支付</button></body>`,{url:'https://h5.waimai.meituan.com/waimai/mindex/preview',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const d=dom.window.document;
  let submits=0,pays=0;
  d.querySelector('#sqt-openh5-preview-submit-btn').onclick=()=>submits++;
  d.querySelector('#pay').onclick=()=>pays++;
  const a=create(d,{visible:()=>true,timeout:60,interval:1});
  return {w:dom.window,d,a,counts:()=>({submits,pays}),args:()=>({budget:4000,fingerprint:a.previewFingerprint(),authorize:true,reserve:async()=>{}})};
}
test('one authorized coupon order is submitted once and never paid',async t=>{
  const f=preview(t);let reserved=0;
  await f.a.createUnpaid({...f.args(),reserve:async()=>reserved++});
  assert.equal(reserved,1);assert.deepEqual(f.counts(),{submits:1,pays:0});
  await assert.rejects(f.a.createUnpaid(f.args()),/已尝试提交/);
  assert.equal(f.counts().submits,1);
});
test('missing coupon, pork, unknown foods, overspend and wrong selected item block submission',async t=>{
  for(const config of [{discount:'1张可用'},{name:'培根饭'},{name:'三鲜饺子'},{total:'40.01'}]) {
    const f=preview(t,config); await assert.rejects(f.a.createUnpaid(f.args())); assert.equal(f.counts().submits,0);
  }
  const f=preview(t); await assert.rejects(f.a.createUnpaid({...f.args(),expected:[{name:'牛肉饭',desired:1}]}),/选择不一致/);
  f.d.querySelector('#goods').replaceChildren();await assert.rejects(f.a.createUnpaid(f.args()),/预览菜品无法核对/);
});
test('address/food/coupon changes revoke consent even after the submission reservation',async t=>{
  const f=preview(t),args=f.args();
  f.d.querySelector('#goods').append('changed address');
  await assert.rejects(f.a.createUnpaid(args),/已变化/);
  await assert.rejects(f.a.createUnpaid({...f.args(),reserve:async()=>{f.d.querySelector('.promotionSelect_fixture').textContent='未选红包';}}),/已变化/);
  assert.equal(f.counts().submits,0);
});
test('storage failure or stop prevents a submission',async t=>{
  const f=preview(t);
  await assert.rejects(f.a.createUnpaid({...f.args(),reserve:async()=>{throw Error('storage failed');}}),/storage failed/);
  await assert.rejects(f.a.createUnpaid({...f.args(),shouldStop:()=>true}),/已停止提交/);
  assert.equal(f.counts().submits,0);
});
test('free expansion is attempted once; a paid or ambiguous offer is never activated',async t=>{
  const f=preview(t),row=f.d.querySelector('.promotion_fixture');let expands=0;
  row.onclick=()=>{const box=f.d.createElement('article');box.id='coupons';box.innerHTML='<webc-text>可使用红包</webc-text><div class="cell-wrapper"><div class="coupon-wrapper"><span class="price-amount-container">¥3</span></div><webc-text>免费膨胀</webc-text><p>不可撤销</p></div><div class="cell-wrapper"><div class="coupon-wrapper"><span class="price-amount-container">¥7</span></div></div><webc-text>不可使用红包</webc-text><div class="cell-wrapper"><span class="price-amount-container">¥99</span></div><webc-text id="confirm">确认</webc-text>';f.d.body.append(box);box.querySelector('.cell-wrapper webc-text').onclick=()=>{expands++;box.querySelector('.cell-wrapper').remove();};box.querySelector('#confirm').onclick=()=>box.remove();};
  await f.a.applyCoupons({expand:true});await f.a.applyCoupons({expand:true});assert.equal(expands,1);
  const g=preview(t);let paid=0;
  g.d.querySelector('.promotion_fixture').onclick=()=>{g.d.body.insertAdjacentHTML('beforeend','<div><span>可使用红包</span><div class="cell-wrapper"><span>购买会员</span><span id="bad">免费膨胀</span></div></div>');g.d.querySelector('#bad').onclick=()=>paid++;};
  await assert.rejects(g.a.applyCoupons({expand:true}),/无法确认免费/);assert.equal(paid,0);
});
test('no usable coupon is a hard stop, even when high value unavailable cards exist',async t=>{
  const f=preview(t,{discount:'未选红包'});
  f.d.querySelector('.promotion_fixture').onclick=()=>f.d.body.insertAdjacentHTML('beforeend','<span>可使用红包</span><span>不可使用红包</span><div class="cell-wrapper"><span class="price-amount-container">¥100</span><span>本单不可用原因</span></div>');
  await assert.rejects(f.a.applyCoupons(),/没有可直接使用/);assert.equal(f.counts().submits,0);
});
test('worker atomically reserves one submission across tabs and persists preferences without account data',async()=>{
  const data={};
  const chrome={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path},storage:{local:{get:async()=>structuredClone(data),set:async value=>Object.assign(data,value),remove:async key=>{for(const name of [].concat(key))delete data[name];}}}};
  const runtime=require(path.join(root,'state.js')).createRuntime(chrome);
  const send=msg=>runtime.message(msg,{id:'test',tab:{id:1,url:'https://h5.waimai.meituan.com/waimai/mindex/preview'}}).catch(error=>({ok:false,error:error.message}));
  const results=await Promise.all([send({type:'reserve',budget:2500,total:2000}),send({type:'reserve',budget:2500,total:2000})]);
  assert.equal(results.filter(x=>x.ok).length,1);
  await send({type:'save',preferences:{budget:'30',mode:'unpaid',expand:true,address:'never store'}});
  assert.equal(data.preferences.noPork,true);assert.equal(data.preferences.requireCoupon,true);assert.equal('address' in data.preferences,false);
  assert.equal((await send({type:'read'})).attempt,true);
  assert.equal((await send({type:'clear',reviewed:false})).ok,false);
  await send({type:'clear',reviewed:true});assert.equal((await send({type:'read'})).attempt,false);
});
