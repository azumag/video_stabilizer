(() => {
  "use strict";

  const SETTINGS_KEY = "videoStabilizerSettings";
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    applyStabilization: false,
    showDiagnostics: true,
    analysisMaxDimension: 320,
    analysisFps: 15,
    smoothingRadius: 12,
    cropZoom: 1.03,
    minConfidence: 0.3,
  });

  const elements = Object.fromEntries(
    Array.from(document.querySelectorAll("[id]")).map((element) => [element.id, element]),
  );

  let settings = { ...DEFAULT_SETTINGS };
  let activeTabId = null;

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(key, (value) => {
        void chrome.runtime.lastError;
        resolve(value ?? {});
      });
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(value, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  function queryActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        void chrome.runtime.lastError;
        resolve(tabs[0] ?? null);
      });
    });
  }

  function sendToTab(message) {
    return new Promise((resolve) => {
      if (!activeTabId) {
        resolve(null);
        return;
      }
      chrome.tabs.sendMessage(activeTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response ?? null);
      });
    });
  }

  function statusWord(value) {
    const words = {
      pending: "待機",
      starting: "起動中",
      ok: "OK",
      blocked: "取得不可",
      error: "エラー",
      unavailable: "利用不可",
    };
    return words[value] ?? value ?? "-";
  }

  function renderSettings() {
    elements.enabled.checked = settings.enabled;
    elements.applyStabilization.checked = settings.applyStabilization;
    elements.showDiagnostics.checked = settings.showDiagnostics;
    elements.analysisMaxDimension.value = String(settings.analysisMaxDimension);
    elements.analysisFps.value = String(settings.analysisFps);
    elements.smoothingRadius.value = String(settings.smoothingRadius);
    elements.cropZoom.value = String(settings.cropZoom);
    elements.smoothingRadiusValue.textContent = `${settings.smoothingRadius} frames`;
    elements.cropZoomValue.textContent = `${((settings.cropZoom - 1) * 100).toFixed(1)}%`;
    elements.applyStabilization.disabled = !settings.enabled;
  }

  function renderStatus(response) {
    if (!response) {
      elements.statusVideo.textContent = "Twitchページと未接続";
      elements.statusCanvas.textContent = "-";
      elements.statusWorker.textContent = "-";
      elements.statusWasm.textContent = "-";
      elements.statusProcessing.textContent = "-";
      elements.statusTracking.textContent = "-";
      elements.statusMessage.textContent = "Twitchの配信またはVODページを開き、再読み込みしてください。";
      elements.statusMessage.classList.add("visible");
      return;
    }

    const diagnostic = response.diagnostic ?? {};
    elements.statusVideo.textContent = diagnostic.videoDetected
      ? `${diagnostic.sourceSize ?? "読込中"} → ${diagnostic.analysisSize ?? "待機"}`
      : "未検出";
    elements.statusCanvas.textContent = statusWord(diagnostic.canvas);
    elements.statusWorker.textContent = statusWord(diagnostic.worker);
    elements.statusWasm.textContent = diagnostic.wasm === "ok"
      ? `OK（add=${diagnostic.wasmResult}）`
      : statusWord(diagnostic.wasm);
    elements.statusProcessing.textContent = Number.isFinite(diagnostic.processingMs)
      ? `${diagnostic.processingMs.toFixed(1)} ms`
      : "-";
    elements.statusTracking.textContent = `${diagnostic.trackingStatus ?? "idle"} / ${diagnostic.featureCount ?? 0}点 / ${Math.round((diagnostic.confidence ?? 0) * 100)}%`;
    elements.statusMessage.textContent = diagnostic.lastError ?? "";
    elements.statusMessage.classList.toggle("visible", Boolean(diagnostic.lastError));
  }

  async function persistAndApply(patch) {
    settings = { ...settings, ...patch };
    renderSettings();
    await storageSet({ [SETTINGS_KEY]: settings });
    const response = await sendToTab({
      type: "VS_APPLY_SETTINGS",
      settings,
    });
    renderStatus(response);
  }

  function installControlHandlers() {
    elements.enabled.addEventListener("change", () => {
      void persistAndApply({ enabled: elements.enabled.checked });
    });
    elements.applyStabilization.addEventListener("change", () => {
      void persistAndApply({ applyStabilization: elements.applyStabilization.checked });
    });
    elements.showDiagnostics.addEventListener("change", () => {
      void persistAndApply({ showDiagnostics: elements.showDiagnostics.checked });
    });
    elements.analysisMaxDimension.addEventListener("change", () => {
      void persistAndApply({ analysisMaxDimension: Number(elements.analysisMaxDimension.value) });
    });
    elements.analysisFps.addEventListener("change", () => {
      void persistAndApply({ analysisFps: Number(elements.analysisFps.value) });
    });
    elements.smoothingRadius.addEventListener("input", () => {
      elements.smoothingRadiusValue.textContent = `${elements.smoothingRadius.value} frames`;
    });
    elements.smoothingRadius.addEventListener("change", () => {
      void persistAndApply({ smoothingRadius: Number(elements.smoothingRadius.value) });
    });
    elements.cropZoom.addEventListener("input", () => {
      elements.cropZoomValue.textContent = `${((Number(elements.cropZoom.value) - 1) * 100).toFixed(1)}%`;
    });
    elements.cropZoom.addEventListener("change", () => {
      void persistAndApply({ cropZoom: Number(elements.cropZoom.value) });
    });
    elements.refresh.addEventListener("click", async () => {
      renderStatus(await sendToTab({ type: "VS_GET_STATUS" }));
    });
    elements.reset.addEventListener("click", async () => {
      renderStatus(await sendToTab({ type: "VS_RESET" }));
    });
  }

  async function initialize() {
    const stored = await storageGet(SETTINGS_KEY);
    settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
    const tab = await queryActiveTab();
    activeTabId = tab?.id ?? null;
    renderSettings();
    installControlHandlers();
    renderStatus(await sendToTab({ type: "VS_GET_STATUS" }));
  }

  void initialize();
})();
