(() => {
  "use strict";
  const KEY = "videoStabilizerSettings";
  const DEFAULTS = { enabled: true, applyStabilization: false, showDiagnostics: true, analysisMaxDimension: 320, analysisFps: 15, smoothingRadius: 12, cropZoom: 1.03, minConfidence: 0.3 };
  const state = { settings: { ...DEFAULTS }, video: null, worker: null, ready: false, busy: false, canvas: null, context: null, callback: null, callbackType: null, lastSample: 0, frame: 0, source: "", originalStyle: null,
    status: { videoDetected: false, sourceSize: null, analysisSize: null, canvas: "pending", worker: "pending", wasm: "pending", wasmResult: null, processedFrames: 0, processingMs: null, featureCount: 0, confidence: 0, trackingStatus: "idle", correction: null, lastError: null } };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const getStorage = () => new Promise((resolve) => chrome.storage.sync.get(KEY, (value) => { void chrome.runtime.lastError; resolve(value?.[KEY] ?? {}); }));
  const setStorage = (value) => new Promise((resolve) => chrome.storage.sync.set({ [KEY]: value }, resolve));
  const normalize = (value) => ({ enabled: value.enabled !== false, applyStabilization: value.applyStabilization === true, showDiagnostics: value.showDiagnostics !== false,
    analysisMaxDimension: clamp(Math.round(Number(value.analysisMaxDimension) || 320), 160, 640), analysisFps: clamp(Math.round(Number(value.analysisFps) || 15), 5, 30),
    smoothingRadius: clamp(Math.round(Number(value.smoothingRadius) || 12), 2, 60), cropZoom: clamp(Number(value.cropZoom) || 1.03, 1, 1.15), minConfidence: clamp(Number(value.minConfidence) || 0.3, 0, 1) });

  function overlay() {
    let host = document.getElementById("__azumag_video_stabilizer_diagnostics");
    if (!state.settings.showDiagnostics) { host?.remove(); return null; }
    if (host) return host;
    host = document.createElement("div"); host.id = "__azumag_video_stabilizer_diagnostics";
    host.style.cssText = "all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;width:292px;padding:11px 13px;border:1px solid #ffffff3d;border-radius:10px;background:#0c0c10e8;color:#f4f4f5;box-shadow:0 8px 28px #0008;font:12px/1.45 system-ui,-apple-system,sans-serif;pointer-events:none;white-space:pre-wrap";
    (document.documentElement || document.body).append(host); return host;
  }

  function word(value) { return ({ pending: "待機", starting: "起動中", ok: "OK", blocked: "取得不可", error: "エラー" })[value] ?? String(value); }
  function render() {
    const host = overlay(); if (!host) return; const s = state.status;
    const video = s.videoDetected ? `${s.sourceSize ?? "読込中"} → ${s.analysisSize ?? "待機"}` : "未検出";
    const wasm = s.wasm === "ok" ? `OK（${s.wasmResult}）` : word(s.wasm);
    const correction = !state.settings.applyStabilization ? "計測のみ（適用OFF）" : s.correction ? `x ${s.correction.x.toFixed(1)} / y ${s.correction.y.toFixed(1)} / ${(s.correction.angle * 57.2958).toFixed(2)}°` : "待機";
    host.textContent = `Twitch Video Stabilizer  [Phase 0]\n映像     ${video}\nCanvas   ${word(s.canvas)}\nWorker   ${word(s.worker)}\nWASM     ${wasm}\n解析     ${state.settings.analysisFps} fps / ${Number.isFinite(s.processingMs) ? s.processingMs.toFixed(1) : "-"} ms / ${s.processedFrames}\n追跡     ${s.trackingStatus} / ${s.featureCount}点 / ${Math.round(s.confidence * 100)}%\n補正     ${correction}${s.lastError ? `\nERROR    ${s.lastError}` : ""}`;
  }

  function update(patch) {
    Object.assign(state.status, patch);
    render();
    try {
      chrome.runtime.sendMessage({ type: "VS_DIAGNOSTIC_STATUS", status: snapshot() }, () => void chrome.runtime.lastError);
    } catch {}
  }
  function snapshot() { return { settings: { ...state.settings }, diagnostic: { ...state.status, correction: state.status.correction ? { ...state.status.correction } : null } }; }

  function restoreTransform() {
    if (!state.video || !state.originalStyle) return;
    for (const [property, value] of Object.entries(state.originalStyle)) value ? state.video.style.setProperty(property, value) : state.video.style.removeProperty(property);
    state.originalStyle = null;
  }

  function applyTransform(result) {
    if (!state.video || !state.settings.applyStabilization || !result?.correction) { restoreTransform(); return; }
    if (result.status === "ok" && result.confidence < state.settings.minConfidence) return;
    if (!state.originalStyle) state.originalStyle = Object.fromEntries(["transform", "transform-origin", "transition", "will-change"].map((property) => [property, state.video.style.getPropertyValue(property)]));
    const rect = state.video.getBoundingClientRect(); const x = result.correction.x * rect.width / result.sourceWidth; const y = result.correction.y * rect.height / result.sourceHeight;
    const scale = clamp(state.settings.cropZoom * result.correction.scale, 0.92, 1.2);
    state.video.style.setProperty("transform-origin", "50% 50%", "important"); state.video.style.setProperty("transition", "none", "important"); state.video.style.setProperty("will-change", "transform", "important");
    state.video.style.setProperty("transform", `translate3d(${x.toFixed(3)}px,${y.toFixed(3)}px,0) rotate(${result.correction.angle.toFixed(6)}rad) scale(${scale.toFixed(6)})`, "important");
  }

  function startWorker() {
    if (state.worker || !state.settings.enabled) return;
    update({ worker: "starting", wasm: "pending", lastError: null });
    try {
      const worker = new Worker(chrome.runtime.getURL("worker.js"), { type: "module", name: "twitch-video-stabilizer" }); state.worker = worker;
      const timeout = setTimeout(() => { if (!state.ready) update({ worker: "error", lastError: "Worker起動がタイムアウトしました" }); }, 3000);
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") { clearTimeout(timeout); state.ready = true; update({ worker: "ok", wasm: data.wasm?.ok ? "ok" : "error", wasmResult: data.wasm?.result ?? null, lastError: data.wasm?.ok ? null : `WASM: ${data.wasm?.error}` }); return; }
        if (data.type === "frame-result") { state.busy = false; if (data.error) { update({ trackingStatus: "error", lastError: data.error }); return; }
          const result = data.result; update({ processedFrames: state.status.processedFrames + 1, processingMs: data.processingMs, featureCount: result.featureCount, confidence: result.confidence, trackingStatus: result.status, correction: result.correction, lastError: null }); applyTransform(result); }
      };
      worker.onerror = (event) => { state.busy = false; update({ worker: "error", lastError: `Worker: ${event.message || "起動失敗"}` }); };
      worker.postMessage({ type: "init", options: { smoothingRadius: state.settings.smoothingRadius, trackingMaxDimension: Math.min(240, state.settings.analysisMaxDimension) } });
    } catch (error) { update({ worker: "error", lastError: `Workerを作成できません: ${error.message || error}` }); }
  }

  function stopWorker() { state.worker?.terminate(); state.worker = null; state.ready = false; state.busy = false; }
  function resetWorker(reason) { if (state.ready) state.worker.postMessage({ type: "reset", reason }); state.busy = false; }

  function primaryVideo() {
    return [...document.querySelectorAll("video")].filter((video) => { const rect = video.getBoundingClientRect(); return rect.width >= 160 && rect.height >= 90 && getComputedStyle(video).display !== "none"; })
      .sort((left, right) => { const a = left.getBoundingClientRect(); const b = right.getBoundingClientRect(); return b.width * b.height - a.width * a.height; })[0] ?? null;
  }

  function cancelFrame() {
    if (state.callback == null || !state.video) return;
    if (state.callbackType === "video" && state.video.cancelVideoFrameCallback) state.video.cancelVideoFrameCallback(state.callback); else cancelAnimationFrame(state.callback);
    state.callback = null;
  }

  function scheduleFrame() {
    if (!state.video) return;
    if (state.video.requestVideoFrameCallback) { state.callbackType = "video"; state.callback = state.video.requestVideoFrameCallback((now, metadata) => { state.callback = null; scheduleFrame(); sample(now, metadata); }); }
    else { state.callbackType = "animation"; state.callback = requestAnimationFrame((now) => { state.callback = null; scheduleFrame(); sample(now, { mediaTime: state.video?.currentTime }); }); }
  }

  function attach(video) {
    if (video === state.video) return; cancelFrame(); restoreTransform(); state.video = video; state.source = ""; state.lastSample = 0; resetWorker("video-change");
    update({ videoDetected: Boolean(video), sourceSize: video?.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : null, analysisSize: null, canvas: "pending", trackingStatus: video ? "waiting-frame" : "idle" });
    if (video) scheduleFrame();
  }

  function sample(now, metadata) {
    if (!state.settings.enabled || !state.ready || state.busy || !state.video || state.video.paused || state.video.ended || document.hidden) return;
    if (now - state.lastSample < 1000 / state.settings.analysisFps || state.video.readyState < 2 || !state.video.videoWidth) return;
    const source = `${state.video.currentSrc}|${state.video.videoWidth}x${state.video.videoHeight}`; if (source !== state.source) { state.source = source; resetWorker("source-change"); }
    const scale = Math.min(1, state.settings.analysisMaxDimension / Math.max(state.video.videoWidth, state.video.videoHeight)); const width = Math.max(32, Math.round(state.video.videoWidth * scale)); const height = Math.max(32, Math.round(state.video.videoHeight * scale));
    try {
      state.canvas ??= document.createElement("canvas"); state.context ??= state.canvas.getContext("2d", { alpha: false, willReadFrequently: true }); if (!state.context) throw new Error("2D Contextを作成できません");
      if (state.canvas.width !== width || state.canvas.height !== height) { state.canvas.width = width; state.canvas.height = height; }
      state.context.drawImage(state.video, 0, 0, width, height); const image = state.context.getImageData(0, 0, width, height); state.lastSample = now; state.busy = true; state.frame += 1;
      update({ canvas: "ok", sourceSize: `${state.video.videoWidth}×${state.video.videoHeight}`, analysisSize: `${width}×${height}`, lastError: null });
      state.worker.postMessage({ type: "frame", id: state.frame, width, height, timestamp: metadata.mediaTime ?? state.video.currentTime, buffer: image.data.buffer }, [image.data.buffer]);
    } catch (error) { state.busy = false; update({ canvas: error?.name === "SecurityError" ? "blocked" : "error", lastError: error?.name === "SecurityError" ? "Twitch映像のCanvas画素取得がSecurityErrorで拒否されました" : `Canvas: ${error.message || error}` }); }
  }

  async function applySettings(patch, persist = false) {
    state.settings = normalize({ ...state.settings, ...patch }); if (persist) await setStorage(state.settings); overlay();
    if (!state.settings.enabled) { stopWorker(); restoreTransform(); update({ trackingStatus: "disabled" }); }
    else { startWorker(); attach(primaryVideo()); if (state.ready) state.worker.postMessage({ type: "configure", options: { smoothingRadius: state.settings.smoothingRadius, trackingMaxDimension: Math.min(240, state.settings.analysisMaxDimension) } }); }
    if (!state.settings.applyStabilization) restoreTransform(); render(); return snapshot();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "VS_GET_STATUS") { sendResponse(snapshot()); return false; }
    if (message?.type === "VS_APPLY_SETTINGS") { applySettings(message.settings, true).then(sendResponse); return true; }
    if (message?.type === "VS_RESET") { resetWorker("popup"); restoreTransform(); update({ trackingStatus: "reset", correction: null }); sendResponse(snapshot()); return false; }
    return undefined;
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "sync" && changes[KEY]) void applySettings(changes[KEY].newValue); });

  async function initialize() {
    state.settings = normalize({ ...DEFAULTS, ...await getStorage() }); render(); if (state.settings.enabled) startWorker(); attach(primaryVideo());
    new MutationObserver(() => attach(primaryVideo())).observe(document.documentElement, { childList: true, subtree: true }); setInterval(() => attach(primaryVideo()), 1000);
    addEventListener("pagehide", () => { cancelFrame(); restoreTransform(); stopWorker(); }, { once: true });
  }
  void initialize();
})();
