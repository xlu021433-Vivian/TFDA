(function(root){
  'use strict';
  const P=typeof module!=='undefined'&&module.exports?require('./policy.js'):root.ShenqiPolicy;
  const defaults={enabled:false,time:'11:00',weekdays:[1,2,3,4,5],budget:2500,request:'',anyShop:true,merchants:[],authorized:false,defaultSpecs:true};
  function clock(value=Date.now()){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
    const date=`${parts.year}-${parts.month}-${parts.day}`;
    return {date,weekday:new Date(`${date}T00:00:00Z`).getUTCDay()||7,minute:Number(parts.hour)*60+Number(parts.minute)};
  }
  function merchant(value){
    let url;try{url=new URL(value?.url);}catch{throw Error('商家链接无效');}
    if(!P.supported(url.href)||url.pathname!=='/waimai/mindex/menu'||!url.searchParams.get('poi_id_str'))throw Error('请在真实美团商家菜单页保存定时商家');
    if(typeof value.name!=='string'||!value.name.trim()||value.name.length>100)throw Error('请填写商家名称');
    const foods=[...new Set(value.foods||[])];
    if(!foods.length||foods.length>100||foods.some(x=>typeof x!=='string'||!x.trim()||x.length>150||P.inspectName(x)))throw Error('定时餐品需先核对配料，并排除猪肉及来源不明肉类');
    // Allow only official menu parameters. The URL stays in extension-local storage, never source control.
    for(const key of [...url.searchParams.keys()])if(!['poi_id_str','actualLat','actualLng','initialLat','initialLng','channel'].includes(key))url.searchParams.delete(key);
    url.hash='';
    return {name:value.name.trim(),url:url.href,foods,defaultSpecs:value.defaultSpecs===true};
  }
  function validate(value){
    if(!value||typeof value.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))throw Error('请设置有效的定时时间');
    if(!Array.isArray(value.weekdays)||!value.weekdays.length||value.weekdays.some(n=>!Number.isInteger(n)||n<1||n>7))throw Error('请选择每周执行日期');
    if(!Number.isSafeInteger(value.budget)||value.budget<1||value.budget>100000)throw Error('预算应为0.01至1000元');
    const request=String(value.request||'').trim();const parsed=P.intent(request);
    if(parsed.budget!==null&&parsed.budget!==value.budget)throw Error('输入中的预算与定时预算不一致');
    const merchants=(value.merchants||[]).map(merchant);if(merchants.length>20)throw Error('最多保存20家商家');
    if(value.enabled&&(!value.authorized||(!value.anyShop&&!merchants.length)))throw Error('启用前需确认官方配送地址，并授权按预算和忌口定时创建待支付订单');
    return {enabled:value.enabled,time:value.time,weekdays:[...new Set(value.weekdays)].sort(),budget:value.budget,request,anyShop:value.anyShop===true,merchants,authorized:value.authorized===true,defaultSpecs:value.defaultSpecs===true};
  }
  function due(config,history={},now=Date.now()){
    const current=clock(now);if(!config.enabled||!config.authorized||!config.weekdays.includes(current.weekday)||history[current.date])return null;
    const [h,m]=config.time.split(':').map(Number),late=current.minute-h*60-m;
    if(late<0)return null;
    return {...current,missed:late>10};
  }
  function unpaid(doc,url){
    let link;try{link=new URL(url);}catch{return null;}
    if(!P.supported(link.href)||!/\/(?:order-detail|orderdetail|cashier|pay)(?:\/|$)/.test(link.pathname))return null;
    const clone=doc.body.cloneNode(true);clone.querySelector('#shenqi-waimai-assistant')?.remove();clone.querySelectorAll('script,style').forEach(el=>el.remove());
    const text=clone.textContent.replace(/\s+/g,' ').trim();
    if(!/待支付|待付款|等待支付|等待付款/.test(text)||/支付成功|已支付|已完成|已取消|订单关闭/.test(text))return null;
    const ids=[...text.matchAll(/(?:订单号|订单编号)\s*[:：]?\s*([A-Za-z0-9-]{8,40})(?![A-Za-z0-9-])/g)].map(m=>m[1]);
    if(new Set(ids).size!==1)return null;
    const amount=text.match(/(?:待支付金额|待付金额|实付金额|应付金额|需支付|待支付|合计)\s*[:：]?\s*[¥￥]\s*(\d+(?:\.\d{1,2})?)(?![\d.])/);
    if(!amount)return null;
    const total=P.cents(amount[1]);if(total===null)return null;
    // Payment links must not carry a location, token or arbitrary redirect in a phone notification.
    const safe=new URL(link.origin+link.pathname);
    for(const key of ['orderId','order_id','wm_order_id','mtOrderId','order_id_str'])if(link.searchParams.has(key))safe.searchParams.set(key,link.searchParams.get(key));
    return {orderId:ids[0],total,url:safe.href,status:'unpaid'};
  }
  const api={defaults,clock,merchant,validate,due,unpaid};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ShenqiSchedule=api;
})(globalThis);
