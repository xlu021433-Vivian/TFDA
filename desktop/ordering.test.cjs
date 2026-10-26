const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require('../.tool-cache/browser-tests/node_modules/jsdom');}})();
const P=require('./engine/policy.js');
const {create}=require('./engine/adapter.js');

test('the real missed medical-store category and recycled shop cards cannot be opened for lunch',t=>{
  const dom=new JSDOM('<body>'+['111医药馆（丈八北路店）','大药房','社区诊所','鲜花速递','EyeSoul隐形眼镜（丈八店）','咖啡色美瞳眼镜店','某某商贸','牛肉河粉餐厅'].map(name=>'<div class="poilist-item"><b class="poilist-item-info1name">'+name+'</b><p>起送￥15 配送约￥0</p></div>').join('')+'</body>',{url:'https://h5.waimai.meituan.com/waimai/mindex/home'});t.after(()=>dom.window.close());
  const d=dom.window.document,a=create(d,{visible:()=>true}),shops=a.shops(2500,'想吃河粉 25元预算 一份');
  assert.deepEqual(shops.map(x=>x.name),['牛肉河粉餐厅']);let clicks=0;shops[0].element.onclick=()=>clicks++;
  shops[0].element.querySelector('b').textContent='111医药馆';assert.throws(()=>a.openShop(shops[0],2500,'河粉'),/列表已变化/);assert.equal(clicks,0);
});
test('known food evidence and supported merchant links are required before navigation',t=>{
  for(const name of ['EyeSoul隐形眼镜（丈八店）','冷泡乌龙茶美瞳','茶色彩妆店','某某商贸'])assert.equal(P.foodShop(name,true),false,name);
  for(const name of ['牛肉河粉餐厅','肯德基','茶话弄','老乡鸡','三米粥铺'])assert.equal(P.foodShop(name,true),true,name);
  const unsupported='https://cactivityapi-sc.waimai.meituan.com/h5/sub-trade/restaurant/restaurant';
  const html=href=>'<div class="poilist-item"><a href="'+href+'"><b class="poilist-item-info1name">牛肉河粉餐厅</b></a><p>起送￥15 配送￥0</p></div>';
  const dom=new JSDOM(html(unsupported)+html('/waimai/mindex/menu?poi_id_str=food'),{url:'https://h5.waimai.meituan.com/waimai/mindex/home'});t.after(()=>dom.window.close());
  const a=create(dom.window.document,{visible:()=>true});assert.equal(a.shops(2500,'河粉').length,1);
  const chosen=a.shops(2500,'河粉')[0];chosen.element.querySelector('a').href=unsupported;assert.throws(()=>a.openShop(chosen,2500,'河粉'),/列表已变化/);
});

test('real separate fee fields cannot absorb the adjacent arrival time or distance',t=>{
  const card=(name,fee,min=20,extra='')=>'<div class="poilist-item"><div class="poilist-item-info1name">'+name+'</div><span class="poi-info-txt">起送 ¥'+min+'</span><span class="poi-info-txt no-margin-right">'+fee+'</span><span class="poi-info-txt">15分钟</span><span class="poi-info-txt">1.9km</span>'+extra+'</div>';
  const dom=new JSDOM(card('农耕记·盖码饭','配送 约¥0')+card('牛肉河粉餐厅','配送 约¥3.50')+card('鸡肉饭餐厅','免配送费')+card('牛肉面馆','配送 约¥6')+card('茶百道','配送 约¥0',18),{url:'https://h5.waimai.meituan.com/waimai/mindex/home'});t.after(()=>dom.window.close());
  const a=create(dom.window.document,{visible:()=>true});assert.match(dom.window.document.body.textContent,/配送 约¥015分钟/);
  assert.deepEqual(a.shops(2500,'').map(x=>[x.name,x.minimum,x.delivery]),[['农耕记·盖码饭',2000,0],['牛肉河粉餐厅',2000,350],['鸡肉饭餐厅',2000,0]]);
  assert.deepEqual(a.shops(2500,'奶茶').map(x=>x.name),['茶百道']);assert.ok(!a.shops(2500,'河粉').some(x=>x.name==='茶百道'));
});
test('missing or conflicting fee fields remain unknown instead of being treated as free',t=>{
  const dom=new JSDOM('<div class="poilist-item"><b class="poilist-item-info1name">牛肉面馆</b><span>起送 ¥20</span><span>减5元配送费</span></div><div class="poilist-item"><b class="poilist-item-info1name">鸡肉饭餐厅</b><span>起送 ¥20</span><span>配送 ¥0</span><span>配送 ¥8</span></div>',{url:'https://h5.waimai.meituan.com/waimai/mindex/home'});t.after(()=>dom.window.close());
  const a=create(dom.window.document,{visible:()=>true});assert.equal(a.shops(2500,'').length,0);assert.ok(a.shopDiagnostics().every(x=>x.delivery===null));
});

