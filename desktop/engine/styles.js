(function (root) {
  root.ShenqiStyles = `
    :host{all:initial;--bg:#f7f4ef;--card:#fff;--ink:#22201c;--muted:#7a746a;--line:#e7e1d6;--accent:#d9480f;--soft:#fdebe1;--bad:#b42318;--good:#2f7d4f;font:14px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);}
    *{box-sizing:border-box} [hidden]{display:none!important}
    .panel{width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 32px);background:var(--card);border-radius:16px;box-shadow:0 0 0 1px var(--line),0 8px 32px #28200f22;overflow:auto}
    header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:16px 20px;border-bottom:1px solid var(--line)}
    header div{min-width:0;flex:1}header b{font-size:18px;white-space:nowrap}header span{display:block;font-size:12px;color:var(--muted)}header button{min-width:44px;flex-shrink:0;white-space:nowrap}
    main{padding:16px 20px 20px}h2{font-size:20px;line-height:1.3;margin:0 0 8px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:12px}
    .row{display:flex;gap:8px;align-items:center}.row>*{min-width:0}.row label{flex:1}
    input,button,select{font:inherit}input[type=number],input[type=search],input[type=text],select{width:100%;min-height:44px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 12px;color:var(--ink)}
    label>span{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}button{min-height:44px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);padding:8px 12px;cursor:pointer}button:hover{border-color:var(--accent)}button:disabled{opacity:.5;cursor:not-allowed}button:active{transform:scale(.98)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.wide{width:100%;margin-top:8px}
    :is(button,input):focus-visible{outline:2px solid var(--accent);outline-offset:3px}input[type=checkbox]{accent-color:var(--accent);width:18px;height:18px;flex:none}
    .ticket{padding:12px 16px;background:var(--bg);border-radius:10px;margin:16px 0}.ticket .amount{font-size:28px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}.ticket .meta{color:var(--muted);font-size:12px;margin-top:4px}
    .dish{display:grid;grid-template-columns:24px 1fr 56px;gap:8px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}.dish label{min-height:44px;display:flex;align-items:center;gap:8px;grid-column:1/3;cursor:pointer}.dish label>div{min-width:0}.dish b{display:block;overflow-wrap:anywhere;font-size:14px}.dish small{display:block;color:var(--muted);font-size:12px}.dish input[type=number]{padding:8px;width:56px}.dish.blocked b{color:var(--muted)}.dish.blocked small{color:var(--bad)}
    #menu{max-height:260px;overflow:auto;margin:8px 0}.empty{padding:20px 0;color:var(--muted)}
    .consent{display:flex;gap:8px;align-items:flex-start;min-height:44px;font-size:12px;padding:12px 0}.consent input{margin-top:3px}.status{background:var(--soft);border-radius:8px;padding:12px;margin-top:12px;font-size:13px;overflow-wrap:anywhere}.status.bad{color:var(--bad)}.status.good{color:var(--good)}
    .collapsed main{display:none}.collapsed{width:260px}.collapsed header span{display:none}.collapsed header b{font-size:14px}a{color:var(--accent)}
    @media(prefers-color-scheme:dark){:host{--bg:#171512;--card:#211e1a;--ink:#efe9df;--muted:#a39b8e;--line:#353029;--accent:#ff7a3d;--soft:#3a2418;--bad:#ff7b6e;--good:#5cc58a}}
    @media(prefers-reduced-motion:reduce){button:active{transform:none}}
    #requestBox .row{margin:8px 0}#requestBox .row button{flex:1}.preferences{font-size:12px;color:var(--good);margin:12px 0}details{margin:12px 0;font-size:12px}summary{min-height:44px;cursor:pointer;display:list-item;padding:12px 0}details label{margin-top:8px}#couponBox h2{font-size:18px}
  `;
})(globalThis);
