const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require('../.tool-cache/browser-tests/node_modules/jsdom');}})();
const P=require('./engine/policy.js');
const {create}=require('./engine/adapter.js');

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
  const dom=new JSDOM('<body><dd data-tag="spu"><div class="name_real">鲜奶茶</div><div data-tag="price">¥12</div><div id="group" class="sqt-menu-add-buttons"></div></dd><button id="cart" aria-label="购物车，没有商品"></button></body>',{url:'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture'});
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
