(function(){
  'use strict';
  const pending=new Map();let sequence=0,page={ready:false},state={},nativeStatus={},lastNativeNotice=null,serial=Promise.resolve();
  const $=id=>document.getElementById(id),native=chrome.webview;
  function rpc(action,args={}){return new Promise((resolve,reject)=>{const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(Error('桌面连接超时，请检查连接后重试'));},20000);pending.set(id,{resolve,reject,timer});native.postMessage({channel:'native-request',id,action,args});});}
  const storage={get:keys=>rpc('storage_get',{keys}),set:async change=>{
    if(change.notificationStatus&&lastNativeNotice){change.notificationStatus={...change.notificationStatus,...lastNativeNotice};lastNativeNotice=null;}
    await rpc('storage_set',{change});
  },remove:keys=>rpc('storage_remove',{keys})};
  const api={runtime:{id:'shenqi-desktop',getURL:name=>'https://shenqi.local/'+name},storage:{local:storage},
    notifications:{async create(id,options){lastNativeNotice=await rpc('notify',{id,options});return id;}},
    tabs:{async create(){await rpc('navigate',{url:'about:blank'});return {id:1};},update:(id,value)=>rpc('navigate',value),sendMessage:(id,body)=>rpc('page_command',{body})},
    scripting:{executeScript:()=>rpc('inject')},alarms:{async get(){return true;},async create(){}}};
  const runtime=globalThis.ShenqiDesktopWorker.createRuntime(api);
  const sender={id:'shenqi-desktop',url:'https://shenqi.local/options.html'};
  const message=body=>runtime.message(body,sender);
  function tell(text,error=false){$('message').textContent=text;$('message').style.color=error?'var(--bad)':'var(--brand)';}
  async function action(fn){try{await fn();await refresh();}catch(error){tell(error.message,true);}}
  function config(enabled){return {enabled,time:$('time').value,weekdays:[...document.querySelectorAll('[name=day]:checked')].map(x=>Number(x.value)),budget:ShenqiPolicy.cents($('scheduleBudget').value),request:$('scheduleRequest').value,anyShop:true,merchants:[],authorized:$('scheduleConsent').checked,defaultSpecs:true};}
  let hydrated=false;
  async function refresh(){
    state=await storage.get(['schedule','activeRun','submissionAttempt','attemptMeta','lastOrder','notificationStatus']);
    nativeStatus=await rpc('status');
    if(!hydrated){const saved=state.schedule||ShenqiSchedule.defaults;$('time').value=saved.time;$('scheduleBudget').value=(saved.budget/100).toFixed(2);$('scheduleRequest').value=saved.request;$('enabled').checked=saved.enabled;$('scheduleConsent').checked=saved.authorized;for(const x of document.querySelectorAll('[name=day]'))x.checked=saved.weekdays.includes(Number(x.value));hydrated=true;}
    const run=state.activeRun,active=run&&!['failed','done','stopped'].includes(run.stage);
    const currentOrder=state.submissionAttempt&&state.attemptMeta&&state.lastOrder&&state.lastOrder.time>=state.attemptMeta.time&&state.lastOrder.date===state.attemptMeta.date?state.lastOrder:null;
    $('requestForm').hidden=!!active||!!state.submissionAttempt;
    $('startMeal').disabled=!page.ready||!$('mealConsent').checked||!!state.submissionAttempt||!!active;
    const budget=ShenqiPolicy.cents($('budget').value);$('budgetSummary').innerHTML=budget!==null?'¥'+Math.floor(budget/100)+'<span>.'+String(budget%100).padStart(2,'0')+'</span>':'—';
    $('connection').textContent=page.error?'网页暂时无法打开':page.ready?'内置网页已连接':'正在等待官方网页';
    $('dot').className='dot '+(page.error?'bad':page.ready?'good':'');
    $('pageStatus').textContent=page.error||page.loginNeeded?'请在右侧处理登录或页面提示':page.ready?'请核对账号和配送地址':'无需安装浏览器扩展';
    if(page.error)$('pageStatus').textContent=page.error;
    let title='先在右侧登录并核对地址',detail='确认当前账号与配送地址后，勾选本次授权，再点击“帮我点这一餐”。',kind='';
    if(active){title=({home:'正在随机选店',menu:'正在选餐与加购',preview:'正在核对用券与预算'})[run.stage]||'正在处理这一餐';detail=page.status||'正在等待官方页面提供可核对的信息。';}
    else if(run?.stage==='failed'){title='本次已暂停';detail=run.reason+'。已加购的商品请在官方购物车核对；不会重复提交。';kind='bad';}
    else if(state.submissionAttempt&&!currentOrder){title='已尝试提交，等待官方结果';detail='请查看右侧或手机美团订单，未确认真实订单号前不会显示成功，也不会重试。';}
    else if(page.ready){title=page.loginNeeded?'请先登录美团':'网页已连接，可以准备这一餐';detail=page.status||detail;}
    if(currentOrder){title='已识别本次待支付订单';detail='请在平台有效期内本人付款；实时状态以官方页面为准。';kind='good';}
    $('flowTitle').textContent=title;$('flowDetail').textContent=detail;$('flow').className='flow '+kind;
    $('flow').hidden=!active&&!state.submissionAttempt&&run?.stage!=='failed'&&!page.error;
    $('order').hidden=!currentOrder;if(currentOrder){$('orderId').textContent=currentOrder.orderId;$('orderAmount').textContent=ShenqiPolicy.money(currentOrder.total)+' · '+currentOrder.date;}
    $('recovery').hidden=!state.submissionAttempt;
    $('scheduleState').textContent=state.schedule?.enabled?'已启用 · 北京时间 '+state.schedule.time+' · 券后含配送 '+ShenqiPolicy.money(state.schedule.budget):'当前已暂停，确认后再启用。';
    $('barkState').textContent=nativeStatus.barkConfigured?'已在本机加密保存 Bark key。'+(nativeStatus.lastBark===true?'最近一次推送已被 Bark 服务接受，请在手机确认。':nativeStatus.lastBark===false?'最近一次推送未成功，请检查 key 和网络。':'请发送一次测试通知。'):'未配置 iPhone 推送，可稍后设置。电脑通知随程序运行。';
    return state;
  }
  native.addEventListener('message',event=>{
    const data=event.data;
    if(data.channel==='native-result'){const request=pending.get(data.id);if(!request)return;clearTimeout(request.timer);pending.delete(data.id);data.error?request.reject(Error(data.error)):request.resolve(data.result);}
    if(data.channel==='page-request')runtime.message(data.body,{id:'shenqi-desktop',url:data.url,tab:{id:1,url:data.url}}).then(result=>rpc('page_result',{id:data.id,result}),error=>rpc('page_result',{id:data.id,result:{ok:false,error:error.message}})).catch(()=>{});
    if(data.channel==='page-state'){page={...page,...data.state};if(data.state.complete&&page.ready)runtime.inject(1,{status:'complete'},{url:page.url}).catch(()=>{});refresh().catch(error=>tell(error.message,true));}
    if(data.channel==='tick'){serial=serial.then(()=>runtime.tick()).then(refresh).catch(error=>tell(error.message,true));}
  });
  for(const button of document.querySelectorAll('nav button'))button.onclick=()=>{for(const b of document.querySelectorAll('nav button'))b.classList.toggle('active',b===button);for(const tab of document.querySelectorAll('.tab'))tab.classList.toggle('active',tab.id===button.dataset.tab);};
  $('mealConsent').onchange=()=>refresh().catch(()=>{});$('budget').oninput=()=>{ $('mealConsent').checked=false;refresh().catch(()=>{}); };$('request').oninput=()=>{$('mealConsent').checked=false;try{const input=ShenqiPolicy.intent($('request').value);if(input.budget!==null)$('budget').value=(input.budget/100).toFixed(2);}catch{}refresh().catch(()=>{});};
  $('home').onclick=()=>action(()=>rpc('navigate',{url:'https://h5.waimai.meituan.com/waimai/mindex/home'}));
  $('reload').onclick=()=>action(()=>rpc('reload'));
  $('startMeal').onclick=()=>action(async()=>{
    if(!$('mealConsent').checked||!page.ready)throw Error('请先在右侧确认账号与地址，并勾选本次授权');
    const intent=ShenqiPolicy.intent($('request').value),budget=ShenqiPolicy.cents($('budget').value);
    if(intent.budget!==null&&intent.budget!==budget)throw Error('输入中的预算与预算框不一致，请核对后重新授权');
    $('startMeal').disabled=true;
    await message({type:'start_now',schedule:{...ShenqiSchedule.defaults,enabled:true,authorized:true,budget,request:$('request').value,anyShop:true,defaultSpecs:true}});
    $('mealConsent').checked=false;
    tell('本次点餐已开始。无券或超预算会暂停，付款由你完成。');
  });
  $('stop').onclick=()=>action(async()=>{const saved=state.schedule||ShenqiSchedule.defaults;await message({type:'configure_schedule',schedule:{...saved,enabled:false}});$('enabled').checked=false;tell('已暂停当前任务和定时，已加购商品请在官方购物车核对。');});
  $('saveSchedule').onclick=()=>action(async()=>{await message({type:'configure_schedule',schedule:config($('enabled').checked)});tell('定时设置已保存到本机。');});
  $('clear').onclick=()=>action(async()=>{if(!$('reviewed').checked)throw Error('请先核对官方订单');await message({type:'clear',reviewed:true});$('reviewed').checked=false;tell('已解除防重记录，请重新核对后开始下一餐。');});
  $('openOrder').onclick=()=>action(()=>rpc('navigate',{url:state.lastOrder?.url}));
  $('saveBark').onclick=()=>action(async()=>{const key=$('barkKey').value.trim();if(!/^[A-Za-z0-9_-]{5,256}$/.test(key))throw Error('请输入真实的 Bark key');await rpc('save_bark',{key});$('barkKey').value='';tell('Bark key 已加密保存在本机。');});
  $('testNotice').onclick=()=>action(async()=>{const result=await rpc('notify',{id:'shenqi-test',options:{title:'神器 · 通知测试',message:'桌面助手通知测试，没有创建订单。'}});tell(result.bark?'Bark 服务已接受推送，请确认 iPhone 收到通知。':result.barkConfigured?'电脑通知已发出，Bark 未确认接受推送。':'电脑通知已发出；iPhone Bark 尚未配置。');});
  $('diagnostics').onclick=()=>action(async()=>{$('diagnosticResult').textContent=(await rpc('diagnostics')).message;});
  $('shortcut').onclick=()=>action(async()=>{await rpc('shortcut');tell('桌面快捷方式已创建。请将本 EXE 保留在固定位置。');});
  globalThis.Desktop={async tick(){await runtime.tick();await refresh();},async inspect(){return {page,state:await refresh(),native:nativeStatus};},runtime,api};
  (async()=>{const initial=await storage.get(['preferences','schedule']);if(!initial.preferences)await storage.set({preferences:{budget:'25.00',mode:'unpaid',expand:true,noPork:true,requireCoupon:true}});await refresh();await runtime.tick();await rpc('panel_ready');setInterval(()=>refresh().catch(error=>tell(error.message,true)),2000);})().catch(error=>tell('无法读取本机状态，点餐保持关闭：'+error.message,true));
})();
