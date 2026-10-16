const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require(path.resolve(__dirname,'../../../.tool-cache/browser-tests/node_modules/jsdom'));}})();
const S=require('../../browser-extension/schedule.js');
const {createRuntime}=require('../../browser-extension/state.js');
const {create}=require('../../browser-extension/adapter.js');
const config=()=>S.validate({...S.defaults,enabled:true,authorized:true});
const time=value=>Date.parse(value);
const monday=time('2026-10-19T03:00:00Z');
function runtime(initial={},when=monday){
  const data={...initial},tabs=[],notices=[],injected=[],pushes=[];let current=when;
  const api={runtime:{id:'test',getURL:name=>'chrome-extension://test/'+name},storage:{local:{get:async()=>structuredClone(data),set:async value=>Object.assign(data,structuredClone(value)),remove:async keys=>{for(const key of [].concat(keys))delete data[key];}}},
    tabs:{create:async value=>{const tab={id:tabs.length+1,...value};tabs.push(tab);return tab;},update:async(id,value)=>{Object.assign(tabs.find(t=>t.id===id),value);},sendMessage:async()=>{}},
    notifications:{create:async(id,value)=>notices.push({id,...value})},alarms:{get:async()=>undefined,create:async(name,value)=>{data.alarm={name,...value};}},scripting:{executeScript:async value=>injected.push(value)}};
  const worker=createRuntime(api,{now:()=>current,fetcher:async(url,request)=>{pushes.push({url,...request});return{ok:true,json:async()=>({delivered:true})};}});
  const sender={id:'test',tab:{id:1,url:'https://h5.waimai.meituan.com/waimai/mindex/preview'}};
  const options={id:'test',url:'chrome-extension://test/options.html'};
  return{data,api,worker,sender,options,tabs,notices,pushes,injected,setTime:value=>current=value};
}
test('schedule uses Asia/Shanghai independent of system timezone and applies weekdays exactly',()=>{
  assert.deepEqual(S.clock(monday),{date:'2026-10-19',weekday:1,minute:660});
  assert.equal(S.clock(time('2026-10-18T16:05:00Z')).weekday,1);
  assert.equal(S.due(config(),{},time('2026-10-17T03:00:00Z')),null);
  assert.equal(S.due(config(),{},monday-60000),null);
  assert.equal(S.due(config(),{},monday).missed,false);
  assert.equal(S.due(config(),{},monday+10*60000).missed,false);
  assert.equal(S.due(config(),{},monday+11*60000).missed,true);
  assert.equal(S.due(config(),{'2026-10-19':{status:'failed'}},monday),null);
});
test('schedule rejects conflicting budgets, invalid days and unapproved recurrence; unrestricted merchants are supported',()=>{
  assert.equal(config().anyShop,true);assert.equal(config().merchants.length,0);
  for(const changes of [{authorized:false},{time:'25:00'},{weekdays:[0]},{budget:0},{request:'奶茶预算30元'},{anyShop:false,merchants:[]}])assert.throws(()=>S.validate({...config(),...changes}));
});
test('simultaneous alarms start one task and persist the daily claim before opening a merchant',async()=>{
  const f=runtime({schedule:config()});
  await Promise.all([f.worker.tick(),f.worker.tick()]);
  assert.equal(f.tabs.length,1);assert.equal(f.data.runs['2026-10-19'].status,'starting');
  assert.equal(f.tabs[0].url,'https://h5.waimai.meituan.com/waimai/mindex/home');
  assert.equal(f.data.activeRun.config.budget,2500);
  await f.worker.ensureAlarm();assert.equal(f.data.alarm.periodInMinutes,1);
});
test('late wakeup skips the meal and does not catch up on an order',async()=>{
  const f=runtime({schedule:config()},monday+11*60000);await f.worker.tick();await f.worker.tick();
  assert.equal(f.tabs.length,0);assert.equal(f.notices.length,1);assert.equal(f.data.runs['2026-10-19'].status,'missed');
});
test('unknown older submission blocks new orders; a confirmed previous-day order permits the next authorized day',async()=>{
  const f=runtime({schedule:config(),submissionAttempt:true});await f.worker.tick();assert.equal(f.tabs.length,0);
  const g=runtime({schedule:config(),submissionAttempt:true,attemptMeta:{date:'2026-10-16'},lastOrder:{date:'2026-10-16'}});
  await g.worker.tick();assert.equal(g.tabs.length,1);assert.equal(g.data.submissionAttempt,undefined);
});
test('a launch failure retains today claim and is never retried',async()=>{
  const f=runtime({schedule:config()});let count=0;f.api.tabs.create=async()=>{count++;throw Error('browser unavailable');};
  await f.worker.tick();await f.worker.tick();assert.equal(count,1);assert.equal(f.notices.length,1);
});
test('order parser requires official detail, one real UI order number, unpaid status and an amount',()=>{
  const parse=(html,url='https://h5.waimai.meituan.com/waimai/mindex/order-detail?orderId=TESTORDER123&actualLat=SECRET')=>{const dom=new JSDOM(html);const result=S.unpaid(dom.window.document,url);dom.window.close();return result;};
  const result=parse('<p>待支付</p><p>订单号：TESTORDER123</p><p>应付金额：¥23.4</p>');
  assert.equal(result.orderId,'TESTORDER123');assert.equal(result.total,2340);assert.equal(result.url.includes('actualLat'),false);
  for(const html of ['<p>待支付，合计¥23.4</p>','<p>已支付 订单号TESTORDER123 应付金额¥23.4</p>','<p>待支付 订单号TESTORDER123</p>','<p>待支付 订单号TESTORDER123 订单号OTHERORDER123 应付金额¥23.4</p>'])assert.equal(parse(html),null);
  assert.equal(parse('<p>待支付 订单号TESTORDER123 应付金额¥23.4</p>','https://h5.waimai.meituan.com/waimai/mindex/preview'),null);
});
test('notifications are correlated to the exact reserved tab, amount and recent attempt, and are deduplicated',async()=>{
  const f=runtime({notificationToken:'a'.repeat(64)});
  await f.worker.message({type:'reserve',budget:2500,total:2340},f.sender);
  const result={status:'unpaid',orderId:'TESTORDER123',total:2340,url:'https://h5.waimai.meituan.com/waimai/mindex/order-detail?orderId=TESTORDER123'};
  await assert.rejects(f.worker.message({type:'order_result',result},{...f.sender,tab:{...f.sender.tab,id:2}}),/没有可关联/);
  await assert.rejects(f.worker.message({type:'order_result',result:{...result,total:2440}},f.sender),/未确认/);
  await f.worker.message({type:'order_result',result},f.sender);await f.worker.message({type:'order_result',result},f.sender);
  assert.equal(f.notices.length,1);assert.equal(f.pushes.length,1);assert.equal(f.data.lastOrder.orderId,'TESTORDER123');
  assert.match(f.pushes[0].body,/TESTORDER123/);assert.doesNotMatch(f.pushes[0].body,/address|phone|cookie/i);
});
test('expired or paused tasks cannot submit',async()=>{
  const f=runtime({schedule:config()});await f.worker.tick();
  const run=f.data.activeRun;f.setTime(monday+9*60000);
  await assert.rejects(f.worker.message({type:'reserve',runId:run.id,budget:2500,total:2300},f.sender),/停止或超时/);
  assert.equal(f.data.submissionAttempt,undefined);
  f.setTime(monday);await f.worker.message({type:'configure_schedule',schedule:{...config(),enabled:false}},f.options);
  await assert.rejects(f.worker.message({type:'schedule_check',id:run.id},f.sender),/已停止/);
});
test('notification token is never returned by public read and other websites cannot control a schedule',async()=>{
  const f=runtime({notificationToken:'a'.repeat(64)});const state=await f.worker.message({type:'read'},f.options);
  assert.equal(state.notificationConfigured,true);assert.equal(state.notificationToken,undefined);
  await assert.rejects(f.worker.message({type:'configure_schedule',schedule:config()},{id:'test',tab:{id:1,url:'https://evil.example'}}),/不接受/);
});
test('official shop cards exclude non-food stores, pork, closed shops and unaffordable delivery minimums',t=>{
  const rows=[['牛肉饭',20,0,''],['健康药房',0,0,''],['老妈蹄花',0,0,''],['鸡肉饭',26,0,''],['盖浇饭',20,6,''],['奶茶',20,0,''],['羊肉饭',20,0,'休息中']];
  const dom=new JSDOM(rows.map(([name,min,fee,extra])=>`<div class="poilist-item"><div class="poilist-item-info1name">${name}</div>起送 ¥${min} 配送 约¥${fee}${extra}</div>`).join(''),{url:'https://h5.waimai.meituan.com/waimai/mindex/home'});t.after(()=>dom.window.close());
  const adapter=create(dom.window.document,{visible:()=>true});
  assert.deepEqual(adapter.shops(2500,'').map(x=>x.name),['牛肉饭']);
  assert.equal(adapter.shops(2500,'',['牛肉饭']).length,0);
});

