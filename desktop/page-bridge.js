(function(){
  'use strict';
  if(location.origin!=='https://h5.waimai.meituan.com'||window!==window.top||globalThis.ShenqiDesktopPage)return;
  globalThis.ShenqiDesktopPage=true;
  const native=window.chrome?.webview;if(!native)return;
  const waiting=new Map(),listeners=[];
  const runtime={id:'shenqi-desktop',sendMessage(body){
    const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiting.delete(id);reject(Error('桌面助手连接超时，操作已暂停'));},15000);
      waiting.set(id,{resolve,reject,timer});native.postMessage({channel:'page-request',id,body});
    });
  },onMessage:{addListener(fn){listeners.push(fn);}}};
  Object.defineProperty(window.chrome,'runtime',{value:runtime,configurable:true});
  native.addEventListener('message',event=>{
    const data=event.data;
    if(data?.channel==='page-result'){
      const pending=waiting.get(data.id);if(!pending)return;clearTimeout(pending.timer);waiting.delete(data.id);pending.resolve(data.result);
    }
    if(data?.channel==='page-command')for(const listener of listeners)listener(data.body,{id:runtime.id});
  });
  setInterval(()=>{
    const host=document.getElementById('shenqi-waimai-assistant'),shadow=host?.shadowRoot;
    // Keep the reused engine's controls available for manual specification recovery.
    if(host){host.style.top='12px';host.style.right='12px';}
    const status=shadow?.getElementById('status')?.textContent||'';
    native.postMessage({channel:'page-status',status:status.slice(0,300),route:location.pathname,
      foods:globalThis.ShenqiAdapter?.create(document).cards().length||0,
      loginNeeded:/登录后|立即登录|手机号登录/.test(document.body?.innerText?.slice(0,500)||'')});
  },2000);
})();
