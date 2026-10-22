/* 模块自动化：连上助手后自动换装 + 自动训练。
 *
 * 只负责「调度」，真正的动作复用页面里已有的实现：
 *   - 换装：window.__wogEquipBestWeapon()（wog-companion.js 暴露）
 *   - 训练：window.__wogTrainingAutoStart() / __wogTrainingAutoRunning()
 * 开关状态存 localStorage['wog-auto-settings-v1']，默认都是开。
 */
(function () {
  'use strict';

  var KEY = 'wog-auto-settings-v1';
  var EQUIP_EVERY = 5 * 60 * 1000;
  var POLL_EVERY = 3000;

  var settings = { equip: true, training: true };
  var state = { lastEquipAt: 0, lastTrainingAt: 0, lastError: '' };
  var equipTimer = null;
  var pollTimer = null;

  function $(sel) { return document.querySelector(sel); }

  /* 写进「日常自动化」页的运行日志，让用户能看见动作发生过 */
  function note(text, kind) {
    try {
      if (typeof window.__wogDailyLog === 'function') window.__wogDailyLog(text, kind || 'info');
    } catch (e) { /* 忽略 */ }
  }

  function bridge() { return window.WOG_COMPANION_RUNTIME_BRIDGE || null; }

  function connected() {
    var b = bridge();
    return !!(b && typeof b.getState === 'function' && b.getState().status === 'connected');
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return;
      for (var k in settings) if (typeof d[k] === 'boolean') settings[k] = d[k];
    } catch (e) { /* 忽略 */ }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  }

  function timeText(ts) {
    if (!ts) return '尚未执行';
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function render() {
    var box = $('#daily-module-stats');
    if (!box) return;
    var trainingRunning = false;
    try {
      if (typeof window.__wogTrainingAutoRunning === 'function') trainingRunning = !!window.__wogTrainingAutoRunning();
    } catch (e) { }

    function cell(value, label, hint) {
      return '<div class="daily-stat"><b>' + value + '</b><span>' + label + (hint ? ' · ' + hint : '') + '</span></div>';
    }

    box.innerHTML =
      cell(settings.equip ? '每 5 分钟' : '已关闭', '自动换装', settings.equip ? '上次 ' + timeText(state.lastEquipAt) : '') +
      cell(trainingRunning ? '运行中' : (settings.training ? '待启动' : '已关闭'), '自动训练',
        trainingRunning ? '' : (settings.training ? '连上游戏后自动开始' : ''));
  }

  /* ---------------- 换装 ---------------- */
  function doEquip(silent) {
    if (!settings.equip) return;
    if (!connected()) return;
    if (typeof window.__wogEquipBestWeapon !== 'function') {
      if (!silent) state.lastError = '找不到换装入口（页面脚本未加载完）';
      render();
      return;
    }
    try {
      window.__wogEquipBestWeapon();
      state.lastEquipAt = Date.now();
      state.lastError = '';
      if (!silent) note('自动换装：已按当前职业穿戴最强武器', 'ok');
    } catch (e) {
      state.lastError = (e && e.message) || String(e);
      if (!silent) note('自动换装失败：' + state.lastError, 'error');
    }
    render();
  }

  function startEquipTimer() {
    if (equipTimer) return;
    equipTimer = setInterval(function () { doEquip(true); }, EQUIP_EVERY);
  }

  function stopEquipTimer() {
    if (equipTimer) { clearInterval(equipTimer); equipTimer = null; }
  }

  /* ---------------- 训练 ---------------- */
  function ensureTraining() {
    if (!connected()) return;
    if (!settings.training) {
      try { if (typeof window.__wogTrainingAutoStop === 'function') window.__wogTrainingAutoStop(); } catch (e) { }
      return;
    }
    if (typeof window.__wogTrainingAutoStart !== 'function') return;
    var running = false;
    try {
      if (typeof window.__wogTrainingAutoRunning === 'function') running = !!window.__wogTrainingAutoRunning();
    } catch (e) { }
    if (running) return;
    try {
      window.__wogTrainingAutoStart();
      state.lastTrainingAt = Date.now();
      note('自动训练：已按推荐路线开始加点', 'ok');
    } catch (e) {
      state.lastError = (e && e.message) || String(e);
      note('自动训练启动失败：' + state.lastError, 'error');
    }
    render();
  }

  /* ---------------- 主循环 ---------------- */
  function tick() {
    if (!connected()) { render(); return; }
    ensureTraining();
    render();
  }

  function start() {
    load();
    render();
    startEquipTimer();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, POLL_EVERY);
    // 连上后先跑一次
    setTimeout(function () {
      if (connected()) { doEquip(false); ensureTraining(); }
    }, 2500);
    render();
  }

  /* ---------------- 对外接口 ---------------- */
  window.__wogAuto = {
    get: function () { return { equip: settings.equip, training: settings.training }; },
    set: function (key, value) {
      if (!(key in settings)) return;
      settings[key] = !!value;
      save();
      if (key === 'equip') {
        if (settings.equip) { startEquipTimer(); doEquip(true); }
        else stopEquipTimer();
      }
      if (key === 'training') ensureTraining();
      render();
    },
    status: function () { return { settings: settings, state: state }; },
    equipNow: function () { doEquip(false); },
    trainingNow: function () { ensureTraining(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