test('an authorized alarm runs official home to menu, coupon preview, one unpaid order ID and one payment notification',async t=>{
  const f=runtime({schedule:config(),notificationToken:'a'.repeat(64)});await f.worker.tick();
  const dom=new JSDOM('<title>本地定时测试</title><main id="page"><div class="poilist-item"><div class="poilist-item-info1name">测试牛肉饭店</div>起送 ¥20 配送 约¥0</div></main>',{url:'https://h5.waimai.meituan.com/waimai/mindex/home',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,d=w.document;let additions=0,submits=0;
  w.HTMLElement.prototype.getClientRects=()=>[{width:10,height:10}];w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.chrome={runtime:{id:'test',onMessage:{addListener:()=>{}},sendMessage:msg=>f.worker.message(msg,{id:'test',tab:{id:1,url:w.location.href}}).catch(error=>({ok:false,error:error.message}))}};
  d.querySelector('.poilist-item').onclick=()=>{
    w.history.pushState({},'','/waimai/mindex/menu?poi_id_str=test');
    d.getElementById('page').innerHTML='<dd data-tag="spu"><div class="name_fixture">牛肉饭</div><div data-tag="price">¥22</div><div class="sqt-menu-add-buttons"><span aria-label="选择规格"><span class="clickArea_fixture"></span></span></div></dd><button aria-label="购物车,没有商品"></button><div id="checkout">去结算</div>';
    d.querySelector('.clickArea_fixture').onclick=()=>{additions++;const group=d.querySelector('.sqt-menu-add-buttons');group.innerHTML='<span aria-label="查看已选规格"></span>1';const cart=d.querySelector('[aria-label^="购物车"]');cart.setAttribute('aria-label','购物车');cart.textContent='1';};
    d.getElementById('checkout').onclick=()=>{
      w.history.pushState({},'','/waimai/mindex/preview');
      d.getElementById('page').innerHTML='<div class="spuInfoList_fixture"><span class="spuInfoSpan_fixture">牛肉饭</span><div class="spuAmount_fixture">x1</div></div><div class="promotion_fixture"><span>美团红包</span><span class="promotionSelect_fixture">-¥7</span></div><div><span class="actual_fixture">合计¥16.50</span><button id="sqt-openh5-preview-submit-btn">提交订单</button></div>';
      d.querySelector('.promotion_fixture').onclick=()=>{const modal=d.createElement('section');modal.innerHTML='<span>可使用红包</span><div class="cell-wrapper"><div class="coupon-wrapper"><span class="price-amount-container">¥7</span></div></div><button>确认</button>';modal.querySelector('button').onclick=()=>modal.remove();d.getElementById('page').append(modal);};
      d.querySelector('#sqt-openh5-preview-submit-btn').onclick=()=>{submits++;w.history.pushState({},'','/waimai/mindex/order-detail?orderId=TESTORDER123');d.getElementById('page').innerHTML='<h2>待支付</h2><p>订单号：TESTORDER123</p><p>应付金额：¥16.50</p>';};
    };
  };
  const root=path.resolve(__dirname,'../../browser-extension');
  for(const file of ['guard-data.js','policy.js','schedule.js','adapter.js','styles.js','content.js','watch.js'])w.eval(fs.readFileSync(path.join(root,file),'utf8'));
  await new Promise(resolve=>setTimeout(resolve,2700));
  assert.equal(additions,1);assert.equal(submits,1);assert.equal(f.data.lastOrder?.orderId,'TESTORDER123');
  assert.equal(f.notices.length,1);assert.equal(f.pushes.length,1);assert.equal(f.data.activeRun.stage,'done');
  await f.worker.tick();assert.equal(f.tabs.length,1);
});
