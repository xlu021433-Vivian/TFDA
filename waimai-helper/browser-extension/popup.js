'use strict';
document.getElementById('activate').onclick = async () => {
  const button = document.getElementById('activate'), message = document.getElementById('message');
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const url = new URL(tab?.url || 'about:blank');
    if (url.protocol !== 'https:' || url.hostname !== 'h5.waimai.meituan.com') throw Error('请先切换到美团网页，再点击扩展。');
    if (!/\/mindex\/(menu|preview)\/?$/.test(url.pathname)) throw Error('请先在美团官方页面登录并进入商家菜单。');
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['guard-data.js', 'policy.js', 'schedule.js', 'adapter.js', 'styles.js', 'content.js', 'watch.js']});
    message.textContent = '助手已在当前页面右上角打开，可以关闭这个小窗口。';
  } catch (error) { message.textContent = error.message || '未能打开助手，请回到美团页面重试。'; }
  finally { button.disabled = false; }
};
document.getElementById('schedule').onclick=()=>chrome.runtime.openOptionsPage();
