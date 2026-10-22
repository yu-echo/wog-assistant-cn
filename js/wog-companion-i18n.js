(function () {
  "use strict";

  // Display-only adapter for the legacy Companion renderer. The legacy bundle
  // remains the source of calculations, data and event behavior. This adapter
  // only changes visible text below the Companion root.
  var locale = window.WOG_COMPANION_LOCALE || "en";
  var payload = window.WOG_COMPANION_TRANSLATIONS || {};
  var gameLocale = window.WOG_COMPANION_GAME_LOCALE || payload.gameLocale || {};
  var root = document.querySelector(".wog-companion-app");
  if (!root) return;
  root.setAttribute("data-wog-locale-state", "booting");

  function markLocaleReady() {
    var gate = window.WOG_COMPANION_LOCALE_GATE;
    if (gate && typeof gate.mark === "function") {
      gate.mark("adapter");
      return;
    }
    // Direct legacy launches do not have the Astro bootstrap gate. Preserve a
    // safe standalone fallback for that source-compatible entry point.
    root.setAttribute("data-wog-locale-state", "ready");
    window.WOG_COMPANION_LOCALE_READY = true;
  }

  var exact = payload.exact || {};
  var attributes = payload.attributes || {};
  var phrases = buildPhraseRules(payload.phrases || []);
  var patterns = buildPatternRules(payload.patterns || []);
  var gameAliases = Object.keys(gameLocale).filter(function (source) {
    return source && gameLocale[source];
  }).sort(function (a, b) {
    return b.length - a.length;
  }).map(function (source, order) {
    return { source: source, target: gameTarget(gameLocale[source]), order: order };
  }).filter(function (entry) {
    return entry.target && entry.target !== entry.source;
  });
  var gameExact = new Map();
  var gameAliasBuckets = new Map();
  gameAliases.forEach(function (entry) {
    gameExact.set(entry.source, entry.target);
    addBucket(gameAliasBuckets, entry.source, entry);
  });

  var enResidual = locale === "en" ? (payload.enResidual || {}) : {};
  var residualExact = enResidual.exact || {};
  var residualAttributes = enResidual.attributes || {};
  var residualPhrases = buildPhraseRules(enResidual.phrases || []);
  var residualPatterns = buildPatternRules(enResidual.patterns || []);
  var residualFragments = Object.keys(residualExact).filter(function (source) {
    return source && source.length >= 1 && containsCjk(source);
  }).sort(function (a, b) {
    return b.length - a.length;
  }).map(function (source, order) {
    return { source: source, target: residualExact[source], order: order };
  });
  var residualFragmentBuckets = new Map();
  residualFragments.forEach(function (entry) {
    addBucket(residualFragmentBuckets, entry.source, entry);
  });

  var nodeCache = new WeakMap();
  var elementCache = new WeakMap();
  var translatedAttributes = new WeakMap();
  var selfTextWrites = new WeakMap();
  var selfElementWrites = new WeakMap();
  var selfAttributeWrites = new WeakMap();
  var translationCache = new Map();
  var MAX_TRANSLATION_CACHE_ENTRIES = 4000;
  var debugConfig = window.__WOG_I18N_DEBUG__;
  var debugQueryEnabled = false;
  try {
    debugQueryEnabled = new URLSearchParams(window.location.search).get("wogI18nDebug") === "1";
  } catch (error) {
    debugQueryEnabled = false;
  }
  var debugEnabled = debugQueryEnabled || debugConfig === true || Boolean(debugConfig && debugConfig.enabled);
  var metrics = {
    fullScanCount: 0,
    incrementalBatchCount: 0,
    nodesVisited: 0,
    textNodesVisited: 0,
    attributesChecked: 0,
    translateValueCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEvictions: 0,
    regexExecutions: 0,
    regexMatches: 0,
    observerCallbacks: 0,
    selfMutationSkipped: 0,
    initialScanMs: 0,
    lastIncrementalMs: 0,
    totalTranslationMs: 0,
    incrementalTranslationMs: 0,
    lastIncrementalRoots: 0,
    lastIncrementalNodesVisited: 0,
    lastIncrementalTranslateValueCalls: 0,
    cacheSize: 0,
  };

  function now() {
    return window.performance && typeof window.performance.now === "function" ? window.performance.now() : Date.now();
  }

  function snapshotMetrics() {
    var result = {};
    Object.keys(metrics).forEach(function (key) { result[key] = metrics[key]; });
    result.cacheSize = translationCache.size;
    result.locale = locale;
    result.ruleCounts = {
      officialGameLocaleAliases: gameAliases.length,
      basePhrases: phrases.length,
      basePatterns: patterns.length,
      enResidualPhrases: residualPhrases.length,
      enResidualPatterns: residualPatterns.length,
      enResidualFragments: residualFragments.length,
      baseAttributes: Object.keys(attributes).length,
      enResidualAttributes: Object.keys(residualAttributes).length,
    };
    return result;
  }

  function publishMetrics() {
    if (!debugEnabled) return;
    var snapshot = snapshotMetrics();
    window.__WOG_I18N_METRICS__ = snapshot;
    // The debug attribute makes metrics observable from browser automation
    // without exposing a production UI or requiring a page-side evaluator.
    document.documentElement.setAttribute("data-wog-i18n-metrics", JSON.stringify(snapshot));
  }

  function addBucket(buckets, source, entry) {
    var first = Array.from(String(source || ""))[0];
    if (!first) return;
    var bucket = buckets.get(first);
    if (!bucket) {
      bucket = [];
      buckets.set(first, bucket);
    }
    bucket.push(entry);
  }

  function buildPhraseRules(entries) {
    var rules = (entries || []).filter(function (entry) {
      return entry && entry.source && entry.value && entry.source !== entry.value;
    }).sort(function (a, b) {
      return b.source.length - a.source.length;
    }).map(function (entry, order) {
      return { source: String(entry.source), target: String(entry.value), order: order };
    });
    rules.buckets = new Map();
    rules.forEach(function (entry) { addBucket(rules.buckets, entry.source, entry); });
    return rules;
  }

  function patternMarker(source) {
    var text = String(source || "");
    for (var i = 0; i < text.length; i += 1) {
      var char = text[i];
      if (char === "^") continue;
      if (char === "\\") {
        var escaped = text[i + 1] || "";
        if (escaped === "$" || escaped === "." || escaped === "(" || escaped === ")" || escaped === "|") return escaped;
        return "";
      }
      if (char === "[") return "";
      if (char === "(" || char === ")" || char === "?" || char === "." || char === "*" || char === "+" || char === "{" || char === "}" || char === "|") continue;
      return char;
    }
    return "";
  }

  function buildPatternRules(entries) {
    return (entries || []).map(function (entry, order) {
      try {
        return { regex: new RegExp(entry.source), value: entry.value, id: entry.id, marker: patternMarker(entry.source), order: order };
      } catch (error) {
        return null;
      }
    }).filter(Boolean);
  }

  function gameTarget(entry) {
    if (!entry) return "";
    if (locale === "ko") return entry.ko || entry.en || "";
    if (locale === "zh-TW") return entry["zh-TW"] || entry["zh-CN"] || entry.en || "";
    if (locale === "zh-CN") return entry["zh-CN"] || entry.en || "";
    return entry.en || "";
  }

  function containsCjk(value) {
    return /[\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(String(value || ""));
  }

  function addCandidate(candidates, seen, entry) {
    if (!entry || seen.has(entry.order)) return;
    seen.add(entry.order);
    candidates.push(entry);
  }

  // Candidate selection is indexed by the source's first character. It keeps
  // the original length/order semantics while avoiding a 2030-entry scan for
  // every text node that is already in the target language.
  function collectIndexedCandidates(value, buckets) {
    var text = String(value || "");
    var candidates = [];
    var seen = new Set();
    var chars = new Set(Array.from(text));
    chars.forEach(function (char) {
      var bucket = buckets.get(char) || [];
      bucket.forEach(function (entry) {
        if (text.indexOf(entry.source) !== -1) addCandidate(candidates, seen, entry);
      });
    });
    candidates.sort(function (a, b) { return a.order - b.order; });
    return candidates;
  }

  function applyIndexedReplacements(value, buckets) {
    var result = String(value || "");
    var candidates = collectIndexedCandidates(result, buckets);
    var processed = new Set();
    for (var i = 0; i < candidates.length; i += 1) {
      var entry = candidates[i];
      if (processed.has(entry.order)) continue;
      processed.add(entry.order);
      if (result.indexOf(entry.source) === -1) continue;
      result = result.split(entry.source).join(entry.target);

      // Preserve the original one-pass ordering if a replacement exposes a
      // later source alias/phrase. Earlier rules have already been processed.
      collectIndexedCandidates(result, buckets).forEach(function (newEntry) {
        if (newEntry.order > entry.order && !processed.has(newEntry.order)) candidates.push(newEntry);
      });
      candidates.sort(function (a, b) { return a.order - b.order; });
    }
    return result;
  }

  function hasIndexedMatch(value, buckets) {
    var text = String(value || "");
    var chars = new Set(Array.from(text));
    var found = false;
    chars.forEach(function (char) {
      if (found) return;
      (buckets.get(char) || []).some(function (entry) {
        if (text.indexOf(entry.source) !== -1) {
          found = true;
          return true;
        }
        return false;
      });
    });
    return found;
  }

  function hasPatternCandidate(value, rules) {
    var text = String(value || "");
    return rules.some(function (entry) {
      return !entry.marker || text.indexOf(entry.marker) !== -1;
    });
  }

  function applyPatterns(value, rules) {
    var result = String(value || "");
    for (var i = 0; i < rules.length; i += 1) {
      var entry = rules[i];
      if (entry.marker && result.indexOf(entry.marker) === -1) continue;
      metrics.regexExecutions += 1;
      var match = result.match(entry.regex);
      if (!match) continue;
      metrics.regexMatches += 1;
      result = replaceTemplate(entry.value, match);
      break;
    }
    return result;
  }

  function replaceTemplate(template, match) {
    return String(template).replace(/\$(\d+)/g, function (_, index) {
      return match[Number(index)] == null ? "" : match[Number(index)];
    });
  }

  function hasKnownSource(value) {
    var text = String(value || "");
    if (!text.trim()) return false;
    if (Object.prototype.hasOwnProperty.call(exact, text) || gameExact.has(text)) return true;
    if (hasIndexedMatch(text, gameAliasBuckets) || hasIndexedMatch(text, phrases.buckets)) return true;
    if (hasPatternCandidate(text, patterns)) return true;
    if (locale === "en") {
      if (containsCjk(text) || Object.prototype.hasOwnProperty.call(residualExact, text)) return true;
      if (hasIndexedMatch(text, residualPhrases.buckets) || hasIndexedMatch(text, residualFragmentBuckets)) return true;
      if (hasPatternCandidate(text, residualPatterns)) return true;
    }
    return false;
  }

  function cacheGet(source) {
    var key = locale + "\u0000" + source;
    if (!translationCache.has(key)) {
      metrics.cacheMisses += 1;
      return undefined;
    }
    var value = translationCache.get(key);
    // Refresh insertion order for a small bounded LRU-like cache.
    translationCache.delete(key);
    translationCache.set(key, value);
    metrics.cacheHits += 1;
    return value;
  }

  function cacheSet(source, value) {
    if (source.length > 2000) return;
    var key = locale + "\u0000" + source;
    if (translationCache.has(key)) translationCache.delete(key);
    translationCache.set(key, value);
    while (translationCache.size > MAX_TRANSLATION_CACHE_ENTRIES) {
      translationCache.delete(translationCache.keys().next().value);
      metrics.cacheEvictions += 1;
    }
  }

  function translateGameValue(value) {
    if (!value || !String(value).trim()) return value;
    var result = String(value);
    var direct = gameExact.get(result);
    if (direct !== undefined) return direct;
    return applyIndexedReplacements(result, gameAliasBuckets);
  }

  function translateValue(value) {
    metrics.translateValueCalls += 1;
    if (!value || !String(value).trim()) return value;
    var original = String(value);
    var cached = cacheGet(original);
    if (cached !== undefined) return cached;

    var trimmed = original.trim();
    if (!hasKnownSource(trimmed)) {
      cacheSet(original, original);
      return original;
    }

    var leading = original.slice(0, original.indexOf(trimmed));
    var trailingStart = original.indexOf(trimmed) + trimmed.length;
    var trailing = original.slice(trailingStart);
    var next = translateGameValue(trimmed);
    var initialResidual = locale === "en" && containsCjk(next);
    if (initialResidual && Object.prototype.hasOwnProperty.call(residualExact, next)) next = residualExact[next];
    if (initialResidual) next = applyPatterns(next, residualPatterns);

    if (Object.prototype.hasOwnProperty.call(exact, next)) next = exact[next];
    next = applyPatterns(next, patterns);
    next = applyIndexedReplacements(next, phrases.buckets);

    if (locale === "en" && containsCjk(next)) {
      if (Object.prototype.hasOwnProperty.call(residualExact, next)) next = residualExact[next];
      next = applyPatterns(next, residualPatterns);
      next = applyIndexedReplacements(next, residualPhrases.buckets);
      next = applyIndexedReplacements(next, residualFragmentBuckets);
    }
    var result = leading + next + trailing;
    cacheSet(original, result);
    return result;
  }

  function hasProtectedIdentity(element) {
    if (!element) return true;
    if (element.closest("[data-wog-user-data], code, input, textarea, .player-name")) return true;
    if (element.closest("[data-wog-game-data], .node-name, .slot-skill-name, .sub-name, .training-card h3")) return true;
    if (["barPlayerName", "profNick", "bannerTopItemName"].indexOf(element.id) !== -1) return true;
    return false;
  }

  function isUserValueNode(node) {
    var element = node && node.parentElement;
    if (!element) return true;
    if (element.closest("[data-wog-user-data], code, input, textarea")) return true;
    var player = element.closest(".player-name, #barPlayerName, #profNick, #bannerTopItemName");
    if (!player) return false;
    return !/^\s*(等级|等級)\s+\d+\s*$/.test(node.nodeValue || "");
  }

  function isExplicitUserValueNode(node) {
    var element = node && node.parentElement;
    if (!element) return true;
    if (element.closest("[data-wog-user-data], code, input, textarea")) return true;
    return Boolean(element.closest(".player-name, #barPlayerName, #profNick"));
  }

  function isGameIdentity(element) {
    return Boolean(element && element.closest("[data-wog-game-data], .node-name, .slot-skill-name, .sub-name, .training-card h3"));
  }

  function isProtectedAttribute(element) {
    if (!element) return true;
    if (element.matches("input, textarea")) return false;
    return hasProtectedIdentity(element);
  }

  function rememberNode(node, value) {
    nodeCache.set(node, { locale: locale, seenText: value });
  }

  function nodeWasSeen(node, value) {
    var previous = nodeCache.get(node);
    return Boolean(previous && previous.locale === locale && previous.seenText === value);
  }

  function processTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    if (node.parentElement && node.parentElement.closest("[data-wog-no-translate]")) {
      rememberNode(node, node.nodeValue || "");
      return;
    }
    metrics.textNodesVisited += 1;
    var current = node.nodeValue || "";
    if (nodeWasSeen(node, current)) return;
    var next = current;

    if (locale === "en" && containsCjk(current) && !isExplicitUserValueNode(node)) {
      var directResidual = translateValue(current);
      if (directResidual !== current && !containsCjk(directResidual)) next = directResidual;
    }
    if (next === current && isUserValueNode(node)) {
      if (/^\s*(等级|等級)\s+\d+\s*$/.test(current)) {
        next = translateValue(current);
      } else {
        var userValueElement = node.parentElement;
        var isEditableValue = Boolean(userValueElement && userValueElement.closest("[data-wog-user-data], code, input, textarea"));
        if (!isEditableValue && locale === "en" && containsCjk(current)) {
          var curatedValue = translateValue(current);
          if (curatedValue !== current && !containsCjk(curatedValue)) next = curatedValue;
        }
      }
    } else if (next === current) {
      var gameNext = translateGameValue(current);
      if (gameNext !== current) {
        next = locale === "en" && containsCjk(gameNext) ? translateValue(gameNext) : gameNext;
      } else if (isGameIdentity(node.parentElement)) {
        next = translateValue(current);
      } else if (!hasProtectedIdentity(node.parentElement)) {
        next = translateValue(current);
      }
    }

    if (next !== current) {
      selfTextWrites.set(node, next);
      node.nodeValue = next;
    }
    rememberNode(node, node.nodeValue || "");
  }

  function processAttributes(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    if (element.closest("[data-wog-no-translate]")) return;
    ["placeholder", "title", "aria-label"].forEach(function (name) {
      if (!element.hasAttribute(name)) return;
      metrics.attributesChecked += 1;
      var current = element.getAttribute(name) || "";
      var done = translatedAttributes.get(element) || {};
      if (done[name] && done[name].locale === locale && done[name].seenText === current) return;
      var curatedResidualAttribute = locale === "en" && containsCjk(current) && !isExplicitUserValueNode({ parentElement: element, nodeValue: current });
      if (isProtectedAttribute(element) && !curatedResidualAttribute) {
        done[name] = { locale: locale, seenText: current };
        translatedAttributes.set(element, done);
        return;
      }
      var next = Object.prototype.hasOwnProperty.call(attributes, current) ? attributes[current] : translateValue(current);
      if (locale === "en" && containsCjk(current)) {
        next = Object.prototype.hasOwnProperty.call(residualAttributes, current) ? residualAttributes[current] : translateValue(current);
      }
      if (next !== current) {
        var selfAttrs = selfAttributeWrites.get(element) || {};
        selfAttrs[name] = next;
        selfAttributeWrites.set(element, selfAttrs);
        element.setAttribute(name, next);
      }
      done[name] = { locale: locale, seenText: element.getAttribute(name) || next };
      translatedAttributes.set(element, done);
    });
  }

  function processLeafElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || element.children.length) return;
    if (element.closest("[data-wog-no-translate]")) return;
    var current = element.textContent || "";
    var previous = elementCache.get(element);
    if (previous && previous.locale === locale && previous.seenText === current) return;
    if (isUserValueNode({ parentElement: element, nodeValue: current }) || isExplicitUserValueNode({ parentElement: element, nodeValue: current })) {
      elementCache.set(element, { locale: locale, seenText: current });
      return;
    }
    var next = translateValue(current);
    if (next !== current) {
      selfElementWrites.set(element, next);
      element.textContent = next;
    }
    elementCache.set(element, { locale: locale, seenText: element.textContent || next });
  }

  function selectWithin(scope, selector) {
    var result = [];
    if (!scope || scope.nodeType !== Node.ELEMENT_NODE) return result;
    if (scope.matches(selector)) result.push(scope);
    scope.querySelectorAll(selector).forEach(function (element) { if (result.indexOf(element) === -1) result.push(element); });
    return result;
  }

  function syncLocaleChromeIn(container) {
    var scope = container && container.nodeType === Node.ELEMENT_NODE ? container : container && container.parentElement;
    if (!scope) return;

    // This badge describes the website's display locale, not the game's
    // profile language. Keep it aligned with the localized Companion route.
    selectWithin(scope, "#wogCompanionLanguageBadge").forEach(function (badge) {
      var expected = locale === "en" ? "🇬🇧 English" : locale === "ko" ? "🇰🇷 한국어" : locale === "zh-TW" ? "🇹🇼 繁體中文" : "🇨🇳 简体中文";
      if ((badge.textContent || "").trim() === expected) return;
      selfElementWrites.set(badge, expected);
      badge.textContent = expected;
    });

    // Steam market data is rendered by the legacy bundle after the initial
    // page scan. Repair only the dynamic label prefix and leave the selected
    // item name, tier and price untouched.
    if (locale !== "en") return;
    selectWithin(scope, "#bannerTopValuableItem").forEach(function (banner) {
      Array.prototype.forEach.call(banner.childNodes, function (child) {
        if (child.nodeType !== Node.TEXT_NODE) return;
        var current = child.nodeValue || "";
        if (!/(?:最贵部件|most\s*贵\s*部\s*items?|most\s+valuable\s+items?)/i.test(current)) return;
        var leading = (current.match(/^\s*/) || [""])[0];
        var next = leading + "👑 Most valuable item: ";
        if (next === current) return;
        selfTextWrites.set(child, next);
        child.nodeValue = next;
      });
    });
  }

  function translateSpecialLabelsIn(container) {
    var scope = container && container.nodeType === Node.ELEMENT_NODE ? container : container && container.parentElement;
    if (!scope) return;
    selectWithin(scope, "#barPlayerName span, #profLevel, #profExpLv").forEach(function (element) {
      var current = (element.textContent || "").trim();
      if (!/^\s*(等级|等級)\s*\d+\s*$/.test(current)) return;
      var next = translateValue(current);
      if (next !== current) {
        selfElementWrites.set(element, next);
        element.textContent = next;
      }
    });
    selectWithin(scope, "#profNick").forEach(function (profileName) {
      var profileText = (profileName.textContent || "").trim();
      if (profileText !== "新手玩家 (未导入存档)" && profileText !== "新手玩家（未导入存档）" && profileText !== "新手玩家（未匯入存檔）") return;
      var profileNext = translateValue(profileText);
      if (profileNext !== profileText) {
        selfElementWrites.set(profileName, profileNext);
        profileName.textContent = profileNext;
      }
    });
    selectWithin(scope, "#barPlayerName").forEach(function (playerName) {
      Array.prototype.forEach.call(playerName.childNodes, function (child) {
        if (child.nodeType !== Node.TEXT_NODE) return;
        var playerText = (child.nodeValue || "").trim();
        if (playerText !== "新手玩家 (未导入存档)" && playerText !== "新手玩家（未导入存档）" && playerText !== "新手玩家（未匯入存檔）") return;
        var playerNext = translateValue(playerText);
        if (playerNext !== playerText) {
          selfTextWrites.set(child, playerNext);
          child.nodeValue = (child.nodeValue || "").replace(playerText, playerNext);
        }
      });
    });
    syncLocaleChromeIn(scope);
  }

  function isSkippableElement(element) {
    return element && (element.tagName === "SCRIPT" || element.tagName === "STYLE");
  }

  function translateSubtree(container) {
    if (!container) return;
    if (container.nodeType === Node.TEXT_NODE) {
      processTextNode(container);
      return;
    }
    if (container.nodeType !== Node.ELEMENT_NODE || isSkippableElement(container)) return;
    // Some legacy renderers intentionally write fully localized data islands
    // after the initial scan. Skip the whole subtree, including its root, so
    // an incremental mutation batch cannot re-translate the island using a
    // less specific game-locale fallback.
    if (container.closest("[data-wog-no-translate]")) return;
    var leaves = [];
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (node.nodeType === Node.ELEMENT_NODE && isSkippableElement(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var current = walker.currentNode;
    while (current) {
      metrics.nodesVisited += 1;
      if (current.nodeType === Node.TEXT_NODE) {
        processTextNode(current);
      } else {
        processAttributes(current);
        if (current !== container && !current.children.length) leaves.push(current);
      }
      current = walker.nextNode();
    }
    leaves.forEach(processLeafElement);
    translateSpecialLabelsIn(container);
  }

  var scheduled = false;
  var pendingRoots = new Set();
  var observer = null;

  function isInsideRoot(node) {
    return node === root || (node && root.contains(node));
  }

  function enqueue(node) {
    if (!node || !isInsideRoot(node)) return;
    pendingRoots.add(node);
  }

  function removeNestedRoots(roots) {
    return roots.filter(function (candidate) {
      return !roots.some(function (ancestor) {
        return ancestor !== candidate && ancestor.nodeType === Node.ELEMENT_NODE && ancestor.contains(candidate);
      });
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var callback = function () {
      scheduled = false;
      flushIncremental();
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(callback);
    else window.setTimeout(callback, 0);
  }

  function isSelfMutation(record) {
    if (record.type === "characterData") {
      var expectedText = selfTextWrites.get(record.target);
      if (expectedText !== undefined) {
        selfTextWrites.delete(record.target);
        if ((record.target.nodeValue || "") === expectedText) {
          metrics.selfMutationSkipped += 1;
          return true;
        }
      }
    }
    if (record.type === "childList") {
      var expectedElement = selfElementWrites.get(record.target);
      if (expectedElement !== undefined) {
        selfElementWrites.delete(record.target);
        if ((record.target.textContent || "") === expectedElement) {
          metrics.selfMutationSkipped += 1;
          return true;
        }
      }
    }
    if (record.type === "attributes") {
      var expectedAttrs = selfAttributeWrites.get(record.target);
      var expectedAttr = expectedAttrs && expectedAttrs[record.attributeName];
      if (expectedAttr !== undefined) {
        delete expectedAttrs[record.attributeName];
        if ((record.target.getAttribute(record.attributeName) || "") === expectedAttr) {
          metrics.selfMutationSkipped += 1;
          return true;
        }
      }
    }
    return false;
  }

  function handleMutations(records) {
    metrics.observerCallbacks += 1;
    records.forEach(function (record) {
      if (isSelfMutation(record)) return;
      if (record.type === "characterData") {
        enqueue(record.target);
        return;
      }
      if (record.type === "attributes") {
        processAttributes(record.target);
        return;
      }
      if (record.addedNodes && record.addedNodes.length) {
        Array.prototype.forEach.call(record.addedNodes, enqueue);
      } else if (record.target && record.target !== root) {
        enqueue(record.target);
      }
    });
    if (pendingRoots.size) schedule();
    publishMetrics();
  }

  function flushIncremental() {
    var roots = removeNestedRoots(Array.from(pendingRoots));
    pendingRoots.clear();
    if (!roots.length) return;
    var start = now();
    var beforeNodes = metrics.nodesVisited;
    var beforeCalls = metrics.translateValueCalls;
    metrics.incrementalBatchCount += 1;
    roots.forEach(translateSubtree);
    metrics.lastIncrementalMs = now() - start;
    metrics.incrementalTranslationMs += metrics.lastIncrementalMs;
    metrics.totalTranslationMs += metrics.lastIncrementalMs;
    metrics.lastIncrementalRoots = roots.length;
    metrics.lastIncrementalNodesVisited = metrics.nodesVisited - beforeNodes;
    metrics.lastIncrementalTranslateValueCalls = metrics.translateValueCalls - beforeCalls;
    publishMetrics();
  }

  function initialTranslate() {
    var start = now();
    metrics.fullScanCount += 1;
    translateSubtree(root);
    metrics.initialScanMs = now() - start;
    metrics.totalTranslationMs += metrics.initialScanMs;
    publishMetrics();
    markLocaleReady();
  }

  initialTranslate();
  observer = new MutationObserver(handleMutations);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["placeholder", "title", "aria-label"]
  });

  var status = {
    locale: locale,
    mode: "curated-visual-and-game-locale-map",
    exactEntries: Object.keys(exact).length,
    phraseEntries: phrases.length,
    patternEntries: patterns.length,
    gameLocaleAliases: gameAliases.length,
    enResidualExactEntries: Object.keys(residualExact).length,
    enResidualPhraseEntries: residualPhrases.length,
    enResidualPatternEntries: residualPatterns.length,
    enResidualExactFragmentEntries: residualFragments.length,
    dynamicRenderHook: true,
    mutationObserver: true,
    mutationObserverScope: "companion-root",
    mutationMode: "incremental-subtree",
    valuesOnly: true,
  };
  window.WOG_COMPANION_TRANSLATION_STATUS = status;
  window.WOG_COMPANION_TRANSLATION_DEBUG = {
    getMetrics: snapshotMetrics,
    resetMetrics: function () {
      Object.keys(metrics).forEach(function (key) { metrics[key] = 0; });
      publishMetrics();
    },
    refresh: function () {
      translationCache.clear();
      nodeCache = new WeakMap();
      elementCache = new WeakMap();
      initialTranslate();
      return snapshotMetrics();
    },
    translate: function (value) {
      return translateValue(value);
    },
    status: status,
  };
  // Legacy data tables need the same locale-aware value for filtering that
  // the MutationObserver later paints into the DOM.
  window.WOG_COMPANION_TRANSLATE_VALUE = function (value) {
    return translateValue(value);
  };
  publishMetrics();
})();
