/* 官方消费者订餐。页面不保存密钥或令牌，不加载示例商家冒充真实结果。 */
let orderingBusy=false, orderingQuote=null, orderingRows=[];

function orderingMessage(message){
  $('buyMessage').textContent=message || '';
}
function renderOrdering(){
  const o=S?.ordering;
  $('buyStatus').textContent=!o ? '后台尚未加载官方订餐模块，请重启软件后刷新。'
    : o.connected ? '已取得消费者 OAuth 授权 · 接口权限仍以美团实际响应为准'
    : o.configured ? '应用已临时配置，下一步需完成美团消费者授权' : '尚未配置消费者订餐应用';
  $('buyCallback').textContent=S?.ordering_callback || '后台未加载';
  $('buyBudget').textContent='预算上限 ¥'+(S?.config?.order?.max_price ?? '—')+'；'+(S?.config?.dry_run ? '当前为试运行，确认按钮不会创建订单。' : '当前为正式模式，确认后将创建真实订单，支付由你本人完成。');
  $('buyConfigureButton').disabled=orderingBusy || !o;
  $('buyAuthorizeButton').disabled=orderingBusy || !o?.configured;
  $('buyClearButton').disabled=orderingBusy || !o?.configured;
  $('buySearchButton').disabled=orderingBusy || !o?.connected || !!o?.uncertain;
  $('buyPreviewButton').disabled=orderingBusy || !o?.connected || !!o?.uncertain || !orderingRows.length;
  $('buySubmitButton').disabled=orderingBusy || !o?.connected || !orderingQuote || !!o?.uncertain;
  if(!o?.connected){ orderingQuote=null; $('buyQuote').textContent=''; }
  $('buyUncertain').hidden=!o?.uncertain;
  const receipt=o?.receipt;
  $('buyReceipt').hidden=!receipt;
  $('buyReceiptText').textContent=receipt ? `已创建订单 ${receipt.order_id} · 预览金额 ¥${receipt.total}。支付结果请以官方收银台或 App 为准。` : '';
  $('buyPayment').hidden=!receipt?.payment_available;
}
async function orderingAction(action){
  if(orderingBusy) return;
  orderingBusy=true; renderOrdering();
  try{ await action(); }
  catch(error){ orderingMessage(error.message || '订餐操作失败，请重试'); }
  finally{
    if(refresh._running) await refresh();
    await refresh(); orderingBusy=false; renderOrdering();
  }
}
function clearOrderingInputs(){
  for(const id of ['buyAppSecret','buySignSecret','buyReceiver','buyPhone','buyAddress','buyNote']) $(id).value='';
}
function orderingInvalidate(){
  orderingQuote=null; $('buyQuote').textContent=''; $('buyConfirm').checked=false;
  renderOrdering();
}
function orderingLocationChanged(){
  orderingRows=[]; $('buyMenu').textContent=''; $('buyShops').textContent=''; orderingInvalidate();
  orderingMessage('查询位置已改变，请重新查询商家和菜单。');
}
async function orderingConfigure(){
  await orderingAction(async()=>{
    try{
      const r=await api('/api/ordering/configure',{app_id:$('buyAppId').value.trim(),app_secret:$('buyAppSecret').value,secret_sign:$('buySignSecret').value});
      orderingRows=[]; orderingInvalidate(); $('buyMenu').textContent=''; $('buyShops').textContent='';
      $('buyAuthorizeLink').hidden=true; orderingMessage(r.message);
    }finally{ $('buyAppSecret').value=''; $('buySignSecret').value=''; }
  });
}
async function orderingAuthorize(){
  await orderingAction(async()=>{
    const r=await api('/api/ordering/authorize',{});
    $('buyAuthorizeLink').href=r.url; $('buyAuthorizeLink').hidden=false; orderingMessage(r.message);
  });
}
async function orderingClear(){
  if(!confirm('清除本机服务内存中的外卖应用密钥、授权和订餐信息？若曾提示提交结果未知，请先在美团官方 App 核对订单。')) return;
  await orderingAction(async()=>{
    const r=await api('/api/ordering/logout',{});
    clearOrderingInputs(); orderingRows=[]; orderingInvalidate(); $('buyMenu').textContent=''; $('buyShops').textContent='';
    $('buyAuthorizeLink').hidden=true; orderingMessage(r.message);
  });
}
async function orderingSearch(){
  if(!$('buyConsent').checked) return orderingMessage('请先勾选本次订餐所需的信息转发确认。');
  await orderingAction(async()=>{
    orderingRows=[]; orderingInvalidate(); $('buyMenu').textContent=''; $('buyShops').textContent='';
    const r=await api('/api/ordering/shops',{longitude:$('buyLongitude').value,latitude:$('buyLatitude').value,keyword:$('buyKeyword').value,consent:true});
    $('buyShops').innerHTML=r.shops.length ? r.shops.map(shop=>`<div class="shop"><div class="row"><b>${esc(shop.name)}</b><span class="muted">${esc(shop.distance)} · 评分 ${esc(shop.wm_poi_score)}</span></div><p class="muted">起送 ¥${esc(shop.min_price)} · 配送 ¥${esc(shop.shipping_fee)}</p><button class="btn small" type="button" ${shop.status!==1?'disabled':''} onclick="orderingLoadMenu('${esc(shop.wm_poi_id)}')">${shop.status===1?'查看菜单':'当前不可配送'}</button></div>`).join('') : '<p class="muted">平台未返回符合条件的商家，请调整位置或关键词。</p>';
    orderingMessage('商家数据来自美团官方响应；查店成功不代表订单已创建。');
  });
}
async function orderingLoadMenu(shopId){
  await orderingAction(async()=>{
    orderingRows=[]; orderingInvalidate(); $('buyMenu').textContent='';
    const r=await api('/api/ordering/menu',{shop_id:shopId}); orderingRows=r.items;
    $('buyMenu').innerHTML=r.items.map((item,index)=>`<div class="shop buy-item" data-sku="${esc(item.id)}"><div class="row"><label class="switch"><input class="buy-select" type="checkbox" onchange="orderingInvalidate()" ${!item.safe||!item.available?'disabled':''}> <b>${esc(item.name)}</b> ${esc(item.spec)}</label><span>¥${esc(item.price)}</span>${item.required_category?'<span class="badge warn">属于必选分类</span>':''}</div><p class="muted">${!item.safe?'忌口规则拦截：'+esc(item.reason):!item.available?'平台显示不可售或缺货':'仍需你本人确认配料与忌口要求'} · 最少 ${esc(item.min_count)} 份</p><label class="f"><span>份数</span><input class="buy-count" type="number" min="${esc(item.min_count)}" max="99" value="${esc(item.min_count)}" onchange="orderingInvalidate()"></label>${item.attrs.map((attr,attrIndex)=>`<label class="f"><span>${esc(attr.name)||'菜品属性'}</span><select class="buy-attr" onchange="orderingInvalidate()"><option value="">请选择</option>${attr.values.map(v=>`<option value="${esc(v.id)}">${esc(v.value)}</option>`).join('')}</select></label>`).join('')}</div>`).join('') || '<p class="muted">平台没有返回可选择的菜品规格。</p>';
    orderingMessage('菜单已读取。请选择菜品、规格和份数，填写收货信息后预览金额。');
  });
}
function orderingCart(){
  return [...document.querySelectorAll('.buy-item')].filter(row=>row.querySelector('.buy-select').checked).map(row=>({
    sku_id:row.dataset.sku,count:Number(row.querySelector('.buy-count').value),
    attr_ids:[...row.querySelectorAll('.buy-attr')].map(select=>select.value || null),
  }));
}
async function orderingPreview(){
  if(!$('buyConsent').checked || !$('buyFoodConfirmed').checked) return orderingMessage('请确认信息转发及菜品忌口要求，再预览订单。');
  const items=orderingCart();
  if(!items.length) return orderingMessage('请先选择菜品。');
  if(items.some(item=>item.attr_ids.includes(null))) return orderingMessage('请补全每种菜品属性。');
  await orderingAction(async()=>{
    orderingInvalidate();
    const r=await api('/api/ordering/preview',{items,consent:true,food_confirmed:true,receiver:{
      name:$('buyReceiver').value,phone:$('buyPhone').value,address:$('buyAddress').value,note:$('buyNote').value,
      longitude:$('buyAddressLongitude').value || $('buyLongitude').value,
      latitude:$('buyAddressLatitude').value || $('buyLatitude').value,
    }});
    orderingQuote=r.quote;
    $('buyQuote').innerHTML=`<h2>平台订单预览 · 尚未下单</h2><p><b>${esc(r.quote.shop)}</b></p>${r.quote.items.map(item=>`<p>${esc(item.name)} · ${esc(item.spec)} ${item.attributes.map(esc).join('、')} × ${esc(item.count)}</p>`).join('')}<p>送到：${esc(r.quote.recipient_address)}<br>${esc(r.quote.recipient_name)} · ${esc(r.quote.phone_masked)}</p><p><b>预览总价 ¥${esc(r.quote.total)}</b> · 有效期 3 分钟</p>`;
    orderingMessage(r.message);
  });
}
async function orderingSubmit(){
  if(!orderingQuote) return orderingMessage('请先预览并核对订单。');
  if(!$('buyConsent').checked || !$('buyFoodConfirmed').checked) return orderingMessage('请先确认本次信息转发及菜品忌口要求。');
  if(!$('buyConfirm').checked) return orderingMessage('请勾选确认当前订单信息和金额。');
  await orderingAction(async()=>{
    try{
      const r=await api('/api/ordering/submit',{ticket:orderingQuote.ticket,confirmed:true});
      orderingMessage(r.message);
      if(r.created){ clearOrderingInputs(); orderingInvalidate(); $('buyQuote').textContent='订单已创建，请核对官方支付页面。'; }
    }catch(error){ orderingInvalidate(); throw error; }
  });
}
