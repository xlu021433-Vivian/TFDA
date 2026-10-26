(function(){
  'use strict';
  const pending=new Map();
  let sequence=0,page={ready:false},state={},nativeStatus={},lastNativeNotice=null;
  let serial=Promise.resolve(),refreshPromise=null,hydrated=false,storageReady=false,actionBusy=false,stopping=false;
  const $=id=>document.getElementById(id),native=chrome.webview;
  function rpc(action,args={}){
    return new Promise((resolve,reject)=>{
      const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(Error('桌面连接超时，请检查连接后重试'));},20000);
      pending.set(id,{resolve,reject,timer});native.postMessage({channel:'native-request',id,action,args});
    });
  }
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
  const guarded=()=>!!(state.submissionAttempt||state.observedOrder);
  const active=()=>state.activeRun&&!['failed','done','stopped'].includes(state.activeRun.stage);
  function path(){try{return new URL(page.url).pathname;}catch{return '';}}
  function tell(text,error=false){$('message').textContent=text;$('message').classList.toggle('bad',error);$('message').hidden=!text;}
  function interpret(){
    try{
      const parsed=ShenqiPolicy.intent($('request').value),budget=ShenqiPolicy.cents($('budget').value);
      if(!Number.isSafeInteger(budget)||budget<1||budget>100000)throw Error('请填写0.01至1000元的本餐预算。');
      if(parsed.budget!==null&&parsed.budget!==budget)throw Error('这句话里的预算与预算框不一致，请统一后重新授权。');
      $('intentResult').textContent=ShenqiPolicy.describe(parsed,budget);
      $('intentResult').classList.remove('bad');return parsed;
    }catch(error){$('intentResult').textContent=error.message;$('intentResult').classList.add('bad');return null;}
  }
  function readInput(){
    $('mealConsent').checked=false;tell('');
    try{const input=ShenqiPolicy.intent($('request').value);if(input.budget!==null)$('budget').value=(input.budget/100).toFixed(2);}catch{}
    render();
  }
  function render(){
    const run=state.activeRun,running=!!active(),parsed=interpret();
    const currentOrder=state.observedOrder||(state.submissionAttempt&&state.attemptMeta&&state.lastOrder&&state.lastOrder.time>=state.attemptMeta.time&&state.lastOrder.date===state.attemptMeta.date?state.lastOrder:null);
    const needsSpecs=!!page.pendingSpecs&&running;
    $('requestForm').hidden=running||guarded();
    $('mealAction').hidden=!$('meal').classList.contains('active')||running||guarded();
    $('manualSpecs').hidden=!needsSpecs;
    if(!needsSpecs)$('specConsent').checked=false;
    $('resumeSpecs').disabled=!needsSpecs||!$('specConsent').checked||actionBusy||stopping;
    let reason='';
    if(!storageReady)reason='正在读取本机设置，请稍等。';
    else if(actionBusy||stopping)reason='正在处理，请稍等。';
    else if(guarded())reason='请先核对上一笔官方订单。';
    else if(running)reason='当前点餐进行中。';
    else if(!page.ready||page.error)reason=page.error||'正在等待右侧美团页面连接。';
    else if(page.loginNeeded)reason='请先在右侧美团页面完成登录。';
    else if(!['/waimai/mindex/home','/waimai/mindex/menu','/waimai/mindex/mine'].includes(path()))reason='先回到美团首页或商家菜单，再开始新的一餐。';
    else if(!parsed)reason='请先调整上方的需求或预算。';
    else if(!$('mealConsent').checked)reason='核对右侧账号、地址后，勾选本次授权。';
    $('startHint').textContent=reason||'准备好了。实际用券且最终金额不超预算，才会提交一次。';
    $('startHint').classList.toggle('bad',!!page.error||!parsed);
    $('startMeal').disabled=!!reason;
    $('startMeal').textContent=actionBusy?'正在准备…':path()==='/waimai/mindex/menu'?'在这家店选餐':parsed&&(parsed.category||parsed.keywords?.length)?'按需求帮我选餐':'帮我随机选餐';
    $('home').disabled=running||guarded()||actionBusy||stopping;
    $('reload').disabled=running||actionBusy||stopping;
    $('recoverHome').hidden=!page.error||running||guarded();
    $('recoverHome').disabled=actionBusy||stopping;
    $('stop').hidden=!running&&!(guarded()&&!currentOrder)&&!state.schedule?.enabled;
    $('stop').disabled=stopping;$('stop').textContent=stopping?'正在暂停…':'暂停点餐与后续定时';
    $('connection').textContent=page.cashier?'已进入官方付款页':page.error?'美团页面暂时无法打开':page.loginNeeded?'请先登录美团':page.ready?'美团内容已加载':'正在连接美团';
    $('dot').className='dot '+(page.error?'bad':page.ready&&!page.loginNeeded?'good':'');
    $('pageStatus').textContent=page.error|| (page.loginNeeded?'在右侧官方页面完成登录':page.ready?'登录与配送地址请在右侧核对':page.cashier?'请在右侧核对订单，付款由你完成':'稍等一下，正在准备官方页面');
    let title='正在准备这一餐',detail=page.status||'正在等待官方页面信息。',kind='';
    if(running)title=needsSpecs?'等你确认规格':({home:'正在为你挑选商家',menu:'正在选择餐品并加购',preview:'正在核对用券与最终金额'})[run.stage]||title;
    if(guarded()&&!currentOrder){title='等待官方订单结果';detail='已尝试提交一次。请查看右侧或手机美团订单；未确认真实订单号前不会重试。';}
    if(page.error){title='需要处理页面连接';detail=page.error;kind='bad';}
    if(currentOrder){title=currentOrder.source==='observed'?'发现待支付订单，优惠待核对':'待支付订单已确认';detail=currentOrder.source==='observed'?'这笔订单不是助手验证用券后提交的，请在官方页面核对优惠。':'付款由你完成，实时状态以美团官方页面为准。';kind='good';}
    $('flowTitle').textContent=title;$('flowDetail').textContent=detail;$('flow').className='flow '+kind;
    $('flow').hidden=!!currentOrder||(!running&&!state.submissionAttempt&&!page.error);
    const stages=['home','menu','preview','done'],current=currentOrder?3:state.submissionAttempt?2:stages.indexOf(run?.stage);
    $('steps').hidden=!running&&!currentOrder;
    for(const item of $('steps').children){const index=stages.indexOf(item.dataset.step);item.classList.toggle('current',index===current);item.classList.toggle('done',index<current);if(index===current)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');}
    $('order').hidden=!currentOrder;
    if(currentOrder){$('orderId').textContent=currentOrder.orderId;$('orderAmount').textContent=ShenqiPolicy.money(currentOrder.total);$('orderHint').textContent=currentOrder.source==='observed'?'用券情况未核实；核对官方订单后再付款。':'请在美团有效期内本人付款。';}
    $('recovery').hidden=!guarded();
    $('clear').disabled=!$('reviewed').checked||actionBusy||stopping||running;
    $('recoveryHint').textContent=running?'当前任务仍在进行。请先点“暂停”，再核对官方订单后解除防重记录。':'先在官方订单中核对上一笔结果。解除防重记录不会取消订单，也不会清空购物车。';
    $('history').hidden=running||guarded()||!['failed','stopped'].includes(run?.stage);
    $('historyDetail').textContent=run?.stage==='failed'?(run.reason||'上次点餐未完成')+'。已加购商品请在官方购物车核对。':run?.stage==='stopped'?(run.reason||'上次点餐已由你暂停。已加购商品请在官方购物车核对。'):'';
    $('scheduleState').textContent=state.schedule?.enabled?'已启用 · 北京时间 '+state.schedule.time+' · 券后含配送 '+ShenqiPolicy.money(state.schedule.budget):'当前未启用，到点不会自动下单。';
    $('barkState').textContent=nativeStatus.barkConfigured?'已保存手机推送设置。'+(nativeStatus.lastBark===true?'最近一次推送已被Bark服务接受，请在手机确认收到。':nativeStatus.lastBark===false?'最近一次推送失败，请检查key和网络。':'可以发送测试通知，确认手机能收到。'):'尚未设置手机推送，电脑通知仍可使用。';
    $('remoteState').textContent=nativeStatus.remoteEnabled?'已允许 L5 管理员账号发送选餐和暂停请求。电脑与神器需保持运行。':'手机控制未启用，网页不会执行点餐。';
    $('phoneTitle').textContent=nativeStatus.remoteEnabled?'手机连接已开启':'在手机上点餐';
    $('phoneDetail').textContent=nativeStatus.remoteEnabled?'l5space.icu/shenqi/ · 已记住这台电脑':'允许L5管理员用当前地址选餐，只到待支付';
    $('connectPhone').textContent=nativeStatus.remoteEnabled?'断开':'连接手机';
    $('connectPhone').disabled=actionBusy||stopping;
    $('resetRemote').disabled=!$('remoteReviewed').checked||actionBusy||stopping||running||guarded();
    for(const id of ['saveSchedule','saveBark','testNotice','diagnostics','shortcut'])$(id).disabled=actionBusy||stopping;
  }
  async function refresh(force=false){
    if(refreshPromise){await refreshPromise;if(!force)return state;}
    refreshPromise=(async()=>{
      const [saved,status]=await Promise.all([storage.get(['schedule','activeRun','submissionAttempt','attemptMeta','lastOrder','notificationStatus','observedOrder']),rpc('status')]);
      state=saved;nativeStatus=status;storageReady=true;
      if(!hydrated){const config=state.schedule||ShenqiSchedule.defaults;$('time').value=config.time;$('scheduleBudget').value=(config.budget/100).toFixed(2);$('scheduleRequest').value=config.request;$('enabled').checked=config.enabled;$('scheduleConsent').checked=config.authorized;for(const item of document.querySelectorAll('[name=day]'))item.checked=config.weekdays.includes(Number(item.value));hydrated=true;}
      render();return state;
    })().catch(error=>{storageReady=false;render();throw error;}).finally(()=>{refreshPromise=null;});
    return refreshPromise;
  }
  async function action(fn){
    if(actionBusy||stopping)return;
    actionBusy=true;render();
    try{await fn();await refresh(true);}catch(error){tell(error.message,true);}finally{actionBusy=false;render();}
  }
  function config(enabled){return {enabled,time:$('time').value,weekdays:[...document.querySelectorAll('[name=day]:checked')].map(item=>Number(item.value)),budget:ShenqiPolicy.cents($('scheduleBudget').value),request:$('scheduleRequest').value,anyShop:true,merchants:[],authorized:$('scheduleConsent').checked,defaultSpecs:true};}
  native.addEventListener('message',event=>{
    const data=event.data;
    if(data.channel==='native-result'){const request=pending.get(data.id);if(!request)return;clearTimeout(request.timer);pending.delete(data.id);data.error?request.reject(Error(data.error)):request.resolve(data.result);}
    if(data.channel==='cashier-result')message({type:'cashier_result',result:data.result}).then(()=>refresh(true)).catch(error=>tell(error.message,true));
    if(data.channel==='page-request')runtime.message(data.body,{id:'shenqi-desktop',url:data.url,tab:{id:1,url:data.url}}).then(result=>rpc('page_result',{id:data.id,result}),error=>rpc('page_result',{id:data.id,result:{ok:false,error:error.message}})).catch(()=>{});
    if(data.channel==='page-state'){
      const next=data.state;
      if(next.ready===false||next.url&&next.url!==page.url){page={ready:false,pendingSpecs:false,loginNeeded:false,status:''};$('mealConsent').checked=false;$('specConsent').checked=false;}
      page={...page,...next};render();
      if(next.complete&&page.ready)runtime.inject(1,{status:'complete'},{url:page.url}).catch(()=>{});
      refresh().catch(error=>tell(error.message,true));
    }
    if(data.channel==='tick')serial=serial.then(()=>runtime.tick()).then(()=>refresh(true)).catch(error=>tell(error.message,true));
  });
  function tab(button){
    for(const item of document.querySelectorAll('nav button')){const selected=item===button;item.classList.toggle('active',selected);item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;}
    for(const panel of document.querySelectorAll('.tab'))panel.classList.toggle('active',panel.id===button.dataset.tab);render();
  }
  for(const button of document.querySelectorAll('nav button')){button.onclick=()=>tab(button);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const items=[...document.querySelectorAll('nav button')],index=items.indexOf(button),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length;tab(items[next]);items[next].focus();};}
  for(const button of document.querySelectorAll('[data-request]'))button.onclick=()=>{$('request').value=button.dataset.request;readInput();$('request').focus();};
  $('request').oninput=readInput;$('budget').oninput=()=>{$('mealConsent').checked=false;tell('');render();};
  $('mealConsent').onchange=render;$('specConsent').onchange=render;$('reviewed').onchange=render;
  for(const input of document.querySelectorAll('#schedule input:not(#scheduleConsent):not(#enabled)'))input.addEventListener('input',()=>{$('scheduleConsent').checked=false;});
  $('home').onclick=()=>action(()=>rpc('navigate',{url:'https://h5.waimai.meituan.com/waimai/mindex/home'}));
  $('recoverHome').onclick=()=>action(()=>rpc('navigate',{url:'https://h5.waimai.meituan.com/waimai/mindex/home'}));
  $('reload').onclick=()=>action(()=>rpc('reload'));
  $('startMeal').onclick=()=>action(async()=>{
    if(!$('mealConsent').checked||!page.ready||page.loginNeeded||!storageReady)throw Error('请先核对右侧账号与地址，并勾选本次授权');
    const intent=interpret(),budget=ShenqiPolicy.cents($('budget').value);
    if(!intent)throw Error($('intentResult').textContent);
    const currentMenu=path()==='/waimai/mindex/menu'?page.url:null;
    await message({type:'start_now',currentMenu,schedule:{...ShenqiSchedule.defaults,enabled:true,authorized:true,budget,request:$('request').value,anyShop:true,defaultSpecs:true}});
    $('mealConsent').checked=false;tell('');
  });
  $('stop').onclick=async()=>{
    if(stopping)return;stopping=true;render();
    try{await rpc('page_command',{body:{type:'stop_scheduled'}});const saved=state.schedule||ShenqiSchedule.defaults;await message({type:'configure_schedule',schedule:{...saved,enabled:false}});$('enabled').checked=false;tell('已暂停这次点餐和后续定时。已加购商品请在美团购物车核对。');await refresh(true);}catch(error){tell('暂停状态未能确认：'+error.message+'。请在右侧核对购物车和官方订单。',true);}finally{stopping=false;render();}
  };
  $('resumeSpecs').onclick=()=>action(async()=>{
    if(!$('specConsent').checked||!page.pendingSpecs||!active())throw Error('请先在右侧选好规格、只加1份，并勾选核对确认。');
    await message({type:'schedule_check',id:state.activeRun.id});
    await rpc('page_command',{body:{type:'verify_pending',reviewed:true}});$('specConsent').checked=false;tell('正在核对官方菜品和购物车数量；没有核对成功时不会再加一份。');
  });
  $('saveSchedule').onclick=()=>action(async()=>{await message({type:'configure_schedule',schedule:config($('enabled').checked)});tell('定时设置已保存在本机。');});
  $('clear').onclick=()=>action(async()=>{if(active())throw Error('请先暂停当前任务，再核对官方订单');if(!$('reviewed').checked)throw Error('请先在官方订单核对上一笔结果');await message({type:'clear',reviewed:true});$('reviewed').checked=false;$('mealConsent').checked=false;tell('已解除防重记录。请重新核对右侧账号、地址与购物车后准备下一餐。');});
  $('openOrder').onclick=()=>action(()=>rpc('navigate',{url:(state.observedOrder||state.lastOrder)?.url}));
  $('saveBark').onclick=()=>action(async()=>{const key=$('barkKey').value.trim();if(!/^[A-Za-z0-9_-]{5,256}$/.test(key))throw Error('请输入Bark提供的真实key');await rpc('save_bark',{key});$('barkKey').value='';tell('手机推送设置已加密保存在本机。');});
  $('testNotice').onclick=()=>action(async()=>{const result=await rpc('notify',{id:'shenqi-test',options:{title:'神器 · 通知测试',message:'桌面助手通知测试，没有创建订单。'}});tell(result.bark?'Bark服务已接受推送，请在iPhone确认收到。':result.barkConfigured?'电脑通知已发出，手机推送未确认成功。':'电脑通知已发出，手机推送尚未配置。');});
  $('diagnostics').onclick=()=>action(async()=>{$('diagnosticResult').textContent=(await rpc('diagnostics')).message;});
  $('shortcut').onclick=()=>action(async()=>{await rpc('shortcut');tell('桌面快捷方式已更新，请将本程序保留在固定位置。');});
  $('remoteReviewed').onchange=render;
  $('connectPhone').onclick=()=>action(async()=>{const enabled=!nativeStatus.remoteEnabled;await rpc('remote_enable',{enabled});tell(enabled?'已连接并记住这台电脑。手机打开 l5space.icu/shenqi/，仅L5管理员可用。':'已断开手机连接。');});
  $('resetRemote').onclick=()=>action(async()=>{if(!$('remoteReviewed').checked||active()||guarded())throw Error('请先暂停并核对上一笔官方订单、防重记录。');await rpc('remote_reset');$('remoteReviewed').checked=false;tell('远程接收记录已清理，请重新核对后发送需求。');});
  function remoteStatus(){
    const run=state.activeRun;
    const order=state.observedOrder||(state.submissionAttempt&&state.attemptMeta&&state.lastOrder&&state.lastOrder.time>=state.attemptMeta.time&&state.lastOrder.date===state.attemptMeta.date?state.lastOrder:null);
    return {ready:!!page.ready&&!page.error&&['/waimai/mindex/home','/waimai/mindex/menu','/waimai/mindex/mine'].includes(path()),loginNeeded:!!page.loginNeeded,busy:!!active()||actionBusy||stopping,locked:guarded(),stage:run?.stage||'idle',message:(page.error||run?.reason||page.status||'请在桌面核对账号和配送地址。').slice(0,300),order:order?{id:order.orderId,amount:order.total,url:order.url,couponVerified:order.source!=='observed'}:null};
  }
  async function remoteCommand(command){
    const id=command.id;
    try{
      if(command.kind==='stop'){
        stopping=true;render();
        try{await rpc('page_command',{body:{type:'stop_scheduled'}});await message({type:'configure_schedule',schedule:{...(state.schedule||ShenqiSchedule.defaults),enabled:false}});$('enabled').checked=false;await refresh(true);}
        finally{stopping=false;render();}
        return {id,ok:true};
      }
      if(command.kind!=='meal'||!nativeStatus.remoteEnabled||actionBusy||stopping)throw Error('远程控制未就绪，或桌面正在处理其他操作。');
      if(active()||guarded()||!storageReady||!page.ready||page.error||page.loginNeeded||!['/waimai/mindex/home','/waimai/mindex/menu','/waimai/mindex/mine'].includes(path()))throw Error('请先在桌面核对账号、配送地址及上一笔订单。');
      const intent=ShenqiPolicy.intent(command.request),budget=command.budget;
      if(!Number.isSafeInteger(budget)||budget<1||budget>100000||intent.budget!==null&&intent.budget!==budget||command.authorized!==true)throw Error('需求、预算或本次授权不一致。');
      actionBusy=true;$('request').value=command.request;$('budget').value=(budget/100).toFixed(2);$('mealConsent').checked=false;render();
      try{await message({type:'start_now',currentMenu:path()==='/waimai/mindex/menu'?page.url:null,schedule:{...ShenqiSchedule.defaults,enabled:true,authorized:true,budget,request:command.request,anyShop:true,defaultSpecs:true}});await refresh(true);}
      finally{actionBusy=false;render();}
      return {id,ok:true};
    }catch(error){return {id,ok:false,error:error.message};}
  }
  globalThis.Desktop={async tick(){await runtime.tick();await refresh(true);},async inspect(){return {page,state:await refresh(true),native:nativeStatus};},remoteStatus,remoteCommand,runtime,api};
  (async()=>{const initial=await storage.get(['preferences','schedule']);if(!initial.preferences)await storage.set({preferences:{budget:'25.00',mode:'unpaid',expand:true,noPork:true,requireCoupon:true}});await refresh();await runtime.tick();await rpc('panel_ready');setInterval(()=>refresh().catch(error=>tell(error.message,true)),2000);})().catch(error=>tell('无法读取本机设置，点餐保持关闭：'+error.message,true));
})();