test('medical and contact-lens stores on the menu route cannot mutate a cart',async t=>{
  for(const title of ['111医药馆（丈八北路店）','EyeSoul隐形眼镜（丈八店）']){const f=fixture(t);f.d.title=title;await assert.rejects(f.adapter.add(f.key,2500),/非餐饮/);assert.equal(f.counts().clicks,0);}
});

test('the reported river-noodle sentence and common budget orders are understood',()=>{
  for(const text of ['想吃河粉 25元预算 一份','想吃河粉，预算25，一份','请帮我点一份河粉，二十五元以内']){
    const request=P.intent(text);assert.equal(request.category,'面条');assert.equal(request.quantity,1);assert.equal(request.budget,2500);assert.deepEqual(request.keywords,['河粉']);
    assert.equal(P.randomPlan([{name:'素炒河粉',cents:1500},{name:'牛肉拉面',cents:1400}],request,2500)[0].name,'素炒河粉');
    assert.match(P.describe(request,2500),/河粉.*1.*25/);
  }
});
test('protein plus staple is one dish, and named food is not silently replaced',()=>{
  const request=P.intent('帮我点一份牛肉饭，25元以内');
  assert.equal(P.randomPlan([{name:'鸡肉饭',cents:1400},{name:'牛肉盖浇饭',cents:1600}],request,2500)[0].name,'牛肉盖浇饭');
  assert.throws(()=>P.randomPlan([{name:'牛肉饭',cents:1200}],P.intent('宫保鸡丁一份'),2500),/没有符合/);
});
test('drink quantity and explicit options survive interpretation',()=>{
  assert.deepEqual(P.intent('来两杯奶茶，少糖去冰，40块以内'),{category:'奶茶',quantity:2,budget:4000,options:{sugar:'少糖',temperature:'去冰'}});
  assert.equal(P.intent('一杯热奶茶').options.temperature,'热');assert.equal(P.optionMatches('temperature','热','热'),true);
  assert.equal(P.intent('我不吃猪肉，随便点点').category,'');
});
test('conflicts, multiple meals, unknown requirements and invalid amounts remain explicit stops',()=>{
  for(const value of ['奶茶不用券','吃猪肉饭','奶茶无糖半糖','奶茶不要珍珠','牛肉饭不辣','奶茶和咖啡','20杯奶茶','奶茶预算abc','奶茶预算25元30元','零杯奶茶'])assert.throws(()=>P.intent(value),undefined,value);
  assert.throws(()=>P.randomPlan([{name:'奶茶蛋糕',cents:1000},{name:'培根饭',cents:1000}],P.intent('奶茶'),2500));
});

