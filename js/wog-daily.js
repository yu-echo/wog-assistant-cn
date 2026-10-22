/* 日常自动化页：古老祭坛（领钻石 / 强化）+ 轮盘抽奖 + 遗物强化 + 邮件 + 每日商店。
 *
 * 两条写入通道，各管一段：
 *   1) 祭坛 / 抽奖 —— 走页面桥 window.WOG_COMPANION_RUNTIME_BRIDGE 的 executeWrite('daily-ops')
 *   2) 遗物 / 邮件 / 商店 —— 自己开 WS 连 ws://127.0.0.1:10998 直接执行表达式
 *      （和「游戏加点」同一条通道；桥的写入动作表没这些动作，硬塞要改压缩后的 bootstrap）
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'wog-daily-settings-v2';
  var LOG_MAX = 80;

  var AUTO = {
    takeDia: { key: 'autoTakeDia', label: '领钻石', every: 60000 },
    enchant: { key: 'autoEnchant', label: '祭坛强化', every: 60000 },
    gacha: { key: 'autoGacha', label: '轮盘抽奖', every: 300000 },
    relic: { key: 'autoRelic', label: '遗物强化', every: 120000 },
    mail: { key: 'autoMail', label: '领取邮件', every: 300000 },
    shop: { key: 'autoShop', label: '每日商店', every: 600000 }
  };

  var settings = {
    autoTakeDia: true, autoEnchant: true, autoGacha: true,
    autoRelic: true, autoMail: true, autoShop: true
  };
  var timers = {};
  var busy = false;
  var logItems = [];
  var lastState = null;

  function $(sel) { return document.querySelector(sel); }
  function bridge() { return window.WOG_COMPANION_RUNTIME_BRIDGE || null; }

  /* ---------------- 设置持久化 ---------------- */
  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('wog-daily-settings-v1');
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      for (var k in settings) if (typeof data[k] === 'boolean') settings[k] = data[k];
    } catch (err) { /* 忽略损坏的本地设置 */ }
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (err) { /* 忽略 */ }
  }

  /* ---------------- 日志 ---------------- */
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function timeLabel() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function log(text, kind) {
    logItems.unshift({ t: timeLabel(), text: String(text), kind: kind || 'info' });
    if (logItems.length > LOG_MAX) logItems.length = LOG_MAX;
    renderLog();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderLog() {
    var list = $('#daily-log');
    if (!list) return;
    if (logItems.length === 0) { list.innerHTML = '<li class="baoyu-muted">暂无记录</li>'; return; }
    var html = '';
    for (var i = 0; i < logItems.length; i += 1) {
      var it = logItems[i];
      var color = it.kind === 'error' ? 'color:#e5484d' : it.kind === 'ok' ? 'color:#2f9e44' : '';
      html += '<li style="' + color + '"><span class="daily-log-time">' + it.t + '</span> ' + escapeHtml(it.text) + '</li>';
    }
    list.innerHTML = html;
  }

  /* 错误条：显示 8 秒后自动收起。轮询会反复调用，所以每次重置计时器，
     但不会让同一条提示永久挂在页面上。 */
  var errTimer = null;
  function showError(text) {
    var box = $('#daily-error-box');
    if (!box) return;
    if (!text) {
      box.classList.add('hidden');
      box.textContent = '';
      if (errTimer) { clearTimeout(errTimer); errTimer = null; }
      return;
    }
    box.classList.remove('hidden');
    box.textContent = String(text);
    if (errTimer) clearTimeout(errTimer);
    errTimer = setTimeout(function () {
      errTimer = null;
      box.classList.add('hidden');
      box.textContent = '';
    }, 8000);
  }

  /* ---------------- 直连游戏内核 ---------------- */
  function runGame(expr, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ws = null;
      var done = false;
      var timer = setTimeout(function () {
        finish(new Error('游戏无响应（超时 ' + Math.round((timeoutMs || 15000) / 1000) + 's）'));
      }, timeoutMs || 15000);

      function finish(err, val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (ws) ws.close(); } catch (e) { }
        if (err) reject(err); else resolve(val);
      }

      try { ws = new WebSocket('ws://127.0.0.1:10998'); }
      catch (e) { return finish(new Error('无法打开游戏连接')); }

      ws.onopen = function () {
        try {
          ws.send(JSON.stringify({
            id: Math.floor(Math.random() * 1000000) + 1,
            method: 'Runtime.evaluate',
            params: { expression: expr, awaitPromise: true, returnByValue: true }
          }));
        } catch (e) { finish(e); }
      };
      ws.onmessage = function (msg) {
        var res;
        try { res = JSON.parse(msg.data); } catch (e) { return; }
        if (!res || !res.result) return;
        if (res.result.exceptionDetails) {
          return finish(new Error(res.result.exceptionDetails.text || '游戏内脚本异常'));
        }
        finish(null, res.result.result ? res.result.result.value : undefined);
      };
      ws.onerror = function () { finish(new Error('连不上游戏（10998），请确认游戏已启动并已注入')); };
      ws.onclose = function () { if (!done) finish(new Error('游戏连接被关闭')); };
    });
  }

  function gameReady() {
    var b = bridge();
    if (b && b.getState().status === 'connected') return true;
    return false;
  }

  /* ---------------- 状态查询表达式 ---------------- */
  var STATE_EXPR = "(async function () {\n" +
    "  try {\n" +
    "    var tree = nn.services.tree, item = nn.services.item;\n" +
    "    var mail = nn.services.mail, shop = nn.services.shop;\n" +
    "    var num = function (v) { try { return Number(v) || 0; } catch (e) { return 0; } };\n" +
    "    var arr = function (v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); };\n" +
    "    var has = function (t, c) { return num(item.getOwnedItemCount(t)) >= c; };\n" +
    "    var out = { altar: {}, relic: {}, mail: {}, shop: {} };\n" +
    "    // 祭坛\n" +
    "    var gid = 0;\n" +
    "    try { var gs = tree.getGroupIds(3) || []; gid = gs.length ? gs[0] : 0; } catch (e) {}\n" +
    "    out.altar.level = num(tree.getReachedLevel(3, gid));\n" +
    "    out.altar.dia = num(item.getOwnedItemCount(6000));\n" +
    "    out.altar.accrued = num(tree.getAccruedDiaRewardCount());\n" +
    "    try { out.altar.maxed = !!tree.isMaxLevel(3, gid); } catch (e) { out.altar.maxed = false; }\n" +
    "    try { out.altar.enough = !!tree.hasEnoughDiaGrowthCost(); } catch (e) { out.altar.enough = false; }\n" +
    "    try { out.altar.block = num(tree.getEnchantBlock(3, tree.getCurrentEnchantTreeId(3, gid))); } catch (e) { out.altar.block = -1; }\n" +
    "    out.coins = num(item.getOwnedItemCount(18000));\n" +
    "    // 遗物（treeType = 2）\n" +
    "    var owned = 0, ready = 0, maxedRelic = 0, best = null;\n" +
    "    try {\n" +
    "      var rg = tree.getGroupIds(2) || [];\n" +
    "      for (var i = 0; i < rg.length; i++) {\n" +
    "        var g = rg[i];\n" +
    "        var lv = num(tree.getReachedLevel(2, g));\n" +
    "        if (lv <= 0) continue;\n" +
    "        owned += 1;\n" +
    "        var nt = tree.getTableByLevel(2, g, lv + 1);\n" +
    "        if (!nt) { maxedRelic += 1; continue; }\n" +
    "        var a = arr(nt.LevelUpItemID), b = arr(nt.LevelUpItemCnt);\n" +
    "        var ok = a.length > 0;\n" +
    "        var needTid = 0, needCnt = 0, haveCnt = 0;\n" +
    "        for (var j = 0; j < Math.min(a.length, b.length); j++) {\n" +
    "          var t = Number(a[j]), c = Number(b[j]);\n" +
    "          if (t > 0 && c > 0) {\n" +
    "            var h = num(item.getOwnedItemCount(t));\n" +
    "            if (!has(t, c)) ok = false;\n" +
    "            if (!needTid) { needTid = t; needCnt = c; haveCnt = h; }\n" +
    "          }\n" +
    "        }\n" +
    "        if (ok) ready += 1;\n" +
    "        if (!best && needTid) {\n" +
    "          var nm = '';\n" +
    "          try { nm = String(item.getItemName(needTid) || ''); } catch (e) {}\n" +
    "          best = { level: lv, needName: nm, need: needCnt, have: haveCnt, ok: ok };\n" +
    "        }\n" +
    "      }\n" +
    "    } catch (e) {}\n" +
    "    out.relic = { owned: owned, ready: ready, maxed: maxedRelic, best: best };\n" +
    "    // 邮件\n" +
    "    try { out.mail.pending = (mail.getCanReceiveMailIds() || []).length; } catch (e) { out.mail.pending = -1; }\n" +
    "    // 每日商店\n" +
    "    try { out.shop.daily = num(shop.findFirstDailyRewardProductTid()) > 0 ? 1 : 0; } catch (e) { out.shop.daily = -1; }\n" +
    "    out.ok = true;\n" +
    "    return JSON.stringify(out);\n" +
    "  } catch (e) {\n" +
    "    return JSON.stringify({ ok: false, error: String((e && e.message) || e) });\n" +
    "  }\n" +
    "})()";

  /* ---------------- 动作表达式 ---------------- */
  function relicExpr(maxTimes) {
    return "(async function (maxTimes) {\n" +
      "  var tree = nn.services.tree, item = nn.services.item;\n" +
      "  var T = 2;\n" +
      "  var num = function (v) { try { return Number(v) || 0; } catch (e) { return 0; } };\n" +
      "  var arr = function (v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); };\n" +
      "  var notes = [], done = [], upgraded = 0, rounds = 0, shortName = '';\n" +
      "  while (upgraded < maxTimes && rounds++ < 120) {\n" +
      "    var progressed = false;\n" +
      "    var gs = [];\n" +
      "    try { gs = tree.getGroupIds(T) || []; } catch (e) { notes.push('读取遗物列表失败'); break; }\n" +
      "    for (var i = 0; i < gs.length; i++) {\n" +
      "      if (upgraded >= maxTimes) break;\n" +
      "      var g = gs[i];\n" +
      "      var lv = num(tree.getReachedLevel(T, g));\n" +
      "      if (lv <= 0) continue;\n" +
      "      var nt = tree.getTableByLevel(T, g, lv + 1);\n" +
      "      if (!nt) continue;\n" +
      "      var toTid = num(nt.PassiveItemID);\n" +
      "      if (toTid <= 0) continue;\n" +
      "      var a = arr(nt.LevelUpItemID), b = arr(nt.LevelUpItemCnt);\n" +
      "      var materials = [], enough = a.length > 0;\n" +
      "      for (var j = 0; j < Math.min(a.length, b.length); j++) {\n" +
      "        var t = Number(a[j]), c = Number(b[j]);\n" +
      "        if (t > 0 && c > 0) {\n" +
      "          materials.push({ itemId: 0n, itemTid: t, itemCnt: c });\n" +
      "          if (num(item.getOwnedItemCount(t)) < c) {\n" +
      "            enough = false;\n" +
      "            if (!shortName) { try { shortName = String(item.getItemName(t) || ('道具' + t)); } catch (e) { shortName = '道具' + t; } }\n" +
      "          }\n" +
      "        }\n" +
      "      }\n" +
      "      if (!enough) continue;\n" +
      "      try { await tree.reqLevelUpAsync(T, g, toTid, materials); }\n" +
      "      catch (e) { notes.push('升级请求失败：' + String((e && e.message) || e)); continue; }\n" +
      "      var nl = num(tree.getReachedLevel(T, g));\n" +
      "      if (nl > lv) { upgraded += 1; progressed = true; done.push({ groupId: String(g), level: nl }); }\n" +
      "    }\n" +
      "    if (!progressed) break;\n" +
      "  }\n" +
      "  if (upgraded === 0 && notes.length === 0) {\n" +
      "    if (typeof shortName !== 'undefined' && shortName) notes.push('遗物材料不足（缺 ' + shortName + '）');\n" +
      "    else notes.push('没有可强化的遗物（材料不足或都已满级）');\n" +
      "  }\n" +
      "  return JSON.stringify({ ok: true, upgraded: upgraded, done: done, notes: notes });\n" +
      "})(TIMES)";
  }

  function mailExpr() {
    return "(async function () {\n" +
      "  var mail = nn.services.mail;\n" +
      "  var notes = [], taken = 0;\n" +
      "  for (var i = 0; i < 10; i++) {\n" +
      "    var ids = [];\n" +
      "    try { ids = mail.getCanReceiveMailIds() || []; } catch (e) { notes.push('读取邮件失败'); break; }\n" +
      "    if (ids.length === 0) break;\n" +
      "    var before = ids.length;\n" +
      "    try { await mail.takeMails(ids); }\n" +
      "    catch (e) { notes.push('领取失败：' + String((e && e.message) || e)); break; }\n" +
      "    await new Promise(function (r) { setTimeout(r, 500); });\n" +
      "    var after = 0;\n" +
      "    try { after = (mail.getCanReceiveMailIds() || []).length; } catch (e) {}\n" +
      "    if (after >= before) { notes.push('邮件没领到手（可能背包已满）'); break; }\n" +
      "    taken += before - after;\n" +
      "  }\n" +
      "  if (taken === 0 && notes.length === 0) notes.push('没有可领取的邮件');\n" +
      "  return JSON.stringify({ ok: true, taken: taken, notes: notes });\n" +
      "})()";
  }

  function shopExpr() {
    return "(async function () {\n" +
      "  var shop = nn.services.shop;\n" +
      "  var notes = [], taken = 0;\n" +
      "  for (var i = 0; i < 8; i++) {\n" +
      "    var id = 0;\n" +
      "    try { id = Number(shop.findFirstDailyRewardProductTid()) || 0; } catch (e) { notes.push('读取商店失败'); break; }\n" +
      "    if (id <= 0) break;\n" +
      "    var table = null;\n" +
      "    try { table = nn.db.shop.get(id); } catch (e) {}\n" +
      "    if (!table) { notes.push('找不到商品配置 ' + id); break; }\n" +
      "    try { await shop.reqShopBuy(table, 1); }\n" +
      "    catch (e) { notes.push('领取失败：' + String((e && e.message) || e)); break; }\n" +
      "    taken += 1;\n" +
      "    await new Promise(function (r) { setTimeout(r, 700); });\n" +
      "  }\n" +
      "  if (taken === 0 && notes.length === 0) notes.push('今天的每日商品已经领完了');\n" +
      "  return JSON.stringify({ ok: true, taken: taken, notes: notes });\n" +
      "})()";
  }

  /* ---------------- 渲染 ---------------- */
  function stat(label, value, hint) {
    return '<div class="daily-stat"><b>' + escapeHtml(value) + '</b><span>' + escapeHtml(label) +
      (hint ? ' · ' + escapeHtml(hint) : '') + '</span></div>';
  }

  function blockLabel(block) {
    if (block === 0) return '可强化';
    if (block === 2) return '已满级';
    if (block === 3) return '非目标树';
    if (block === 4) return '条件未满足';
    if (block === 5) return '钻石不足';
    return block === -1 ? '读取失败' : '状态 ' + block;
  }

  function renderAll(s) {
    if (!s || !s.ok) return;
    lastState = s;

    var altar = $('#daily-altar-stats');
    if (altar) {
      altar.innerHTML =
        stat('祭坛等级', 'Lv.' + (s.altar.level || 0), s.altar.maxed ? '已满级' : '') +
        stat('待领钻石', (s.altar.accrued || 0) + ' 颗', s.altar.accrued > 0 ? '可领取' : '未积攒满') +
        stat('钻石数量', (s.altar.dia || 0) + ' 颗', s.altar.enough ? '够强化' : '不够强化') +
        stat('强化状态', blockLabel(s.altar.block), '');
    }

    var gacha = $('#daily-gacha-stats');
    if (gacha) gacha.innerHTML = stat('轮盘币', (s.coins || 0) + ' 个', s.coins > 0 ? '可以抽奖' : '暂无');

    var relic = $('#daily-relic-stats');
    if (relic) {
      var b = s.relic.best;
      relic.innerHTML =
        stat('已拥有', (s.relic.owned || 0) + ' 件', (s.relic.maxed || 0) + ' 件满级') +
        stat('可强化', (s.relic.ready || 0) + ' 件', s.relic.ready > 0 ? '材料已够' : '材料不足') +
        (b ? stat('下一件', 'Lv.' + b.level + '→' + (b.level + 1), (b.needName || '材料') + ' ' + b.have + '/' + b.need) : '');
    }

    var mail = $('#daily-mail-stats');
    if (mail) {
      mail.innerHTML = stat('可领邮件', (s.mail.pending < 0 ? '—' : (s.mail.pending || 0) + ' 封'),
        s.mail.pending > 0 ? '待领取' : '邮箱空');
    }

    var shop = $('#daily-shop-stats');
    if (shop) {
      shop.innerHTML = stat('每日免费', s.shop.daily > 0 ? '可领取' : (s.shop.daily < 0 ? '—' : '已领完'), '');
    }

    var head = $('#daily-header-summary');
    if (head) {
      head.textContent = '祭坛 Lv.' + (s.altar.level || 0) + ' · 钻石 ' + (s.altar.dia || 0) +
        ' · 遗物 ' + (s.relic.ready || 0) + '/' + (s.relic.owned || 0) + ' 可强化' +
        ' · 邮件 ' + (s.mail.pending < 0 ? '—' : s.mail.pending) +
        ' · 轮盘币 ' + (s.coins || 0);
    }
    var upd = $('#daily-last-updated');
    if (upd) upd.textContent = '更新于 ' + new Date().toLocaleTimeString();
  }

  /* ---------------- 祭坛 / 抽奖（走页面桥） ---------------- */
  function runBridge(op, times, opts) {
    opts = opts || {};
    var b = bridge();
    if (!b) { if (!opts.silent) showError('没有找到本地运行时桥，请先在页面顶部点「连接」。'); return Promise.resolve(null); }
    if (b.getState().status !== 'connected') { if (!opts.silent) showError('游戏运行时未连接，请先在页面顶部点「连接」。'); return Promise.resolve(null); }
    if (busy) { if (!opts.silent) log('上一次操作还没结束，稍后再试', 'warn'); return Promise.resolve(null); }
    busy = true;
    return b.executeWrite('daily-ops', { op: op, times: times || 1 }).then(function (res) {
      busy = false;
      showError('');
      var r = (res && res.runtimeResult) || {};
      reportAltar(op, r, opts);
      refresh();
      return r;
    }).catch(function (err) {
      busy = false;
      var msg = (err && err.message) || String(err);
      log((op === 'takeDia' ? '领取钻石' : op === 'enchant' ? '祭坛强化' : '轮盘抽奖') + '失败：' + msg, 'error');
      if (!opts.silent) showError(msg);
      return null;
    });
  }

  function reportAltar(op, r, opts) {
    var notes = r.notes || [];
    if (op === 'takeDia') {
      if (r.taken > 0) log('领取钻石 ' + r.taken + ' 颗', 'ok');
      else if (!opts.silent) log(notes[0] || '暂时没有可领取的钻石');
      return;
    }
    if (op === 'enchant') {
      if (r.upgraded > 0) log('祭坛强化 ' + r.upgraded + ' 次 → Lv.' + ((r.after && r.after.level) || '?'), 'ok');
      else if (!opts.silent) log(notes[0] || '这次没有强化');
      return;
    }
    if (op === 'gacha') {
      if (r.opened > 0) log('抽奖 ' + r.opened + ' 次：' + (rewardText(r.rewards) || '（未返回奖励明细）'), 'ok');
      else if (!opts.silent) log(notes[0] || '轮盘币不足，暂时不能抽奖');
    }
  }

  function rewardText(rewards) {
    if (!rewards || rewards.length === 0) return '';
    var parts = [];
    for (var i = 0; i < rewards.length; i += 1) {
      var r = rewards[i];
      parts.push((r.name || ('道具 ' + r.tid)) + ' ×' + (r.cnt || 1));
    }
    return parts.join('、');
  }

  /* ---------------- 遗物 / 邮件 / 商店（走自建 WS） ---------------- */
  function runGameAction(kind, opts) {
    opts = opts || {};
    if (!gameReady()) {
      if (!opts.silent) showError('游戏运行时未连接，请先在页面顶部点「连接」。');
      return Promise.resolve(null);
    }
    if (busy) { if (!opts.silent) log('上一次操作还没结束，稍后再试', 'warn'); return Promise.resolve(null); }
    busy = true;

    var expr = kind === 'relic' ? relicExpr(opts.times || 30).replace('TIMES', String(opts.times || 30))
      : kind === 'mail' ? mailExpr()
        : shopExpr();
    var label = kind === 'relic' ? '遗物强化' : kind === 'mail' ? '领取邮件' : '每日商店';

    return runGame(expr, 60000).then(function (raw) {
      busy = false;
      showError('');
      var r = null;
      try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { r = null; }
      if (!r) { log(label + '返回异常：' + String(raw).slice(0, 100), 'error'); return null; }
      var notes = r.notes || [];
      if (kind === 'relic') {
        if (r.upgraded > 0) {
          var lv = r.done && r.done.length ? r.done[r.done.length - 1].level : '?';
          log('遗物强化 ' + r.upgraded + ' 次（最新 Lv.' + lv + '）', 'ok');
        } else if (!opts.silent) log(notes[0] || '没有可强化的遗物');
      } else if (kind === 'mail') {
        if (r.taken > 0) log('领取邮件 ' + r.taken + ' 封', 'ok');
        else if (!opts.silent) log(notes[0] || '没有可领取的邮件');
      } else {
        if (r.taken > 0) log('领取每日商品 ' + r.taken + ' 个', 'ok');
        else if (!opts.silent) log(notes[0] || '今天的每日商品已经领完了');
      }
      refresh();
      return r;
    }).catch(function (err) {
      busy = false;
      var msg = (err && err.message) || String(err);
      log(label + '失败：' + msg, 'error');
      if (!opts.silent) showError(msg);
      return null;
    });
  }

  /* ---------------- 刷新状态 ---------------- */
  function refresh() {
    if (!gameReady()) {
      var altar = $('#daily-altar-stats');
      if (altar) altar.innerHTML = '<div class="daily-stat"><b>—</b><span>未连接游戏运行时</span></div>';
      return Promise.resolve(null);
    }
    if (busy) return Promise.resolve(null);
    return runGame(STATE_EXPR, 15000).then(function (raw) {
      var s = null;
      try { s = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { s = null; }
      if (s && s.ok) { renderAll(s); showError(''); }
      return s;
    }).catch(function (err) {
      showError((err && err.message) || String(err));
      return null;
    });
  }

  /* ---------------- 自动任务 ---------------- */
  function autoRun(name) {
    if (name === 'takeDia') return runBridge('takeDia', 5, { silent: true });
    if (name === 'enchant') return runBridge('enchant', 1, { silent: true });
    if (name === 'gacha') return runBridge('gacha', 5, { silent: true });
    if (name === 'relic') return runGameAction('relic', { silent: true, times: 50 });
    if (name === 'mail') return runGameAction('mail', { silent: true });
    if (name === 'shop') return runGameAction('shop', { silent: true });
    return null;
  }

  function startAuto(name) {
    if (timers[name]) return;
    if (!settings[AUTO[name].key]) return;
    timers[name] = setInterval(function () {
      if (busy) return;
      if (!gameReady()) return;
      var section = document.getElementById('dailySection');
      autoRun(name);
      if (section && section.style.display === 'none') {
        // 不在这个标签页时也照常跑，只是不刷新界面
      }
    }, AUTO[name].every);
  }

  function stopAuto(name) {
    if (timers[name]) { clearInterval(timers[name]); delete timers[name]; }
  }

  function syncAuto(name, immediate) {
    if (settings[AUTO[name].key]) {
      startAuto(name);
      log('已开启自动' + AUTO[name].label + '（每 ' + Math.round(AUTO[name].every / 60000) + ' 分钟检查）');
      if (immediate) autoRun(name);
    } else {
      stopAuto(name);
    }
  }

  function syncAllAuto() {
    for (var name in AUTO) syncAuto(name, false);
  }

  /* ---------------- 接线 ---------------- */
  function bindSwitch(id, name) {
    var el = document.getElementById(id);
    if (!el) return;
    el.checked = !!settings[AUTO[name].key];
    el.addEventListener('change', function () {
      settings[AUTO[name].key] = !!el.checked;
      saveSettings();
      if (el.checked && !gameReady()) {
        el.checked = false;
        settings[AUTO[name].key] = false;
        saveSettings();
        showError('未连接游戏运行时，无法开启自动任务。');
        return;
      }
      syncAuto(name, true);
    });
  }

  function clickButton(id, handler) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', handler);
  }

  /* 模块自动化（换装 / 训练）的开关交给 js/wog-auto.js 管 */
  function bindModuleSwitch(id, key) {
    var el = document.getElementById(id);
    if (!el) return;
    var auto = window.__wogAuto;
    if (auto && typeof auto.get === 'function') el.checked = !!auto.get()[key];
    el.addEventListener('change', function () {
      if (window.__wogAuto && typeof window.__wogAuto.set === 'function') {
        window.__wogAuto.set(key, !!el.checked);
      }
    });
  }

  /* 断线重连提示：桥接本身会在断开后每 3 秒自动重试（默认不限次数），
     但界面上看不出来，这里轮询连接状态，变化时写进运行日志。
     注意：window.WOG_COMPANION_RUNTIME_BRIDGE 只有 getState/connect/pollNow，
     没有 onStatus，只能轮询。 */
  var connState = null;
  var connEverOk = false;
  function watchConnection() {
    var bridge = window.WOG_COMPANION_RUNTIME_BRIDGE;
    if (!bridge || typeof bridge.getState !== 'function') {
      setTimeout(watchConnection, 1000);
      return;
    }
    var st = null;
    try { st = bridge.getState(); } catch (e) { st = null; }
    var s = st ? st.status : null;
    if (s && s !== connState) {
      var prev = connState;
      connState = s;
      if (s === 'connected') {
        if (connEverOk) log('游戏已重新连接，自动化继续', 'ok');
        connEverOk = true;
      } else if (s === 'error') {
        log('自动重连失败：' + ((st && st.error) || '未知原因') + '。点页面顶部「尝试重新连接」', 'error');
      } else if (prev === 'connected') {
        log('游戏连接断开，正在自动重连…', 'info');
      }
    }
    setTimeout(watchConnection, 1000);
  }

  function init() {
    if (!$('#dailySection')) return;
    loadSettings();
    renderLog();

    bindSwitch('daily-auto-takeDia', 'takeDia');
    bindSwitch('daily-auto-enchant', 'enchant');
    bindSwitch('daily-auto-gacha', 'gacha');
    bindSwitch('daily-auto-relic', 'relic');
    bindSwitch('daily-auto-mail', 'mail');
    bindSwitch('daily-auto-shop', 'shop');
    bindModuleSwitch('daily-auto-equip', 'equip');
    bindModuleSwitch('daily-auto-training', 'training');

    clickButton('daily-take-dia', function () { runBridge('takeDia', 5); });
    clickButton('daily-enchant-once', function () { runBridge('enchant', 1); });
    clickButton('daily-gacha-once', function () { runBridge('gacha', 1); });
    clickButton('daily-gacha-all', function () { runBridge('gacha', 20); });
    clickButton('daily-relic-once', function () { runGameAction('relic', { times: 1 }); });
    clickButton('daily-relic-all', function () { runGameAction('relic', { times: 50 }); });
    clickButton('daily-mail-take', function () { runGameAction('mail', {}); });
    clickButton('daily-shop-take', function () { runGameAction('shop', {}); });
    clickButton('daily-equip-now', function () {
      if (window.__wogAuto && typeof window.__wogAuto.equipNow === 'function') window.__wogAuto.equipNow();
    });
    clickButton('daily-training-once', function () {
      if (window.__wogAuto && typeof window.__wogAuto.trainingNow === 'function') window.__wogAuto.trainingNow();
    });

    syncAllAuto();

    setInterval(function () {
      var section = document.getElementById('dailySection');
      if (!section || section.style.display === 'none') return;
      if (typeof document !== 'undefined' && document.hidden) return;
      refresh();
    }, 30000);

    window.__wogDailyRefresh = refresh;
    window.__wogDailyLog = log;
    watchConnection();
    if ($('#dailySection').style.display !== 'none') refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
