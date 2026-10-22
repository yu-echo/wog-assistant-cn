/* 数据库（本地图鉴）
 *
 * 数据来自 js/wog-db-data.js（游戏内核导出的快照），不联网、不跳外站。
 * 名字取游戏 locale 的 CN，缺中文退 TW 再退 EN，导出时已统一转简体。
 *
 * 快照字段（数组按下标取值）：
 *   heroes [id, 中文名, 英文名, 品阶, 职业, 战斗类型, 开放等级, 图标,
 *           攻击, 防御, 生命, 攻速, 攻击距离, 移速, 命中, 闪避, 暴击率, 暴击伤害, 技能id串]
 *   equips [id, 中文名, 英文名, 品阶, 装备类型, 部位, 职业, 需求等级, 图标,
 *           能力类型[], 能力数值[], 技能id[], 镶嵌组id[]]
 *   items  [id, 中文名, 英文名, 品阶, 物品类型, 显示类型, 需求等级, 堆叠, 图标, 说明]
 *   pets   [id, 中文名, 英文名, 品阶, 伙伴类型, 部位, 职业, 需求等级, 图标,
 *           能力类型[], 能力数值[], 技能id[]]
 *   stages [id, 中文名, 英文名, 关卡序号, 清关金币, Boss金币, 清关经验, Boss经验]
 *   abilities { "1001": {zh:"攻击力 +{0}", en:"...", per:0}, ... }
 *   技能取自页面里已有的 skillTrees（105 条）
 */