function fixture(t,{control='direct',silent=false,unknown=false,disabled=false}={}){
  const dom=new JSDOM('<body><dd data-tag="spu"><div class="name_real">鲜奶茶</div><div data-tag="price">¥12</div><div id="group" class="sqt-menu-add-buttons"></div></dd><button id="cart" aria-label="购物车，没有商品"></button></body>',{url:'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture',runScripts:'outside-only'});
  t.after(()=>dom.window.close());const w=dom.window,d=w.document;let clicks=0,adds=0,q=0;
  const group=d.getElementById('group'),cart=d.getElementById('cart');
  function update(){q++;adds++;group.innerHTML='<span aria-label="移出购物车"></span><span class="count_real">'+q+'</span><span aria-label="加入购物车"><span class="clickArea_real"></span></span>';group.querySelector('.clickArea_real').onclick=onClick;cart.setAttribute('aria-label','购物车，已选商品');cart.textContent=String(q);}
  function spec(){const dialog=d.createElement('section');dialog.id='spec';dialog.innerHTML='<button aria-label="关闭商品规格选择弹窗">关闭</button><dl data-tag="attribute"><dt>糖度</dt><dd><span class="tag_real selected_real">全糖</span><span class="tag_real">少糖</span></dd></dl><dl data-tag="attribute"><dt>冰量</dt><dd><span class="tag_real selected_real">正常冰</span><span class="tag_real">去冰</span></dd></dl><div class="price_real">总计 ¥12<div class="oriPrice_real">¥18</div></div><div class="addToCartBtn_real">加入购物车</div>';d.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.remove();for(const tag of dialog.querySelectorAll('.tag_real'))tag.onclick=()=>{for(const peer of tag.parentElement.children)peer.className='tag_real';tag.className='tag_real selected_real';};dialog.querySelector('.addToCartBtn_real').onclick=update;}
  function onClick(){clicks++;if(silent)return;if(control==='direct')update();else spec();}
  if(control==='multi'){group.classList.add('mBtnGroup_real');group.onclick=onClick;}else{group.innerHTML='<span aria-label="'+(control==='direct'?'加入购物车':'选择规格')+'" class="'+(disabled?'plusGrey_real':'plus_real')+'"><span class="clickArea_real"></span></span>';group.querySelector('.clickArea_real').onclick=onClick;}
  if(unknown){cart.textContent='未知';cart.setAttribute('aria-label','购物车');}
  const adapter=create(d,{visible:()=>true,timeout:40,interval:1});
  return {d,w,adapter,key:adapter.cards()[0].key,counts:()=>({clicks,adds,q}),spec};
}
test('ordinary no-spec add uses the actual add label and works for two quantities',async t=>{
  const f=fixture(t);assert.equal((await f.adapter.add(f.key,2500)).status,'added');assert.equal((await f.adapter.add(f.key,2500)).status,'added');assert.deepEqual(f.counts(),{clicks:2,adds:2,q:2});
});
test('the official multi-spec group opens without an aria-labelled inner button',async t=>{
  const f=fixture(t,{control:'multi'});assert.equal((await f.adapter.add(f.key,2500)).status,'specs');assert.equal(f.counts().adds,0);
});
test('requested sugar and ice are verified before adding; original price is excluded',async t=>{
  const f=fixture(t,{control:'spec'}),result=await f.adapter.add(f.key,2500,{requireSpecs:true});
  await f.adapter.confirmDefaultSpecs(result.pending,2500,P.intent('奶茶少糖去冰'));
  assert.deepEqual(f.counts(),{clicks:1,adds:1,q:1});assert.equal(f.adapter.specDialog(),null);
});
test('missing requested option stops without using the default or confirming add',async t=>{
  const f=fixture(t,{control:'spec'}),result=await f.adapter.add(f.key,2500);
  await assert.rejects(f.adapter.confirmDefaultSpecs(result.pending,2500,P.intent('奶茶无糖')),/无糖/);assert.equal(f.counts().adds,0);
});
test('nested selected styling represents one option, not two competing selections',async t=>{
  const f=fixture(t,{control:'spec'}),result=await f.adapter.add(f.key,2500);
  for(const tag of f.d.querySelectorAll('.tag_real.selected_real'))tag.innerHTML='<span class="selected_text">'+tag.textContent+'</span>';
  await f.adapter.confirmDefaultSpecs(result.pending,2500,P.intent('奶茶'));assert.equal(f.counts().adds,1);
});
test('official selected summary resolves changed styling, while conflicts still stop before add',async t=>{
  const f=fixture(t,{control:'spec'}),result=await f.adapter.add(f.key,2500);
  for(const tag of f.d.querySelectorAll('.selected_real'))tag.className='tag_real';
  const summary=f.d.createElement('p');summary.textContent='已选规格：全糖、正常冰';f.d.getElementById('spec').append(summary);
  await f.adapter.confirmDefaultSpecs(result.pending,2500,P.intent('奶茶'));assert.equal(f.counts().adds,1);
  const g=fixture(t,{control:'spec'}),pending=await g.adapter.add(g.key,2500);const wrong=g.d.createElement('p');wrong.textContent='已选规格：少糖、正常冰';g.d.getElementById('spec').append(wrong);
  await assert.rejects(g.adapter.confirmDefaultSpecs(pending.pending,2500,P.intent('奶茶')),/摘要/);assert.equal(g.counts().adds,0);
});
test('cart badge outside the icon is read without confusing the total price with a quantity',t=>{
  const f=fixture(t),button=f.d.querySelector('button');button.setAttribute('aria-label','购物车');button.outerHTML='<div class="cart_footer"><button aria-label="购物车"></button><span class="badge_real">1</span><span>¥23.90</span></div>';
  assert.equal(f.adapter.cart().count,1);f.d.querySelector('.badge_real').remove();assert.equal(f.adapter.cart().count,null);
});

