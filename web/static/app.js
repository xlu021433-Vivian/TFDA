(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  let state={},csrf='',sending=false,pending=sessionStorage.getItem('shenqiPending')||'',pendingAt=Number(sessionStorage.getItem('shenqiPendingAt')||Date.now()),reading=false;
  function say(value,bad=false){$('message').textContent=value;$('message').classList.toggle('bad',bad);$('message').hidden=!value;}
  function interpret(syncBudget=false){
    try{
      const intent=ShenqiPolicy.intent($('request').value);
      if(syncBudget&&intent.budget!==null)$('budget').value=(intent.budget/100).toFixed(2);
      const budget=ShenqiPolicy.cents($('budget').value);
      if(!Number.isSafeInteger(budget)||budget<1||budget>100000)throw Error('请填写0.01至1000元预算。');
      if(intent.budget!==null&&intent.budget!==budget)throw Error('需求里的预算与预算框不一致，请统一。');
      $('intent').textContent=ShenqiPolicy.describe(intent,budget);$('intent').classList.remove('bad');return {intent,budget};
    }catch(error){$('intent').textContent=error.message;$('intent').classList.add('bad');return null;}
  }
  function render(){
    const parsed=interpret(),online=state.online===true,enabled=state.enabled===true;
    if(pending&&state.requestId===pending&&['done','failed','stopped','rejected','interrupted'].includes(state.requestState)){
      sessionStorage.removeItem('shenqiPending');pending='';
      if(state.requestError)say(state.requestError,true);
    }
    if(pending&&online&&Date.now()>pendingAt+70000&&!state.queued&&!state.unresolved&&!state.busy&&!state.locked&&state.requestId!==pending){sessionStorage.removeItem('shenqiPending');pending='';say('上一笔请求没有被确认接收，现已过期；请重新核对后发送。');}
    $('connectionTitle').textContent=!online?'桌面神器未连接':!enabled?'桌面已连接，远程未启用':state.loginNeeded?'请在电脑上登录美团':state.ready?'桌面神器已连接':'桌面需要处理';
    $('dot').className='dot '+(online&&enabled&&state.ready&&!state.loginNeeded?'good':!online?'bad':'');
    $('connectionDetail').textContent=!online?'请在电脑打开神器0.6.1或更新版，保持联网、不休眠。':!enabled?'在电脑神器首页点一次「连接手机」，以后会记住。':state.loginNeeded?'请在桌面窗口亲自登录并确认配送地址。':!state.ready?(state.message||'请回电脑检查美团页面。'):'可以直接填写需求并选餐；电脑使用当前美团配送地址。';
    let reason=!online?'等待桌面神器连接':!enabled?'请先在桌面启用远程控制':state.loginNeeded?'请先在电脑登录美团':pending||state.queued?'等待电脑确认本次请求':state.busy?'这一餐正在准备中':state.locked?'请先核对上一笔官方订单':state.unresolved?'上一笔接收结果需在桌面核对':!state.ready?'请先在桌面准备美团页面':!parsed?'请调整需求或预算':'';
    $('start').disabled=!!reason||sending;
    $('start').textContent=sending?'正在发送…':reason||('用券选1餐 · 不超过¥'+(parsed.budget/100).toFixed(2));
    $('hint').textContent=reason||'实际用券、券后不超预算，才会创建1笔待支付订单。';
    $('stop').disabled=!online||!enabled||sending;
    $('progressCard').hidden=!(state.busy||pending||state.queued||state.requestError||state.unresolved);
    $('stageTitle').textContent=state.requestError?'需要你处理':pending||state.queued?'请求已发出，等电脑确认':({home:'正在为你挑选商家',menu:'正在选择餐品',preview:'正在核对用券与金额',done:'已生成待支付订单',failed:'本次点餐已停止',stopped:'本次点餐已暂停'})[state.stage]||'正在准备这一餐';
    $('stageDetail').textContent=state.requestError||state.message||'请保持电脑和神器运行，不要重复下单。';
    for(const item of $('steps').children)item.classList.toggle('current',item.dataset.step===state.stage);
    const order=online&&state.order;
    let url;try{url=new URL(order?.url);}catch{}
    const valid=order&&/^\d{8,40}$/.test(order.id)&&Number.isSafeInteger(order.amount)&&order.amount>0&&url?.protocol==='https:'&&url.hostname==='h5.waimai.meituan.com'&&!url.port;
    $('orderCard').hidden=!valid;
    if(valid){$('orderAmount').textContent='¥ '+(order.amount/100).toFixed(2);$('orderId').textContent=order.id;$('orderLink').href=url.href;}
  }
  async function api(path,options={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch('/shenqi/api/'+path,{...options,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...options.headers}});
      const result=await response.json();
      if(!response.ok||!result.ok){const error=Error(result.error||'连接失败，请刷新页面。');error.rejected=response.status>=400&&response.status<500;throw error;}
      return result;
    }finally{clearTimeout(timer);}
  }
  async function refresh(){
    if(reading)return;reading=true;
    try{const result=await api('status');state=result.status;csrf=result.csrf;render();}
    catch(error){state={online:false};render();say(error.message||'无法确认桌面状态，请稍后刷新。',true);}
    finally{reading=false;}
  }
  $('mealForm').onsubmit=async event=>{
    event.preventDefault();const parsed=interpret();
    if(sending||$('start').disabled||!parsed)return;
    sending=true;pending=crypto.randomUUID();pendingAt=Date.now();sessionStorage.setItem('shenqiPending',pending);sessionStorage.setItem('shenqiPendingAt',String(pendingAt));render();
    try{
      await api('command',{method:'POST',body:JSON.stringify({id:pending,createdAt:pendingAt,kind:'meal',request:$('request').value,budget:parsed.budget,authorized:true})});
      say('已发送到电脑。请等待真实订单结果，不要重复下单。');
    }catch(error){
      // A failed connection may still have accepted the request. Never resend it automatically.
      if(error.rejected){sessionStorage.removeItem('shenqiPending');pending='';say(error.message,true);}
      else say((error.message||'网络中断')+' 本次接收结果尚需核对；不会自动重试。',true);
    }finally{sending=false;render();await refresh();}
  };
  $('stop').onclick=async()=>{
    if(sending||$('stop').disabled)return;sending=true;render();
    try{await api('command',{method:'POST',body:JSON.stringify({id:crypto.randomUUID(),createdAt:Date.now(),kind:'stop'})});say('暂停请求已发送，等待桌面确认；请核对官方购物车和订单。');}
    catch(error){say('暂停尚未确认：'+error.message,true);}finally{sending=false;await refresh();}
  };
  for(const button of document.querySelectorAll('[data-request]'))button.onclick=()=>{$('request').value=button.dataset.request;interpret(true);render();$('request').focus();};
  $('request').oninput=()=>{interpret(true);render();};
  $('budget').oninput=()=>{render();};
  refresh();setInterval(refresh,5000);
})();
