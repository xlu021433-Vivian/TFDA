(function () {
  'use strict';
  const P = globalThis.ShenqiPolicy;
  if (!P.supported(location.href)) return;
  const existing = document.getElementById('shenqi-waimai-assistant');
  if (existing) { existing.hidden = false; return; }
  const host = document.createElement('aside');
  host.id = 'shenqi-waimai-assistant';
  host.style.cssText = 'position:fixed;right:12px;top:16px;z-index:2147483600;';
  const shadow = host.attachShadow({mode: 'open'});
  shadow.innerHTML = `<style>${globalThis.ShenqiStyles}</style><div class="panel" aria-label="网页点餐助手"><header><div><b>神器 · 点餐</b><span>选好这一餐，再去结算</span></div><button id="collapse" aria-label="收起或展开助手">收起</button><button id="close" aria-label="关闭助手">×</button></header><main>
    <h2 id="shop">本次点餐</h2><p class="muted">当前仅支持美团网页版。先在官方页选店，再读取已加载的菜单。</p>
    <div id="requestBox"><label><span>今天想吃什么？</span><input id="request" type="text" maxlength="160" placeholder="我想喝奶茶，预算30元，一杯"></label><div class="row"><button id="random" class="primary">帮我随机选</button><button id="start">开始自助加购</button></div><p class="muted">在当前商家已加载菜单中挑选；没有合适商品就暂停，请在官方页换店。</p></div>
    <p class="preferences">已记住：不吃猪肉 · 必须实际用券</p>
    <div class="row"><label><span>本餐预算上限（含配送等费用）</span><input id="budget" type="number" value="40" min="0.01" step="0.01" inputmode="decimal"></label><button id="refresh">读取菜单</button></div>
    <details id="settings"><summary>自助点餐设置</summary><label><span>完成到哪一步</span><select id="mode"><option value="unpaid">创建待支付订单，我来付款</option><option value="preview">只到预览，由我提交</option></select></label><label class="consent"><input type="checkbox" id="expand" checked><span>可免费膨胀时先膨胀一张（每次最多一张；金额和门槛随机，不可撤销）</span></label><button id="save" class="wide">保存预算与设置</button><p id="saved" class="muted">不吃猪肉、必须用券始终生效。</p></details>
    <div class="ticket"><div id="amount" class="amount">¥0.00</div><div id="summary" class="meta">所选菜品小计 · 不含包装、配送费</div><div id="cart" class="meta">购物车：待核对</div></div>
    <input id="filter" type="search" placeholder="在已读取菜品中筛选" aria-label="筛选已读取的菜品">
    <div id="menu"></div>
    <label id="ingredientConsent" class="consent"><input id="ingredients" type="checkbox"><span>我已核对所选食材与忌口。菜名筛选不能保证配料安全；规格在官方弹窗中选择。</span></label>
    <label id="autoConsentLabel" class="consent"><input id="autoConsent" type="checkbox"><span>本次自助：我已在官方页确认当前商家和配送地址，允许助手按所选餐品、当前预算且必须用券的条件创建 1 笔待支付订单。付款由我完成。</span></label>
    <button id="add" class="primary wide">按所选数量加购</button><button id="verify" class="wide" hidden>我已在官方弹窗加了 1 份，核对结果</button><button id="checkout" class="wide">核对数量并前往官方结算</button>
    <section id="couponBox" hidden><h2>券后再下单</h2><p id="coupons" class="muted">尚未核对抵扣</p><button id="couponsApply" class="primary wide">免费膨胀并选择可用券</button><label class="consent"><input id="orderConsent" type="checkbox"><span>我已核对官方页面的商家、地址、菜品和规格，授权在本餐预算内创建这一笔待支付订单。</span></label><button id="createOrder" class="wide">核对用券后创建待支付订单</button><p class="muted">提交只尝试一次，付款由本人完成。没有实际用券、超预算、页面变化时停止。</p></section>
    <details id="recovery" hidden><summary>已有提交尝试，请先核对官方订单</summary><p class="muted">若提交结果不明，先到美团官方订单列表检查，不能直接重试。</p><label class="consent"><input type="checkbox" id="reviewed"><span>我已核对官方订单，确认可以开始下一餐</span></label><button id="clearAttempt">核对后解除防重记录</button></details>
    <div id="status" class="status" role="status" aria-live="polite">可输入想吃的品类，也可直接随机选。先核对食材，券后创建待支付订单，付款交给你。</div>
  </main></div>`;
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);
  const adapter = globalThis.ShenqiAdapter.create(document);
  const selected = new Map();
  let menu = [], pending = null, busy = false, stopped = false, currentScope = adapter.scope(), lastPreviewAmount = null;
  let autoFlow=false, consentFingerprint='', lastCouponSignature='', attempt=false, persistenceReady=false;
  let armed=null;
  let scheduledId=null,scheduledRun=null,scheduledPhase='';
  let settingsTouched=false;
  function revokeAuto(){armed=null; $('autoConsent').checked=false;}
  for(const id of ['request','budget','mode','expand']) $(id).addEventListener('input',()=>{settingsTouched=true; revokeAuto();});
  async function message(value) {
    if(!globalThis.chrome?.runtime?.sendMessage) throw Error('扩展设置与提交防重不可用，请通过已安装的扩展打开助手');
    const result=await chrome.runtime.sendMessage(value);
    if(!result?.ok) throw Error(result?.error || '无法记录操作，已暂停');
    return result;
  }
  async function reserveSubmission() {
    await message({type:'reserve',budget:P.cents($('budget').value),total:adapter.previewTotal(),runId:scheduledId}); attempt=true;
    $('cart').textContent='已有提交尝试，请以官方订单状态为准';
  }
  function status(message, kind = '') { $('status').textContent = message; $('status').className = `status ${kind}`; }
  function controls() {
    $('add').disabled = busy || !!pending || adapter.isUncertain();
    $('checkout').disabled = busy || !!pending || adapter.isUncertain();
    $('refresh').disabled = busy || !!pending;
    $('verify').hidden = !pending;
    $('verify').disabled = busy;
    $('budget').disabled = busy || !!pending;
    $('autoConsent').disabled=busy || !!pending || attempt || !persistenceReady;
    $('autoConsentLabel').hidden=$('mode').value!=='unpaid' || !/\/mindex\/menu\/?$/.test(location.pathname);
    for(const id of ['random','start','couponsApply','save','mode','expand']) $(id).disabled=busy || !!pending || attempt;
    $('createOrder').disabled=busy || attempt || !persistenceReady || !$('orderConsent').checked || $('mode').value!=='unpaid';
    $('recovery').hidden=!attempt;
    for (const input of $('menu').querySelectorAll('input')) input.disabled = busy || !!pending || input.dataset.blocked === 'true';
  }
  function items() {
    return [...selected].map(([key, desired]) => {
      const item = menu.find(entry => entry.key === key);
      if (!item) throw Error('所选菜品已变化，请重新读取菜单并选择');
      return {...item, desired};
    });
  }
  function summary() {
    const rows = items();
    const total = rows.reduce((sum, item) => sum + (item.cents || 0) * item.desired, 0);
    $('amount').textContent = P.money(total);
    $('summary').textContent = `${rows.reduce((sum, item) => sum + item.desired, 0)} 份菜品小计 · 包装、配送费以官方预览为准`;
    const count = adapter.cart().count;
    $('cart').textContent = `官方购物车：${count === null ? '无法核对' : `${count} 份`}`;
  }
  function draw() {
    $('menu').replaceChildren();
    const filter = $('filter').value.trim();
    let shown = 0;
    for (const item of menu) {
      if (filter && !item.name.includes(filter)) continue;
      shown++;
      const reason = item.blocked || (item.soldOut ? '已售罄' : item.cents === null ? '价格无法核对' : '');
      const row = document.createElement('div'); row.className = `dish ${reason ? 'blocked' : ''}`;
      const label = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(item.key); check.dataset.blocked = String(!!reason); check.disabled = !!reason;
      const info = document.createElement('div'), name = document.createElement('b'), detail = document.createElement('small');
      name.textContent = item.name; detail.textContent = reason || `${P.money(item.cents)} · 购物车 ${item.quantity === null ? '数量待核对' : item.quantity + ' 份'}`;
      info.append(name, detail); label.append(check, info);
      const quantity = document.createElement('input'); quantity.type = 'number'; quantity.min = '1'; quantity.max = '10'; quantity.step = '1'; quantity.value = selected.get(item.key) || 1; quantity.dataset.blocked = String(!!reason); quantity.disabled = !!reason; quantity.setAttribute('aria-label', `${item.name}的目标份数`);
      check.addEventListener('change', () => { if (check.checked) selected.set(item.key, Number(quantity.value)); else selected.delete(item.key); revokeAuto(); $('ingredients').checked = false; summary(); });
      quantity.addEventListener('input', () => { if (check.checked) selected.set(item.key, Number(quantity.value)); revokeAuto(); $('ingredients').checked = false; summary(); });
      row.append(label, quantity); $('menu').append(row);
    }
    if (!shown) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = menu.length ? '当前筛选没有匹配菜品' : '尚未读到菜品。请在官方页切换分类或滚动加载，再点击“读取菜单”。'; $('menu').append(p); }
    summary(); controls();
  }
  function scan() {
    menu = adapter.cards();
    // Missing, repriced, or newly unavailable selections require a new choice.
    for (const key of selected.keys()) if (!menu.some(item => item.key === key && !item.soldOut && !item.blocked)) selected.delete(key);
    $('ingredients').checked = false;
    revokeAuto();
    $('shop').textContent = document.title === '美团外卖' ? '本次点餐' : document.title;
    draw();
  }
  async function run(action) {
    if (busy) return;
    busy = true; controls();
    try { await action(); }
    catch (error) {
      if(!pending){autoFlow=false;armed=null;}
      status(error.message || '操作未完成，请检查官方页面', 'bad');
      if(scheduledId&&!pending)try{await message({type:'schedule_failed',id:scheduledId,reason:error.message||'点餐未完成'});}catch{}
    }
    finally { busy = false; controls(); }
  }
  async function addAction() {
    if(stopped&&scheduledId)throw Error('本次点餐已暂停，不会恢复加购');
    stopped = false;
    if (!$('ingredients').checked) throw Error('请先核对所选菜品的食材与忌口');
    const budget = P.cents($('budget').value), plan = items();
    P.checkPlan(plan, budget);
    for (const selectedItem of plan) {
      let actual = adapter.cards().find(item => item.key === selectedItem.key);
      if (!actual || actual.quantity === null || actual.quantity > selectedItem.desired) throw Error('实际数量无法核对或已超过目标份数，请在官方购物车调整');
      while (actual.quantity < selectedItem.desired) {
        if (stopped) throw Error('已停止后续加购。已加入的商品请在官方购物车核对');
        if(scheduledId)await message({type:'schedule_check',id:scheduledId});
        status(`正在加购并核对：${actual.name}`);
        const request=P.intent(scheduledRun?.config.request??$('request').value);
        const result = await adapter.add(actual.key, budget,{requireSpecs:!!request.options,shouldStop:()=>stopped});
        if (result.status === 'specs') {
          let reason='';
          if(scheduledId&&scheduledRun.config.defaultSpecs){
            try{await adapter.confirmDefaultSpecs(result.pending,budget,request,()=>stopped);actual=adapter.cards().find(item=>item.key===selectedItem.key);continue;}
            catch(error){if(stopped||adapter.isUncertain())throw error;reason=error.message;}
          }
          pending = result.pending;
          status(`${reason?reason+'。':''}请在右侧官方弹窗选择“${actual.name}”的规格，核对忌口和输入的要求，只加入 1 份；再在左侧点击“核对并继续”。`);
          if(scheduledId)message({type:'schedule_attention',id:scheduledId}).catch(()=>{});
          return;
        }
        actual = adapter.cards().find(item => item.key === selectedItem.key);
      }
    }
    menu = adapter.cards(); draw(); status('所选数量已核对。前往官方结算后，还需核对含配送费的最终合计。', 'good');
    if(autoFlow && !stopped) {
      if(scheduledId)await message({type:'schedule_stage',id:scheduledId,stage:'preview',expected:items().map(({name,desired})=>({name,desired}))});
      adapter.checkout(items(),budget,()=>stopped); status('加购已核对，正在前往官方结算并准备选券。');
    }
  }
  $('add').onclick = () => run(addAction);
  function choose() {
    adapter.ensure();
    if(adapter.cart().count!==0) throw Error('随机选餐前请在官方购物车清空或核对已有商品，避免混入上一餐');
    const request=P.intent($('request').value);
    const budget=request.budget??P.cents($('budget').value);
    if(!Number.isSafeInteger(budget) || budget<=0) throw Error('请填写有效的本餐预算');
    const fresh=adapter.cards(), plan=P.randomPlan(fresh,request,budget);
    menu=fresh; selected.clear(); revokeAuto(); for(const item of plan) selected.set(item.key,item.desired);
    $('budget').value=(budget/100).toFixed(2); $('ingredients').checked=false; draw();
    status(`随机选中 ${plan[0].name} × ${plan[0].desired}。请核对食材后点“开始自助加购”；不为凑券自动增购。`,'good');
  }
  $('random').onclick=()=>run(async()=>choose());
  $('request').onkeydown=event=>{if(event.key==='Enter') $('random').click();};
  $('start').onclick=()=>run(async()=>{
    if(attempt) throw Error('请先核对上一笔官方订单');
    if(!selected.size) { choose(); return; }
    if(!$('ingredients').checked) throw Error('请先核对随机选中的食材并勾选确认');
    if($('mode').value==='unpaid') {
      if(!persistenceReady || !$('autoConsent').checked) throw Error('自动待支付模式需勾选本次自助授权；也可在设置中改为只到预览');
      const budget=P.cents($('budget').value), plan=items(); P.checkPlan(plan,budget);
      armed={budget,expected:plan.map(({name,desired})=>({name,desired}))};
    }
    autoFlow=true; await addAction();
  });
  $('verify').onclick = () => run(async () => {
    if(stopped||!pending)throw Error('没有可继续的规格步骤');
    if(scheduledId)await message({type:'schedule_check',id:scheduledId});
    if(stopped||!pending)throw Error('本次点餐已暂停，不会恢复加购');
    adapter.verifyManual(pending); pending = null; menu = adapter.cards(); draw(); status('这 1 份加购已核对。点击“按所选数量加购”继续，其余已满足目标的菜品不会重复添加。', 'good');
    if(autoFlow) await addAction();
  });
  $('checkout').onclick = () => run(async () => {
    if (!$('ingredients').checked) throw Error('请先核对所选食材与忌口');
    adapter.checkout(items(), P.cents($('budget').value));
    status('已点击“去结算”，正在等待官方预览。这里尚未创建订单。');
  });
  $('refresh').onclick = () => run(async () => { adapter.ensure(); scan(); status(`读到 ${menu.length} 道已加载菜品。请重新核对食材后选择。`); });
  $('filter').oninput = draw;
  $('budget').oninput = () => {
    $('orderConsent').checked=false; consentFingerprint='';
    const total = adapter.previewTotal();
    if (total !== null) showPreview(total);
    else { $('ingredients').checked = false; status('预算已调整，请核对所选小计；配送等费用以官方预览为准。'); }
  };
  $('collapse').onclick = () => { const collapsed = shadow.querySelector('.panel').classList.toggle('collapsed'); $('collapse').textContent = collapsed ? '展开' : '收起'; };
  $('close').onclick = () => { stopped = true; autoFlow=false; armed=null; host.hidden = true; };
  $('save').onclick=()=>run(async()=>{
    await message({type:'save',preferences:{budget:$('budget').value,mode:$('mode').value,expand:$('expand').checked}});
    $('saved').textContent='已保存到此浏览器扩展；不保存账号、地址或输入记录。';
  });
  $('mode').onchange=()=>{ $('orderConsent').checked=false; consentFingerprint=''; controls(); };
  $('couponsApply').onclick=()=>run(async()=>{
    if(stopped&&scheduledId)throw Error('本次点餐已暂停，不会恢复选券');
    stopped=false; $('orderConsent').checked=false; consentFingerprint='';
    if(scheduledId)await message({type:'schedule_check',id:scheduledId});
    status('正在核对免费膨胀和实际用券；未确认的操作不会自动重试。');
    const result=await adapter.applyCoupons({expand:$('expand').checked,shouldStop:()=>stopped});
    if(result.expanded) $('couponsApply').textContent='重新选择可用券（本次不再膨胀）';
    showPreview(adapter.previewTotal());
    if(armed) {
      const authorization=armed; armed=null;
      if($('mode').value!=='unpaid' || P.cents($('budget').value)!==authorization.budget) throw Error('点餐设置已变化，请重新授权本单');
      await adapter.createUnpaid({budget:authorization.budget,expected:authorization.expected,fingerprint:adapter.previewFingerprint(),authorize:true,shouldStop:()=>stopped,reserve:reserveSubmission});
      status('已按本次授权单次点击提交。请以官方待支付结果为准，由你付款；结果不明时不会重试。');
    }
  });
  $('orderConsent').onchange=()=>{consentFingerprint=$('orderConsent').checked?adapter.previewFingerprint():''; controls();};
  $('createOrder').onclick=()=>run(async()=>{
    if($('mode').value!=='unpaid') throw Error('当前设置为只到预览');
    stopped=false;
    await adapter.createUnpaid({budget:P.cents($('budget').value),expected:selected.size?items():null,fingerprint:consentFingerprint,authorize:$('orderConsent').checked,shouldStop:()=>stopped,reserve:reserveSubmission});
    $('orderConsent').checked=false;
    status('已单次点击“提交订单”。请以官方页面的待支付结果为准，由你付款；若未跳转，先核对官方订单，不自动重试。');
  });
  $('clearAttempt').onclick=()=>run(async()=>{
    if(!$('reviewed').checked) throw Error('请先在官方订单列表核对上一笔提交结果');
    await message({type:'clear',reviewed:true}); attempt=false; $('reviewed').checked=false; controls();
    status('防重记录已解除。已尝试提交的旧页面不会再次提交，请回商家开始新的一餐。');
  });
  function showPreview(total) {
    lastPreviewAmount = total;
    $('menu').replaceChildren(); $('filter').hidden = true;
    for (const id of ['add', 'verify', 'checkout', 'refresh']) $(id).hidden = true;
    $('ingredientConsent').hidden = true;
    $('requestBox').hidden=true; $('couponBox').hidden=false;
    $('amount').textContent = P.money(total);
    $('summary').textContent = '官方订单预览合计 · 以平台提交前最新金额为准';
    $('cart').textContent = attempt?'已有提交尝试，请以官方订单状态为准':'订单尚未由本助手提交';
    const coupons=adapter.couponRows();
    lastCouponSignature=JSON.stringify(coupons.map(({label,discount,value})=>({label,discount,value})));
    $('coupons').textContent=coupons.map(row=>`${row.label}：${row.discount?'-'+P.money(row.discount):row.value||'未确认使用'}`).join('；');
    $('orderConsent').checked=false; consentFingerprint='';
    const verdict=P.previewVerdict(total,P.cents($('budget').value),coupons);
    status(verdict.message+(verdict.ok?'。核对官方地址与餐品后，可创建待支付订单。':'。已暂停下单。'),verdict.ok?'good':'bad');
    controls();
  }
  function route() {
    const next = adapter.scope();
    if (next === currentScope) {
      if (/\/mindex\/preview\/?$/.test(location.pathname)) {
        const latest = adapter.previewTotal();
        const signature=JSON.stringify(adapter.couponRows().map(({label,discount,value})=>({label,discount,value})));
        if (!busy && (latest !== lastPreviewAmount || signature!==lastCouponSignature)) showPreview(latest);
        if(!busy && $('orderConsent').checked && consentFingerprint!==adapter.previewFingerprint()) { $('orderConsent').checked=false;consentFingerprint='';controls();status('官方订单信息已变化，请重新核对后授权。','bad'); }
      }
      return;
    }
    currentScope = next;
    const total = adapter.previewTotal();
    if (/\/mindex\/preview\/?$/.test(location.pathname)) { pending = null; showPreview(total); if(autoFlow&&!attempt) {autoFlow=false; $('couponsApply').click();} return; }
    // Never carry a plan across shops, login, or another route.
    pending = null; autoFlow=false; armed=null; selected.clear(); menu = [];
    if (/\/mindex\/menu\/?$/.test(location.pathname)) {
      for (const id of ['add', 'checkout', 'refresh', 'filter']) $(id).hidden = false;
      $('ingredientConsent').hidden = false;
      $('requestBox').hidden=false; $('couponBox').hidden=true;
      scan(); status('商家或页面已切换，已清除上次选择。请重新读取菜单、选择并核对。');
    } else {
      for (const id of ['add', 'checkout']) $(id).hidden = true;
      $('couponBox').hidden=true; $('requestBox').hidden=true;
      status(attempt?'已尝试单次提交。请查看官方页面或订单列表，确认待支付状态后由你付款；不会自动重试。':'请在官方页面完成登录或选店，再回到商家菜单页。');
    }
    if(scheduledId&&!attempt)message({type:'read'}).then(result=>{if(result.run)startScheduled(result.run);}).catch(()=>{});
  }
  function startScheduled(task){
    const key=task.id+'|'+location.pathname+'|'+task.stage;
    if(key===scheduledPhase||attempt)return;
    scheduledPhase=key;scheduledId=task.id;scheduledRun=task;
    $('budget').value=(task.config.budget/100).toFixed(2);$('mode').value='unpaid';$('expand').checked=true;
    if(/\/mindex\/preview\/?$/.test(location.pathname)){
      if(task.stage!=='preview'||!task.expected?.length)return;
      armed={budget:task.config.budget,expected:task.expected};$('couponsApply').click();return;
    }
    if(!/\/mindex\/(home|menu)\/?$/.test(location.pathname))return;
    run(async()=>{
      await message({type:'schedule_check',id:task.id});
      const started=Date.now();
      while(Date.now()-started<10000){
        if(stopped)throw Error('已停止定时点餐');
        if(/\/mindex\/home\/?$/.test(location.pathname)?adapter.shops(task.config.budget,task.config.request,task.tried).length:adapter.cards().length)break;
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      if(/\/mindex\/home\/?$/.test(location.pathname)){
        const candidates=adapter.shops(task.config.budget,task.config.request,task.tried);
        if(task.tried.length>=5)throw Error('已核对5家餐厅仍没有符合本次需求的餐品，已停止；没有创建新订单');
        if(!candidates.length){const report=adapter.shopDiagnostics(task.config.budget,task.config.request);throw Error(!report.length?'尚未读到商家列表，请在官方页确认配送位置后重试；没有创建新订单':report.some(item=>P.foodShop(item.name,true)&&(item.minimum===null||item.delivery===null))?'餐厅的起送价或配送费尚未读取完整，请刷新商家列表；没有创建新订单':'当前已加载餐厅经营业状态、忌口、预算及需求筛选后没有可选项；没有创建新订单');}
        const chosen=candidates[Math.floor(Math.random()*candidates.length)];
        await message({type:'schedule_shop',id:task.id,name:chosen.name,minimum:chosen.minimum});
        if(stopped)throw Error('已暂停选店');
        status('正在选择商家：'+chosen.name);adapter.openShop(chosen,task.config.budget,task.config.request,task.tried);return;
      }
      if(task.stage!=='menu')throw Error('购物车阶段无法核对，不会重复加购');
      adapter.ensure();if(adapter.cart().count!==0)throw Error('商家已有购物车商品，无法确认来源，今日不自动修改');
      const request=P.intent(task.config.request),all=adapter.cards();
      const candidates=all.filter(item=>item.cents*request.quantity>=task.minimum&&(!task.merchant||task.merchant.foods.includes(item.name))&&(request.category||request.keywords?.length||/饭|面|鸡|牛|羊|沙拉|轻食/.test(item.name)));
      let plan;
      try{plan=P.randomPlan(candidates,request,task.config.budget);}catch(error){
        if(!task.currentShop&&task.config.anyShop&&task.tried.length<5){await message({type:'schedule_stage',id:task.id,stage:'home'});if(stopped)throw Error('已暂停换店');location.assign('https://h5.waimai.meituan.com/waimai/mindex/home');return;}
        throw error;
      }
      menu=all;selected.clear();for(const item of plan)selected.set(item.key,item.desired);draw();
      $('ingredients').checked=true;
      armed={budget:task.config.budget,expected:plan.map(({name,desired})=>({name,desired}))};
      autoFlow=true;await addAction();
    });
  }
  globalThis.chrome?.runtime?.onMessage?.addListener((request,sender)=>{
    if(request.type==='stop_scheduled'&&sender.id===chrome.runtime.id){stopped=true;autoFlow=false;armed=null;pending=null;controls();status('已暂停点餐，已加入商品请在官方购物车核对。');}
    if(request.type==='verify_pending'&&sender.id===chrome.runtime.id&&request.reviewed===true&&pending&&!busy&&!stopped)$('verify').click();
  });
  message({type:'read'}).then(result=>{
    persistenceReady=true; attempt=result.attempt;
    const prefs=result.preferences;
    if(!settingsTouched) {
      if(prefs.budget) $('budget').value=prefs.budget;
      if(['preview','unpaid'].includes(prefs.mode)) $('mode').value=prefs.mode;
      if(typeof prefs.expand==='boolean') $('expand').checked=prefs.expand;
    }
    controls();
    if(/\/mindex\/preview\/?$/.test(location.pathname)) showPreview(adapter.previewTotal());
    if(result.run)startScheduled(result.run);
  }).catch(()=>{$('saved').textContent='未连接扩展设置；可查看菜单，创建订单保持关闭。';});
  const total = adapter.previewTotal();
  if (/\/mindex\/preview\/?$/.test(location.pathname)) { $('budget').value = ''; showPreview(total); }
  else { scan(); }
  const routeTimer = setInterval(route, 500);
  window.addEventListener('pagehide', () => clearInterval(routeTimer), {once:true});
})();
