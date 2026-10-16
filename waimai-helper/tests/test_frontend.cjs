const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/refresh\(true\);\s*$/, '');
new vm.Script(source);

const state = {
  config: {
    device: '127.0.0.1:16384', bark: {key: '', server: 'https://api.day.app'}, dry_run: true,
    claim_coupons: ['meituan', 'eleme'], meals: [],
    order: {delivery_time: '12:00', max_price: 40, avoid_repeat_days: 2, note: '', address: ''},
    guard: {extra_block: [], allow: [], scan_ignore: []},
    schedule: {enabled: false, weekdays: [1, 2, 3, 4, 5]},
    recommend: {keywords: ['牛肉'], platforms: ['meituan'], deep: false},
  },
  job: {name: null, result: null}, busy: false, recs: {}, history: [], logs: [],
  platforms: {meituan: '美团', eleme: '饿了么'}, accounts: {},
};

function fixture(fetch) {
  const elements = new Map();
  const timers = new Map();
  let timerID = 0;
  const context = vm.createContext({
    console, fetch,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          value: '', textContent: '', innerHTML: '', className: '', checked: false,
          classList: {add() {}, remove() {}, toggle() {}}, style: {}, attributes: {},
          setAttribute(key, value) { this.attributes[key] = value; },
          getAttribute(key) { return this.attributes[key] ?? null; },
          removeAttribute(key) { delete this.attributes[key]; },
          scrollTop: 0, clientHeight: 0, scrollHeight: 0,
        });
        return elements.get(id);
      },
      querySelectorAll() { return []; },
    },
    window: {addEventListener() {}}, confirm: () => true,
    setTimeout(fn, ms) { timers.set(++timerID, {fn, ms}); return timerID; },
    clearTimeout(id) { timers.delete(id); },
  });
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) context.document.getElementById(match[1]);
  vm.runInContext(source, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/ordering.js'),'utf8'), context);
  return {context, elements, timers, run: code => vm.runInContext(code, context)};
}

