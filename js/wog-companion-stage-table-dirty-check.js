(function () {
  "use strict";

  // Narrow performance adapter for the legacy farming renderer. It preserves
  // every legacy call site and only decides whether renderStageTable needs to
  // rebuild its existing DOM for the current visible inputs.
  if (typeof window === "undefined" || !window || window.__WOG_STAGE_TABLE_DIRTY_CHECK__) return;

  var state = {
    installed: false,
    lastSignature: null,
    currentCycleId: null,
    currentCycleSignature: null,
    cycleId: 0,
    forceNext: false,
    forceReasons: [],
    originalRender: null,
    originalApply: null,
    stageDataRef: null,
    stageDataSignature: null,
    stageTableObserver: null,
    metrics: {
      renderStageTableCalls: 0,
      renderStageTableRealRenders: 0,
      renderStageTableDirtySkips: 0,
      renderStageTableCycleSkips: 0,
      functionCalls: 0,
      realRenders: 0,
      dirtySkips: 0,
      cycleDuplicateSkips: 0,
      changedSignatureCount: 0,
      unchangedSignatureCount: 0,
      signatureBuildCount: 0,
      signatureBuildTotalMs: 0,
      signatureBuildMaxMs: 0,
      renderTotalMs: 0,
      renderAvgMs: 0,
      renderMaxMs: 0,
      hiddenCalls: 0,
      hiddenRealRenders: 0,
      hiddenDirtySkips: 0,
      hiddenCycleSkips: 0,
      forceRenderCount: 0,
      stageTableMutationRecords: 0,
      stageTableNodesAdded: 0,
      stageTableNodesRemoved: 0,
      stageTableDomWrites: null,
      stageTableDomWritesSource: "live-render-debug-per-render",
      lastSkipReason: null,
      lastSignatureBuildMs: 0,
      lastRealRenderMs: 0,
      lastRenderMutationRecords: 0,
      lastRenderNodesAdded: 0,
      lastRenderNodesRemoved: 0,
    },
  };

  function now() {
    return window.performance && typeof window.performance.now === "function" ? window.performance.now() : Date.now();
  }

  function encode(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    var text = String(value);
    return text.length + ":" + text;
  }

  function readLocalStorage(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function valueAt(object, key) {
    return object && object[key] !== undefined ? object[key] : null;
  }

  function getProfile() {
    return window.userProfile || {};
  }

  function getCurrentDps() {
    var value = window.currentDps;
    if (value === undefined || value === null) value = window.__lastTotalDps;
    if (value === undefined || value === null) {
      var profile = getProfile();
      value = profile.combatStats && profile.combatStats.realDps;
    }
    return Number(value) || 3415;
  }

  function getTrainingLevel() {
    try {
      if (typeof window.getUserTrainingLevel === "function") return Number(window.getUserTrainingLevel(57000)) || 0;
    } catch (error) {}
    return 0;
  }

  function getHuntingReduction() {
    try {
      if (typeof window.getUserHuntingReduction === "function") return Number(window.getUserHuntingReduction()) || 0;
    } catch (error) {}
    return 0;
  }

  function getIncomeBonuses() {
    try {
      if (typeof window.getIncomeBonuses === "function") return window.getIncomeBonuses() || {};
    } catch (error) {}
    return {};
  }

  function syncCalibrationFromHistory() {
    try {
      if (typeof window.syncStageCalibrationFromHistory === "function") window.syncStageCalibrationFromHistory();
    } catch (error) {}
  }

  function getCalibrationRegistry() {
    try {
      if (typeof window.getStageCalibrationRegistry === "function") return window.getStageCalibrationRegistry() || {};
    } catch (error) {}
    try {
      var raw = window.localStorage.getItem("genesis_stage_calibration_registry");
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function calibrationSignature(registry) {
    var keys = Object.keys(registry || {}).sort();
    return encode(keys.length) + ":" + keys.map(function (key) {
      var entry = registry[key] || {};
      // Only these fields reach the Stage Table output. Timestamps, min/max
      // samples and object identity are deliberately excluded.
      return [key, entry.stage_id, entry.success_count, entry.avg_sec].map(encode).join(",");
    }).join("|");
  }

  function stageRowSignature(row) {
    if (!row || typeof row !== "object") return encode(row);
    // Stable projection of fields actually consumed by the renderer and its
    // calculateStageRewards/getStageActualMobsAndHp helpers.
    return [
      row.stage_id,
      row.area_name,
      row.difficulty,
      row.display_tag,
      row.boss_req_mobs,
      row.avg_mob_hp,
      row.boss_hp,
      row.total_hp,
      row.clear_gold,
      row.boss_gold,
      row.total_gold,
      row.clear_exp,
      row.boss_exp,
      row.total_exp,
    ].map(encode).join(",");
  }

  function stageDataSignature() {
    var data = window.stageData;
    if (!Array.isArray(data)) return "not-array";
    if (state.stageDataRef === data && state.stageDataSignature !== null) return state.stageDataSignature;
    state.stageDataRef = data;
    state.stageDataSignature = encode(data.length) + ":" + data.map(stageRowSignature).join("|");
    return state.stageDataSignature;
  }

  function getExpSignature(profile) {
    var expInfo = profile.expInfo || {};
    var currencies = profile.currencies || {};
    var expCurrency = currencies["2000"] || currencies[2000] || {};
    return [
      profile.level,
      expInfo.curExp,
      expInfo.maxExp,
      expCurrency.count,
      window.__currentEps,
    ].map(encode).join(",");
  }

  function getBonusSignature(bonuses) {
    return [
      bonuses.goldBonusPct,
      bonuses.expBonusPct,
      bonuses.allGoldPct,
      bonuses.allExpPct,
      bonuses.mobGoldPct,
      bonuses.bossGoldPct,
      bonuses.mobExpPct,
      bonuses.bossExpPct,
      bonuses.mobGoldPlus,
      bonuses.bossGoldPlus,
      bonuses.mobExpPlus,
      bonuses.bossExpPlus,
      bonuses.totalMobGoldPct,
      bonuses.totalBossGoldPct,
      bonuses.totalMobExpPct,
      bonuses.totalBossExpPct,
    ].map(encode).join(",");
  }

  function getControl(id, property, fallback) {
    var element = document.getElementById(id);
    if (!element) return fallback;
    return element[property] === undefined ? fallback : element[property];
  }

  function buildStageTableSignature() {
    var profile = getProfile();
    syncCalibrationFromHistory();
    var bonuses = getIncomeBonuses();
    var maxUnlockedId = profile.maxUnlockedStageTid || (profile.clearStageTid ? profile.clearStageTid + 1 : (profile.stageTid || 13210));
    var maxStage = Array.isArray(window.stageData) ? window.stageData.find(function (stage) { return stage.stage_id == maxUnlockedId; }) : null;
    if (!maxStage && Array.isArray(window.stageData)) maxStage = window.stageData.find(function (stage) { return stage.stage_id == 13210; });
    var language = readLocalStorage("genesis_helper_lang", "zh-CN");
    var root = document.documentElement;

    return [
      "stageData", stageDataSignature(),
      "scope", encode(getControl("stageScopeSelect", "value", "unlocked")),
      "sort", encode(getControl("stageSortSelect", "value", "gps")),
      "query", encode(String(getControl("stageSearchInput", "value", "") || "").toLowerCase().trim()),
      "calibrationEnabled", encode(readLocalStorage("genesis_enable_stage_calibration", "true") !== "false"),
      "applyBonuses", encode(readLocalStorage("genesis_apply_income_bonuses", "true") !== "false"),
      "calibrationRegistry", calibrationSignature(getCalibrationRegistry()),
      "currentStage", encode(profile.stageTid || 13208),
      "clearStage", encode(profile.clearStageTid),
      "maxUnlockedStage", encode(maxUnlockedId),
      "maxUnlockedTag", encode(maxStage && maxStage.display_tag),
      "dps", encode(getCurrentDps()),
      "trainingLevel57000", encode(getTrainingLevel()),
      "huntingReduction", encode(getHuntingReduction()),
      "incomeBonuses", getBonusSignature(bonuses),
      "expEta", getExpSignature(profile),
      "calibrationCheckbox", encode(!!getControl("chkEnableStageCalibration", "checked", false)),
      "bonusCheckbox", encode(!!getControl("chkApplyIncomeBonuses", "checked", false)),
      "language", encode(language),
      "documentLanguage", encode(root && root.lang),
    ].join(";");
  }

  function consumeTableMutations() {
    if (!state.stageTableObserver || typeof state.stageTableObserver.takeRecords !== "function") {
      return { records: 0, added: 0, removed: 0 };
    }
    var records = state.stageTableObserver.takeRecords();
    var result = { records: records.length, added: 0, removed: 0 };
    records.forEach(function (record) {
      if (record.addedNodes) result.added += record.addedNodes.length;
      if (record.removedNodes) result.removed += record.removedNodes.length;
    });
    return result;
  }

  function installTableObserver() {
    var body = document.getElementById("stageTableBody");
    if (!body || !window.MutationObserver) return;
    try {
      state.stageTableObserver = new MutationObserver(function () {});
      state.stageTableObserver.observe(body, { childList: true, subtree: true, characterData: true, attributes: true });
      consumeTableMutations();
    } catch (error) {
      state.stageTableObserver = null;
    }
  }

  function isStageSectionHidden() {
    var section = document.getElementById("stageSection");
    if (!section) return null;
    return section.hidden || section.style.display === "none";
  }

  function forceRender(reason) {
    state.forceNext = true;
    state.forceReasons.push(reason || "explicit");
    state.metrics.forceRenderCount += 1;
    state.metrics.lastSkipReason = null;
    return true;
  }

  function snapshotMetrics() {
    var result = {};
    Object.keys(state.metrics).forEach(function (key) { result[key] = state.metrics[key]; });
    result.currentCycleId = state.currentCycleId;
    result.lastSignaturePresent = state.lastSignature !== null;
    result.pendingForceRender = state.forceNext;
    result.lastForceReasons = state.forceReasons.slice(-10);
    return result;
  }

  function installActionForce(name) {
    var original = window[name];
    if (typeof original !== "function" || original.__wogStageTableDirtyActionWrapped) return;
    var wrapped = function () {
      forceRender(name);
      return original.apply(this, arguments);
    };
    wrapped.__wogStageTableDirtyActionWrapped = true;
    window[name] = wrapped;
  }

  function install() {
    if (state.installed) return true;
    var originalRender = window.renderStageTable;
    if (typeof originalRender !== "function") return false;
    state.originalRender = originalRender;
    installTableObserver();

    var wrappedRender = function () {
      var callStarted = now();
      var signatureStarted = now();
      var signature = buildStageTableSignature();
      var signatureBuildMs = now() - signatureStarted;
      var metrics = state.metrics;
      metrics.renderStageTableCalls += 1;
      metrics.functionCalls += 1;
      metrics.signatureBuildCount += 1;
      metrics.signatureBuildTotalMs += signatureBuildMs;
      metrics.signatureBuildMaxMs = Math.max(metrics.signatureBuildMaxMs, signatureBuildMs);
      metrics.lastSignatureBuildMs = signatureBuildMs;

      var sameAsLast = state.lastSignature !== null && signature === state.lastSignature;
      if (sameAsLast) metrics.unchangedSignatureCount += 1;
      else metrics.changedSignatureCount += 1;

      var explicitForce = arguments.length > 0 && arguments[0] === true;
      var shouldForce = explicitForce || state.forceNext;
      if (shouldForce) {
        state.forceNext = false;
        state.forceReasons.length = 0;
      }

      var hidden = isStageSectionHidden();
      if (hidden === true) metrics.hiddenCalls += 1;

      // Discard mutation records from external changes before this call. The
      // original renderer owns only records created during its own execution.
      consumeTableMutations();

      if (!shouldForce && sameAsLast && state.currentCycleId !== null && state.currentCycleSignature === signature) {
        var cycleSkipMs = now() - callStarted;
        metrics.renderStageTableCycleSkips += 1;
        metrics.cycleDuplicateSkips += 1;
        if (hidden === true) metrics.hiddenCycleSkips += 1;
        metrics.lastSkipReason = "CYCLE_DUPLICATE_SKIP";
        return undefined;
      }

      if (!shouldForce && sameAsLast) {
        var dirtySkipMs = now() - callStarted;
        metrics.renderStageTableDirtySkips += 1;
        metrics.dirtySkips += 1;
        if (hidden === true) metrics.hiddenDirtySkips += 1;
        metrics.lastSkipReason = "DIRTY_UNCHANGED_SKIP";
        return undefined;
      }

      var renderStarted = now();
      var result;
      try {
        result = originalRender.apply(this, arguments);
      } finally {
        var renderMs = now() - renderStarted;
        var tableMutations = consumeTableMutations();
        metrics.renderStageTableRealRenders += 1;
        metrics.realRenders += 1;
        metrics.renderTotalMs += renderMs;
        metrics.renderAvgMs = metrics.renderTotalMs / metrics.realRenders;
        metrics.renderMaxMs = Math.max(metrics.renderMaxMs, renderMs);
        metrics.lastRealRenderMs = renderMs;
        metrics.stageTableMutationRecords += tableMutations.records;
        metrics.stageTableNodesAdded += tableMutations.added;
        metrics.stageTableNodesRemoved += tableMutations.removed;
        metrics.lastRenderMutationRecords = tableMutations.records;
        metrics.lastRenderNodesAdded = tableMutations.added;
        metrics.lastRenderNodesRemoved = tableMutations.removed;
        if (hidden === true) metrics.hiddenRealRenders += 1;
        state.lastSignature = signature;
        if (state.currentCycleId !== null) state.currentCycleSignature = signature;
      }
      return result;
    };
    wrappedRender.__wogStageTableDirtyCheckWrapped = true;
    window.renderStageTable = wrappedRender;

    var originalApply = window.applyLiveGameData;
    if (typeof originalApply === "function" && !originalApply.__wogStageTableDirtyCycleWrapped) {
      state.originalApply = originalApply;
      var wrappedApply = function () {
        var previousCycle = state.currentCycleId;
        var previousSignature = state.currentCycleSignature;
        state.cycleId += 1;
        state.currentCycleId = state.cycleId;
        state.currentCycleSignature = null;
        try {
          return originalApply.apply(this, arguments);
        } finally {
          state.currentCycleId = previousCycle;
          state.currentCycleSignature = previousSignature;
        }
      };
      wrappedApply.__wogStageTableDirtyCycleWrapped = true;
      window.applyLiveGameData = wrappedApply;
    }

    // These actions explicitly change or reset Stage Table inputs. Other
    // controls are covered by the value projection in the signature.
    [
      "toggleApplyIncomeBonuses",
      "toggleStageCalibration",
      "deleteSingleStageCalibration",
      "resetStageCalibrations",
      "clearStageHistory",
      "applyRealDps",
      "updateDps",
    ].forEach(installActionForce);

    window.addEventListener("wog:localechange", function () { forceRender("locale"); });
    window.addEventListener("languagechange", function () { forceRender("locale"); });
    window.addEventListener("storage", function (event) {
      if (event && [
        "genesis_helper_lang",
        "genesis_enable_stage_calibration",
        "genesis_apply_income_bonuses",
        "genesis_stage_calibration_registry",
        "genesis_stage_run_history",
      ].indexOf(event.key) !== -1) forceRender("storage:" + event.key);
    });

    state.installed = true;
    return true;
  }

  window.__WOG_STAGE_TABLE_DIRTY_CHECK__ = {
    version: 1,
    buildStageTableSignature: buildStageTableSignature,
    forceRender: forceRender,
    invalidate: forceRender,
    getMetrics: snapshotMetrics,
    getState: function () {
      return {
        installed: state.installed,
        cycleId: state.cycleId,
        currentCycleId: state.currentCycleId,
        lastSignature: state.lastSignature,
      };
    },
  };

  if (!install()) {
    var attempts = 0;
    var retry = function () {
      if (state.installed || attempts++ > 80) return;
      if (!install()) window.setTimeout(retry, 25);
    };
    window.setTimeout(retry, 0);
  }
})();
