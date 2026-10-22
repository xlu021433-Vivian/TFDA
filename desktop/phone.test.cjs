const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require('../.tool-cache/browser-tests/node_modules/jsdom');}})();
const policy=require('./engine/policy.js');
const wait=()=>new Promise(resolve=>setTimeout(resolve,15));
async function page(t,state={}){
  const root=path.join(__dirname,'../web/static'),dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://l5space.icu/shenqi/',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,calls=[];let release;
  w.ShenqiPolicy=policy;
  w.fetch=async(url,options)=>{
    if(options.method==='POST'){calls.push(JSON.parse(options.body));await new Promise(resolve=>release=resolve);return {ok:true,json:async()=>({ok:true})};}
    return {ok:true,json:async()=>({ok:true,csrf:'fixture',status:{online:true,enabled:true,ready:true,...state}})};
  };
  w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));await wait();
  return {w,d:w.document,calls,finish:()=>release?.()};
}
test('phone starts only on an explicit click, carries the interpreted budget, and blocks a double click',async t=>{
  const f=await page(t),request=f.d.getElementById('request'),button=f.d.getElementById('start');
  request.value='想吃河粉 25元预算 一份';request.dispatchEvent(new f.w.Event('input'));
  assert.match(f.d.getElementById('intent').textContent,/河粉.*1.*25/);assert.equal(f.calls.length,0);assert.equal(button.disabled,false);
  button.click();button.click();await wait();assert.equal(f.calls.length,1);assert.equal(f.calls[0].budget,2500);assert.equal(f.calls[0].authorized,true);assert.equal(button.disabled,true);f.finish();await wait();assert.equal(button.disabled,true);
});
test('phone blocks disconnected or signed-out desktops and conflicting budgets without sending a meal',async t=>{
  const offline=await page(t,{online:false});offline.d.getElementById('start').click();assert.equal(offline.calls.length,0);
  const signedOut=await page(t,{loginNeeded:true});assert.equal(signedOut.d.getElementById('start').disabled,true);
  const f=await page(t),request=f.d.getElementById('request');request.value='想吃河粉 25元预算 一份';request.dispatchEvent(new f.w.Event('input'));const budget=f.d.getElementById('budget');budget.value='30';budget.dispatchEvent(new f.w.Event('input'));
  assert.equal(f.d.getElementById('start').disabled,true);assert.match(f.d.getElementById('intent').textContent,/不一致/);assert.equal(f.calls.length,0);
});