async function main() {
  let checks = 0;
  {
    const current=JSON.parse(JSON.stringify(state));
    current.auth={csrf:'business-csrf'};
    current.ordering={configured:false,connected:false};
    current.ordering_callback='http://127.0.0.1:8765/api/ordering/oauth/callback';
    let submitted;
    const f=fixture(async(url,options)=>{
      if(url==='/api/state') return {ok:true,json:async()=>current};
      submitted=options;
      return {ok:true,json:async()=>({ok:true,message:'仅配置于内存'})};
    });
    await f.run('refresh()');
    assert.equal(f.elements.get('buySearchButton').disabled,true);
    f.elements.get('buyAppId').value='test-app';
    f.elements.get('buyAppSecret').value='test-oauth-secret';
    f.elements.get('buySignSecret').value='test-sign-secret';
    await f.run('orderingConfigure()');
    assert.equal(submitted.headers['X-Login-CSRF'],'business-csrf');
    assert.equal(f.elements.get('buyAppSecret').value,'');
    assert.equal(f.elements.get('buySignSecret').value,'');
    checks++;
  }
  {
    const f=fixture(async()=>{throw new Error('步骤不完整时不得发送请求');});
    await f.run('orderingSearch()');
    assert.match(f.elements.get('buyMessage').textContent,/勾选/);
    await f.run('orderingSubmit()');
    assert.match(f.elements.get('buyMessage').textContent,/先预览/);
    f.elements.get('buyPhone').value='13800138000';
    f.elements.get('buyAddress').value='测试地址';
    f.run("showSection('home')");
    assert.equal(f.elements.get('buyPhone').value,'');
    assert.equal(f.elements.get('buyAddress').value,'');
    checks++;
  }
  {
    let posts=0;
    const current=JSON.parse(JSON.stringify(state));
    current.auth={csrf:'local-csrf',connected:false,pending:false,retry_after:0};
    const f=fixture(async(url,options)=>{
      if(options?.method==='POST') posts++;
      return {ok:true,json:async()=>current};
    });
    await f.run('refresh()');
    assert.equal(f.elements.get('verifyLoginSmsButton').disabled,false);
    await f.run('verifyLoginSms()');
    assert.match(f.elements.get('authMessage').textContent,/先填写手机号.*获取验证码/);
    await f.run('sendLoginSms()');
    assert.match(f.elements.get('authMessage').textContent,/11 位手机号/);
    f.elements.get('authPhone').value='13800138000';
    await f.run('sendLoginSms()');
    assert.match(f.elements.get('authMessage').textContent,/勾选/);
    assert.equal(posts,0,'步骤不完整时只显示提示，不发送短信请求');
    checks++;
  }
  {
    const f = fixture(async () => ({ok: true, json: async () => JSON.parse(JSON.stringify(state))}));
    await f.run('refresh()');
    assert.equal(f.elements.get('serverWarning').hidden, false);
    assert.equal(f.elements.get('phoneLoginForm').hidden, true);
    assert.equal(f.elements.get('sendLoginSmsButton').disabled, true);
    const current=JSON.parse(JSON.stringify(state));
    current.auth={csrf:'new-backend',connected:false,pending:false,retry_after:0};
    f.context.fetch=async()=>({ok:true,json:async()=>current});
    await f.run('refresh()');
    assert.equal(f.elements.get('serverWarning').hidden, true);
    assert.equal(f.elements.get('phoneLoginForm').hidden, false);
    assert.equal(f.elements.get('sendLoginSmsButton').disabled, false);
    checks++;
  }
  {
    const f = fixture(async () => ({ok: false, status: 400, json: async () => ({ok: false, message: '预算无效'})}));
    await assert.rejects(f.run("api('/api/config', {})"), /预算无效/);
    assert.equal(f.elements.get('toast').textContent, '预算无效');
    checks++;
  }
  {
    const f = fixture(async () => ({ok: false, status: 500, json: async () => { throw new Error('HTML'); }}));
    await assert.rejects(f.run("api('/api/state')"), /未返回有效数据/);
    checks++;
  }
  {
    let calls = 0;
    const f = fixture(async () => {
      if (++calls === 1) throw new Error('网络断开');
      return {ok: true, json: async () => JSON.parse(JSON.stringify(state))};
    });
    await f.run('refresh(true)');
    assert.equal(f.run('initialized'), false);
    const retry = [...f.timers.values()].find(t => t.ms === 5000);
    assert.ok(retry, '失败后仍安排刷新');
    await retry.fn();
    assert.equal(f.run('initialized'), true);
    assert.equal(f.elements.get('s_device').value, state.config.device);
    checks++;
  }
  {
    let release;
    let calls = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture(async () => { calls++; await pending; return {ok: true, json: async () => state}; });
    const first = f.run('refresh()');
    const second = f.run('refresh()');
    assert.equal(calls, 1, '并发刷新只发出一次请求');
    release();
    await Promise.all([first, second]);
    checks++;
  }
  {
    let calls = 0;
    const f = fixture(async () => { calls++; throw new Error('不应请求'); });
    f.run("editingMeals = [{name:'牛肉面',shop:'',dishes:['牛肉面']}]");
    await f.run('saveMeals()');
    assert.equal(calls, 0);
    assert.match(f.elements.get('toast').textContent, /第 1 行未填完整/);
    checks++;
  }
  {
    const current = JSON.parse(JSON.stringify(state));
    current.accounts.meituan = {installed: true, logged_in: true, message: '已登录'};
    current.job.name = 'dump';
    const f = fixture(async () => ({ok: true, json: async () => current}));
    await f.run('refresh()');
    assert.match(f.elements.get('acctCards').innerHTML, /已登录/);
    checks++;
  }
  {
    const current = JSON.parse(JSON.stringify(state));
    current.recs = {time: 'test', keywords: ['牛肉'], shops: [{
      shop: '牛肉面店', platform: 'meituan', shop_ok: true, safe: ['牛肉面'], deals: [], blocked: [],
    }]};
    const f = fixture(async () => ({ok: true, json: async () => current}));
    await f.run('refresh()');
    f.run("picked['meituan|牛肉面店'].add('旧菜品'); renderRecs()");
    assert.equal(f.run("picked['meituan|牛肉面店'].has('旧菜品')"), false);
    checks++;
  }
  {
    let calls = 0;
    const f = fixture(async () => { calls++; return {ok: true, json: async () => state}; });
    await f.run('refresh()');
    calls = 0;
    f.elements.get('s_max').value = '';
    await f.run('testPush()');
    assert.equal(calls, 0, '无效设置不能继续发送测试推送');
    checks++;
  }
  {
    const f = fixture(async () => ({ok: true, json: async () => JSON.parse(JSON.stringify(state))}));
    await f.run('refresh()');
    f.elements.get('s_device').value = '未保存的地址';
    await f.run('refresh()');
    assert.equal(f.elements.get('s_device').value, '未保存的地址', '自动刷新不覆盖正在编辑的内容');
    checks++;
  }
  {
    const current=JSON.parse(JSON.stringify(state));
    current.auth={csrf:'local-csrf',connected:false,pending:true,retry_after:0,security_required:false};
    let submitted;
    const f=fixture(async(url,options)=>{
      if(url==='/api/state') return {ok:true,json:async()=>JSON.parse(JSON.stringify(current))};
      submitted={url,options}; current.auth.connected=true; current.auth.pending=false;
      return {ok:true,json:async()=>({ok:true,message:'授权成功'})};
    });
    await f.run('refresh()');
    f.elements.get('authPhone').value='13800138000'; f.elements.get('authCode').value='123456';
    f.elements.get('authConsent').checked=true;
    await f.run('verifyLoginSms()');
    assert.equal(submitted.options.headers['X-Login-CSRF'],'local-csrf');
    assert.equal(submitted.url,'/api/auth/meituan/verify');
    assert.equal(f.elements.get('authPhone').value,''); assert.equal(f.elements.get('authCode').value,'');
    assert.equal(f.elements.get('authConsent').checked,false);
    assert.match(f.elements.get('webAuthStatus').textContent,/已授权/); checks++;
  }
  {
    const current=JSON.parse(JSON.stringify(state));
    current.auth={csrf:'local-csrf',connected:false,pending:true,retry_after:0,security_required:false};
    const f=fixture(async url=>url==='/api/state' ? {ok:true,json:async()=>JSON.parse(JSON.stringify(current))}
      : {ok:false,status:400,json:async()=>({ok:false,message:'验证码错误'})});
    await f.run('refresh()');
    f.elements.get('authPhone').value='13800138000'; f.elements.get('authCode').value='123456';
    f.elements.get('authConsent').checked=true; await f.run('verifyLoginSms()');
    assert.equal(f.elements.get('authCode').value,''); assert.equal(f.run('authBusy'),false);
    assert.equal(f.run('S.auth.connected'),false); checks++;
  }
  {
    let posts=0;
    const current=JSON.parse(JSON.stringify(state));
    current.auth={csrf:'local-csrf',connected:false,pending:false,retry_after:0,security_required:false};
    const f=fixture(async(url,options)=>{if(options?.method==='POST') posts++; return {ok:true,json:async()=>current};});
    await f.run('refresh()'); f.elements.get('authPhone').value='13800138000';
    f.elements.get('authConsent').checked=false; await f.run('sendLoginSms()');
    assert.equal(posts,0,'未勾选授权不能发送验证码');
    f.elements.get('authCode').value='123456'; f.run("showSection('home')");
    assert.equal(f.elements.get('authPhone').value,''); assert.equal(f.elements.get('authCode').value,''); checks++;
  }
  {
    const current=JSON.parse(JSON.stringify(state));
    current.auth={csrf:'old-csrf',connected:true,pending:false,retry_after:0,security_required:false};
    let postedHeaders;
    const f=fixture(async(url,options)=>{
      if(url==='/api/state') return {ok:true,json:async()=>JSON.parse(JSON.stringify(current))};
      postedHeaders=options.headers; current.auth.csrf='new-csrf'; current.auth.connected=false;
      return {ok:true,json:async()=>({ok:true,message:'已清除'})};
    });
    await f.run('refresh()'); await f.run('clearWebAuth()');
    assert.equal(postedHeaders['X-Login-CSRF'],'old-csrf');
    assert.equal(f.run('S.auth.csrf'),'new-csrf'); assert.equal(f.run('S.auth.connected'),false); checks++;
  }
  assert.doesNotMatch(source,/localStorage|sessionStorage|document\.cookie|navigator\.sendBeacon/,
    '登录页面不得持久保存输入、读取 Cookie 或增加后台追踪'); checks++;
  const orderingSource=fs.readFileSync(path.join(__dirname,'../static/ordering.js'),'utf8');
  assert.doesNotMatch(orderingSource,/localStorage|sessionStorage|document\.cookie|navigator\.sendBeacon/);
  const ids=new Set([...html.matchAll(/<(?:input|button|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(match=>match[1]));
  for (const match of (source+orderingSource).matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    assert.equal(ids.has(match[1]),false,`控件 ID 不得遮蔽页面函数 ${match[1]}`);
  }
  checks++;
  console.log(`前端 ${checks} 项回归检查通过`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
