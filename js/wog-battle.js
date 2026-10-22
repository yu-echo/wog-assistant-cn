/* 战场（每日一次）：团队副本 / 世界首领 / 竞技场。
 *
 * 规则来自需求：
 *   - 没开放的直接跳过（赛季状态不是「开放」就不碰）
 *   - 开放的每天只打一次（本地按日期记账，同一天不会重复打）
 *   - 竞技场只挑战「战力比自己低」的对手，找不到就跳过，不盲打
 *
 * 通道和 js/wog-daily.js 一样：自己开 WS 连 ws://127.0.0.1:10998 执行表达式。
 * 接口事实（2026-10-22 实测）：
 *   nn.services.dungeon.startDungeonBattle(dungeonTid, targetUserInfo, dungeonStartType)
 *     → 返回 1 = 成功；6 = PvP 缺少目标；其它 = 失败码
 *   nn.services.league.getLeagueSeasonState(leagueTid) === 2 表示已开放
 *   nn.net.data.dungeonInfo._mapDungeonInfo 里的 _playCnt 可以用来确认这一把真打了
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'wog-battle-daily-v1';
  var SETTINGS_KEY = 'wog-battle-settings-v1';
  var POLL_EVERY = 10 * 60 * 1000;
  var WS_URL = 'ws://127.0.0.1:10998';

  /* 三个战场：名称 / 副本 id / 门票道具 id / 记账键 */
  var CONTENTS = [
    { key: 'boss', name: '世界首领', tid: 10000, ticket: 5300 },
    { key: 'arena', name: '竞技场', tid: 30000, ticket: 5000 },
    { key: 'raid', name: '团队副本', tid: 20000, ticket: 5200 }
  ];

  var settings = { autoBattle: true };
  var timer = null;
  var busy = false;
  var lastStatus = null;

  function $(sel) { return document.querySelector(sel); }

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

  /* ---------------- 每日记账 ---------------- */
  function todayKey() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function loadDone() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var d = raw ? JSON.parse(raw) : null;
      if (!d || d.date !== todayKey()) return {};
      return d.done || {};
    } catch (e) { return {}; }
  }

  function markDone(key) {
    var done = loadDone();
    done[key] = true;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: todayKey(), done: done }));
    } catch (e) { /* 忽略 */ }
    render();
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && typeof d.autoBattle === 'boolean') settings.autoBattle = d.autoBattle;
    } catch (e) { /* 忽略 */ }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 直连游戏内核 ---------------- */
  function runGame(expr, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ws = null;
      var done = false;
      var timer = setTimeout(function () {
        finish(new Error('游戏无响应（超时 ' + Math.round((timeoutMs || 20000) / 1000) + 's）'));
      }, timeoutMs || 20000);

      function finish(err, val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (ws) ws.close(); } catch (e) { /* 忽略 */ }
        if (err) reject(err); else resolve(val);
      }

      try { ws = new WebSocket(WS_URL); } catch (e) { return finish(e); }
      ws.onopen = function () { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); };
      ws.onerror = function () { finish(new Error('连不上游戏内核（ws://127.0.0.1:10998）')); };
      ws.onmessage = function (ev) {
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return finish(new Error('返回解析失败')); }
        if (!msg || msg.id !== 1) return;
        var res = msg.result || {};
        if (res.exceptionDetails) {
          return finish(new Error((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text || '表达式报错'));
        }
        var out = res.result || {};
        finish(null, out.value);
      };
    });
  }

  /* ---------------- 游戏侧表达式 ---------------- */
  function battleExpr(opts) {
    return [
      '(async function (opts) {',
      '  var out = { ok: true, notes: [], battles: [], status: [] };',
      '  var gs = nn.net.manager.gameSession;',
      '  var sL = nn.services.league;',
      '  var sD = nn.services.dungeon;',
      '  var itemSvc = nn.services.item;',
      '  var myCP = 0;',
      '  try { myCP = Math.round(Number(nn.services.contentState._finalCp) || 0); } catch (e) { }',
      '  out.myCP = myCP;',
      '  function num(v) { try { return Number(v) || 0; } catch (e) { return 0; } }',
      '  var DEFS = [',
      '    { key: "boss",  name: "世界首领", tid: 10000, ticket: 5300 },',
      '    { key: "arena", name: "竞技场",   tid: 30000, ticket: 5000 },',
      '    { key: "raid",  name: "团队副本", tid: 20000, ticket: 5200 }',
      '  ];',
      '  function playCount(tid) {',
      '    var row = null;',
      '    var m = nn.net.data.dungeonInfo._mapDungeonInfo;',
      '    if (m && typeof m.forEach === "function") {',
      '      m.forEach(function (v) { if (num(v._dungeonTid) === num(tid)) row = v; });',
      '    }',
      '    return row ? num(row._playCnt) : 0;',
      '  }',
      '  function seasonOf(tid) {',
      '    var ltid = 0, st = -1;',
      '    try { ltid = num(sL.getCurrentLeagueTidByDungeonTid(tid)); } catch (e) { }',
      '    if (ltid > 0) { try { st = num(sL.getLeagueSeasonState(ltid)); } catch (e) { } }',
      '    return { leagueTid: ltid, state: st, open: st === 2 };',
      '  }',
      '  function snapshot() {',
      '    var list = [];',
      '    DEFS.forEach(function (d) {',
      '      var s = seasonOf(d.tid);',
      '      list.push({ key: d.key, name: d.name, tid: d.tid, ticket: d.ticket,',
      '        ticketOwned: num(itemSvc.getOwnedItemCount(d.ticket)),',
      '        open: s.open, state: s.state, leagueTid: s.leagueTid, play: playCount(d.tid) });',
      '    });',
      '    return list;',
      '  }',
      '  out.status = snapshot();',
      '  if (opts.op === "status") return JSON.stringify(out);',
      '',
      '  function retText(r) {',
      '    if (r === 1) return "成功";',
      '    if (r === 2) return "副本表读取失败";',
      '    if (r === 3) return "上一场还没结束";',
      '    if (r === 4) return "战斗数据解析失败";',
      '    if (r === 5) return "战斗数据缺失";',
      '    if (r === 6) return "缺少对手";',
      '    if (r === 7) return "PvP 请求被服务端拒绝";',
      '    if (r === 8) return "请求被服务端拒绝（多半是今天次数已用完，或游戏会话校验失效）";',
      '    return "失败（返回码 " + r + "）";',
      '  }',
      '',
      '  async function playPve(d) {',
      '    var s = seasonOf(d.tid);',
      '    if (!s.open) { out.notes.push(d.name + " 未开放，跳过"); return; }',
      '    var owned = num(itemSvc.getOwnedItemCount(d.ticket));',
      '    if (owned <= 0) { out.notes.push(d.name + " 没有门票，跳过"); return; }',
      '    var before = playCount(d.tid);',
      '    var ret;',
      '    try { ret = await sD.startDungeonBattle(d.tid, null, 1); }',
      '    catch (e) { out.notes.push(d.name + " 发起失败：" + e.message); return; }',
      '    var after = playCount(d.tid);',
      '    out.battles.push({ key: d.key, name: d.name, ret: ret, retText: retText(ret),',
      '      ok: after > before, playBefore: before, playAfter: after });',
      '  }',
      '',
      '  /* 竞技场：只打战力比自己低的，挑战力最低的那个（稳赢，一次机会别浪费） */',
      '  async function playArena(d) {',
      '    var s = seasonOf(d.tid);',
      '    if (!s.open) { out.notes.push("竞技场 未开放，跳过"); return; }',
      '    var owned = num(itemSvc.getOwnedItemCount(d.ticket));',
      '    if (owned <= 0) { out.notes.push("竞技场 没有门票，跳过"); return; }',
      '',
      '    var target = null, source = "", listed = 0;',
      '    // 官方对手列表（flatbuffer：Data.arenaPvpUserInfo().serverRankInfos(i)）',
      '    try {',
      '      var res = await gs.reqArenaPvpUserInfo(d.tid);',
      '      if (res && !res.hasError() && res.Data && typeof res.Data.arenaPvpUserInfo === "function") {',
      '        var a = res.Data.arenaPvpUserInfo();',
      '        var n = num(a.serverRankInfosLength());',
      '        listed = n;',
      '        for (var i = 0; i < n; i += 1) {',
      '          var it = a.serverRankInfos(i);',
      '          var cp = num(it.combatPower());',
      '          if (cp <= 0 || cp >= myCP) continue;',
      '          if (!target || cp < target.cp) target = { cp: cp, userId: it.userId(), nick: String(it.nick() || ""), lv: num(it.lv()) };',
      '        }',
      '        if (target) source = "官方对手列表";',
      '      }',
      '    } catch (e) { }',
      '',
      '    // 回退：排行榜里战力比我低的（只有前 100 名，通常都比自己强）',
      '    if (!target && s.leagueTid > 0) {',
      '      try {',
      '        await gs.reqServerRankList(s.leagueTid);',
      '        var m = nn.net.data.rank._mapServerRankList;',
      '        var v = m && typeof m.get === "function" ? (m.get(s.leagueTid) || m.get(String(s.leagueTid))) : null;',
      '        if (v && v._rankList && typeof v._rankList.forEach === "function") {',
      '          var best2 = null;',
      '          v._rankList.forEach(function (x) {',
      '            var cp = num(x._combatPower);',
      '            if (cp <= 0 || cp >= myCP) return;',
      '            if (!best2 || cp < best2.cp) best2 = { cp: cp, userId: x._userId, nick: String(x._nick || ""), lv: num(x._lv) };',
      '          });',
      '          if (best2) { target = best2; source = "排行榜"; }',
      '        }',
      '      } catch (e) { }',
      '    }',
      '',
      '    if (!target) { out.notes.push("竞技场 没找到战力比自己低的对手，跳过（我 " + myCP + "，列表 " + listed + " 人）"); return; }',
      '',
      '    var before = playCount(d.tid);',
      '    var ret;',
      '    try {',
      '      ret = await sD.startDungeonBattle(d.tid, { userId: target.userId, nick: target.nick, lv: target.lv, combatPower: target.cp }, 1);',
      '    } catch (e) { out.notes.push("竞技场 发起失败：" + e.message); return; }',
      '    var after = playCount(d.tid);',
      '    out.battles.push({ key: d.key, name: "竞技场", ret: ret, retText: retText(ret),',
      '      ok: after > before, playBefore: before, playAfter: after, source: source,',
      '      target: { nick: target.nick, cp: target.cp } });',
      '  }',
      '',
      '  var want = opts.list || [];',
      '  if (want.indexOf("boss") >= 0) await playPve(DEFS[0]);',
      '  if (want.indexOf("raid") >= 0) await playPve(DEFS[2]);',
      '  if (want.indexOf("arena") >= 0) await playArena(DEFS[1]);',
      '',
      '  out.status = snapshot();',
      '  return JSON.stringify(out);',
      '})(', JSON.stringify(opts), ')'
    ].join('\n');
  }

  /* ---------------- 渲染 ---------------- */
  function stateText(item, done) {
    if (done) return '今天已打';
    if (!item.open) return '未开放';
    if (item.ticketOwned <= 0) return '没门票';
    return '可打';
  }

  function render() {
    var box = $('#daily-battle-stats');
    if (!box) return;
    var done = loadDone();
    if (!lastStatus || !lastStatus.length) {
      box.innerHTML = '<div class="daily-stat"><b>—</b><span>尚未读取</span></div>';
      return;
    }
    var html = '';
    for (var i = 0; i < lastStatus.length; i += 1) {
      var it = lastStatus[i];
      html += '<div class="daily-stat"><b>' + stateText(it, done[it.key]) + '</b><span>' +
        it.name + ' · 门票 ' + it.ticketOwned + '</span></div>';
    }
    box.innerHTML = html;
  }

  function refreshStatus() {
    if (!connected()) {
      lastStatus = null;
      render();
      return Promise.resolve(null);
    }
    return runGame(battleExpr({ op: 'status' }), 15000).then(function (raw) {
      var r = null;
      try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { r = null; }
      if (r && r.status) {
        lastStatus = r.status;
        render();
      }
      return r;
    }).catch(function () { return null; });
  }

  /* ---------------- 出战 ---------------- */
  function runBattle(target, opts) {
    opts = opts || {};
    if (!connected()) {
      if (!opts.silent) note('战场：游戏未连接，先在页面顶部点「连接」', 'error');
      return Promise.resolve(null);
    }
    if (busy) { if (!opts.silent) note('战场：上一次出战还没结束', 'warn'); return Promise.resolve(null); }

    var done = loadDone();
    var all = ['boss', 'raid', 'arena'];
    var list = target === 'all' ? all : [target];
    list = list.filter(function (k) { return !done[k]; });
    if (!list.length) {
      if (!opts.silent) note('战场：今天这几项都打过了，明天再来', 'info');
      return Promise.resolve(null);
    }

    busy = true;

    // 出战前先清一次异常弹窗，否则请求会被弹窗挡住（返回码 8）
    var pre = (window.__wogPopup && typeof window.__wogPopup.clearNow === 'function')
      ? window.__wogPopup.clearNow() : Promise.resolve(0);

    return pre.then(function () {
      return runGame(battleExpr({ op: 'play', list: list }), 90000);
    }).then(function (raw) {
      busy = false;
      var r = null;
      try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { r = null; }
      if (!r) { note('战场返回异常：' + String(raw).slice(0, 120), 'error'); return null; }

      var battles = r.battles || [];
      for (var i = 0; i < battles.length; i += 1) {
        var b = battles[i];
        if (b.ok) {
          var extra = b.target ? '（对手 ' + b.target.nick + '，战力 ' + b.target.cp + ' < 我 ' + r.myCP + '，来源 ' + b.source + '）' : '';
          note(b.name + ' 已打一场' + extra, 'ok');
          markDone(b.key);
        } else {
          note(b.name + ' ' + (b.retText || '未成功'), 'warn');
        }
      }
      var notes = r.notes || [];
      for (var j = 0; j < notes.length; j += 1) {
        var n = notes[j];
        var kind = (n.indexOf('未开放') >= 0 || n.indexOf('跳过') >= 0) ? 'info' : 'warn';
        if (opts.silent && kind === 'info') continue;
        note('战场：' + n, kind);
      }

      if (r.status) { lastStatus = r.status; render(); }
      return r;
    }).catch(function (err) {
      busy = false;
      var msg = (err && err.message) || String(err);
      note('战场失败：' + msg, 'error');
      return null;
    });
  }

  /* ---------------- 自动（每天一次） ---------------- */
  function autoTick() {
    if (!settings.autoBattle || !connected() || busy) return;
    var done = loadDone();
    if (done.boss && done.arena && done.raid) return;
    runBattle('all', { silent: true }).catch(function () { /* 忽略 */ });
  }

  function startAuto() {
    if (timer) return;
    timer = setInterval(autoTick, POLL_EVERY);
    setTimeout(autoTick, 6000);
  }

  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---------------- 接线 ---------------- */
  function init() {
    var box = $('#daily-battle-stats');
    if (!box) return;
    loadSettings();
    render();

    var sw = document.getElementById('daily-auto-battle');
    if (sw) {
      sw.checked = !!settings.autoBattle;
      sw.addEventListener('change', function () {
        settings.autoBattle = !!sw.checked;
        saveSettings();
        if (settings.autoBattle) {
          note('战场：自动出战已开启（每天每项只打一次）');
          startAuto();
        } else {
          note('战场：自动出战已关闭');
          stopAuto();
        }
      });
    }

    function bind(id, target) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function () { runBattle(target, {}); });
    }
    bind('daily-battle-boss', 'boss');
    bind('daily-battle-arena', 'arena');
    bind('daily-battle-all', 'all');

    if (settings.autoBattle) startAuto();

    // 切到日常页时刷新一次状态
    var raw = window.__wogDailyRefresh;
    window.__wogDailyRefresh = function () {
      var p = typeof raw === 'function' ? raw.apply(this, arguments) : null;
      refreshStatus();
      return p;
    };
  }

  window.__wogBattle = {
    status: function () { return lastStatus; },
    refresh: refreshStatus,
    play: runBattle,
    done: loadDone,
    get: function () { return { autoBattle: settings.autoBattle }; },
    set: function (key, value) {
      if (key === 'autoBattle') {
        settings.autoBattle = !!value;
        saveSettings();
        if (settings.autoBattle) startAuto(); else stopAuto();
        render();
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
