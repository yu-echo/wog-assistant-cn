/* 本地版（连接器）下载入口与状态检测。
 *
 * 背景：托管在公网的页面受浏览器安全限制，不能直接连本机游戏进程；
 * 想用实时数据和自动功能，需要在本地运行「本地版」，它同时在
 * 127.0.0.1:8791 提供同一套页面和 10998 注入接口。
 *
 * 这里只做两件事：探测本地版在不在跑、给出下载/打开入口。
 */
(function () {
  'use strict';

  var LOCAL_PORT = 8791;
  var LOCAL_URL = 'http://127.0.0.1:' + LOCAL_PORT + '/index.html';

  /* 下载地址：换成你的 GitHub Release 或网盘直链即可。
     留空则使用随页面一起托管的 download/ 目录。 */
  var DOWNLOAD_URL = 'download/WoG助手.exe';

  var state = { checked: false, running: null, note: '' };

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return [].slice.call(document.querySelectorAll(sel)); }

  function paint() {
    var text;
    if (!state.checked) {
      text = '正在检测本地版…';
    } else if (state.running) {
      text = '已检测到本地版在运行';
    } else if (state.note) {
      text = state.note;
    } else {
      text = '未检测到本地版';
    }
    $$('[data-wog-connector-status]').forEach(function (el) { el.textContent = text; });
    $$('[data-wog-connector]').forEach(function (el) {
      el.setAttribute('data-state', state.running ? 'on' : (state.checked ? 'off' : 'checking'));
    });
    /* 本地版已经在跑了就不用再下载，把下载按钮收起来 */
    $$('[data-wog-connector-download]').forEach(function (el) {
      el.style.display = state.running ? 'none' : '';
    });
  }

  function markRunning(ok, note) {
    state.checked = true;
    state.running = !!ok;
    state.note = note || '';
    paint();
  }

  /* 先按 CORS 正常探测；浏览器拦了就退回 no-cors（只能判断「有东西在」）。 */
  function probe() {
    if (typeof fetch !== 'function') { markRunning(false, ''); return; }
    var url = 'http://127.0.0.1:' + LOCAL_PORT + '/api/status';
    fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && typeof d.game_running !== 'undefined') markRunning(true, '');
        else markRunning(false, '');
      })
      .catch(function () {
        fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
          .then(function () { markRunning(true, '已检测到本地版在运行'); })
          .catch(function () { markRunning(false, '未检测到本地版（点「打开本地版」试一下）'); });
      });
  }

  function openLocal() {
    window.open(LOCAL_URL, '_blank', 'noopener');
  }

  function download() {
    if (!DOWNLOAD_URL) {
      try {
        alert('下载地址还没配置。\n\n在 js/wog-connector.js 里把 DOWNLOAD_URL 改成实际链接即可。');
      } catch (e) { }
      return;
    }
    var a = document.createElement('a');
    a.href = DOWNLOAD_URL;
    a.setAttribute('download', '');
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function bind() {
    $$('[data-wog-connector-open]').forEach(function (b) {
      b.addEventListener('click', function (ev) { ev.preventDefault(); openLocal(); });
    });
    $$('[data-wog-connector-download]').forEach(function (b) {
      b.addEventListener('click', function (ev) { ev.preventDefault(); download(); });
    });
    paint();
    probe();
    window.setInterval(probe, 15000);
  }

  window.__wogConnector = {
    probe: probe,
    openLocal: openLocal,
    download: download,
    state: function () { return state; },
    url: DOWNLOAD_URL
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
