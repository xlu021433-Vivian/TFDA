const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require('../.tool-cache/browser-tests/node_modules/jsdom');}})();
const P=require('./engine/policy.js'),S=require('./engine/schedule.js');
const pause=()=>new Promise(resolve=>setTimeout(resolve,15));
async function panel(t,{initial={},handle=async()=>({ok:true})}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'options.html'),'utf8'),{url:'https://shenqi.local/options.html',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,d=w.document,data={preferences:{budget:'25',mode:'unpaid'},...structuredClone(initial)},listeners=[],nativeCalls=[],messages=[];
  function emit(state){for(const listener of listeners)listener({data:{channel:'page-state',state}});}
  w.chrome={webview:{addEventListener:(type,fn)=>listeners.push(fn),postMessage:request=>{
    nativeCalls.push(request);
    const result=request.action==='storage_get'?Object.fromEntries(request.args.keys.filter(key=>key in data).map(key=>[key,data[key]])):request.action==='status'?{}:{ok:true};
    if(request.action==='storage_set')Object.assign(data,request.args.change);
    if(request.action==='storage_remove')for(const key of request.args.keys)delete data[key];
    queueMicrotask(()=>listeners.forEach(fn=>fn({data:{channel:'native-result',id:request.id,result}})));
  }}};
  w.ShenqiPolicy=P;w.ShenqiSchedule=S;w.ShenqiDesktopWorker={createRuntime:()=>({tick:async()=>{},message:async body=>{messages.push(body);return handle(body,data);}})};
  w.eval(fs.readFileSync(path.join(__dirname,'desktop.js'),'utf8'));await pause();emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/home',loginNeeded:false});await pause();
  const $=id=>d.getElementById(id),change=id=>$(id).dispatchEvent(new w.Event('change'));
  return {w,d,data,$,emit,change,nativeCalls,messages};
}
test('login and new page navigation revoke readiness and per-meal consent',async t=>{
  const f=await panel(t);f.$('mealConsent').checked=true;f.change('mealConsent');assert.equal(f.$('startMeal').disabled,false);
  f.emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/mine',loginNeeded:true});await pause();assert.equal(f.$('startMeal').disabled,true);assert.match(f.$('startHint').textContent,/登录/);assert.equal(f.$('mealConsent').checked,false);
  f.emit({ready:false});assert.equal(f.$('startMeal').disabled,true);
});
test('a conflicting budget is shown before an authorized start, not after navigation',async t=>{
  const f=await panel(t);f.$('request').value='想吃河粉 25元预算 一份';f.$('request').dispatchEvent(new f.w.Event('input'));f.$('budget').value='30';f.$('budget').dispatchEvent(new f.w.Event('input'));f.$('mealConsent').checked=true;f.change('mealConsent');
  assert.match(f.$('intentResult').textContent,/预算.*不一致/);assert.equal(f.$('startMeal').disabled,true);assert.equal(f.messages.length,0);
});
test('quick examples only fill the request; tabs expose one action surface with keyboard navigation',async t=>{
  const f=await panel(t);f.d.querySelector('[data-request*="河粉"]').click();assert.match(f.$('request').value,/河粉/);assert.match(f.$('intentResult').textContent,/河粉/);assert.equal(f.messages.length,0);
  f.$('mealTab').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowRight'}));assert.equal(f.$('scheduleTab').getAttribute('aria-selected'),'true');assert.equal(f.$('mealAction').hidden,true);assert.equal(f.$('mealTab').tabIndex,-1);
  f.$('mealTab').click();assert.equal(f.$('mealAction').hidden,false);
});
test('two rapid start clicks issue only one task',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const f=await panel(t,{handle:async body=>body.type==='start_now'?pending:{ok:true}});
  f.$('mealConsent').checked=true;f.change('mealConsent');f.$('startMeal').click();f.$('startMeal').click();await pause();assert.equal(f.messages.filter(x=>x.type==='start_now').length,1);assert.equal(f.$('startMeal').disabled,true);finish({ok:true});await pause();assert.equal(f.$('mealConsent').checked,false);
});
test('manual specification continuation requires acknowledgement and sends no new meal',async t=>{
  const f=await panel(t,{initial:{activeRun:{id:'waiting',stage:'menu',config:S.defaults}}});f.emit({ready:true,url:'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture',pendingSpecs:true});await pause();
  assert.equal(f.$('manualSpecs').hidden,false);assert.equal(f.$('resumeSpecs').disabled,true);assert.equal(f.$('mealAction').hidden,true);
  assert.equal(f.$('steps').querySelector('.current').dataset.step,'menu');
  f.$('specConsent').checked=true;f.change('specConsent');f.$('resumeSpecs').click();await pause();
  assert.equal(f.messages.filter(x=>x.type==='start_now').length,0);assert.ok(f.nativeCalls.some(x=>x.action==='page_command'&&x.args.body.type==='verify_pending'&&x.args.body.reviewed));assert.equal(f.$('specConsent').checked,false);
});
test('historical failures stay collapsed and unknown active submissions cannot be cleared',async t=>{
  const f=await panel(t,{initial:{activeRun:{id:'old',stage:'failed',reason:'旧失败'}}});assert.equal(f.$('history').hidden,false);assert.equal(f.$('history').open,false);assert.equal(f.$('flow').hidden,true);
  f.data.activeRun={id:'new',stage:'preview'};f.data.submissionAttempt=true;await f.w.Desktop.inspect();f.$('reviewed').checked=true;f.change('reviewed');assert.equal(f.$('clear').disabled,true);assert.match(f.$('recoveryHint').textContent,/先点.*暂停/);assert.equal(f.$('history').hidden,true);
});
test('the stop command is still sent while another action is busy',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const f=await panel(t,{initial:{activeRun:{id:'busy',stage:'menu',config:S.defaults}},handle:async body=>body.type==='configure_schedule'?pending:{ok:true}});
  f.$('saveSchedule').click();await pause();f.$('stop').click();await pause();assert.ok(f.nativeCalls.some(x=>x.action==='page_command'&&x.args.body.type==='stop_scheduled'));finish({ok:true});await pause();
});
