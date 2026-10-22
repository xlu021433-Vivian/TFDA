(function () {
  'use strict';
  if (window !== window.top || location.origin !== 'https://h5.waimai.meituan.com' || globalThis.ShenqiReading) return;
  const style = document.createElement('style');
  style.id = 'shenqi-official-reading';
  style.textContent = `
html[data-shenqi-reading] { font-size:min(50px,13.333333vw)!important; --meal-paper:#fbf3f6; --meal-ink:#382d37; --meal-muted:#7b6573; --meal-leaf:#a33f69; --meal-line:rgba(151,93,122,.15); }
html[data-shenqi-reading] body { background:var(--meal-paper)!important; color:var(--meal-ink); font-family:'Microsoft YaHei UI','Segoe UI',sans-serif!important; }
html[data-shenqi-reading] :focus-visible { outline:2px solid var(--meal-leaf)!important; outline-offset:3px; }
html[data-shenqi-reading="home"] .poilist-item { box-sizing:border-box; background:#fff!important; margin:10px 14px!important; padding:18px!important; border:1px solid var(--meal-line)!important; border-radius:16px!important; box-shadow:0 3px 12px #20302805; }
html[data-shenqi-reading="home"] .poilist-item-info1name { color:var(--meal-ink)!important; font-size:18px!important; font-weight:650!important; line-height:1.5!important; }
html[data-shenqi-reading="home"] .poilist-item img { border-radius:10px; object-fit:cover; }
html[data-shenqi-reading="home"] #sqt-openh5-homeSearchBar { background:#f3e8ee!important; border-radius:14px!important; }
html[data-shenqi-reading="menu"] dd[data-tag="spu"] { box-sizing:border-box; background:#fff!important; border:1px solid var(--meal-line)!important; border-radius:14px!important; padding:16px!important; margin:10px 12px!important; }
html[data-shenqi-reading="menu"] dd[data-tag="spu"] [class^="name_"], html[data-shenqi-reading="menu"] dd[data-tag="spu"] [class*=" name_"] { color:var(--meal-ink)!important; font-size:17px!important; line-height:1.5!important; font-weight:650!important; }
html[data-shenqi-reading="menu"] dd[data-tag="spu"] [data-tag="price"] { font-variant-numeric:tabular-nums; }
html[data-shenqi-reading="menu"] dd[data-tag="spu"] img { border-radius:10px; object-fit:cover; }
@media(max-width:600px) {
  html[data-shenqi-reading="home"] .poilist-item { margin:8px!important; padding:12px!important; border-radius:12px!important; }
  html[data-shenqi-reading="menu"] dd[data-tag="spu"] { margin:8px 6px!important; padding:10px!important; }
}
`;
  let enabled = true, disposed = false;
  function update() {
    if (disposed || !window.document?.documentElement) return;
    if (!style.isConnected) (document.head || document.documentElement)?.append(style);
    const route = location.pathname.match(/^\/waimai\/mindex\/(home|menu)\/?$/)?.[1];
    // Dialogs and every transactional/authentication route keep the official layout.
    const dialog = document.querySelector('button[aria-label="关闭商品规格选择弹窗"], [role="dialog"], dialog[open]');
    const value = enabled && route && !dialog ? route : null;
    if (value && document.documentElement.getAttribute('data-shenqi-reading') !== value) document.documentElement.setAttribute('data-shenqi-reading', value);
    if (!value && document.documentElement.hasAttribute('data-shenqi-reading')) document.documentElement.removeAttribute('data-shenqi-reading');
  }
  globalThis.ShenqiReading = {setEnabled(value) { enabled = value === true; update(); }};
  let queued = false;
  const observer = new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; update(); }); } });
  window.addEventListener('popstate', update);
  window.addEventListener('hashchange', update);
  // SPA routes can change without a DOM mutation. No history API is replaced.
  let timer;
  function resume() { disposed = false; observer.observe(document, {childList:true,subtree:true}); clearInterval(timer); timer = setInterval(update, 1000); update(); }
  window.addEventListener('pagehide', () => { disposed = true; observer.disconnect(); clearInterval(timer); });
  window.addEventListener('pageshow', resume);
  resume();
})();