test('direct-add goods cannot silently ignore requested specifications',async t=>{
  const f=fixture(t);await assert.rejects(f.adapter.add(f.key,2500,{requireSpecs:true}),/规格/);assert.equal(f.counts().clicks,0);
});
test('disabled and unknown-cart controls are never clicked',async t=>{
  for(const options of [{disabled:true},{unknown:true}]){const f=fixture(t,options);await assert.rejects(f.adapter.add(f.key,2500));assert.equal(f.counts().clicks,0);}
});
test('an unknown mutation is never retried',async t=>{
  const f=fixture(t,{silent:true});await assert.rejects(f.adapter.add(f.key,2500),/未确认/);await assert.rejects(f.adapter.add(f.key,2500),/上次/);assert.equal(f.counts().clicks,1);
});
test('the desktop shows interpretation or an actionable error as the user types',async t=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'options.html'),'utf8'),{url:'https://shenqi.local/options.html',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;
  const listeners=[];w.chrome={webview:{addEventListener:(type,fn)=>listeners.push(fn),postMessage:msg=>queueMicrotask(()=>listeners.forEach(fn=>fn({data:{channel:'native-result',id:msg.id,result:msg.action==='status'?{}:msg.action==='storage_get'?{}:{ok:true}}})))}};
  w.ShenqiPolicy=P;w.ShenqiSchedule=require('./engine/schedule.js');w.ShenqiDesktopWorker={createRuntime:()=>({tick:async()=>{},message:async()=>({ok:true})})};w.eval(fs.readFileSync(path.join(__dirname,'desktop.js'),'utf8'));
  await new Promise(r=>setTimeout(r,20));const input=d.getElementById('request');input.value='想吃河粉 25元预算 一份';input.dispatchEvent(new w.Event('input'));await new Promise(r=>setTimeout(r,20));assert.match(d.getElementById('intentResult').textContent,/河粉.*25/);assert.equal(d.getElementById('budget').value,'25.00');
  input.value='奶茶不用券';input.dispatchEvent(new w.Event('input'));await new Promise(r=>setTimeout(r,20));assert.match(d.getElementById('intentResult').textContent,/冲突/);assert.equal(d.getElementById('startMeal').disabled,true);
});

