const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const folder=path.resolve(process.env.SHENQI_DESKTOP_ASSETS||'dist/desktop-0.5.4/assets');
const P=require(path.join(folder,'policy.js')),S=require(path.join(folder,'schedule.js'));
const sandbox={ShenqiPolicy:P,ShenqiSchedule:S,Date,crypto,structuredClone,URL};
vm.runInNewContext(fs.readFileSync(path.join(folder,'worker.js'),'utf8'),sandbox);
function setup(initial={}){
  const data=structuredClone(initial),tabs=[],notifications=[];
  const api={runtime:{id:'desktop-test',getURL:name=>'https://shenqi.local/'+name},storage:{local:{get:async()=>structuredClone(data),set:async value=>Object.assign(data,structuredClone(value)),remove:async keys=>keys.forEach(key=>delete data[key])}},tabs:{create:async()=>({id:1}),update:async(id,value)=>tabs.push(value),sendMessage:async()=>{}},notifications:{create:async(id,value)=>notifications.push(value)},alarms:{get:async()=>true,create:async()=>{}},scripting:{executeScript:async()=>{}}};
  const runtime=sandbox.ShenqiDesktopWorker.createRuntime(api,{now:()=>Date.parse('2026-10-20T03:00:00Z')});
  const panel={id:'desktop-test',url:'https://shenqi.local/options.html'};
  const page={id:'desktop-test',url:'https://h5.waimai.meituan.com/waimai/mindex/preview',tab:{id:1,url:'https://h5.waimai.meituan.com/waimai/mindex/preview'}};
  return {data,tabs,runtime,panel,page,api,notifications};
}
const request={type:'start_now',schedule:{...S.defaults,enabled:true,authorized:true}};

test('worker rejects a medical store even if a page bypasses candidate filtering',async()=>{
  const f=setup();await f.runtime.message(request,f.panel);const id=f.data.activeRun.id;
  await assert.rejects(f.runtime.message({type:'schedule_shop',id,name:'111医药馆（丈八北路店）',minimum:2000},f.page));
  assert.equal(f.data.activeRun.stage,'home');assert.deepEqual(f.data.activeRun.tried,[]);
});
test('one meal can run with recurrence off, without enabling recurrence',async()=>{
  const f=setup({schedule:{...S.defaults,enabled:false}});await f.runtime.message(request,f.panel);
  assert.equal(f.data.schedule.enabled,false);assert.equal(f.data.activeRun.oneShot,true);assert.equal(f.tabs.length,1);
  const id=f.data.activeRun.id;await f.runtime.message({type:'reserve',runId:id,budget:2500,total:1500},f.page);
  assert.equal(f.data.submissionAttempt,true);assert.equal(f.data.attemptMeta.total,1500);
});
test('concurrent clicks start one task; unresolved attempts block new meals',async()=>{
  const f=setup();const result=await Promise.allSettled([f.runtime.message(request,f.panel),f.runtime.message(request,f.panel)]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.tabs.length,1);
  const g=setup({submissionAttempt:true});await assert.rejects(g.runtime.message(request,g.panel));assert.equal(g.tabs.length,0);
});
test('unapproved, foreign-page and conflicting-budget requests do not open a merchant',async()=>{
  const f=setup();await assert.rejects(f.runtime.message({...request,schedule:{...request.schedule,authorized:false}},f.panel));
  await assert.rejects(f.runtime.message(request,f.page));
  await assert.rejects(f.runtime.message({...request,schedule:{...request.schedule,request:'奶茶预算30元'}},f.panel));assert.equal(f.tabs.length,0);
});
test('pause stops the one-shot permission; failed persistence cannot navigate or reserve',async()=>{
  const f=setup();await f.runtime.message(request,f.panel);const id=f.data.activeRun.id;
  await f.runtime.message({type:'configure_schedule',schedule:{...S.defaults,enabled:false}},f.panel);
  await assert.rejects(f.runtime.message({type:'reserve',runId:id,budget:2500,total:1500},f.page));
  const g=setup();g.api.storage.local.set=async()=>{throw Error('disk full');};await assert.rejects(g.runtime.message(request,g.panel));assert.equal(g.tabs.length,0);
});
test('coupon, pork and real-order parsing guards are retained',()=>{
  assert.equal(P.previewVerdict(1500,2500,[]).ok,false);assert.equal(P.previewVerdict(3000,2500,[{discount:300}]).ok,false);
  assert.ok(P.inspectName('猪肉饭'));assert.equal(P.inspectName('牛肉饭'),'');assert.equal(S.unpaid({body:{cloneNode(){throw Error('must not inspect nonofficial');}}},'https://example.com/pay'),null);
});
test('starting inside the selected merchant retains it and rejects foreign menu URLs',async()=>{
  const f=setup(),url='https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture';
  await f.runtime.message({...request,currentMenu:url},f.panel);
  assert.equal(f.data.activeRun.stage,'menu');assert.equal(f.data.activeRun.currentShop,true);assert.equal(f.tabs[0].url,url);
  for(const currentMenu of ['https://example.com/waimai/mindex/menu?poi_id_str=x','https://h5.waimai.meituan.com:8443/waimai/mindex/menu?poi_id_str=x','https://h5.waimai.meituan.com/waimai/mindex/menu']){
    const g=setup();await assert.rejects(g.runtime.message({...request,currentMenu},g.panel));assert.equal(g.tabs.length,0);
  }
});
test('an active submission cannot lose its duplicate guard; stopping retains it until reviewed',async()=>{
  const f=setup();await f.runtime.message(request,f.panel);const id=f.data.activeRun.id;
  await f.runtime.message({type:'reserve',runId:id,budget:2500,total:1500},f.page);
  await assert.rejects(f.runtime.message({type:'clear',reviewed:true},f.panel),/先暂停/);assert.equal(f.data.submissionAttempt,true);
  await f.runtime.message({type:'configure_schedule',schedule:{...S.defaults,enabled:false}},f.panel);assert.equal(f.data.submissionAttempt,true);
  await f.runtime.message({type:'clear',reviewed:true},f.panel);assert.equal(f.data.submissionAttempt,undefined);
});
test('manual specification attention notifies once and keeps the task available for review',async()=>{
  const f=setup();await f.runtime.message({...request,currentMenu:'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture'},f.panel);
  const id=f.data.activeRun.id;await f.runtime.message({type:'schedule_attention',id},f.page);await f.runtime.message({type:'schedule_attention',id},f.page);
  assert.equal(f.notifications.length,1);assert.equal(f.data.activeRun.stage,'menu');assert.equal(f.data.submissionAttempt,undefined);
  await f.runtime.message({type:'schedule_check',id},f.page);
});
