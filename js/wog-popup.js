/* 异常弹窗自动确认
 *
 * 背景（2026-10-22 实测）：游戏弹「Error / 发生网络错误。/ 确认」这种模态框时，
 * 所有服务端请求都会被挡住（NetResult 3000 / CheckCodeErrType 6），
 * 战场、领钻石、抽奖全部失效。点掉「确认」后立刻恢复正常（NetResult 1000）。
 *
 * 做法：直连 ws://127.0.0.1:10998，在 Unity 场景里以「确认」按钮为锚点找弹窗根：
 *   消息框 → 祖先里的 PanelMessagePopup
 *   系统错误框 → 祖先里的 Root（UIBase_PopupBg 那一层，Root 在上）
 * 读出文案（NewNormal.Core.UI.NText），命中「网络错误」这类关键词才点确认，
 * 普通购买/出售/选择类确认框一律不碰。
 *
 * 点击方式：NButton.onClick.Invoke()，实测对两种框都有效。
 */
(function () {
  'use strict';

  var SETTINGS_KEY = 'wog-popup-settings-v1';
  var STATS_KEY = 'wog-popup-stats-v1';
  var WS_URL = 'ws://127.0.0.1:10998';
  var POLL_EVERY = 8000;

  /* 出现这些字样的弹窗才自动确认；普通确认框不动 */
  var KEYWORDS = [
    '网络错误', '网络异常', '网络连接', '网络中断', '网络不稳定', '网络超时',
    '连接失败', '连接中断', '连接超时', '连接已断开', '服务器错误', '服务器连接',
    '请求失败', '数据错误', '发生错误', '断线', '重新连接',
    'network', 'timeout', 'disconnect', 'connection'
  ];

  /* 离线奖励面板：按内容认，不依赖面板节点名（游戏里查不到带 Offline 的类型，名字不可靠） */
  var OFFLINE_KEYWORDS = [
    '离线奖励', '離線獎勵', '离线獎勵', '離線奖励', '离线收益', '離線收益',
    '离线挂机', '離線掛機', 'offline'
  ];

  /* 认作「确认/领取」的按钮文案 */
  var CONFIRM_LABEL = /确认|確認|確定|确定|领取|領取|ok/i;
  var CANCEL_LABEL = /取消|关闭|關閉|cancel|close/i;

  var settings = { autoClose: true };
  var timer = null;
  var busy = false;
  var last = null;   // { at, dialogs:[{text,hit,root}], clicked }

  function bridge() { return window.WOG_COMPANION_RUNTIME_BRIDGE || null; }

  function connected() {
    var b = bridge();
    return !!(b && typeof b.getState === 'function' && b.getState().status === 'connected');
  }

  function note(text, kind) {
    try {
      if (typeof window.__wogDailyLog === 'function') window.__wogDailyLog(text, kind || 'info');
    } catch (e) { /* 忽略 */ }
  }

  function todayKey() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && typeof d.autoClose === 'boolean') settings.autoClose = d.autoClose;
    } catch (e) { /* 忽略 */ }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  }

  function loadStats() {
    try {
      var raw = localStorage.getItem(STATS_KEY);
      var d = raw ? JSON.parse(raw) : null;
      if (!d || d.date !== todayKey()) return { date: todayKey(), closed: 0 };
      return d;
    } catch (e) { return { date: todayKey(), closed: 0 }; }
  }

  function bumpStats(n) {
    var s = loadStats();
    s.closed += n;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
    return s;
  }

  /* ---------------- 直连游戏内核 ---------------- */
  function runGame(expr, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ws = null;
      var done = false;
      var t = setTimeout(function () {
        finish(new Error('游戏无响应（超时 ' + Math.round((timeoutMs || 15000) / 1000) + 's）'));
      }, timeoutMs || 15000);

      function finish(err, val) {
        if (done) return;
        done = true;
        clearTimeout(t);
        try { if (ws) ws.close(); } catch (e) { /* 忽略 */ }
        if (err) reject(err); else resolve(val);
      }

      try { ws = new WebSocket(WS_URL); } catch (e) { return finish(e); }
      ws.onopen = function () {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
      };
      ws.onerror = function () { finish(new Error('连不上游戏内核（ws://127.0.0.1:10998）')); };
      ws.onmessage = function (ev) {
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return finish(new Error('返回解析失败')); }
        if (!msg || msg.id !== 1) return;
        var res = msg.result || {};
        if (res.exceptionDetails) {
          return finish(new Error((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text || '表达式报错'));
        }
        finish(null, (res.result || {}).value);
      };
    });
  }

  /* ---------------- 游戏侧表达式 ---------------- */
  function popupExpr(opts) {
    return [
      '(function (opts) {',
      '  var out = { dialogs: [], clicked: 0, note: "", offline: { found: false, clicked: false, texts: [], button: "" } };',
      '  var RT = null, NT = null, NB = null;',
      '  try { RT = puer.$typeof(CS.UnityEngine.RectTransform); } catch (e) { out.note = "取不到 RectTransform"; return JSON.stringify(out); }',
      '  try { NT = puer.$typeof(CS.NewNormal.Core.UI.NText); } catch (e) { }',
      '  try { NB = puer.$typeof(CS.NewNormal.Core.UI.NButton); } catch (e) { }',
      '  if (!NB) { out.note = "取不到按钮组件"; return JSON.stringify(out); }',
      '',
      '  var KWS = opts.keywords || [], OKWS = opts.offlineKeywords || [];',
      '  var CONFIRM = null, CANCEL = null;',
      '  try { if (opts.confirmLabel) CONFIRM = new RegExp(opts.confirmLabel, "i"); } catch (e) { }',
      '  try { if (opts.cancelLabel) CANCEL = new RegExp(opts.cancelLabel, "i"); } catch (e) { }',
      '',
      '  /* 读一个节点下所有文本（NewNormal 的 NText），拼成一行 */',
      '  function textOf(go) {',
      '    if (!go || !NT) return "";',
      '    var parts = [];',
      '    try {',
      '      var list = go.GetComponentsInChildren(NT, true);',
      '      for (var i = 0; i < list.Length; i += 1) {',
      '        var s = ""; try { s = String(list.get_Item(i).text || ""); } catch (e) { }',
      '        if (s) parts.push(s);',
      '      }',
      '    } catch (e) { }',
      '    return parts.join(" | ");',
      '  }',
      '  function anyIn(txt, list) {',
      '    var low = String(txt).toLowerCase();',
      '    for (var i = 0; i < list.length; i += 1) {',
      '      if (low.indexOf(String(list[i]).toLowerCase()) >= 0) return true;',
      '    }',
      '    return false;',
      '  }',
      '  /* 往上找最近的弹窗容器：名字是 Root 或以 Panel 开头（UIBase_PopupBg 这类空壳会被跳过） */',
      '  function containerOf(go, maxUp) {',
      '    var p = go;',
      '    for (var d = 0; d < (maxUp || 9) && p; d += 1) {',
      '      var pn = ""; try { pn = String(p.name || ""); } catch (e) { }',
      '      if (pn === "Root" || pn.indexOf("Panel") === 0) return p;',
      '      try { p = p.transform.parent ? p.transform.parent.gameObject : null; } catch (e) { p = null; }',
      '    }',
      '    return null;',
      '  }',
      '  function clickBtn(go) {',
      '    var btn = null; try { btn = go.GetComponent(NB); } catch (e) { }',
      '    if (!btn) return false;',
      '    try {',
      '      if (btn.interactable === false) return false;',
      '      btn.onClick.Invoke();',
      '      return true;',
      '    } catch (e) { return false; }',
      '  }',
      '',
      '  /* 第一遍：以「确认」按钮为锚点，按容器文案判断是异常框还是离线奖励面板 */',
      '  var arr = CS.UnityEngine.Object.FindObjectsByType(RT, CS.UnityEngine.FindObjectsSortMode.None);',
      '  var seen = {}, doneRoot = {};',
      '  for (var i = 0; i < arr.Length; i += 1) {',
      '    var t = arr.get_Item(i), nm = "";',
      '    try { nm = String(t.name || ""); } catch (e) { }',
      '    if (nm !== "Btn_Confirm") continue;',
      '    var btnGo = null; try { btnGo = t.gameObject; } catch (e) { continue; }',
      '    if (!btnGo || !btnGo.activeInHierarchy) continue;',
      '',
      '    var rootGo = containerOf(btnGo, 9);',
      '    if (!rootGo) continue;',
      '',
      '    var id = ""; try { id = String(rootGo.GetInstanceID()); } catch (e) { id = "x" + i; }',
      '    if (seen[id]) continue;',
      '    seen[id] = 1;',
      '',
      '    var txt = textOf(rootGo);',
      '    var isErr = anyIn(txt, KWS);',
      '    var isOff = anyIn(txt, OKWS);',
      '    var kind = isOff ? "offline" : (isErr ? "error" : "other");',
      '    out.dialogs.push({ text: txt.slice(0, 120), hit: isErr || isOff, kind: kind, root: String(rootGo.name || "") });',
      '',
      '    if (isOff) {',
      '      out.offline.found = true;',
      '      out.offline.texts = txt.split(" | ").slice(0, 8);',
      '      out.offline.button = "Btn_Confirm";',
      '    }',
      '    if ((isErr || isOff) && !opts.dry) {',
      '      if (clickBtn(btnGo)) {',
      '        out.clicked += 1;',
      '        doneRoot[id] = 1;',
      '        if (isOff) out.offline.clicked = true;',
      '      }',
      '    }',
      '  }',
      '',
      '  /* 第二遍：按钮名不叫 Btn_Confirm 的离线奖励面板——按钮文案是「确认/领取」，且容器里有「离线奖励」才点 */',
      '  if (!out.offline.clicked && !opts.dry) {',
      '    var btnArr = null;',
      '    try { btnArr = CS.UnityEngine.Object.FindObjectsByType(NB, CS.UnityEngine.FindObjectsSortMode.None); } catch (e) { btnArr = null; }',
      '    for (var b = 0; btnArr && b < btnArr.Length; b += 1) {',
      '      var nb = btnArr.get_Item(b), bGo = null;',
      '      try { bGo = nb.gameObject; } catch (e) { continue; }',
      '      if (!bGo || !bGo.activeInHierarchy) continue;',
      '      var bn = ""; try { bn = String(bGo.name || ""); } catch (e) { }',
      '      if (bn === "Btn_Confirm") continue;',
      '',
      '      var lbl = ""; try { lbl = textOf(bGo).trim(); } catch (e) { }',
      '      if (!lbl || !CONFIRM || !CONFIRM.test(lbl) || (CANCEL && CANCEL.test(lbl))) continue;',
      '',
      '      var cGo = containerOf(bGo, 9);',
      '      if (!cGo) continue;',
      '      var cTxt = textOf(cGo);',
      '      if (!anyIn(cTxt, OKWS)) continue;',
      '',
      '      var cid = ""; try { cid = String(cGo.GetInstanceID()); } catch (e) { cid = "b" + b; }',
      '      if (doneRoot[cid]) continue;',
      '      doneRoot[cid] = 1;',
      '',
      '      out.offline.found = true;',
      '      out.offline.texts = cTxt.split(" | ").slice(0, 8);',
      '      out.offline.button = bn || lbl;',
      '      if (clickBtn(bGo)) { out.offline.clicked = true; out.clicked += 1; }',
      '      out.dialogs.push({ text: cTxt.slice(0, 120), hit: true, kind: "offline", root: String(cGo.name || "") });',
      '      break;',
      '    }',
      '  }',
      '',
      '  return JSON.stringify(out);',
      '})(', JSON.stringify(opts), ')'
    ].join('\n');
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var box = document.querySelector('#daily-popup-stats');
    if (!box) return;
    var s = loadStats();
    var stat = '';
    if (!last) {
      stat = '<div class="daily-stat"><b>—</b><span>尚未检查</span></div>';
    } else if (last.offline && last.offline.clicked) {
      var brief = (last.offline.texts || []).filter(function (t) { return /\d/.test(t); }).slice(0, 3).join(' / ');
      stat = '<div class="daily-stat"><b>已领离线奖励</b><span>' + (brief || '今日已确认 ' + s.closed + ' 次') + '</span></div>';
    } else if (!last.dialogs.length) {
      stat = '<div class="daily-stat"><b>正常</b><span>没有弹窗 · 今日已确认 ' + s.closed + ' 次</span></div>';
    } else {
      var errN = 0, offStuck = false, txt = '';
      for (var i = 0; i < last.dialogs.length; i += 1) {
        var dg = last.dialogs[i];
        if (dg.kind === 'error') errN += 1;
        if (dg.kind === 'offline' && !(last.offline && last.offline.clicked)) offStuck = true;
        if (!txt && dg.text) txt = dg.text;
      }
      if (errN) {
        stat = '<div class="daily-stat"><b>已确认 ' + last.clicked + '</b><span>今日累计 ' + s.closed + ' 次 · ' + txt.slice(0, 40) + '</span></div>';
      } else if (offStuck) {
        stat = '<div class="daily-stat"><b>离线奖励</b><span>面板在，确认按钮没点动 · ' + txt.slice(0, 40) + '</span></div>';
      } else {
        stat = '<div class="daily-stat"><b>未处理</b><span>有弹窗但不是异常框，没动它 · ' + txt.slice(0, 40) + '</span></div>';
      }
    }
    box.innerHTML = stat;
  }

  /* ---------------- 检查 / 处理 ---------------- */
  function check(opts) {
    opts = opts || {};
    if (!connected()) {
      if (!opts.silent) note('异常弹窗：游戏未连接，先在页面顶部点「连接」', 'error');
      return Promise.resolve(0);
    }
    if (busy) return Promise.resolve(0);
    busy = true;
    var dry = !!opts.dry;

    return runGame(popupExpr({
      keywords: KEYWORDS,
      offlineKeywords: OFFLINE_KEYWORDS,
      confirmLabel: CONFIRM_LABEL.source,
      cancelLabel: CANCEL_LABEL.source,
      dry: dry
    }), 15000).then(function (raw) {
      busy = false;
      var r = null;
      try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { r = null; }
      if (!r) { if (!opts.silent) note('异常弹窗：检查返回异常 ' + String(raw).slice(0, 80), 'error'); return 0; }

      last = { at: Date.now(), dialogs: r.dialogs || [], clicked: r.clicked || 0, offline: r.offline || null };

      /* out.clicked 已经把离线奖励那一次算进去了，这里不再重复 +1 */
      var total = last.clicked || 0;

      if (last.clicked > 0) {
        var preview = '', hasErr = false;
        for (var i = 0; i < last.dialogs.length; i += 1) {
          if (last.dialogs[i].kind === 'error' && last.dialogs[i].hit) { hasErr = true; preview = last.dialogs[i].text; break; }
        }
        if (hasErr) note('异常弹窗：已自动确认「' + preview.slice(0, 40) + '」', 'ok');
        else if (!last.offline || !last.offline.clicked) {
          note('异常弹窗：已自动确认 1 个弹窗', 'ok');
        }
      }
      if (last.offline && last.offline.clicked) {
        var brief = (last.offline.texts || []).filter(function (t) {
          return /经验|金幣|金币|EXP|\d/.test(t);
        }).slice(0, 4).join(' / ');
        note('离线奖励：已自动确认领取' + (brief ? '（' + brief + '）' : ''), 'ok');
      }
      if (total > 0) {
        var s = bumpStats(total);
        last.closedToday = s.closed;
      } else if (!opts.silent && last.dialogs.some(function (d) { return d.kind === 'other'; })) {
        note('异常弹窗：检测到 1 个弹窗，但不是网络异常框，没有自动确认', 'info');
      }
      if (last.offline && last.offline.found && !last.offline.clicked && !opts.silent) {
        note('离线奖励：面板在，但确认按钮没点动（按钮 ' + (last.offline.button || '未知') + '）', 'warn');
      }

      render();
      return total;
    }).catch(function (err) {
      busy = false;
      if (!opts.silent) note('异常弹窗：检查失败 ' + ((err && err.message) || err), 'error');
      return 0;
    });
  }

  /* 出战/领奖前先清一次，避免被弹窗卡住 */
  function clearNow() {
    return check({ silent: true });
  }

  function startAuto() {
    if (timer) return;
    timer = setInterval(function () {
      if (!settings.autoClose) return;
      check({ silent: true });
    }, POLL_EVERY);
    setTimeout(function () { if (settings.autoClose) check({ silent: true }); }, 4000);
  }

  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---------------- 接线 ---------------- */
  function init() {
    if (!document.querySelector('#daily-popup-stats')) return;
    loadSettings();
    render();

    var sw = document.getElementById('daily-auto-popup');
    if (sw) {
      sw.checked = !!settings.autoClose;
      sw.addEventListener('change', function () {
        settings.autoClose = !!sw.checked;
        saveSettings();
        if (settings.autoClose) { note('异常弹窗：自动确认已开启'); startAuto(); }
        else { note('异常弹窗：自动确认已关闭'); stopAuto(); }
      });
    }

    var btn = document.getElementById('daily-popup-check');
    if (btn) btn.addEventListener('click', function () { check({}); });

    if (settings.autoClose) startAuto();
  }

  window.__wogPopup = {
    check: check,
    clearNow: clearNow,
    last: function () { return last; },
    stats: loadStats,
    get: function () { return { autoClose: settings.autoClose }; },
    set: function (key, value) {
      if (key === 'autoClose') {
        settings.autoClose = !!value;
        saveSettings();
        var sw = document.getElementById('daily-auto-popup');
        if (sw) sw.checked = settings.autoClose;
        if (settings.autoClose) startAuto(); else stopAuto();
        render();
      }
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
