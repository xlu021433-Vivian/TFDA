// Read-only: no listeners, requests, credentials, clicks or payment actions.
(function(root){
  'use strict';
  function supported(value){
    try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='mpay.meituan.com'&&!u.port&&!u.username&&!u.password&&u.pathname==='/resource/icashier/s/index.html';}catch{return false;}
  }
  function read(doc,value){
    if(!supported(value))return null;
    const u=new URL(value),clone=doc.body.cloneNode(true);
    clone.querySelectorAll('script,style').forEach(el=>el.remove());
    const text=clone.textContent.replace(/\s+/g,' ').trim();
    if(!/支付订单/.test(text)||!/交易剩余时间/.test(text)||/支付成功|已支付|已完成|已取消|订单关闭|超时|已过期|交易关闭|交易取消/.test(text))return null;
    if(/交易剩余时间\s*0{1,2}:00(?:\s|$)/.test(text))return null;
    let success;try{success=new URL(u.searchParams.get('pay_success_url'));}catch{return null;}
    if(success.protocol!=='https:'||success.hostname!=='h5.waimai.meituan.com'||success.port||success.username||success.password||success.pathname!=='/waimai/mindex/order-detail')return null;
    const orderId=success.searchParams.get('mtOrderViewId');
    if(!/^\d{8,40}$/.test(orderId||''))return null;
    const ids=[...text.matchAll(/[-－]\s*(\d{8,40})(?!\d)/g)].map(m=>m[1]);
    if(new Set(ids).size!==1||ids[0]!==orderId)return null;
    const amounts=[...text.matchAll(/支付金额\s*[¥￥]\s*(\d+)(?:\.(\d{1,2}))?(?![\d.])/g)];
    if(amounts.length!==1)return null;
    const total=Number(amounts[0][1])*100+Number((amounts[0][2]||'').padEnd(2,'0'));
    if(!Number.isSafeInteger(total)||total<=0||total>10000000)return null;
    return {orderId,total,status:'unpaid',url:'https://h5.waimai.meituan.com/waimai/mindex/order-detail?mtOrderViewId='+orderId};
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={supported,read};return;}
  return read(root.document,root.location.href);
})(globalThis);
