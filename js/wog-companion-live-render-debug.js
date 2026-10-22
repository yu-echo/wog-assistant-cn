(function () {
  "use strict";

  // This is a development-only measurement adapter. It is deliberately kept
  // outside the legacy bundle so the Companion calculations, poll cadence and
  // runtime boundary remain untouched. Nothing in this file opens a socket or
  // dispatches a game command.
  var enabled = false;
  try {
    enabled = new URLSearchParams(window.location.search).get("wogLiveRenderDebug") === "1";
  } catch (error) {
    enabled = false;
  }
  if (!enabled || !window.MutationObserver || !window.performance) return;

  var root = document.querySelector(".wog-companion-app");
  if (!root) return;
  if (window.__WOG_LIVE_RENDER_AUDIT__) return;

  var startedAt = performance.now();
  var polls = [];
  var rendererCalls = [];
  var currentPoll = null;
  var currentCall = null;
  var callStack = [];
  var pollSequence = 0;
  var callSequence = 0;
  var lastRendererSignatures = Object.create(null);
  var orphanRendererCalls = 0;
  var orphanMutationRecords = 0;
  var patched = [];
  var longTasks = [];
  var longTaskObserver = null;

  var rendererConfig = {
    applyUserData: { module: "profile", section: "profileSection", dependency: "profile" },
    updateStageHistoryFromGame: { module: "history", section: "stageHistorySection", dependency: "history" },
    renderProfileGear: { module: "profile", section: "profileSection", dependency: "profileGear" },
    renderLiveBagAndStorage: { module: "equipment", section: "equipSection", dependency: "equipment" },
    renderEquip: { module: "equipment", section: "equipSection", dependency: "equipment" },
    renderProfileTraining: { module: "profile", section: "profileSection", dependency: "training" },
    renderTraining: { module: "training", section: "trainingSection", dependency: "training" },
    renderTrainingAdvisor: { module: "training", section: "trainingSection", dependency: "training" },
    renderCombatBreakdown: { module: "damage", section: "dpsSection", dependency: "damage" },
    renderStageTable: { module: "farming", section: "stageSection", dependency: "farming" },
    renderStageHighlights: { module: "farming", section: "stageSection", dependency: "farming" },
    renderStageHistoryTable: { module: "history", section: "stageHistorySection", dependency: "history" },
    updateSlotCountSelectorUI: { module: "skill-tree", section: "treeSection", dependency: "skillTree" },
    updateClassButtonsLiveBadge: { module: "skill-tree", section: "treeSection", dependency: "skillTree" },
    updateTreeHeader: { module: "skill-tree", section: "treeSection", dependency: "skillTree" },
    updateInspector: { module: "skill-tree", section: "treeSection", dependency: "skillTree" },
    renderTree: { module: "skill-tree", section: "treeSection", dependency: "skillTree" },
    renderJewelSection: { module: "jewels", section: "jewelSection", dependency: "jewels" },
    renderJewelTable: { module: "jewels", section: "jewelSection", dependency: "jewels" },
  };

  var dependencyNames = Object.keys(rendererConfig).reduce(function (result, name) {
    result[rendererConfig[name].dependency] = true;
    return result;
  }, {});

  function now() {
    return performance.now();
  }

  function own(value, key) {
    return value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
  }

  function arrayDigest(value, depth) {
    if (!Array.isArray(value)) return "-";
    var sample = value.length <= 120 ? value : value.slice(0, 60).concat(value.slice(-60));
    return "a" + value.length + ":" + sample.map(function (item) { return digest(item, depth - 1); }).join("|");
  }

  function digest(value, depth) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return String(value);
    if (depth <= 0) return Array.isArray(value) ? "array:" + value.length : "object";
    if (Array.isArray(value)) return arrayDigest(value, depth);
    var keys = Object.keys(value).sort();
    return "o:" + keys.map(function (key) { return key + "=" + digest(value[key], depth - 1); }).join(";");
  }

  function getProfile() {
    return window.userProfile || {};
  }

  function localJson(key) {
    try { return JSON.parse(window.localStorage.getItem(key) || "null"); } catch (error) { return null; }
  }

  function dependencySignature(name) {
    var profile = getProfile();
    var liveJewel = window.liveJewelData || window.__liveJewelData__ || {};
    if (name === "profile") return digest({ nickname: profile.nickname, level: profile.level, combatPower: profile.combatPower, stageTid: profile.stageTid, clearStageTid: profile.clearStageTid, currencies: profile.currencies, expInfo: profile.expInfo, stats: profile.stats, combatStats: profile.combatStats, heroClass: profile.liveHeroClass, dps: window.__lastTotalDps }, 3);
    if (name === "profileGear") return digest({ equipped: profile.equippedGearEnriched, bag: profile.bagItems, storage: profile.storageItems }, 3);
    if (name === "equipment") return digest({ equipped: profile.equippedGearEnriched, bag: profile.bagItems, storage: profile.storageItems, filters: window.equipmentFilters || window.currentEquipFilters }, 3);
    if (name === "training") return digest({ training: profile.trainingSkills, currency: profile.currencies, levels: window.trainingSkills, budget: window.trainingBudget || window.trainingGoldBudget }, 2);
    if (name === "damage") return digest({ stats: profile.stats, combatStats: profile.combatStats, training: profile.trainingSkills, gear: profile.equippedGearEnriched, skills: profile.liveSkillLevels || window.liveSkillLevels, allocations: window.skillAllocations, mode: window.currentDamageMode || window.damageMode }, 2);
    if (name === "farming") return digest({ stage: profile.stageTid, clearStage: profile.clearStageTid, maxStage: profile.maxUnlockedStageTid, stats: profile.stats, combatStats: profile.combatStats, dps: window.__lastTotalDps }, 2);
    if (name === "history") return digest({ runs: profile.stageRunHistory, storedRuns: localJson("genesis_stage_run_history"), calibration: localJson("genesis_stage_calibration_registry") }, 3);
    if (name === "skillTree") return digest({ levels: profile.liveSkillLevels || window.liveSkillLevels, allocations: window.skillAllocations, points: profile.skillPointsStock, className: window.currentClass, classType: profile.liveHeroClass }, 2);
    if (name === "jewels") return digest({ data: liveJewel, includeStorage: window.isIncludeStorageJewelActive, allowedTiers: window.autoFuseAllowedTiers }, 3);
    return "unavailable";
  }

  function activeTab() {
    var tabRoot = document.querySelector("[data-wog-companion-root]") || root;
    return tabRoot.getAttribute("data-wog-companion-active-module") || window.currentTab || "unknown";
  }

  function isVisible(sectionId) {
    var node = document.getElementById(sectionId);
    if (!node) return null;
    return node.style.display !== "none" && !node.hidden;
  }

  function getI18nMetrics() {
    var metrics = window.__WOG_I18N_METRICS__;
    return metrics ? JSON.parse(JSON.stringify(metrics)) : null;
  }

  function writeTypeFor(method) {
    if (method === "setAttribute" || method === "removeAttribute") return "attribute";
    if (method === "appendChild" || method === "insertBefore" || method === "removeChild" || method === "replaceChildren" || method === "insertAdjacentHTML") return "structure";
    return method;
  }

  function recordDomWrite(method, target) {
    if (!currentPoll) return;
    var owner = currentCall ? currentCall.name : (callStack.length ? callStack[callStack.length - 1] : "applyLiveGameData");
    var row = currentPoll.writeByOwner[owner] || { count: 0, types: {} };
    row.count += 1;
    var type = writeTypeFor(method);
    row.types[type] = (row.types[type] || 0) + 1;
    currentPoll.writeByOwner[owner] = row;
    currentPoll.domWrites += 1;
    currentPoll.domWriteTypes[type] = (currentPoll.domWriteTypes[type] || 0) + 1;
    if (currentCall) {
      currentCall.domWrites += 1;
      currentCall.domWriteTypes[type] = (currentCall.domWriteTypes[type] || 0) + 1;
    }
    void target;
  }

  function patchMethod(proto, method) {
    if (!proto || typeof proto[method] !== "function") return;
    var original = proto[method];
    var wrapped = function () {
      recordDomWrite(method, this);
      return original.apply(this, arguments);
    };
    try {
      proto[method] = wrapped;
      patched.push(function () { proto[method] = original; });
    } catch (error) { /* a browser may expose a non-writable prototype */ }
  }

  function patchSetter(proto, property) {
    if (!proto) return;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(proto, property); } catch (error) { descriptor = null; }
    if (!descriptor || typeof descriptor.set !== "function") return;
    var originalSet = descriptor.set;
    var originalGet = descriptor.get;
    try {
      Object.defineProperty(proto, property, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: originalGet,
        set: function (value) {
          recordDomWrite(property, this);
          return originalSet.call(this, value);
        },
      });
      patched.push(function () { Object.defineProperty(proto, property, descriptor); });
    } catch (error) { /* instrumentation remains best-effort */ }
  }

  function observeMutations(records) {
    var poll = currentPoll;
    if (!poll) { orphanMutationRecords += records.length; return; }
    records.forEach(function (record) {
      poll.mutationCount += 1;
      if (record.type === "characterData") poll.textNodeUpdates += 1;
      if (record.type === "attributes") poll.attributeUpdates += 1;
      if (record.addedNodes) poll.nodesAdded += record.addedNodes.length;
      if (record.removedNodes) poll.nodesRemoved += record.removedNodes.length;
    });
  }

  var observer = new MutationObserver(observeMutations);
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });

  patchSetter(typeof Element !== "undefined" ? Element.prototype : null, "innerHTML");
  patchSetter(typeof Node !== "undefined" ? Node.prototype : null, "textContent");
  patchSetter(typeof HTMLElement !== "undefined" ? HTMLElement.prototype : null, "innerText");
  patchMethod(typeof Element !== "undefined" ? Element.prototype : null, "setAttribute");
  patchMethod(typeof Element !== "undefined" ? Element.prototype : null, "removeAttribute");
  patchMethod(typeof Node !== "undefined" ? Node.prototype : null, "appendChild");
  patchMethod(typeof Node !== "undefined" ? Node.prototype : null, "insertBefore");
  patchMethod(typeof Node !== "undefined" ? Node.prototype : null, "removeChild");
  patchMethod(typeof Node !== "undefined" ? Node.prototype : null, "replaceChildren");
  patchMethod(typeof Element !== "undefined" ? Element.prototype : null, "insertAdjacentHTML");

  if (window.PerformanceObserver && Array.isArray(window.PerformanceObserver.supportedEntryTypes) && window.PerformanceObserver.supportedEntryTypes.indexOf("longtask") !== -1) {
    try {
      longTaskObserver = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          var item = { startTime: entry.startTime, duration: entry.duration, name: entry.name || "self" };
          longTasks.push(item);
          if (currentPoll) currentPoll.longTaskCount += 1;
        });
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] });
    } catch (error) { longTaskObserver = null; }
  }

  function makePoll() {
    pollSequence += 1;
    var dependencies = {};
    Object.keys(dependencyNames).forEach(function (name) { dependencies[name] = { before: dependencySignature(name), after: null, changed: null }; });
    return {
      pollId: pollSequence,
      startedAt: now(),
      timestamp: new Date().toISOString(),
      activeTabBefore: activeTab(),
      applyDurationMs: null,
      applyDomWrites: 0,
      domWrites: 0,
      domWriteTypes: {},
      writeByOwner: {},
      mutationCount: 0,
      nodesAdded: 0,
      nodesRemoved: 0,
      textNodeUpdates: 0,
      attributeUpdates: 0,
      longTaskCount: 0,
      rendererCalls: [],
      dependencies: dependencies,
      translationBefore: getI18nMetrics(),
      translationAfter: null,
      finalized: false,
    };
  }

  function finalizePoll(poll) {
    if (!poll || poll.finalized) return;
    poll.finalized = true;
    Object.keys(poll.dependencies).forEach(function (name) {
      var dependency = poll.dependencies[name];
      dependency.after = dependencySignature(name);
      dependency.changed = dependency.before !== dependency.after;
    });
    poll.translationAfter = getI18nMetrics();
    poll.activeTabAfter = activeTab();
    poll.endedAt = now();
    poll.settleDurationMs = poll.endedAt - poll.startedAt;
    poll.rendererCalls.forEach(function (call) {
      var dependencyName = rendererConfig[call.name] && rendererConfig[call.name].dependency;
      var dependency = dependencyName && poll.dependencies[dependencyName];
      call.dataChanged = dependency ? dependency.changed : null;
      call.status = dependency ? (call.dataChanged ? "CHANGED_AND_RENDERED" : "UNCHANGED_BUT_RENDERED") : "NOT_APPLICABLE";
      call.visibleTab = rendererConfig[call.name] ? isVisible(rendererConfig[call.name].section) : null;
      call.hiddenRenderer = call.visibleTab === false;
    });
    poll.expectedRendererStatuses = {};
    Object.keys(rendererConfig).forEach(function (name) {
      var config = rendererConfig[name];
      var dependency = poll.dependencies[config.dependency];
      var called = poll.rendererCalls.some(function (call) { return call.name === name; });
      poll.expectedRendererStatuses[name] = !dependency ? "NOT_APPLICABLE" : called ? (dependency.changed ? "CHANGED_AND_RENDERED" : "UNCHANGED_BUT_RENDERED") : (dependency.changed ? "CHANGED_NOT_RENDERED" : "NOT_APPLICABLE");
    });
    delete poll.finalized;
    polls.push(poll);
    currentPoll = null;
    publish();
  }

  function scheduleFinalize(poll) {
    window.setTimeout(function () { if (currentPoll === poll) finalizePoll(poll); }, 140);
  }

  function instrumentRenderer(name, original) {
    return function () {
      var call = {
        callId: ++callSequence,
        name: name,
        module: rendererConfig[name] ? rendererConfig[name].module : "unclassified",
        startedAt: now(),
        durationMs: null,
        domWrites: 0,
        domWriteTypes: {},
        activeTab: activeTab(),
        visibleTab: rendererConfig[name] ? isVisible(rendererConfig[name].section) : null,
        dataChanged: null,
        status: "NOT_APPLICABLE",
      };
      if (currentPoll) currentPoll.rendererCalls.push(call); else orphanRendererCalls += 1;
      rendererCalls.push(call);
      callStack.push(name);
      currentCall = call;
      try {
        return original.apply(this, arguments);
      } finally {
        call.durationMs = now() - call.startedAt;
        callStack.pop();
        currentCall = null;
      }
    };
  }

  function installHooks() {
    if (!window.applyLiveGameData) {
      window.setTimeout(installHooks, 25);
      return;
    }
    Object.keys(rendererConfig).forEach(function (name) {
      var original = window[name];
      if (typeof original !== "function" || original.__wogLiveRenderWrapped) return;
      var wrapped = instrumentRenderer(name, original);
      wrapped.__wogLiveRenderWrapped = true;
      window[name] = wrapped;
    });
    var originalApply = window.applyLiveGameData;
    if (typeof originalApply === "function" && !originalApply.__wogLiveRenderWrapped) {
      var wrappedApply = function (data) {
        if (currentPoll) finalizePoll(currentPoll);
        var poll = makePoll();
        currentPoll = poll;
        var started = now();
        callStack.push("applyLiveGameData");
        try {
          return originalApply.apply(this, arguments);
        } finally {
          poll.applyDurationMs = now() - started;
          poll.applyDomWrites = poll.writeByOwner.applyLiveGameData ? poll.writeByOwner.applyLiveGameData.count : 0;
          callStack.pop();
          scheduleFinalize(poll);
        }
      };
      wrappedApply.__wogLiveRenderWrapped = true;
      window.applyLiveGameData = wrappedApply;
    }
    publish();
  }

  function diffMetric(before, after, key) {
    if (!before || !after || typeof before[key] !== "number" || typeof after[key] !== "number") return null;
    return after[key] - before[key];
  }

  function summarizeTranslation(poll) {
    var before = poll.translationBefore;
    var after = poll.translationAfter;
    if (!before || !after) return { status: "UNAVAILABLE" };
    return {
      status: "MEASURED",
      fullScanCount: after.fullScanCount,
      fullScanDelta: diffMetric(before, after, "fullScanCount"),
      incrementalBatchDelta: diffMetric(before, after, "incrementalBatchCount"),
      nodesVisitedDelta: diffMetric(before, after, "nodesVisited"),
      translateValueCallsDelta: diffMetric(before, after, "translateValueCalls"),
      totalTranslationMs: diffMetric(before, after, "totalTranslationMs"),
      lastIncrementalMs: after.lastIncrementalMs,
    };
  }

  function getLiveBagOptimizationMetrics() {
    var adapter = window.__WOG_LIVE_BAG_DIRTY_CHECK__;
    if (!adapter || typeof adapter.getMetrics !== "function") return null;
    try { return adapter.getMetrics(); } catch (error) { return { status: "UNAVAILABLE" }; }
  }

  function getStageTableOptimizationMetrics(byRenderer) {
    var adapter = window.__WOG_STAGE_TABLE_DIRTY_CHECK__;
    if (!adapter || typeof adapter.getMetrics !== "function") return null;
    try {
      var metrics = adapter.getMetrics();
      var renderer = byRenderer.renderStageTable;
      if (renderer) {
        // The existing renderer instrumentation is the authoritative count of
        // DOM setter calls made inside the original render function.
        metrics.stageTableDomWrites = renderer.totalDomWrites;
        metrics.stageTableDomWritesSource = "live-render-debug-renderer-attribution";
      }
      return metrics;
    } catch (error) { return { status: "UNAVAILABLE" }; }
  }

  function buildSummary() {
    var byRenderer = {};
    rendererCalls.forEach(function (call) {
      var item = byRenderer[call.name] || { name: call.name, module: call.module, calls: 0, totalDurationMs: 0, maxDurationMs: 0, totalDomWrites: 0, visibleCalls: 0, hiddenCalls: 0 };
      item.calls += 1;
      item.totalDurationMs += call.durationMs || 0;
      item.maxDurationMs = Math.max(item.maxDurationMs, call.durationMs || 0);
      item.totalDomWrites += call.domWrites || 0;
      if (call.visibleTab === true) item.visibleCalls += 1;
      if (call.visibleTab === false) item.hiddenCalls += 1;
      byRenderer[call.name] = item;
    });
    Object.keys(byRenderer).forEach(function (name) {
      var item = byRenderer[name];
      item.averageDurationMs = item.calls ? item.totalDurationMs / item.calls : 0;
      item.hiddenCallRatio = item.calls ? item.hiddenCalls / item.calls : 0;
    });
    var applyDurations = polls.map(function (poll) { return poll.applyDurationMs || 0; });
    var intervals = polls.slice(1).map(function (poll, index) { return poll.startedAt - polls[index].startedAt; });
    var sorted = applyDurations.slice().sort(function (a, b) { return a - b; });
    var p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;
    return {
      schemaVersion: 1,
      audit: "companion-live-render",
      debugEnabled: true,
      startedAt: new Date(Date.now() - (now() - startedAt)).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: now() - startedAt,
      runtimeFetch: { status: "UNAVAILABLE", reason: "The central WebSocket transport was not instrumented; this audit measures applyLiveGameData and DOM work only." },
      pollCount: polls.length,
      applyLiveGameData: { count: polls.length, averageDurationMs: applyDurations.length ? applyDurations.reduce(function (a, b) { return a + b; }, 0) / applyDurations.length : null, maxDurationMs: applyDurations.length ? Math.max.apply(Math, applyDurations) : null, p95DurationMs: p95, overlapCount: 0 },
      pollIntervalsMs: { samples: intervals, average: intervals.length ? intervals.reduce(function (a, b) { return a + b; }, 0) / intervals.length : null, min: intervals.length ? Math.min.apply(Math, intervals) : null, max: intervals.length ? Math.max.apply(Math, intervals) : null },
      renderers: Object.values(byRenderer),
      longTasks: { status: longTaskObserver ? "MEASURED" : "UNAVAILABLE", count: longTasks.length, entries: longTasks.slice(-100) },
      translation: { status: "MEASURED_IF_I18N_DEBUG_QUERY_ENABLED", fullScanCount: window.__WOG_I18N_METRICS__ ? window.__WOG_I18N_METRICS__.fullScanCount : null, latest: window.__WOG_I18N_METRICS__ || null },
      liveBagAndStorageOptimization: getLiveBagOptimizationMetrics(),
      stageTableOptimization: getStageTableOptimizationMetrics(byRenderer),
      orphanRendererCalls: orphanRendererCalls,
      orphanMutationRecords: orphanMutationRecords,
      polls: polls.map(function (poll) { var copy = JSON.parse(JSON.stringify(poll)); copy.translation = summarizeTranslation(poll); return copy; }),
      rendererConfig: rendererConfig,
    };
  }

  function publish() {
    var summary = buildSummary();
    window.__WOG_LIVE_RENDER_AUDIT__ = summary;
    root.setAttribute("data-wog-live-render-audit", JSON.stringify(summary));
  }

  window.__WOG_LIVE_RENDER_AUDIT__ = { status: "initializing", schemaVersion: 1 };
  window.__WOG_LIVE_RENDER_AUDIT_CONTROL__ = Object.freeze({
    getReport: function () { publish(); return window.__WOG_LIVE_RENDER_AUDIT__; },
    reset: function () { polls.length = 0; rendererCalls.length = 0; longTasks.length = 0; publish(); },
    stop: function () { observer.disconnect(); if (longTaskObserver) longTaskObserver.disconnect(); patched.forEach(function (restore) { restore(); }); },
  });
  installHooks();
  publish();
})();
