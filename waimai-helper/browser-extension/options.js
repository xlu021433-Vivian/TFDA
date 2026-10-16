'use strict';
const $=id=>document.getElementById(id),P=globalThis.ShenqiPolicy,S=globalThis.ShenqiSchedule;
async function send(value){const result=await chrome.runtime.sendMessage(value);if(!result?.ok)throw Error(result?.error||'设置操作未完成');return result;}
function show(message,bad=false){$('message').textContent=message;$('message').style.color=bad?'var(--bad)':'var(--ink)';}
function form(){return S.validate({enabled:$('enabled').checked,time:$('time').value,weekdays:[...document.querySelectorAll('[name=day]:checked')].map(el=>Number(el.value)),budget:P.cents($('budget').value),request:$('request').value,anyShop:true,merchants:[],authorized:$('authorized').checked,defaultSpecs:$('defaultSpecs').checked});}
async function load(){
  const state=await send({type:'read'}),config=state.schedule;
  $('enabled').checked=config.enabled;$('time').value=config.time;$('budget').value=(config.budget/100).toFixed(2);$('request').value=config.request;$('authorized').checked=config.authorized;$('defaultSpecs').checked=config.defaultSpecs;
  for(const day of document.querySelectorAll('[name=day]'))day.checked=config.weekdays.includes(Number(day.value));
  $('summaryBudget').textContent=P.money(config.budget);$('summaryTime').textContent=`北京时间 ${config.time} · 每周${config.weekdays.join('、')} · 不限定商家`;
  $('state').textContent=config.enabled?'定时已启用；到点后按预算和忌口执行。':'定时尚未启用。确认官方配送地址并授权后保存。';
  $('notificationState').textContent=state.notificationConfigured?'已保存本机通知连接码；请发送测试通知确认Bark连通。':'尚未连接本机Bark，电脑通知仍可使用。';
  if(state.lastOrder){const order=state.lastOrder;$('lastOrder').textContent=`订单号 ${order.orderId} · 待支付 ${P.money(order.total)} · ${order.date}（以官方当前状态为准）`;const link=document.createElement('a');link.href=order.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='打开官方订单 ↗';$('lastOrder').append(document.createElement('br'),link);}
}
async function action(fn){for(const button of document.querySelectorAll('button'))button.disabled=true;try{await fn();}catch(error){show(error.message,true);}finally{for(const button of document.querySelectorAll('button'))button.disabled=false;}}
$('settings').onsubmit=event=>{event.preventDefault();action(async()=>{const config=form();await send({type:'configure_schedule',schedule:config});await load();show(config.enabled?'已启用：按北京时间执行；实际订单号识别后通知你付款。':'已保存，定时保持暂停。');});};
$('pause').onclick=()=>action(async()=>{const state=await send({type:'read'});await send({type:'configure_schedule',schedule:{...state.schedule,enabled:false}});await load();show('定时已暂停，进行中的任务也会停止后续提交。');});
$('connect').onclick=()=>action(async()=>{await send({type:'connect_notifications',token:$('token').value.trim()});$('token').value='';await load();show('连接码已保存在本机扩展，没有上传GitHub。');});
$('test').onclick=()=>action(async()=>{const result=await send({type:'test_notifications'});show(`电脑通知${result.desktop?'已发送':'未成功'}；Bark${result.bark?'服务已接受推送':'未成功，请检查本机助手与连接码'}。`);});
$('clear').onclick=()=>action(async()=>{if(!$('reviewed').checked)throw Error('请先检查官方订单列表，确认上一笔结果');await send({type:'clear',reviewed:true});$('reviewed').checked=false;show('防重记录已解除，已执行过的当天定时任务不会再次执行。');});
load().catch(error=>show(error.message,true));
