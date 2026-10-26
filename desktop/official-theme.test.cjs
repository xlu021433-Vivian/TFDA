const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require('../.tool-cache/browser-tests/node_modules/jsdom');}})();
const source=fs.readFileSync(path.join(__dirname,'official-theme.js'),'utf8');
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
test('official reading is reversible, route scoped, and leaves transactional controls and text intact',async t=>{
  const dom=new JSDOM('<title>测试餐厅</title><body><dd data-tag="spu"><div class="name_real">素炒河粉</div><button id="add">加入购物车</button></dd></body>',{url:'https://h5.waimai.meituan.com/waimai/mindex/menu',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,d=w.document,button=d.getElementById('add'),original=d.body.innerHTML;w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};let clicks=0;button.onclick=()=>clicks++;
  w.eval(source);assert.equal(d.documentElement.dataset.shenqiReading,'menu');assert.equal(d.body.innerHTML,original);assert.equal(clicks,0);
  w.ShenqiReading.setEnabled(false);assert.equal(d.documentElement.hasAttribute('data-shenqi-reading'),false);
  w.ShenqiReading.setEnabled(true);assert.equal(d.documentElement.dataset.shenqiReading,'menu');
  const dialog=d.createElement('div');dialog.setAttribute('role','dialog');d.body.append(dialog);await pause();assert.equal(d.documentElement.hasAttribute('data-shenqi-reading'),false);
  dialog.hidden=true;await pause();assert.equal(d.documentElement.dataset.shenqiReading,'menu');
  dialog.hidden=false;await pause();assert.equal(d.documentElement.hasAttribute('data-shenqi-reading'),false);
  dialog.remove();await pause();assert.equal(d.documentElement.dataset.shenqiReading,'menu');
  for(const route of ['preview','order-detail','mine','address','login']){w.history.replaceState({},'', '/waimai/mindex/'+route);w.dispatchEvent(new w.PopStateEvent('popstate'));assert.equal(d.documentElement.hasAttribute('data-shenqi-reading'),false);}
  assert.equal(d.getElementById('add'),button);assert.equal(clicks,0);button.click();assert.equal(clicks,1);
});
test('reading theme is never installed into another service or a nondefault port',t=>{
  for(const url of ['https://cactivityapi-sc.waimai.meituan.com/h5/restaurant','https://h5.waimai.meituan.com:8443/waimai/mindex/home']){
    const dom=new JSDOM('<body>官方内容</body>',{url,runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.eval(source);assert.equal(dom.window.ShenqiReading,undefined);assert.equal(dom.window.document.querySelector('style'),null);
  }
});
