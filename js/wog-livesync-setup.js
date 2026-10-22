(function () {
  "use strict";

  function boot() {
    var root = document.querySelector("[data-wog-livesync-setup]");
    if (!root) return;

    var locale = document.documentElement.dataset.siteLocale || "en";
    var copy = {
      en: {
        checking: "Checking local LiveSync…",
        offline: "Not connected",
        offlineDetail: "No 10998 port yet — click Inject to enable it.",
        connecting: "Connecting…",
        connectingDetail: "Waiting for the local game runtime.",
        ready: "Connected",
        readyDetail: "Live profile and game data are available.",
        incompatible: "Game version not supported",
        incompatibleDetail: "This Connector supports the verified v1245 game build.",
        error: "Connection check failed",
        errorDetail: "Start the Connector, then check the connection again.",
        probePassed: "Local read-only connection ready",
        probeWaiting: "Local endpoint reached · waiting for game runtime",
        probeOffline: "Local connection · read-only",
        checkFirst: "Checking the local Connector…",
      },
      "zh-CN": {
        checking: "正在检测本地 LiveSync…",
        offline: "尚未连接",
        offlineDetail: "没检测到 10998 端口，点「注入补丁」即可开启。",
        connecting: "正在连接…",
        connectingDetail: "正在等待本地游戏运行时。",
        ready: "已连接",
        readyDetail: "实时角色和游戏数据已可用。",
        incompatible: "游戏版本不受支持",
        incompatibleDetail: "当前 Connector 支持经过验证的 v1245 游戏版本。",
        error: "连接检测失败",
        errorDetail: "启动 Connector 后，再次检查连接。",
        probePassed: "本地只读连接已就绪",
        probeWaiting: "本地端点已连接 · 正在等待游戏运行时",
        probeOffline: "本地连接 · 只读",
        checkFirst: "正在检查本地 Connector…",
      },
      "zh-TW": {
        checking: "正在檢查本機 LiveSync…",
        offline: "尚未連線",
        offlineDetail: "沒檢測到 10998 埠，點「注入補丁」即可開啟。",
        connecting: "正在連線…",
        connectingDetail: "正在等待本機遊戲執行環境。",
        ready: "已連線",
        readyDetail: "即時角色與遊戲資料已可用。",
        incompatible: "遊戲版本不支援",
        incompatibleDetail: "目前 Connector 支援經過驗證的 v1245 遊戲版本。",
        error: "連線檢查失敗",
        errorDetail: "啟動 Connector 後，再次檢查連線。",
        probePassed: "本機唯讀連線已就緒",
        probeWaiting: "本機端點已連線 · 正在等待遊戲執行環境",
        probeOffline: "本機連線 · 唯讀",
        checkFirst: "正在檢查本機 Connector…",
      },
      ko: {
        checking: "로컬 LiveSync 확인 중…",
        offline: "연결되지 않음",
        offlineDetail: "10998 포트가 없습니다. 주입 버튼으로 켜세요.",
        connecting: "연결 중…",
        connectingDetail: "로컬 게임 런타임을 기다리는 중입니다.",
        ready: "연결됨",
        readyDetail: "실시간 프로필과 게임 데이터를 사용할 수 있습니다.",
        incompatible: "지원되지 않는 게임 버전",
        incompatibleDetail: "이 Connector는 확인된 v1245 게임 빌드를 지원합니다.",
        error: "연결 확인 실패",
        errorDetail: "Connector를 실행한 뒤 다시 연결을 확인하세요.",
        probePassed: "로컬 읽기 전용 연결 준비 완료",
        probeWaiting: "로컬 엔드포인트 연결됨 · 게임 런타임 대기 중",
        probeOffline: "로컬 연결 · 읽기 전용",
        checkFirst: "로컬 Connector 확인 중…",
      },
    }[locale] || {
      checking: "Checking local LiveSync…",
      offline: "Not connected",
      offlineDetail: "No 10998 port yet — click Inject to enable it.",
      connecting: "Connecting…",
      connectingDetail: "Waiting for the local game runtime.",
      ready: "Connected",
      readyDetail: "Live profile and game data are available.",
      incompatible: "Game version not supported",
      incompatibleDetail: "This Connector supports the verified v1245 game build.",
      error: "Connection check failed",
      errorDetail: "Start the Connector, then check the connection again.",
      probePassed: "Local read-only connection ready",
      probeWaiting: "Local endpoint reached · waiting for game runtime",
      probeOffline: "Local connection · read-only",
      checkFirst: "Checking the local Connector…",
    };

    var status = root.querySelector("[data-wog-livesync-status]");
    var title = root.querySelector("[data-wog-livesync-status-title]");
    var detail = root.querySelector("[data-wog-livesync-status-detail]");
    var version = root.querySelector("[data-wog-livesync-version-state]");
    var guide = root.querySelector("[data-wog-livesync-guide]");
    var modal = root.querySelector("[data-wog-livesync-modal]");
    var modalTitle = root.querySelector("[data-wog-livesync-modal-status-title]");
    var modalDetail = root.querySelector("[data-wog-livesync-modal-status-detail]");
    var openButton = root.querySelector("[data-wog-livesync-open]");
    var checkButtons = root.querySelectorAll("[data-wog-livesync-check]");
    var closeButton = root.querySelector("[data-wog-livesync-close]");
    var dismissButton = root.querySelector("[data-wog-livesync-dismiss]");
    var injectButton = root.querySelector("[data-wog-inject-patch]");
    var setupSeenKey = "wog_livesync_onboarding_seen";
    var legacySetupSeenKey = "wog_livesync_setup_seen";
    var bridge = null;
    var unsubscribe = null;
    var guideTouched = false;

    function getBridge() {
      return window.WOG_COMPANION_RUNTIME_BRIDGE || null;
    }

    function setStateClass(state) {
      root.dataset.wogLivesyncState = state;
      if (status) status.className = "wog-livesync-status is-" + state;
    }

    function hasSeenOnboarding() {
      try {
        return window.localStorage.getItem(setupSeenKey) === "1" || window.localStorage.getItem(legacySetupSeenKey) === "1";
      } catch (_) {
        return false;
      }
    }

    function markOnboardingSeen() {
      try {
        window.localStorage.setItem(setupSeenKey, "1");
      } catch (_) {}
    }

    function openModal() {
      markOnboardingSeen();
      if (!modal) return;
      if (typeof modal.showModal === "function") {
        if (!modal.open) modal.showModal();
      } else {
        modal.setAttribute("open", "");
      }
    }

    function closeModal() {
      if (!modal) return;
      if (typeof modal.close === "function" && modal.open) modal.close();
      else modal.removeAttribute("open");
    }

    function setModalStatus(nextTitle, nextDetail) {
      if (modalTitle) modalTitle.textContent = nextTitle;
      if (modalDetail) modalDetail.textContent = nextDetail;
    }

    function render(state) {
      state = state || {};
      var stateName = state.status || "offline";
      var descriptor = state.runtimeDescriptor || {};
      var nativeReady = stateName === "connected" && descriptor.kind === "native-puerts" && descriptor.probe === "passed";
      var effectiveState = nativeReady ? "ready" : stateName === "connected" ? "checking" : stateName;
      setStateClass(effectiveState);

      if (nativeReady) {
        if (title) title.textContent = copy.ready;
        if (detail) detail.textContent = copy.readyDetail;
        if (version) version.textContent = copy.probePassed;
        setModalStatus(copy.ready, copy.readyDetail);
        markOnboardingSeen();
        if (guide && !guideTouched) guide.open = false;
      } else if (stateName === "connecting" || stateName === "reconnecting" || stateName === "connected") {
        if (title) title.textContent = copy.connecting;
        if (detail) detail.textContent = copy.connectingDetail;
        if (version) version.textContent = copy.probeWaiting;
        setModalStatus(copy.connecting, copy.connectingDetail);
      } else if (stateName === "incompatible") {
        if (title) title.textContent = copy.incompatible;
        if (detail) detail.textContent = copy.incompatibleDetail;
        if (version) version.textContent = copy.probeOffline;
        setModalStatus(copy.incompatible, copy.incompatibleDetail);
      } else if (stateName === "error") {
        if (title) title.textContent = copy.error;
        if (detail) detail.textContent = copy.errorDetail;
        if (version) version.textContent = copy.probeOffline;
        setModalStatus(copy.error, copy.errorDetail);
      } else {
        if (title) title.textContent = copy.offline;
        if (detail) detail.textContent = copy.offlineDetail;
        if (version) version.textContent = copy.probeOffline;
        setModalStatus(copy.offline, copy.offlineDetail);
      }
    }

    function connectOrRefresh() {
      bridge = bridge || getBridge();
      if (!bridge) {
        if (title) title.textContent = copy.checkFirst;
        return;
      }
      var state = bridge.getState ? bridge.getState() : {};
      if (state.status === "connected") {
        if (typeof bridge.pollNow === "function") bridge.pollNow().catch(function () {});
      } else if (typeof bridge.reconnect === "function") {
        bridge.reconnect();
      } else if (typeof bridge.connect === "function") {
        bridge.connect();
      }
    }

    function attach() {
      bridge = getBridge();
      if (!bridge) return false;
      if (typeof bridge.subscribe === "function") unsubscribe = bridge.subscribe(render);
      render(bridge.getState ? bridge.getState() : {});
      return true;
    }

    /* ---------- 本地注入接口（由 启动.cmd 起的服务提供） ---------- */
    function apiFetch(url, options, timeoutMs) {
      if (typeof window.fetch !== "function") return Promise.reject(new Error("浏览器不支持 fetch"));
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = controller ? window.setTimeout(function () { controller.abort(); }, timeoutMs || 12000) : null;
      var opts = Object.assign({ cache: "no-store" }, options || {});
      if (controller) opts.signal = controller.signal;
      return window.fetch(url, opts).then(function (resp) {
        if (timer) window.clearTimeout(timer);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      }, function (err) {
        if (timer) window.clearTimeout(timer);
        throw err;
      });
    }

    function apiStatus() {
      return apiFetch("/api/status", null, 6000);
    }

    function apiPatch() {
      return apiFetch("/api/patch", { method: "POST" }, 20000);
    }

    var injectionState = { busy: false, available: null, message: "" };

    function setModalStatusOnly(text) {
      if (modalDetail) modalDetail.textContent = text;
      if (modalTitle) modalTitle.textContent = copy.offline;
    }

    function renderInjectButton(state) {
      if (!injectButton) return;
      var src = state || {};
      if (injectionState.available === false) {
        injectButton.disabled = true;
        injectButton.textContent = "⚠️ 需要从「启动.cmd」打开";
        return;
      }
      if (injectionState.busy) {
        injectButton.disabled = true;
        injectButton.textContent = "⏳ 正在注入…";
        return;
      }
      injectButton.disabled = false;
      if (src.patched) {
        injectButton.textContent = "✅ 已注入 10998（重新检测）";
      } else if (src.game_running === false) {
        injectButton.textContent = "⚡ 注入补丁（先启动游戏）";
      } else {
        injectButton.textContent = "⚡ 注入补丁（开启 10998）";
      }
    }

    function waitForPort(attemptsLeft, onDone) {
      if (attemptsLeft <= 0) return onDone(false);
      window.setTimeout(function () {
        apiStatus().then(function (st) {
          if (st && st.port_open) return onDone(true);
          waitForPort(attemptsLeft - 1, onDone);
        }, function () {
          waitForPort(attemptsLeft - 1, onDone);
        });
      }, 700);
    }

    function doInject() {
      if (injectionState.busy) return;
      injectionState.busy = true;
      markOnboardingSeen();
      renderInjectButton({});
      setModalStatusOnly("正在给游戏注入 10998 端口…");
      apiPatch().then(function (res) {
        if (res && res.ok) {
          setModalStatusOnly(res.message || "注入成功，等待游戏端口就绪…");
          waitForPort(10, function (open) {
            injectionState.busy = false;
            renderInjectButton({ patched: open });
            if (open) {
              setModalStatus(copy.ready, copy.readyDetail);
              connectOrRefresh();
              window.setTimeout(closeModal, 700);
            } else {
              setModalStatusOnly("已写入内存，但端口还没起来。可以把游戏切到前台等一两秒，再点「检查连接」。");
            }
          });
        } else {
          injectionState.busy = false;
          renderInjectButton({});
          setModalStatusOnly((res && res.message) || "注入失败：未知原因");
        }
      }, function (err) {
        injectionState.busy = false;
        renderInjectButton({});
        injectionState.available = false;
        setModalStatusOnly(err && err.message === "HTTP 404"
          ? "本地服务不支持注入，请用「启动.cmd」打开本页面。"
          : "调用注入接口失败：" + ((err && err.message) || err));
      });
    }

    if (openButton) openButton.addEventListener("click", function () {
      openModal();
      refreshInjectPanel();
    });
    checkButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        markOnboardingSeen();
        connectOrRefresh();
      });
    });
    if (closeButton) closeButton.addEventListener("click", closeModal);
    if (dismissButton) dismissButton.addEventListener("click", closeModal);
    if (modal) {
      modal.addEventListener("click", function (event) {
        if (event.target === modal) closeModal();
      });
      modal.addEventListener("close", markOnboardingSeen);
    }
    if (guide) guide.addEventListener("toggle", function (event) { if (event.isTrusted) guideTouched = true; });
    if (!attach()) {
      var attempts = 0;
      var timer = window.setInterval(function () {
        attempts += 1;
        if (attach() || attempts >= 100) window.clearInterval(timer);
      }, 100);
    }

    if (injectButton) injectButton.addEventListener("click", doInject);

    function refreshInjectPanel() {
      apiStatus().then(function (st) {
        injectionState.available = true;
        renderInjectButton(st || {});
        if (st && st.port_open) {
          setModalStatus(copy.ready, copy.readyDetail);
        } else if (st && st.game_running === false) {
          setModalStatus(copy.offline, "游戏没在运行。先启动《War of Genesis: Idle Loot》，再回来点注入。");
        } else if (st && st.reason) {
          setModalStatus(copy.offline, st.reason);
        }
      }, function () {
        injectionState.available = false;
        renderInjectButton({});
      });
    }

    // 页面一加载先问本地服务：已经通了就不弹窗，没通才提示注入
    apiStatus().then(function (st) {
      injectionState.available = true;
      renderInjectButton(st || {});
      if (st && (st.port_open || st.patched)) {
        markOnboardingSeen();
        closeModal();
        return;
      }
      if (root.dataset.wogLivesyncFirstVisit === "true" && !hasSeenOnboarding()) {
        window.setTimeout(function () {
          openModal();
          refreshInjectPanel();
        }, 450);
      }
    }, function () {
      injectionState.available = false;
      renderInjectButton({});
      if (root.dataset.wogLivesyncFirstVisit === "true" && !hasSeenOnboarding()) {
        window.setTimeout(openModal, 450);
      }
    });

    window.addEventListener("pagehide", function () {
      if (typeof unsubscribe === "function") unsubscribe();
    }, { once: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
