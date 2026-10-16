"""Loopback-only UI fixture. No real platform requests or scheduler are started."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flask import Response, send_from_directory
from app import app
from browser_package import EXTENSION_FILES, EXTENSION_ROOT


@app.get('/fixture-assets/<name>')
def fixture_asset(name):
    if name not in EXTENSION_FILES:
        return '', 404
    return send_from_directory(EXTENSION_ROOT, name)


@app.get('/waimai/mindex/menu')
def fixture_menu():
    return Response('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地测试商家</title>
<style>body{font:16px/1.6 system-ui;padding:24px;background:#f7f4ef;color:#222}article{max-width:520px}dd{margin:16px 0;padding:16px;background:white;border-radius:12px}.name_fixture{font-weight:bold}.sqt-menu-add-buttons{display:flex;gap:16px;align-items:center}.clickArea_fixture{display:inline-block;padding:12px;background:#ffcf35;border-radius:8px;cursor:pointer}#checkout{padding:16px;background:#333;color:white;display:inline-block;cursor:pointer}</style>
<h1>本地交互测试 · 不会创建真实订单</h1><article id="official"><dd data-tag="spu"><div class="name_fixture">清真牛肉饭</div><div data-tag="price">¥18.00</div><div class="sqt-menu-add-buttons"></div></dd><dd data-tag="spu"><div class="name_fixture">鸡肉饭</div><div data-tag="price">¥16.00</div><div class="sqt-menu-add-buttons"></div></dd><dd data-tag="spu"><div class="name_fixture">培根汉堡</div><div data-tag="price">¥15.00</div><div class="sqt-menu-add-buttons"></div></dd><dd data-tag="spu"><div class="name_fixture">珍珠奶茶</div><div data-tag="price">¥12.00</div><div class="sqt-menu-add-buttons"></div></dd><dd data-tag="spu"><div class="name_fixture">鲜乳奶茶</div><div data-tag="price">¥14.00</div><div class="sqt-menu-add-buttons"></div></dd><button aria-label="购物车,没有商品"></button><div id="checkout">去结算</div></article><p id="fixture-result" role="status"></p>
<script src="/fixture-assets/guard-data.js"></script><script src="/fixture-assets/policy.js"></script><script src="/fixture-assets/adapter.js"></script><script src="/fixture-assets/styles.js"></script>
<script>
if(location.hostname==='127.0.0.1') ShenqiPolicy.supported=url=>new URL(url).origin===location.origin;
// Fixture-only bridge. Production uses the actual isolated extension worker.
const fixtureState={preferences:{budget:'30',mode:'unpaid',expand:true},attempt:false};
window.chrome={runtime:{sendMessage:async msg=>{if(msg.type==='read')return{ok:true,...fixtureState};if(msg.type==='save'){fixtureState.preferences=msg.preferences;return{ok:true}}if(msg.type==='reserve'){if(fixtureState.attempt)return{ok:false,error:'已有提交尝试'};fixtureState.attempt=true;return{ok:true}}if(msg.type==='clear'&&msg.reviewed){fixtureState.attempt=false;return{ok:true}}return{ok:false}}}};
let counts=[0,0,0,0,0],packet=0,voucher=0,puffed=false;
function draw(){document.querySelectorAll('dd[data-tag=spu]').forEach((card,index)=>{const group=card.querySelector('.sqt-menu-add-buttons');group.replaceChildren();if(counts[index]){const minus=document.createElement('span');minus.setAttribute('aria-label','查看已选规格');group.append(minus,document.createTextNode(counts[index]));}const plus=document.createElement('span');plus.setAttribute('aria-label','选择规格');const area=document.createElement('span');area.className='clickArea_fixture';area.textContent='';area.style.cssText='width:44px;height:44px;';area.setAttribute('aria-label','加入 '+card.querySelector('.name_fixture').textContent);area.onclick=()=>{counts[index]++;draw()};plus.append(area);group.append(plus)});const total=counts.reduce((a,b)=>a+b,0);const cart=document.querySelector('button[aria-label^="购物车"]');cart.setAttribute('aria-label',total?'购物车':'购物车,没有商品');cart.textContent=total||'';}
draw();document.getElementById('checkout').onclick=()=>{
 const foods=[...document.querySelectorAll('dd[data-tag=spu]')].map((el,i)=>({name:el.querySelector('.name_fixture').textContent,n:counts[i],price:[18,16,15,12,14][i]})).filter(x=>x.n);
 const goods=foods.reduce((sum,x)=>sum+x.price*x.n,0);
 history.pushState({},'', '/waimai/mindex/preview');
 const official=document.getElementById('official');official.innerHTML='<h2>本地测试商家 · 测试地址</h2>'+foods.map(x=>'<div class="spuInfoList_fixture"><div><span class="spuInfoSpan_fixture">'+x.name+'</span></div><span class="spuAmount_fixture">x'+x.n+'</span></div>').join('')+'<div class="promotion_fixture" id="packet"><span>美团红包</span><span class="promotionSelect_fixture">未选红包</span></div><div class="promotion_fixture" id="voucher"><span>商家代金券</span><span class="promotionSelect_fixture">1张可用</span></div><div><span class="actual_fixture"></span><button id="sqt-openh5-preview-submit-btn">提交订单</button></div>';
 function total(){document.querySelector('.actual_fixture').textContent='合计¥'+(goods+1.5-packet-voucher).toFixed(2);document.querySelector('#packet .promotionSelect_fixture').textContent=packet?'-¥'+packet:'未选红包';document.querySelector('#voucher .promotionSelect_fixture').textContent=voucher?'-¥'+voucher:'1张可用';}
 total();document.getElementById('packet').onclick=()=>{
  const modal=document.createElement('section');modal.id='couponModal';modal.style='background:white;padding:20px;border:1px solid #ddd';let chosen=packet;
  function render(){modal.innerHTML='<span>可使用红包</span>'+(!puffed?'<div class="cell-wrapper" id="free"><div class="coupon-wrapper">吃喝玩乐神券<span class="price-amount-container">¥3</span></div><webc-text>免费膨胀</webc-text><span>不可撤销</span></div>':'')+'<div class="cell-wrapper"><div class="coupon-wrapper" id="seven">外卖神券<span class="price-amount-container">¥7</span></div></div><span>不可使用红包</span><button id="packetConfirm">确认</button>';
   modal.querySelector('#free webc-text')?.addEventListener('click',()=>{puffed=true;render()});modal.querySelector('#seven').onclick=()=>chosen=7;
   modal.querySelector('#packetConfirm').onclick=()=>{packet=chosen;voucher=0;modal.remove();total()};
  }render();official.append(modal);
 };
 document.getElementById('voucher').onclick=()=>{
  const modal=document.createElement('article');modal.innerHTML='<span>可用店铺券</span><div class="topPart_fixture"><span>本地测试商家</span><div class="disContainer_fixture">¥2</div><div class="select_fixture canceled_fixture"></div></div><button>确定</button>';let chosen=false;
  modal.querySelector('.topPart_fixture').onclick=()=>{chosen=!chosen;modal.querySelector('[class^=select_]').className='select_fixture '+(chosen?'selected_fixture':'canceled_fixture')};modal.querySelector('button').onclick=()=>{voucher=chosen?2:0;modal.remove();total()};official.append(modal);
 };
 document.getElementById('sqt-openh5-preview-submit-btn').onclick=()=>{document.getElementById('fixture-result').textContent='本地验证：已单次创建模拟待支付订单，未付款';history.pushState({},'', '/waimai/mindex/mock-unpaid');official.innerHTML='<h2>模拟待支付订单</h2><p>没有连接真实平台，不会创建真实订单。</p>';};
};
</script><script src="/fixture-assets/content.js"></script></html>''', mimetype='text/html')


@app.get('/fixture-options')
def fixture_options():
    source = (EXTENSION_ROOT / 'options.html').read_text('utf-8')
    for name in EXTENSION_FILES:
        source = source.replace(f'src="{name}"', f'src="/fixture-assets/{name}"')
        source = source.replace(f'href="{name}"', f'href="/fixture-assets/{name}"')
    bridge = '''<script>
const fixtureData={};const fixtureListeners=[];
window.chrome={runtime:{id:'fixture',getURL:name=>'chrome-extension://fixture/'+name,onMessage:{addListener:fn=>fixtureListeners.push(fn)},onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}},openOptionsPage:()=>{},sendMessage:msg=>new Promise(resolve=>fixtureListeners[0](msg,{id:'fixture',url:'chrome-extension://fixture/options.html'},resolve))},storage:{local:{get:async()=>structuredClone(fixtureData),set:async value=>Object.assign(fixtureData,structuredClone(value)),remove:async names=>{for(const name of [].concat(names))delete fixtureData[name]}}},alarms:{get:async()=>null,create:async()=>{},onAlarm:{addListener:()=>{}}},tabs:{onUpdated:{addListener:()=>{}},create:async()=>({id:1}),update:async()=>{},sendMessage:async()=>{}},scripting:{executeScript:async()=>{}},notifications:{create:async()=>{},onClicked:{addListener:()=>{}}}};
</script><script src="/fixture-assets/state.js"></script>'''
    source = source.replace('<script src="/fixture-assets/options.js">', bridge + '<script src="/fixture-assets/options.js">')
    source = source.replace('<main>', '<main><p style="font-weight:bold;color:#b42318">本地界面测试 · 不会启用真实定时任务或创建真实订单</p>')
    return Response(source, mimetype='text/html')


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8766, use_reloader=False, threaded=True)