test('pause during lazy control preparation prevents the first mutating click',async t=>{
  const f=fixture(t);let stopped=false;f.d.querySelector('dd[data-tag]').scrollIntoView=()=>{stopped=true;};
  await assert.rejects(f.adapter.add(f.key,2500,{shouldStop:()=>stopped}),/停止/);assert.equal(f.counts().clicks,0);assert.equal(f.adapter.isUncertain(),false);
});
test('pause before specification confirmation prevents option and cart mutations',async t=>{
  const f=fixture(t,{control:'spec'}),result=await f.adapter.add(f.key,2500);
  await assert.rejects(f.adapter.confirmDefaultSpecs(result.pending,2500,P.intent('奶茶少糖去冰'),()=>true),/停止/);
  assert.equal(f.counts().adds,0);assert.match(f.d.querySelector('.selected_real').textContent,/全糖/);
});
function couponFixture(t,{red=true,merchant='-¥3'}={}){
  const dom=new JSDOM('<body>'+(red?'<div class="promotion_real" id="red"><span>美团红包</span><span class="promotionSelect_real">无可用</span></div>':'')+'<div class="promotion_real" id="merchant"><span>商家代金券</span><span class="promotionSelect_real">'+merchant+'</span></div><div><span class="actual_real">¥15</span><button id="sqt-openh5-preview-submit-btn">提交订单</button></div></body>',{url:'https://h5.waimai.meituan.com/waimai/mindex/preview'});t.after(()=>dom.window.close());
  const d=dom.window.document;let redClosed=0,selected=0,submits=0;
  d.querySelector('#sqt-openh5-preview-submit-btn').onclick=()=>submits++;
  if(red)d.getElementById('red').onclick=()=>{const modal=d.createElement('article');modal.innerHTML='<span>不可使用红包</span><button>确认</button>';modal.querySelector('button').onclick=()=>{redClosed++;modal.remove();};d.body.append(modal);};
  d.getElementById('merchant').onclick=()=>{const modal=d.createElement('article');modal.innerHTML='<span>可用店铺券</span><div class="topPart_real"><span class="disContainer_real">¥5</span><span class="select_real canceled_real"></span></div><button>确定</button>';modal.querySelector('.topPart_real').onclick=()=>{selected++;modal.querySelector('.select_real').className='select_real';};modal.querySelector('button').onclick=()=>{if(!modal.querySelector('.canceled_real'))d.querySelector('#merchant .promotionSelect_real').textContent='-¥5';modal.remove();};d.body.append(modal);};
  return {d,a:create(d,{visible:()=>true,timeout:40,interval:1}),counts:()=>({redClosed,selected,submits})};
}
test('a genuinely applied merchant voucher alone satisfies the coupon requirement',async t=>{
  const f=couponFixture(t,{red:false});const result=await f.a.applyCoupons();assert.equal(result.coupons[1].discount,300);assert.equal(f.counts().submits,0);
});
test('an empty red-packet list closes and continues to a usable merchant voucher',async t=>{
  const f=couponFixture(t,{merchant:'1张可用'});const result=await f.a.applyCoupons({expand:true});assert.equal(result.coupons[1].discount,500);assert.deepEqual(f.counts(),{redClosed:1,selected:1,submits:0});
});
test('no red packet and no actual merchant discount is still a hard stop',async t=>{
  const f=couponFixture(t,{merchant:'无可用'});await assert.rejects(f.a.applyCoupons(),/实际用券/);assert.equal(f.counts().submits,0);
});
test('complex specifications wait for a reviewed one-item add, and verification never adds again',async t=>{
  const f=fixture(t,{control:'spec'}),received=[],listeners=[];
  f.w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
  const task={id:'manual-fixture',stage:'menu',currentShop:true,tried:[],minimum:0,config:{budget:2500,request:'奶茶无糖',defaultSpecs:true,anyShop:true}};
  const checkout=f.d.createElement('button');checkout.textContent='去结算';let checkouts=0;checkout.onclick=()=>checkouts++;f.d.body.append(checkout);
  f.w.chrome={runtime:{id:'test',onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async message=>{received.push(message);return message.type==='read'?{ok:true,attempt:false,preferences:{budget:'25',mode:'unpaid'},run:task}:{ok:true,run:task};}}};
  for(const name of ['guard-data.js','policy.js','adapter.js','styles.js','content.js'])f.w.eval(fs.readFileSync(path.join(__dirname,'engine',name),'utf8'));
  const shadow=f.d.getElementById('shenqi-waimai-assistant').shadowRoot;
  for(let i=0;i<50&&shadow.getElementById('verify').hidden;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(shadow.getElementById('verify').hidden,false);assert.equal(f.counts().adds,0);assert.equal(received.some(x=>x.type==='schedule_failed'),false);
  for(const fn of listeners)fn({type:'verify_pending',reviewed:true},{id:'test'});
  await new Promise(r=>setTimeout(r,15));assert.equal(received.some(x=>x.type==='schedule_failed'),false);assert.equal(f.counts().adds,0);
  f.d.querySelector('.addToCartBtn_real').click();
  for(const fn of listeners)fn({type:'verify_pending',reviewed:true},{id:'test'});
  await new Promise(r=>setTimeout(r,25));assert.equal(f.counts().adds,1);assert.equal(checkouts,1);assert.equal(shadow.getElementById('verify').hidden,true);
});

test('a stop received during manual verification cannot restart checkout',async t=>{
  const f=fixture(t,{control:'spec'}),listeners=[];let stopOnCheck=false,checkouts=0;
  f.w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
  const task={id:'stop-fixture',stage:'menu',currentShop:true,tried:[],minimum:0,config:{budget:2500,request:'奶茶无糖',defaultSpecs:true,anyShop:true}};
  const checkout=f.d.createElement('button');checkout.textContent='去结算';checkout.onclick=()=>checkouts++;f.d.body.append(checkout);
  f.w.chrome={runtime:{id:'test',onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async body=>{
    if(body.type==='schedule_check'&&stopOnCheck)for(const fn of listeners)fn({type:'stop_scheduled'},{id:'test'});
    return body.type==='read'?{ok:true,attempt:false,preferences:{budget:'25',mode:'unpaid'},run:task}:{ok:true,run:task};
  }}};
  for(const name of ['guard-data.js','policy.js','adapter.js','styles.js','content.js'])f.w.eval(fs.readFileSync(path.join(__dirname,'engine',name),'utf8'));
  const shadow=f.d.getElementById('shenqi-waimai-assistant').shadowRoot;
  for(let i=0;i<50&&shadow.getElementById('verify').hidden;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(shadow.getElementById('verify').hidden,false);f.d.querySelector('.addToCartBtn_real').click();stopOnCheck=true;
  for(const fn of listeners)fn({type:'verify_pending',reviewed:true},{id:'test'});
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.counts().adds,1);assert.equal(checkouts,0);assert.equal(shadow.getElementById('verify').hidden,true);
});


test('delivery discounts alone cannot authorize submission, even when the total fits',async t=>{
  const f=couponFixture(t,{red:false,merchant:'无可用'}),d=f.d;
  const fee=d.createElement('div');fee.innerHTML='<span>配送费</span><s>¥3.60</s><span>-¥3.60</span>';d.body.append(fee);
  const foods=d.createElement('div');foods.className='spuInfoList_real';foods.innerHTML='<span class="spuInfoSpan_real">素炒河粉</span><span class="spuAmount_real">x1</span>';d.body.append(foods);
  let reserved=0;await assert.rejects(f.a.createUnpaid({budget:2500,authorize:true,fingerprint:f.a.previewFingerprint(),reserve:async()=>reserved++}),/用券/);
  assert.equal(reserved,0);assert.equal(f.counts().submits,0);
});
test('coupon removal while saving the duplicate guard stops before the submit click',async t=>{
  const f=couponFixture(t,{red:false}),d=f.d;const foods=d.createElement('div');foods.className='spuInfoList_real';foods.innerHTML='<span class="spuInfoSpan_real">素炒河粉</span><span class="spuAmount_real">x1</span>';d.body.append(foods);
  let reserved=0;await assert.rejects(f.a.createUnpaid({budget:2500,authorize:true,fingerprint:f.a.previewFingerprint(),reserve:async()=>{reserved++;d.querySelector('#merchant .promotionSelect_real').textContent='无可用';}}),/变化/);assert.equal(reserved,1);assert.equal(f.counts().submits,0);
});
