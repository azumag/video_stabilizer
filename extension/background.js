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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(SETTINGS_KEY, (stored) => {
    if (chrome.runtime.lastError || stored[SETTINGS_KEY]) {
      return;
    }
    chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  });

  chrome.action.setBadgeBackgroundColor({ color: "#6d28d9" });
  chrome.action.setBadgeText({ text: "P0" });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "VS_DIAGNOSTIC_STATUS" || !sender.tab?.id) {
    return;
  }

  const diagnostic = message.status?.diagnostic ?? {};
  const settings = message.status?.settings ?? {};
  let text = "P0";
  let color = "#6d28d9";

  if (!settings.enabled) {
    text = "OFF";
    color = "#52525b";
  } else if (diagnostic.canvas === "blocked" || diagnostic.worker === "error" || diagnostic.wasm === "error") {
    text = "ERR";
    color = "#b91c1c";
  } else if (diagnostic.canvas === "ok" && diagnostic.worker === "ok" && diagnostic.wasm === "ok") {
    text = settings.applyStabilization ? "ON" : "OK";
    color = settings.applyStabilization ? "#047857" : "#2563eb";
  }

  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color });
  chrome.action.setBadgeText({ tabId: sender.tab.id, text });
});
