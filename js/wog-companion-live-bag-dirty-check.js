(function () {
  "use strict";

  // Narrow performance adapter for the legacy bag/storage renderer. It keeps
  // the original function and all original call sites intact; it only decides
  // whether a call needs to rebuild the same two DOM grids.
  if (!window || window.__WOG_LIVE_BAG_DIRTY_CHECK__) return;

  var state = {
    installed: false,
    lastSignature: null,
    currentCycleId: null,
    currentCycleSignature: null,
    cycleId: 0,
    currentStoragePage: 1,
    forceNext: false,
    forceReasons: [],
    marketObjectIds: typeof WeakMap === "function" ? new WeakMap() : null,
    nextMarketObjectId: 1,
    originalRender: null,
    originalApply: null,
    metrics: {
      renderLiveBagAndStorageCalls: 0,
      renderLiveBagAndStorageRealRenders: 0,
      renderLiveBagAndStorageDirtySkips: 0,
      renderLiveBagAndStorageCycleSkips: 0,
      functionCalls: 0,
      realRenders: 0,
      dirtySkips: 0,
      cycleDuplicateSkips: 0,
      changedSignatureCount: 0,
      unchangedSignatureCount: 0,
      signatureBuildCount: 0,
      signatureBuildTotalMs: 0,
      signatureBuildMaxMs: 0,
      skipTotalMs: 0,
      skipMaxMs: 0,
      renderTotalMs: 0,
      avgRealRenderMs: 0,
      maxRealRenderMs: 0,
      hiddenCalls: 0,
      hiddenRealRenders: 0,
      forceRenderCount: 0,
      lastSkipReason: null,
      lastSignatureBuildMs: 0,
      lastRealRenderMs: 0,
      lastSkipMs: 0,
    },
  };

  function now() {
    return window.performance && typeof window.performance.now === "function" ? window.performance.now() : Date.now();
  }

  function readLocalStorage(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function encode(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    var text = String(value);
    return text.length + ":" + text;
  }

  function itemSignature(item) {
    if (!item || typeof item !== "object") return encode(item);
    // These are the fields read by renderItemCell/getSteamMarketPrice and by
    // the slot/capacity/page calculations in renderLiveBagAndStorage.
    return [
      item.id,
      item.tid,
      item.slot,
      item.tier,
      item.level_req,
      item.icon,
      item.name_zh,
      item.name_en,
      item.name_vi,
      item.parts_type,
      item.equip_type,
      item.is_lock,
    ].map(encode).join(",");
  }

  function itemsSignature(items) {
    if (!Array.isArray(items)) return "not-array";
    return encode(items.length) + ":" + items.map(itemSignature).join("|");
  }

  function getItems(helperName, profileKey, storageKey) {
    try {
      if (typeof window[helperName] === "function") {
        var helperItems = window[helperName]();
        if (Array.isArray(helperItems)) return helperItems;
      }
    } catch (error) {
      // Fall through to the same storage sources used by the legacy helper.
    }
    try {
      var profile = window.userProfile || {};
      if (Array.isArray(profile[profileKey]) && profile[profileKey].length > 0) return profile[profileKey];
      var stored = window.localStorage.getItem(storageKey);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (error) {
      // The legacy renderer has an embedded fallback; an empty signature is
      // still safe because the next real source change produces a new value.
    }
    return [];
  }

  function getBagItems() {
    return getItems("getStoredBagItems", "bagItems", "genesis_live_bag_items");
  }

  function getStorageItems() {
    return getItems("getStoredStorageItems", "storageItems", "genesis_live_storage_items");
  }

  function getCapacity(bagItems) {
    try {
      if (typeof window.getBagCapacity === "function") return window.getBagCapacity();
    } catch (error) {}
    var capacity = parseInt(readLocalStorage("genesis_bag_capacity", "68"), 10) || 68;
    (bagItems || []).forEach(function (item) {
      if (item && typeof item.slot === "number" && item.slot >= capacity) capacity = item.slot + 1;
    });
    return capacity;
  }

  function getStoragePages(storageItems) {
    try {
      if (typeof window.getStorageTotalPages === "function") return window.getStorageTotalPages(storageItems);
    } catch (error) {}
    var pages = parseInt(readLocalStorage("genesis_storage_total_pages", "3"), 10) || 3;
    (storageItems || []).forEach(function (item) {
      if (item && typeof item.slot === "number") pages = Math.max(pages, Math.floor(item.slot / 42) + 1);
    });
    return Math.max(pages, 1);
  }

  function getMarketObjectToken() {
    var market = window.steamMarketPrices;
    if (!market || typeof market !== "object") return "none";
    var objectId = 0;
    if (state.marketObjectIds) {
      objectId = state.marketObjectIds.get(market) || 0;
      if (!objectId) {
        objectId = state.nextMarketObjectId++;
        state.marketObjectIds.set(market, objectId);
      }
    } else {
      objectId = Object.keys(market).length;
    }
    return [objectId, readLocalStorage("genesis_steam_market_time", ""), window.steamMarketUpdatedTime || "", Object.keys(market).length].map(encode).join(":");
  }

  function getLanguageToken() {
    var root = document.documentElement;
    return [
      readLocalStorage("genesis_helper_lang", "zh-CN"),
      root && root.lang,
    ].map(encode).join(":");
  }

  function buildLiveBagAndStorageSignature() {
    var bagItems = getBagItems();
    var storageItems = getStorageItems();
    var storagePage = state.currentStoragePage;
    var bagCapacity = getCapacity(bagItems);
    var storagePages = getStoragePages(storageItems);
    return [
      "bag", itemsSignature(bagItems),
      "storage", itemsSignature(storageItems),
      "capacity", encode(bagCapacity),
      "storagePages", encode(storagePages),
      "currentStoragePage", encode(storagePage),
      "bagCapacitySetting", encode(readLocalStorage("genesis_bag_capacity", "68")),
      "storagePagesSetting", encode(readLocalStorage("genesis_storage_total_pages", "3")),
      "market", getMarketObjectToken(),
      "language", getLanguageToken(),
    ].join(";");
  }

  function isEquipmentSectionHidden() {
    var section = document.getElementById("equipSection");
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
    if (typeof original !== "function" || original.__wogLiveBagDirtyActionWrapped) return;
    var wrapped = function () {
      forceRender(name);
      return original.apply(this, arguments);
    };
    wrapped.__wogLiveBagDirtyActionWrapped = true;
    window[name] = wrapped;
  }

  function installStoragePageActions() {
    var switchOriginal = window.switchStorageTab;
    if (typeof switchOriginal === "function" && !switchOriginal.__wogLiveBagDirtyActionWrapped) {
      var switchWrapped = function (pageNum) {
        state.currentStoragePage = Math.max(1, parseInt(pageNum, 10) || 1);
        forceRender("switchStorageTab");
        return switchOriginal.apply(this, arguments);
      };
      switchWrapped.__wogLiveBagDirtyActionWrapped = true;
      window.switchStorageTab = switchWrapped;
    }

    var removeOriginal = window.removeStoragePage;
    if (typeof removeOriginal === "function" && !removeOriginal.__wogLiveBagDirtyActionWrapped) {
      var removeWrapped = function () {
        forceRender("removeStoragePage");
        var result = removeOriginal.apply(this, arguments);
        try {
          var totalPages = getStoragePages(getStorageItems());
          if (state.currentStoragePage > totalPages) state.currentStoragePage = totalPages;
        } catch (error) {}
        return result;
      };
      removeWrapped.__wogLiveBagDirtyActionWrapped = true;
      window.removeStoragePage = removeWrapped;
    }

    installActionForce("addStoragePage");
  }

  function install() {
    if (state.installed) return true;
    var originalRender = window.renderLiveBagAndStorage;
    if (typeof originalRender !== "function") return false;
    state.originalRender = originalRender;

    var wrappedRender = function () {
      var callStarted = now();
      var signatureStarted = now();
      var signature = buildLiveBagAndStorageSignature();
      var signatureBuildMs = now() - signatureStarted;
      var metrics = state.metrics;
      metrics.renderLiveBagAndStorageCalls += 1;
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

      var hidden = isEquipmentSectionHidden();
      if (hidden === true) metrics.hiddenCalls += 1;

      if (!shouldForce && sameAsLast && state.currentCycleId !== null && state.currentCycleSignature === signature) {
        var cycleSkipMs = now() - callStarted;
        metrics.renderLiveBagAndStorageCycleSkips += 1;
        metrics.cycleDuplicateSkips += 1;
        metrics.skipTotalMs += cycleSkipMs;
        metrics.skipMaxMs = Math.max(metrics.skipMaxMs, cycleSkipMs);
        metrics.lastSkipMs = cycleSkipMs;
        metrics.lastSkipReason = "CYCLE_DUPLICATE_SKIP";
        return undefined;
      }

      if (!shouldForce && sameAsLast) {
        var dirtySkipMs = now() - callStarted;
        metrics.renderLiveBagAndStorageDirtySkips += 1;
        metrics.dirtySkips += 1;
        metrics.skipTotalMs += dirtySkipMs;
        metrics.skipMaxMs = Math.max(metrics.skipMaxMs, dirtySkipMs);
        metrics.lastSkipMs = dirtySkipMs;
        metrics.lastSkipReason = "DIRTY_UNCHANGED_SKIP";
        return undefined;
      }

      var renderStarted = now();
      var result;
      try {
        result = originalRender.apply(this, arguments);
      } finally {
        var renderMs = now() - renderStarted;
        metrics.renderLiveBagAndStorageRealRenders += 1;
        metrics.realRenders += 1;
        metrics.renderTotalMs += renderMs;
        metrics.maxRealRenderMs = Math.max(metrics.maxRealRenderMs, renderMs);
        metrics.avgRealRenderMs = metrics.renderTotalMs / metrics.realRenders;
        metrics.lastRealRenderMs = renderMs;
        if (hidden === true) metrics.hiddenRealRenders += 1;
        state.lastSignature = signature;
        if (state.currentCycleId !== null) state.currentCycleSignature = signature;
      }
      return result;
    };
    wrappedRender.__wogLiveBagDirtyCheckWrapped = true;
    window.renderLiveBagAndStorage = wrappedRender;

    var originalApply = window.applyLiveGameData;
    if (typeof originalApply === "function" && !originalApply.__wogLiveBagDirtyCycleWrapped) {
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
      wrappedApply.__wogLiveBagDirtyCycleWrapped = true;
      window.applyLiveGameData = wrappedApply;
    }

    installActionForce("promptSetBagCapacity");
    installStoragePageActions();

    window.addEventListener("wog:localechange", function () { forceRender("locale"); });
    window.addEventListener("languagechange", function () { forceRender("locale"); });
    window.addEventListener("storage", function (event) {
      if (event && (event.key === "genesis_helper_lang" || event.key === "genesis_bag_capacity" || event.key === "genesis_storage_total_pages")) forceRender("storage:" + event.key);
    });

    state.installed = true;
    return true;
  }

  window.__WOG_LIVE_BAG_DIRTY_CHECK__ = {
    version: 1,
    buildLiveBagAndStorageSignature: buildLiveBagAndStorageSignature,
    forceRender: forceRender,
    invalidate: forceRender,
    getMetrics: snapshotMetrics,
    getState: function () {
      return {
        installed: state.installed,
        cycleId: state.cycleId,
        currentCycleId: state.currentCycleId,
        lastSignature: state.lastSignature,
        currentStoragePage: state.currentStoragePage,
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
