const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require('../.tool-cache/browser-tests/node_modules/jsdom');}})();
const P=require('./engine/policy.js'),S=require('./engine/schedule.js');
const pause=()=>new Promise(resolve=>setTimeout(resolve,15));
async function panel(t,{initial={},handle=async()=>({ok:true}),status={}}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'options.html'),'utf8'),{url:'https://shenqi.local/options.html',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,d=w.document,data={preferences:{budget:'25',mode:'unpaid'},...structuredClone(initial)},listeners=[],nativeCalls=[],messages=[];
  function emit(state){for(const listener of listeners)listener({data:{channel:'page-state',state}});}
  w.chrome={webview:{addEventListener:(type,fn)=>listeners.push(fn),postMessage:request=>{
    nativeCalls.push(request);
    const result=request.action==='storage_get'?Object.fromEntries(request.args.keys.filter(key=>key in data).map(key=>[key,data[key]])):request.action==='status'?structuredClone(status):{ok:true};
    if(request.action==='storage_set')Object.assign(data,request.args.change);
    if(request.action==='storage_remove')for(const key of request.args.keys)delete data[key];
    queueMicrotask(()=>listeners.forEach(fn=>fn({data:{channel:'native-result',id:request.id,result}})));
  }}};
  w.ShenqiPolicy=P;w.ShenqiSchedule=S;w.ShenqiDesktopWorker={createRuntime:()=>({tick:async()=>{},message:async body=>{messages.push(body);return handle(body,data);}})};
  w.eval(fs.readFileSync(path.join(__dirname,'desktop.js'),'utf8'));await pause();emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/home',loginNeeded:false});await pause();
  const $=id=>d.getElementById(id),change=id=>$(id).dispatchEvent(new w.Event('change'));
  return {w,d,data,$,emit,change,nativeCalls,messages};
}
test('the start button states what one click authorizes, and login or navigation disables it',async t=>{
  const f=await panel(t);assert.equal(f.$('startMeal').disabled,false);assert.match(f.$('startMeal').textContent,/用券选1餐.*¥25\.00/);assert.match(f.$('startHint').textContent,/点击即授权.*1笔待支付订单/);
  f.emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/mine',loginNeeded:true});await pause();assert.equal(f.$('startMeal').disabled,true);assert.match(f.$('startHint').textContent,/登录/);
  f.emit({ready:false});assert.equal(f.$('startMeal').disabled,true);assert.equal(f.messages.length,0);
});
test('a conflicting budget is shown before an authorized start, not after navigation',async t=>{
  const f=await panel(t);f.$('request').value='想吃河粉 25元预算 一份';f.$('request').dispatchEvent(new f.w.Event('input'));f.$('budget').value='30';f.$('budget').dispatchEvent(new f.w.Event('input'));
  assert.match(f.$('intentResult').textContent,/预算.*不一致/);assert.equal(f.$('startMeal').disabled,true);assert.equal(f.messages.length,0);
});
test('quick examples only fill the request; tabs expose one action surface with keyboard navigation',async t=>{
  const f=await panel(t);f.d.querySelector('[data-request*="河粉"]').click();assert.match(f.$('request').value,/河粉/);assert.match(f.$('intentResult').textContent,/河粉/);assert.equal(f.messages.length,0);
  f.$('mealTab').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowRight'}));assert.equal(f.$('scheduleTab').getAttribute('aria-selected'),'true');assert.equal(f.$('mealAction').hidden,true);assert.equal(f.$('mealTab').tabIndex,-1);
  f.$('mealTab').click();assert.equal(f.$('mealAction').hidden,false);
});
test('two rapid start clicks issue only one task',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const f=await panel(t,{handle:async body=>body.type==='start_now'?pending:{ok:true}});
  f.$('startMeal').click();f.$('startMeal').click();await pause();assert.equal(f.messages.filter(x=>x.type==='start_now').length,1);assert.equal(f.$('startMeal').disabled,true);finish({ok:true});await pause();assert.equal(f.messages.filter(x=>x.type==='start_now').length,1);
});
test('manual specification continuation requires acknowledgement and sends no new meal',async t=>{
  const f=await panel(t,{initial:{activeRun:{id:'waiting',stage:'menu',config:S.defaults}}});f.emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture',pendingSpecs:true});await pause();
  assert.equal(f.$('manualSpecs').hidden,false);assert.equal(f.$('resumeSpecs').disabled,true);assert.equal(f.$('mealAction').hidden,true);
  assert.equal(f.$('steps').querySelector('.current').dataset.step,'menu');
  f.$('specConsent').checked=true;f.change('specConsent');f.$('resumeSpecs').click();await pause();
  assert.equal(f.messages.filter(x=>x.type==='start_now').length,0);assert.ok(f.nativeCalls.some(x=>x.action==='page_command'&&x.args.body.type==='verify_pending'&&x.args.body.reviewed));assert.equal(f.$('specConsent').checked,false);
});
test('a failed meal shows its reason above the note until dismissed; unknown active submissions cannot be cleared',async t=>{
  const f=await panel(t,{initial:{activeRun:{id:'old',stage:'failed',reason:'已核对5家餐厅仍没有符合本次需求的餐品'}}});
  assert.equal(f.$('flow').hidden,false);assert.equal(f.$('flowTitle').textContent,'上次没点成');assert.match(f.$('flowDetail').textContent,/5家餐厅/);assert.equal(f.$('requestForm').hidden,false);assert.equal(f.$('startMeal').disabled,false);
  f.$('dismissRun').click();assert.equal(f.$('flow').hidden,true);
  f.data.activeRun={id:'new',stage:'preview'};f.data.submissionAttempt=true;await f.w.Desktop.inspect();f.$('reviewed').checked=true;f.change('reviewed');assert.equal(f.$('clear').disabled,true);assert.match(f.$('recoveryHint').textContent,/先点.*暂停/);assert.equal(f.$('dismissRun').hidden,true);
});
test('the stop command is still sent while another action is busy',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const f=await panel(t,{initial:{activeRun:{id:'busy',stage:'menu',config:S.defaults}},handle:async body=>body.type==='configure_schedule'?pending:{ok:true}});
  f.$('saveSchedule').click();await pause();f.$('stop').click();await pause();assert.ok(f.nativeCalls.some(x=>x.action==='page_command'&&x.args.body.type==='stop_scheduled'));finish({ok:true});await pause();
});
test('remote meals require the local opt-in and reuse budget, login and duplicate guards',async t=>{
  const f=await panel(t);
  const input={id:'fixture-id',kind:'meal',request:'想吃河粉 25元预算 一份',budget:2500,authorized:true};
  assert.equal((await f.w.Desktop.remoteCommand(input)).ok,false);
  assert.equal(f.messages.length,0);
  const source=fs.readFileSync(path.join(__dirname,'desktop.js'),'utf8');
  assert.match(source,/!nativeStatus.remoteEnabled/);
  assert.match(source,/intent\.budget!==null&&intent\.budget!==budget/);
  const state=f.w.Desktop.remoteStatus();assert.equal(state.ready,true);
  assert.equal('barkKey' in state,false);assert.equal('preferences' in state,false);
});
test('remote pause is available without initiating or enabling a meal',async t=>{
  const f=await panel(t,{initial:{activeRun:{id:'remote',stage:'menu',config:S.defaults}}});
  const result=await f.w.Desktop.remoteCommand({id:'stop-fixture',kind:'stop'});
  assert.equal(result.ok,true);assert.ok(f.nativeCalls.some(x=>x.action==='page_command'&&x.args.body.type==='stop_scheduled'));
  assert.equal(f.messages.filter(x=>x.type==='start_now').length,0);
});