(function () {
  'use strict';

  var PAGE_SIZE = 60;

  var CLASS = { 1: '狂战士', 2: '游侠', 3: '元素师', 4: '混合', 5: '通用' };
  var SLOT = {
    1: '主武器', 2: '副武器', 3: '头盔', 4: '铠甲', 5: '手套',
    6: '靴子', 7: '护肩', 8: '披风', 9: '戒指', 10: '耳环',
    11: '项链', 12: '手镯', 13: '腰带', 14: '饰品',
    15: '翅膀', 16: '符文', 17: '伙伴'
  };
  var EQUIP_TYPE = { 1: '装备', 2: '饰品' };
  var COMBAT_TYPE = { 1: '近战', 2: '远程', 3: '魔法', 4: '混合' };

  var state = { tab: 'hero', q: '', facet: '', page: 0 };
  var DATA = null;
  var views = {};

  function d() {
    if (!DATA) DATA = window.WOG_DB_DATA || { heroes: [], equips: [], items: [], pets: [], stages: [], abilities: {} };
    return DATA;
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function abilityText(t, v) {
    var ab = d().abilities[String(t)];
    if (!ab) return '能力 #' + t + ' +' + v;
    var val = String(v) + (num(ab.per) ? '%' : '');
    return String(ab.zh || ab.en || ('能力 #' + t)).replace('{0}', val);
  }

  function abilityList(types, values) {
    var out = [];
    for (var i = 0; i < types.length; i += 1) {
      if (!num(types[i])) continue;
      out.push(abilityText(num(types[i]), values[i]));
    }
    return out.join('、');
  }

  /* ---------------- 各表的行构造 ---------------- */
  function heroRows() {
    return d().heroes.map(function (r) {
      var cls = CLASS[num(r[4])] || ('职业' + r[4]);
      return {
        id: r[0],
        name: r[1] || r[2],
        en: r[2],
        facet: cls,
        cols: [esc(r[1] || r[2]), '品阶 ' + r[3], cls, COMBAT_TYPE[num(r[5])] || r[5], 'Lv.' + r[6],
          num(r[8]), num(r[9]), num(r[10]), num(r[11])],
        facet2: cls,
        detail: [
          ['名称', r[1] || r[2]], ['英文名', r[2]], ['角色ID', r[0]], ['品阶', r[3]],
          ['职业', cls], ['战斗类型', COMBAT_TYPE[num(r[5])] || r[5]], ['开放等级', r[6]],
          ['基础攻击', num(r[8])], ['基础防御', num(r[9])], ['基础生命', num(r[10])],
          ['攻击速度', num(r[11])], ['攻击距离', num(r[12])], ['移动速度', num(r[13])],
          ['命中', num(r[14])], ['闪避', num(r[15])], ['暴击率', num(r[16]) + '%'],
          ['暴击伤害', num(r[17]) + '%'], ['技能数量', String(r[18] || '').split(',').filter(function (x) { return x; }).length]
        ]
      };
    });
  }

  function equipRows() {
    return d().equips.map(function (r) {
      var slot = SLOT[num(r[5])] || ('部位' + r[5]);
      var cls = CLASS[num(r[6])] || ('职业' + r[6]);
      var ab = abilityList(r[9] || [], r[10] || []);
      return {
        id: r[0],
        name: r[1] || r[2],
        en: r[2],
        facet: slot,
        cols: [esc(r[1] || r[2]), '品阶 ' + r[3], slot, cls, 'Lv.' + r[7], esc(ab)],
        detail: [
          ['名称', r[1] || r[2]], ['英文名', r[2]], ['装备ID', r[0]], ['品阶', r[3]],
          ['类型', EQUIP_TYPE[num(r[4])] || r[4]], ['部位', slot], ['职业', cls],
          ['需求等级', r[7]], ['能力', ab || '—'],
          ['镶嵌组', (r[12] || []).filter(function (x) { return num(x); }).join('、') || '—'],
          ['绑定技能', (r[11] || []).filter(function (x) { return num(x); }).join('、') || '—']
        ]
      };
    });
  }

  function itemRows() {
    return d().items.map(function (r) {
      return {
        id: r[0],
        name: r[1] || r[2],
        en: r[2],
        facet: '品阶 ' + r[3],
        cols: [esc(r[1] || r[2]), '品阶 ' + r[3], '类型 ' + r[4], '堆叠 ' + r[7], 'Lv.' + r[6]],
        detail: [
          ['名称', r[1] || r[2]], ['英文名', r[2]], ['物品ID', r[0]], ['品阶', r[3]],
          ['物品类型', r[4]], ['显示类型', r[5]], ['需求等级', r[6]], ['堆叠类型', r[7]],
          ['说明', r[9] || '—']
        ]
      };
    });
  }

  function petRows() {
    return d().pets.map(function (r) {
      var slot = SLOT[num(r[5])] || ('部位' + r[5]);
      var cls = CLASS[num(r[6])] || ('职业' + r[6]);
      var ab = abilityList(r[9] || [], r[10] || []);
      return {
        id: r[0],
        name: r[1] || r[2],
        en: r[2],
        facet: slot,
        cols: [esc(r[1] || r[2]), '品阶 ' + r[3], slot, cls, 'Lv.' + r[7], esc(ab)],
        detail: [
          ['名称', r[1] || r[2]], ['英文名', r[2]], ['伙伴ID', r[0]], ['品阶', r[3]],
          ['类型', slot], ['职业', cls], ['需求等级', r[7]], ['能力', ab || '—'],
          ['绑定技能', (r[11] || []).filter(function (x) { return num(x); }).join('、') || '—']
        ]
      };
    });
  }

  function stageRows() {
    return d().stages.map(function (r) {
      return {
        id: r[0],
        name: r[1] || r[2],
        en: r[2],
        facet: r[1] || r[2],
        cols: [esc(r[1] || r[2]), '第 ' + r[3] + ' 关', num(r[4]), num(r[5]),
          num(r[6]), num(r[7]), num(r[4]) + num(r[5]), num(r[6]) + num(r[7])],
        detail: [
          ['名称', r[1] || r[2]], ['英文名', r[2]], ['关卡ID', r[0]], ['关卡序号', r[3]],
          ['清关金币', num(r[4])], ['Boss 金币', num(r[5])],
          ['清关经验', num(r[6])], ['Boss 经验', num(r[7])],
          ['合计金币', num(r[4]) + num(r[5])], ['合计经验', num(r[6]) + num(r[7])]
        ]
      };
    });
  }

  function skillRows() {
    var trees = (typeof skillTrees !== 'undefined' && skillTrees) ? skillTrees : (window.skillTrees || null);
    if (!trees) return [];
    var rows = [];
    Object.keys(trees).forEach(function (key) {
      var cls = trees[key];
      var cname = cls.class_name || key;
      (cls.branches || []).forEach(function (br) {
        (br.skills || []).forEach(function (sk) {
          var lv1 = (sk.levels && sk.levels[0]) || {};
          rows.push({
            id: sk.id,
            name: sk.name_zh || sk.name_vi || sk.name_en,
            en: sk.name_en,
            facet: cname,
            cols: [esc(sk.name_zh || sk.name_vi || sk.name_en), cname, esc(br.branch_title || ''),
              sk.is_passive ? '被动' : '主动', 'Lv.' + (sk.req_player_level || 1),
              lv1.cooldown_sec ? lv1.cooldown_sec + 's' : '—',
              lv1.damage_percent ? lv1.damage_percent + '%' : '—'],
            detail: [
              ['名称', sk.name_zh || sk.name_vi || sk.name_en], ['英文名', sk.name_en],
              ['技能ID', sk.id], ['组ID', sk.group_id], ['职业', cname],
              ['分支', br.branch_title || '—'], ['类型', sk.is_passive ? '被动技能' : '主动技能'],
              ['需求等级', sk.req_player_level || 1],
              ['前置技能', sk.pre_req ? String(sk.pre_req) : '—'],
              ['1级效果', lv1.description || (lv1.damage_percent ? '造成 ' + lv1.damage_percent + '% 伤害' : '—')],
              ['冷却', lv1.cooldown_sec ? lv1.cooldown_sec + ' 秒' : '—'],
              ['等级数', (sk.levels || []).length]
            ]
          });
        });
      });
    });
    return rows;
  }

  /* ---------------- 子页定义 ---------------- */
  var TABS = [
    {
      key: 'hero', name: '角色', icon: '👥',
      cols: ['名称', '品阶', '职业', '战斗类型', '等级', '攻击', '防御', '生命', '攻速'],
      rows: heroRows, facetLabel: '职业'
    },
    {
      key: 'equip', name: '装备', icon: '🛡️',
      cols: ['名称', '品阶', '部位', '职业', '等级', '能力'],
      rows: equipRows, facetLabel: '部位'
    },
    {
      key: 'item', name: '物品', icon: '🎒',
      cols: ['名称', '品阶', '类型', '堆叠', '等级'],
      rows: itemRows, facetLabel: '品阶'
    },
    {
      key: 'skill', name: '技能', icon: '✨',
      cols: ['名称', '职业', '分支', '类型', '需求等级', '冷却', '伤害'],
      rows: skillRows, facetLabel: '职业'
    },
    {
      key: 'stage', name: '关卡', icon: '🗺️',
      cols: ['名称', '关序号', '清关金币', 'Boss金币', '清关经验', 'Boss经验', '金币合计', '经验合计'],
      rows: stageRows, facetLabel: '区域'
    },
    {
      key: 'pet', name: '伙伴', icon: '🐾',
      cols: ['名称', '品阶', '类型', '职业', '等级', '能力'],
      rows: petRows, facetLabel: '类型'
    }
  ];

  function tabDef(key) {
    for (var i = 0; i < TABS.length; i += 1) if (TABS[i].key === key) return TABS[i];
    return TABS[0];
  }

  function rowsOf(key) {
    if (!views[key]) views[key] = tabDef(key).rows();
    return views[key];
  }

  /* ---------------- 渲染 ---------------- */
  function filtered() {
    var rows = rowsOf(state.tab);
    var q = state.q.trim().toLowerCase();
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      if (state.facet && r.facet !== state.facet) continue;
      if (q) {
        var hay = (String(r.name || '') + ' ' + String(r.en || '') + ' ' + r.id).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(r);
    }
    return out;
  }

  function renderFacets() {
    var sel = document.getElementById('codexFacet');
    if (!sel) return;
    var rows = rowsOf(state.tab);
    var seen = {};
    var list = [];
    for (var i = 0; i < rows.length; i += 1) {
      var f = rows[i].facet;
      if (!f || seen[f]) continue;
      seen[f] = 1;
      list.push(f);
    }
    list.sort();
    var html = '<option value="">全部' + tabDef(state.tab).facetLabel + '</option>';
    for (var j = 0; j < list.length; j += 1) {
      html += '<option value="' + esc(list[j]) + '">' + esc(list[j]) + '</option>';
    }
    sel.innerHTML = html;
    if (state.facet && !seen[state.facet]) state.facet = '';
    sel.value = state.facet;
  }

  function renderTabs() {
    var box = document.getElementById('codexTabs');
    if (!box) return;
    var html = '';
    for (var i = 0; i < TABS.length; i += 1) {
      var t = TABS[i];
      var n = rowsOf(t.key).length;
      html += '<button type="button" class="codex-tab' + (t.key === state.tab ? ' active' : '') +
        '" data-codex-tab="' + t.key + '">' + t.icon + ' ' + t.name +
        '<span class="codex-tab-count">' + n + '</span></button>';
    }
    box.innerHTML = html;
  }

  function renderList() {
    var box = document.getElementById('codexList');
    var pager = document.getElementById('codexPager');
    var count = document.getElementById('codexCount');
    if (!box) return;

    var rows = filtered();
    var def = tabDef(state.tab);
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.page >= pages) state.page = pages - 1;
    var start = state.page * PAGE_SIZE;
    var slice = rows.slice(start, start + PAGE_SIZE);

    if (count) count.textContent = '共 ' + rows.length + ' 条' + (rows.length !== rowsOf(state.tab).length ? '（已筛选）' : '');

    var html = '<table class="codex-table"><thead><tr>';
    for (var c = 0; c < def.cols.length; c += 1) html += '<th>' + esc(def.cols[c]) + '</th>';
    html += '</tr></thead><tbody>';

    if (!slice.length) {
      html += '<tr><td colspan="' + def.cols.length + '" class="codex-empty">没有匹配的条目，换个关键词试试</td></tr>';
    }
    for (var i = 0; i < slice.length; i += 1) {
      var r = slice[i];
      html += '<tr class="codex-row" data-codex-id="' + esc(r.id) + '">';
      for (var j = 0; j < def.cols.length; j += 1) {
        var v = r.cols[j];
        html += '<td' + (j === 0 ? ' class="codex-name"' : '') + '>' + (v === undefined || v === '' ? '—' : v) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    box.innerHTML = html;

    if (pager) {
      var ph = '<button type="button" class="small-btn" data-codex-page="prev"' + (state.page === 0 ? ' disabled' : '') + '>‹ 上一页</button>';
      ph += '<span class="codex-page-info">第 ' + (state.page + 1) + ' / ' + pages + ' 页</span>';
      ph += '<button type="button" class="small-btn" data-codex-page="next"' + (state.page >= pages - 1 ? ' disabled' : '') + '>下一页 ›</button>';
      pager.innerHTML = ph;
    }
  }

  function renderDetail(row) {
    var box = document.getElementById('codexDetail');
    if (!box) return;
    if (!row) { box.className = 'codex-detail hidden'; box.innerHTML = ''; return; }
    var html = '<div class="codex-detail-head"><b>' + esc(row.name) + '</b>' +
      '<button type="button" class="codex-detail-close" data-codex-close="1" aria-label="关闭">×</button></div><dl>';
    for (var i = 0; i < row.detail.length; i += 1) {
      html += '<dt>' + esc(row.detail[i][0]) + '</dt><dd>' + esc(row.detail[i][1]) + '</dd>';
    }
    html += '</dl>';
    box.className = 'codex-detail';
    box.innerHTML = html;
  }

  function render() {
    renderTabs();
    renderFacets();
    renderList();
  }

  function show(tab) {
    if (tab && tabDef(tab).key === tab) {
      if (state.tab !== tab) { state.tab = tab; state.facet = ''; state.page = 0; }
    }
    state.page = 0;
    // 换页时清掉上一页的关键词，免得看着像「没有数据」
    state.q = '';
    var se = document.getElementById('codexSearch');
    if (se) se.value = '';
    render();
    renderDetail(null);
  }

  /* ---------------- 事件 ---------------- */
  function focusSearch() {
    var el = document.getElementById('codexSearch');
    if (el) { el.focus(); el.select(); }
  }

  function bind() {
    var tabs = document.getElementById('codexTabs');
    if (tabs) {
      tabs.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('[data-codex-tab]') : null;
        if (!btn) return;
        show(btn.getAttribute('data-codex-tab'));
      });
    }

    var search = document.getElementById('codexSearch');
    if (search) {
      search.addEventListener('input', function () {
        state.q = search.value || '';
        state.page = 0;
        renderList();
      });
    }

    var facet = document.getElementById('codexFacet');
    if (facet) {
      facet.addEventListener('change', function () {
        state.facet = facet.value || '';
        state.page = 0;
        renderList();
      });
    }

    var list = document.getElementById('codexList');
    if (list) {
      list.addEventListener('click', function (ev) {
        var tr = ev.target.closest ? ev.target.closest('[data-codex-id]') : null;
        if (!tr) return;
        var id = tr.getAttribute('data-codex-id');
        var rows = filtered();
        for (var i = 0; i < rows.length; i += 1) {
          if (String(rows[i].id) === String(id)) { renderDetail(rows[i]); break; }
        }
      });
    }

    var pager = document.getElementById('codexPager');
    if (pager) {
      pager.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('[data-codex-page]') : null;
        if (!btn) return;
        if (btn.getAttribute('data-codex-page') === 'prev' && state.page > 0) state.page -= 1;
        else if (btn.getAttribute('data-codex-page') === 'next') state.page += 1;
        renderList();
      });
    }

    var detail = document.getElementById('codexDetail');
    if (detail) {
      detail.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('[data-codex-close]')) renderDetail(null);
      });
    }

    /* 侧边栏：数据库 6 项 + 搜索 + Builds 全部改成页内跳转 */
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      var jump = t && t.closest ? t.closest('[data-codex-jump]') : null;
      if (jump) {
        ev.preventDefault();
        var k = jump.getAttribute('data-codex-jump');
        if (k === '__search') {
          window.__wogDb.show('hero');
          setTimeout(focusSearch, 60);
        } else {
          window.__wogDb.show(k);
        }
        return;
      }
      var main = t && t.closest ? t.closest('[data-jump-main]') : null;
      if (main) {
        ev.preventDefault();
        var tb = main.getAttribute('data-jump-main');
        if (typeof switchMainTab === 'function') switchMainTab(tb);
        return;
      }
      var db = t && t.closest ? t.closest('[data-jump-db]') : null;
      if (db) {
        ev.preventDefault();
        window.__wogDb.show(db.getAttribute('data-jump-db'));
      }
    });
  }

  function init() {
    if (!document.getElementById('codexSection')) return;
    bind();
    render();
  }

  /* 供侧边栏 / 外部调用 */
  window.__wogDb = {
    show: function (tab) {
      if (typeof switchMainTab === 'function') switchMainTab('codex');
      show(tab);
    },
    focusSearch: function () {
      var el = document.getElementById('codexSearch');
      if (el) { el.focus(); el.select(); }
    },
    stats: function () {
      return {
        hero: rowsOf('hero').length, equip: rowsOf('equip').length,
        item: rowsOf('item').length, skill: rowsOf('skill').length,
        stage: rowsOf('stage').length, pet: rowsOf('pet').length
      };
    },
    render: render
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
