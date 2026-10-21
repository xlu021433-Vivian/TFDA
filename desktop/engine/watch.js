(function(){
  'use strict';
  if(globalThis.ShenqiOrderWatcher)return;globalThis.ShenqiOrderWatcher=true;
  let sent='',busy=false;
  async function inspect(){
    if(busy)return;const result=globalThis.ShenqiSchedule.unpaid(document,location.href);
    if(!result||sent===result.orderId)return;
    busy=true;
    try{const response=await chrome.runtime.sendMessage({type:'order_result',result});if(response?.ok)sent=result.orderId;}catch{}finally{busy=false;}
  }
  const timer=setInterval(inspect,2000);inspect();
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
