(() => {
  "use strict";
  const KEY = "videoStabilizerSettings";
  const DEFAULTS = { enabled: true, applyStabilization: false, showDiagnostics: true, analysisMaxDimension: 320, analysisFps: 15, smoothingRadius: 12, cropZoom: 1.03, minConfidence: 0.3 };
  const state = { settings: { ...DEFAULTS }, video: null, worker: null, ready: false, busy: false, canvas: null, context: null, callback: null, callbackType: null, lastSample: 0, frame: 0, generation: 0, activeFrameId: null, lastMediaTime: null, source: "", originalStyle: null, canvasBlockedUntil: 0,
    target: null, applied: { x: 0, y: 0, angle: 0, scale: 1 }, rafHandle: null, lastRafTime: 0,
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
    if (state.rafHandle != null) { cancelAnimationFrame(state.rafHandle); state.rafHandle = null; }
    state.target = null; state.applied = { x: 0, y: 0, angle: 0, scale: 1 };
    if (!state.video || !state.originalStyle) return;
    for (const [property, style] of Object.entries(state.originalStyle)) style.value ? state.video.style.setProperty(property, style.value, style.priority) : state.video.style.removeProperty(property);
    state.originalStyle = null;
  }

  const APPLIED_REST_EPSILON = { x: 0.05, y: 0.05, angle: 0.0005, scale: 0.0003 };

  // Worker results land at analysisFps (typically 15Hz); applying each one
  // straight to the CSS transform turned smooth real motion into a
  // sample-and-hold sawtooth at display framerate (~60Hz), which itself reads
  // as fine jitter. Instead each result only updates a `target`, and a
  // requestAnimationFrame loop eases `applied` toward it every display frame.
  // The time constant shrinks for larger steps so genuine motion is still
  // followed promptly, while small steps (mostly measurement noise) are
  // filtered more heavily.
  function stepTowardTarget(deltaMs) {
    const target = state.target ?? { x: 0, y: 0, angle: 0, scale: 1 };
    const stepPixels = Math.hypot(target.x - state.applied.x, target.y - state.applied.y);
    const tauMs = clamp(70 - stepPixels * 3, 25, 70);
    const alpha = 1 - Math.exp(-deltaMs / tauMs);
    state.applied = {
      x: state.applied.x + (target.x - state.applied.x) * alpha,
      y: state.applied.y + (target.y - state.applied.y) * alpha,
      angle: state.applied.angle + (target.angle - state.applied.angle) * alpha,
      scale: state.applied.scale + (target.scale - state.applied.scale) * alpha,
    };
  }

  function renderTransformFrame(now) {
    state.rafHandle = null;
    if (!state.video) return;
    const deltaMs = state.lastRafTime ? Math.min(64, now - state.lastRafTime) : 16;
    state.lastRafTime = now;
    stepTowardTarget(deltaMs);
    const atRestIdentity = state.target == null &&
      Math.abs(state.applied.x) < APPLIED_REST_EPSILON.x && Math.abs(state.applied.y) < APPLIED_REST_EPSILON.y &&
      Math.abs(state.applied.angle) < APPLIED_REST_EPSILON.angle && Math.abs(state.applied.scale - 1) < APPLIED_REST_EPSILON.scale;
    if (atRestIdentity) { restoreTransform(); return; }
    if (!state.originalStyle) {
      state.originalStyle = Object.fromEntries(["transform", "transform-origin", "transition", "will-change"].map((property) => [property, { value: state.video.style.getPropertyValue(property), priority: state.video.style.getPropertyPriority(property) }]));
      state.video.style.setProperty("transform-origin", "50% 50%", "important"); state.video.style.setProperty("transition", "none", "important"); state.video.style.setProperty("will-change", "transform", "important");
    }
    state.video.style.setProperty("transform", `translate3d(${state.applied.x.toFixed(3)}px,${state.applied.y.toFixed(3)}px,0) rotate(${state.applied.angle.toFixed(6)}rad) scale(${state.applied.scale.toFixed(6)})`, "important");
    state.rafHandle = requestAnimationFrame(renderTransformFrame);
  }

  function ensureRenderLoop() {
    if (state.rafHandle == null && state.video) { state.lastRafTime = 0; state.rafHandle = requestAnimationFrame(renderTransformFrame); }
  }

  function applyTransform(result) {
    if (!state.video || !state.settings.applyStabilization) { restoreTransform(); return; }
    // A confident correction becomes the new interpolation target; anything
    // else (missing correction, or confidence below the threshold) fades
    // translation/rotation back to neutral instead of freezing whatever was
    // last applied. Scale stays at cropZoom (not 1) so toggling in and out of
    // "confident" near the threshold doesn't also pulse the zoom level.
    if (!result?.correction || (result.status === "ok" && result.confidence < state.settings.minConfidence)) { state.target = { x: 0, y: 0, angle: 0, scale: state.settings.cropZoom }; ensureRenderLoop(); return; }
    const rect = state.video.getBoundingClientRect(); const x = result.correction.x * rect.width / result.sourceWidth; const y = result.correction.y * rect.height / result.sourceHeight;
    const scale = clamp(state.settings.cropZoom * result.correction.scale, 0.92, 1.2);
    state.target = { x, y, angle: result.correction.angle, scale };
    ensureRenderLoop();
  }

  function startWorker() {
    if (state.worker || !state.settings.enabled) return;
    update({ worker: "starting", wasm: "pending", lastError: null });
    try {
      // Chromeはcontent script(ページorigin)からのWorker生成時に、chrome-extension://の
      // スクリプトURLを直接渡すと「cannot be accessed from origin」で拒否する
      // (web_accessible_resourcesはWorker()自体の同一オリジン判定を免除しない)。
      // 同一origin(このページ)で生成したBlob URLをブートストラップとして経由させ、
      // その中でchrome-extension://の実体をimportすることで、web_accessible_resources
      // に基づく通常のモジュール解決経路に載せる。
      const scriptUrl = chrome.runtime.getURL("worker.js");
      const blobUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(scriptUrl)};`], { type: "text/javascript" }));
      const releaseBlobUrl = () => URL.revokeObjectURL(blobUrl);
      const worker = new Worker(blobUrl, { type: "module", name: "twitch-video-stabilizer" }); state.worker = worker;
      const timeout = setTimeout(() => { if (!state.ready) { releaseBlobUrl(); update({ worker: "error", lastError: "Worker起動がタイムアウトしました" }); } }, 3000);
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") { clearTimeout(timeout); releaseBlobUrl(); state.ready = true; update({ worker: "ok", wasm: data.wasm?.ok ? "ok" : "error", wasmResult: data.wasm?.result ?? null, lastError: data.wasm?.ok ? null : `WASM: ${data.wasm?.error}` }); return; }
        if (data.type === "frame-result") {
          if (data.generation !== state.generation || data.id !== state.activeFrameId) return;
          state.busy = false; state.activeFrameId = null;
          if (data.error) { update({ trackingStatus: "error", lastError: data.error }); return; }
          const result = data.result; update({ processedFrames: state.status.processedFrames + 1, processingMs: data.processingMs, featureCount: result.featureCount, confidence: result.confidence, trackingStatus: result.status, correction: result.correction, lastError: null }); applyTransform(result);
        }
      };
      worker.onerror = (event) => { releaseBlobUrl(); state.busy = false; state.activeFrameId = null; update({ worker: "error", lastError: `Worker: ${event.message || "起動失敗"}` }); };
      worker.postMessage({ type: "init", options: { smoothingRadius: state.settings.smoothingRadius, trackingMaxDimension: Math.min(240, state.settings.analysisMaxDimension) } });
    } catch (error) { update({ worker: "error", lastError: `Workerを作成できません: ${error.message || error}` }); }
  }

  function stopWorker() { state.generation += 1; state.activeFrameId = null; state.lastMediaTime = null; state.worker?.terminate(); state.worker = null; state.ready = false; state.busy = false; }
  function resetWorker(reason) {
    state.generation += 1; state.activeFrameId = null; state.lastMediaTime = null;
    if (state.ready) state.worker.postMessage({ type: "reset", reason, generation: state.generation });
    state.busy = false;
  }

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

  const CANVAS_BLOCKED_RETRY_MS = 15000;
  const TIMESTAMP_DISCONTINUITY_SECONDS = 1;
  const TIMESTAMP_BACKWARD_TOLERANCE_SECONDS = 0.25;
  const PLAYBACK_BOUNDARY_EVENTS = ["seeking", "seeked", "loadstart", "emptied"];

  function handlePlaybackBoundary(event) {
    if (event.currentTarget !== state.video) return;
    state.source = ""; state.lastSample = 0; state.canvasBlockedUntil = 0;
    resetWorker(event.type); restoreTransform();
    update({ trackingStatus: "waiting-frame", correction: null });
  }

  function attach(video) {
    if (video === state.video) return;
    if (state.video) for (const type of PLAYBACK_BOUNDARY_EVENTS) state.video.removeEventListener(type, handlePlaybackBoundary);
    cancelFrame(); restoreTransform(); state.video = video; state.source = ""; state.lastSample = 0; state.canvasBlockedUntil = 0; resetWorker("video-change");
    update({ videoDetected: Boolean(video), sourceSize: video?.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : null, analysisSize: null, canvas: "pending", trackingStatus: video ? "waiting-frame" : "idle", correction: null });
    if (video) { for (const type of PLAYBACK_BOUNDARY_EVENTS) video.addEventListener(type, handlePlaybackBoundary); scheduleFrame(); }
  }

  function sample(now, metadata) {
    if (!state.settings.enabled || !state.ready || state.busy || !state.video || state.video.paused || state.video.ended || document.hidden) return;
    if (now - state.lastSample < 1000 / state.settings.analysisFps || state.video.readyState < 2 || !state.video.videoWidth) return;
    const mediaTime = Number(metadata.mediaTime ?? state.video.currentTime);
    const source = `${state.video.currentSrc}|${state.video.videoWidth}x${state.video.videoHeight}`;
    if (source !== state.source) { state.source = source; state.canvasBlockedUntil = 0; resetWorker("source-change"); }
    const hasMediaTime = Number.isFinite(mediaTime);
    const timestampDiscontinuity = hasMediaTime && state.lastMediaTime != null &&
      (mediaTime < state.lastMediaTime - TIMESTAMP_BACKWARD_TOLERANCE_SECONDS || mediaTime - state.lastMediaTime > TIMESTAMP_DISCONTINUITY_SECONDS);
    if (timestampDiscontinuity) {
      resetWorker("timestamp-discontinuity"); restoreTransform(); state.lastMediaTime = mediaTime;
      update({ trackingStatus: "waiting-frame", correction: null });
      return;
    }
    if (hasMediaTime) state.lastMediaTime = mediaTime;
    // A SecurityError (tainted/DRM canvas) won't clear up until the source changes, so back off
    // instead of retrying drawImage()/getImageData() and re-notifying on every video frame.
    if (state.canvasBlockedUntil && now < state.canvasBlockedUntil) return;
    const scale = Math.min(1, state.settings.analysisMaxDimension / Math.max(state.video.videoWidth, state.video.videoHeight)); const width = Math.max(32, Math.round(state.video.videoWidth * scale)); const height = Math.max(32, Math.round(state.video.videoHeight * scale));
    try {
      state.canvas ??= document.createElement("canvas"); state.context ??= state.canvas.getContext("2d", { alpha: false, willReadFrequently: true }); if (!state.context) throw new Error("2D Contextを作成できません");
      if (state.canvas.width !== width || state.canvas.height !== height) { state.canvas.width = width; state.canvas.height = height; }
      state.context.drawImage(state.video, 0, 0, width, height); const image = state.context.getImageData(0, 0, width, height); state.lastSample = now; state.busy = true; state.frame += 1; state.activeFrameId = state.frame;
      state.canvasBlockedUntil = 0;
      update({ canvas: "ok", sourceSize: `${state.video.videoWidth}×${state.video.videoHeight}`, analysisSize: `${width}×${height}`, lastError: null });
      state.worker.postMessage({ type: "frame", id: state.activeFrameId, generation: state.generation, width, height, timestamp: hasMediaTime ? mediaTime : 0, buffer: image.data.buffer }, [image.data.buffer]);
    } catch (error) {
      state.busy = false; state.activeFrameId = null; state.lastSample = now;
      const blocked = error?.name === "SecurityError";
      if (blocked) state.canvasBlockedUntil = now + CANVAS_BLOCKED_RETRY_MS;
      update({ canvas: blocked ? "blocked" : "error", lastError: blocked ? "Twitch映像のCanvas画素取得がSecurityErrorで拒否されました" : `Canvas: ${error.message || error}` });
    }
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