test('unsupported-page recovery only returns home and never starts or submits a meal',async t=>{
  const f=await panel(t,{initial:{activeRun:{id:'wrong-store',stage:'failed'}}});
  f.emit({ready:false,error:'当前是非餐饮商家，已停止选餐和加购。'});await pause();assert.equal(f.$('recoverHome').hidden,false);
  f.$('recoverHome').click();await pause();assert.ok(f.nativeCalls.some(x=>x.action==='navigate'&&x.args.url==='https://h5.waimai.meituan.com/waimai/mindex/home'));assert.equal(f.messages.length,0);
  f.data.submissionAttempt=true;await f.w.Desktop.inspect();assert.equal(f.$('recoverHome').hidden,true);
});


test('unverified observed orders remain visible and block starting another meal',async t=>{
  const f=await panel(t,{initial:{observedOrder:{orderId:'4402356522089986176',total:2390,url:'https://h5.waimai.meituan.com/waimai/mindex/order-detail?mtOrderViewId=4402356522089986176',source:'observed'}}});
  assert.equal(f.$('order').hidden,false);assert.match(f.$('orderHint').textContent,/未核实/);assert.match(f.$('orderTitle').textContent,/发现/);assert.equal(f.$('mealAction').hidden,true);assert.equal(f.w.Desktop.remoteStatus().locked,true);assert.equal(f.w.Desktop.remoteStatus().order.couponVerified,false);
});

