'use strict';
if(typeof importScripts==='function')importScripts('guard-data.js','policy.js','schedule.js');
(function(root){
  const P=typeof module!=='undefined'&&module.exports?require('./policy.js'):root.ShenqiPolicy;
  const S=typeof module!=='undefined'&&module.exports?require('./schedule.js'):root.ShenqiSchedule;
  function createRuntime(api,{now=Date.now,random=Math.random,fetcher=globalThis.fetch}={}){
    let queue=Promise.resolve();
    const serialize=fn=>{const result=queue.then(fn,fn);queue=result.catch(()=>{});return result;};
    const read=()=>api.storage.local.get(['preferences','submissionAttempt','attemptMeta','schedule','runs','activeRun','lastOrder','notificationToken','notificationStatus']);
    const extensionSender=sender=>sender.id===api.runtime.id&&sender.url?.startsWith(api.runtime.getURL('options.html'));
    const pageSender=sender=>sender.id===api.runtime.id&&sender.tab&&P.supported(sender.tab.url||'');
    const runFor=(state,sender)=>state.activeRun?.tabId===sender.tab?.id?state.activeRun:null;
    function validRun(state,sender,id){
      const run=runFor(state,sender);
      if(!run||run.id!==id||!state.schedule?.enabled||['failed','done','stopped'].includes(run.stage)||now()>run.deadline)throw Error('定时任务已停止或超时，不会提交');
      return run;
    }
    function publicState(state,sender){
      const run=runFor(state,sender);
      return {ok:true,preferences:state.preferences||{},attempt:!!state.submissionAttempt,
        run:run&&!['done','failed','stopped'].includes(run.stage)?run:null,
        schedule:state.schedule||structuredClone(S.defaults),lastOrder:state.lastOrder||null,
        notificationConfigured:!!state.notificationToken,notificationStatus:state.notificationStatus||null};
    }
    async function notify(title,body,url,kind='attention',order){
      const status={time:now(),desktop:false,bark:false};
      try{await api.notifications.create('shenqi-'+(order?.orderId||now()),{type:'basic',iconUrl:api.runtime.getURL('icon.png'),title,message:body});status.desktop=true;}catch{}
      const {notificationToken}=await read();
      if(notificationToken){
        try{
          const response=await fetcher('http://127.0.0.1:8765/api/browser-events',{method:'POST',headers:{'Content-Type':'application/json','X-Shenqi-Notify-Token':notificationToken},body:JSON.stringify(kind==='unpaid'?{kind,orderId:order.orderId,total:order.total,url}:{kind,message:body}),signal:AbortSignal.timeout(12000)});
          const result=await response.json();status.bark=response.ok&&result.delivered===true;
        }catch{}
      }
      await api.storage.local.set({notificationStatus:status});return status;
    }
    async function fail(state,reason){
      const run=state.activeRun;
      if(run)await api.storage.local.set({activeRun:{...run,stage:'failed',reason},runs:{...state.runs,[run.date]:{status:'failed',reason,time:now()}}});
      await notify('神器 · 本次点餐需处理',reason+'；未确认生成新的待支付订单，请查看官方页面。');
      return {ok:true};
    }
    async function handle(message,sender){
      if(!pageSender(sender)&&!extensionSender(sender))throw Error('不接受此页面的请求');
      const state=await read(),isOptions=extensionSender(sender);
      if(message.type==='read')return publicState(state,sender);
      if(message.type==='save'){
        const v=message.preferences;
        if(!v||!/^\d+(?:\.\d{1,2})?$/.test(String(v.budget))||Number(v.budget)<=0||!['preview','unpaid'].includes(v.mode)||typeof v.expand!=='boolean')throw Error('设置格式无效');
        await api.storage.local.set({preferences:{budget:String(v.budget),mode:v.mode,expand:v.expand,noPork:true,requireCoupon:true}});return {ok:true};
      }
      if(message.type==='configure_schedule'&&isOptions){
        const config=S.validate(message.schedule);await api.storage.local.set({schedule:config});await ensureAlarm();
        if(!config.enabled&&state.activeRun&&!['done','failed','stopped'].includes(state.activeRun.stage)){
          await api.storage.local.set({activeRun:{...state.activeRun,stage:'stopped'}});
          try{await api.tabs.sendMessage(state.activeRun.tabId,{type:'stop_scheduled'});}catch{}
        }
        return {ok:true};
      }
      if(message.type==='connect_notifications'&&isOptions){
        if(!/^[a-f0-9]{64}$/.test(message.token||''))throw Error('请从本机助手获取有效连接码');
        await api.storage.local.set({notificationToken:message.token});return {ok:true};
      }
      if(message.type==='test_notifications'&&isOptions)return {ok:true,...await notify('神器 · 通知测试','定时点餐通知连接测试，当前未创建订单。',null,'test')};
      if(message.type==='schedule_check')return {ok:true,run:validRun(state,sender,message.id)};
      if(message.type==='schedule_stage'){
        const run=validRun(state,sender,message.id);
        if(!['home','menu','preview'].includes(message.stage))throw Error('无效任务阶段');
        let expected=run.expected;
        if(message.stage==='preview'){
          expected=message.expected;
          if(!Array.isArray(expected)||!expected.length||expected.some(x=>typeof x.name!=='string'||P.inspectName(x.name)||!Number.isInteger(x.desired)||x.desired<1||x.desired>10))throw Error('餐品信息无效');
        }
        await api.storage.local.set({activeRun:{...run,stage:message.stage,expected}});return {ok:true};
      }
      if(message.type==='schedule_shop'){
        const run=validRun(state,sender,message.id);
        if(typeof message.name!=='string'||message.name.length>100||run.tried.length>=5||!Number.isSafeInteger(message.minimum))throw Error('已达到选店次数或店铺信息无效');
        await api.storage.local.set({activeRun:{...run,stage:'menu',shopName:message.name,minimum:message.minimum,tried:[...run.tried,message.name]}});return {ok:true};
      }
      if(message.type==='schedule_failed'){validRun(state,sender,message.id);return fail(state,String(message.reason||'页面未提供可用点餐流程').slice(0,160));}
      if(message.type==='reserve'){
        if(state.submissionAttempt)throw Error('已有提交尝试，请先到官方订单列表核对，避免重复下单');
        if(message.runId)validRun(state,sender,message.runId);
        const budget=message.budget,total=message.total;
        if(!Number.isSafeInteger(budget)||!Number.isSafeInteger(total)||total<0||total>budget)throw Error('无法核对提交金额');
        await api.storage.local.set({submissionAttempt:true,attemptMeta:{tabId:sender.tab.id,runId:message.runId||null,time:now(),date:S.clock(now()).date,budget,total}});return {ok:true};
      }
      if(message.type==='order_result'){
        const meta=state.attemptMeta,r=message.result;
        if(!state.submissionAttempt||!meta||meta.tabId!==sender.tab.id||now()-meta.time>15*60*1000)throw Error('没有可关联的本次提交');
        if(!r||r.status!=='unpaid'||!/^[A-Za-z0-9-]{8,40}$/.test(r.orderId)||r.total!==meta.total||!P.supported(r.url)||!/\/(order-detail|orderdetail|cashier|pay)(\/|$)/.test(new URL(r.url).pathname))throw Error('未确认真实订单号、待支付状态及金额');
        if(state.lastOrder?.orderId===r.orderId)return {ok:true,duplicate:true};
        const order={orderId:r.orderId,total:r.total,url:r.url,date:meta.date,time:now(),status:'unpaid'};
        const change={lastOrder:order};
        if(meta.runId&&state.activeRun?.id===meta.runId){change.activeRun={...state.activeRun,stage:'done'};change.runs={...state.runs,[meta.date]:{status:'unpaid',orderId:r.orderId,time:now()}};}
        await api.storage.local.set(change);
        await notify('神器 · 外卖待支付',`订单号：${r.orderId}\n待支付：${P.money(r.total)}\n请在平台有效期内付款。`,r.url,'unpaid',order);
        return {ok:true};
      }
      if(message.type==='clear'&&message.reviewed===true){await api.storage.local.remove(['submissionAttempt','attemptMeta']);return {ok:true};}
      throw Error('未知操作');
    }
    async function tick(){
      const state=await read(),config=state.schedule;
      if(state.activeRun&&!['done','failed','stopped'].includes(state.activeRun.stage)){
        if(now()>state.activeRun.deadline)await fail(state,'定时点餐超时或页面未确认订单号，不会重试提交');return;
      }
      if(!config)return;const due=S.due(config,state.runs||{},now());if(!due)return;
      const runs={...state.runs,[due.date]:{status:due.missed?'missed':'starting',time:now()}};
      const recent=Object.fromEntries(Object.entries(runs).sort().slice(-40));await api.storage.local.set({runs:recent});
      if(due.missed){await notify('神器 · 今日定时点餐已跳过','浏览器未在定时窗口内运行，已跳过今日点餐，不会在稍后补下单。');return;}
      if(state.submissionAttempt){
        if(!state.lastOrder||state.lastOrder.date>=due.date||state.attemptMeta?.date!==state.lastOrder.date){await notify('神器 · 今日未下单','上次提交结果尚未核对，请先检查官方订单，今天不重复下单。');return;}
        await api.storage.local.remove(['submissionAttempt','attemptMeta']);
      }
      let tab;
      try{
        const id=crypto.randomUUID(),merchants=config.merchants||[];
        const picked=config.anyShop?null:merchants[Math.floor(random()*merchants.length)];
        tab=await api.tabs.create({url:'about:blank',active:false});
        const run={id,date:due.date,tabId:tab.id,stage:picked?'menu':'home',tried:[],minimum:0,startedAt:now(),deadline:now()+8*60*1000,config,merchant:picked,expected:null};
        await api.storage.local.set({activeRun:run});await api.tabs.update(tab.id,{url:picked?.url||'https://h5.waimai.meituan.com/waimai/mindex/home'});
      }catch{
        const latest=await read();
        if(latest.activeRun?.date===due.date)await fail(latest,'无法打开浏览器点餐页');
        else{await api.storage.local.set({runs:{...recent,[due.date]:{status:'failed',reason:'无法打开浏览器点餐页',time:now()}}});await notify('神器 · 本次未下单','无法打开浏览器点餐页，今天不自动重试。');}
      }
    }
    async function inject(tabId,change,tab){
      const state=await read(),run=state.activeRun;
      if(change.status!=='complete'||!run||run.tabId!==tabId||['done','failed','stopped'].includes(run.stage)||!P.supported(tab.url||''))return;
      try{await api.scripting.executeScript({target:{tabId},files:['guard-data.js','policy.js','schedule.js','adapter.js','styles.js','content.js','watch.js']});}catch{await fail(state,'浏览器没有允许美团网页操作，请检查扩展站点权限');}
    }
    async function ensureAlarm(){if(!await api.alarms.get('shenqi-meal-tick'))await api.alarms.create('shenqi-meal-tick',{periodInMinutes:1});}
    return {message:(m,s)=>serialize(()=>handle(m,s)),tick:()=>serialize(tick),inject:(...args)=>serialize(()=>inject(...args)),ensureAlarm,serialize};
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={createRuntime};return;}
  const runtime=createRuntime(chrome);
  chrome.runtime.onMessage.addListener((m,s,reply)=>{runtime.message(m,s).then(reply,error=>reply({ok:false,error:error.message}));return true;});
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='shenqi-meal-tick')runtime.tick().catch(()=>{});});
  chrome.tabs.onUpdated.addListener((...args)=>runtime.inject(...args).catch(()=>{}));
  chrome.runtime.onStartup.addListener(()=>{runtime.ensureAlarm().then(()=>runtime.tick()).catch(()=>{});});
  chrome.runtime.onInstalled.addListener(()=>runtime.ensureAlarm().catch(()=>{}));
  chrome.notifications.onClicked.addListener(async id=>{
    const {lastOrder}=await chrome.storage.local.get('lastOrder');
    if(lastOrder&&id==='shenqi-'+lastOrder.orderId)chrome.tabs.create({url:lastOrder.url});else chrome.runtime.openOptionsPage();
  });
  runtime.ensureAlarm().catch(()=>{});
})(globalThis);