test('the official cashier explains why a new meal waits, and a page error outranks it',async t=>{
  const f=await panel(t);
  f.emit({ready:false,cashier:true,complete:true,status:'已进入美团官方付款页',url:'https://mpay.meituan.com/resource/icashier/s/index.html'});await pause();
  assert.equal(f.$('connection').textContent,'已进入官方付款页');assert.match(f.$('startHint').textContent,/付款页/);assert.equal(f.$('startMeal').disabled,true);
  f.emit({ready:false,cashier:true,error:'网页加载失败：ConnectionAborted',url:'https://mpay.meituan.com/resource/icashier/s/index.html'});await pause();
  assert.equal(f.$('connection').textContent,'美团页面暂时无法打开');assert.match(f.$('pageStatus').textContent,/ConnectionAborted/);
});

test('messages sit outside the scrolling area; there is no separate consent checkbox',async t=>{
  const f=await panel(t);assert.equal(f.$('message').closest('main'),null);assert.equal(f.d.getElementById('mealConsent'),null);
  assert.equal(f.d.querySelector('#mealAction input[type=checkbox]'),null);assert.equal(f.$('startMeal').disabled,false);
});

test('away from the start pages the home action becomes a visible way back',async t=>{
  const f=await panel(t);assert.match(f.$('home').textContent,/挑店/);
  f.emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/address-list'});await pause();
  assert.match(f.$('home').textContent,/返回外卖首页/);assert.equal(f.$('home').hidden,false);
  f.$('home').click();await pause();assert.ok(f.nativeCalls.some(x=>x.action==='navigate'&&x.args.url==='https://h5.waimai.meituan.com/waimai/mindex/home'));assert.equal(f.messages.length,0);
});

test('a meal can start from any official page; the runtime returns home instead of keeping that page',async t=>{
  const f=await panel(t);f.emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/address-list'});await pause();
  assert.equal(f.$('startMeal').disabled,false);f.$('startMeal').click();await pause();
  const start=f.messages.find(x=>x.type==='start_now');assert.ok(start);assert.equal(start.currentMenu,null);assert.equal(start.schedule.authorized,true);
});

test('inside a merchant menu the button keeps that merchant',async t=>{
  const f=await panel(t);f.emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture'});await pause();
  assert.match(f.$('startMeal').textContent,/^在这家店用券选1餐/);f.$('startMeal').click();await pause();
  assert.equal(f.messages.find(x=>x.type==='start_now').currentMenu,'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture');
});

test('a newer published version replaces the version label with a download action',async t=>{
  const plain=await panel(t,{status:{version:'0.6.5'}});assert.equal(plain.$('version').textContent,'0.6.5');assert.equal(plain.$('update').hidden,true);
  const f=await panel(t,{status:{version:'0.6.5',latestVersion:'0.6.6'}});
  assert.equal(f.$('update').hidden,false);assert.match(f.$('update').textContent,/0\.6\.6/);assert.equal(f.$('version').hidden,true);
  f.$('update').click();await pause();assert.ok(f.nativeCalls.some(x=>x.action==='open_update'));assert.equal(f.messages.length,0);
});

