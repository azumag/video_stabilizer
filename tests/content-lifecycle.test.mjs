import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const contentSource = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../extension/worker.js", import.meta.url), "utf8");

function createStyle() {
  const values = new Map();
  const priorities = new Map();
  return {
    getPropertyValue: (property) => values.get(property) ?? "",
    getPropertyPriority: (property) => priorities.get(property) ?? "",
    setProperty(property, value, priority = "") { values.set(property, String(value)); priorities.set(property, priority); },
    removeProperty(property) { values.delete(property); priorities.delete(property); },
  };
}

function createVideo(name) {
  const listeners = new Map();
  let callbackId = 0;
  let frameCallback = null;
  const video = {
    name,
    paused: false,
    ended: false,
    readyState: 4,
    videoWidth: 320,
    videoHeight: 180,
    currentSrc: `https://example.test/${name}.m3u8`,
    currentTime: 0,
    style: createStyle(),
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    requestVideoFrameCallback(callback) { callbackId += 1; frameCallback = callback; return callbackId; },
    cancelVideoFrameCallback() { frameCallback = null; },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    fire(type) { for (const callback of listeners.get(type) ?? []) callback({ type, currentTarget: video }); },
    fireFrame(now, mediaTime) {
      const callback = frameCallback;
      assert.ok(callback, `${name} has no scheduled video frame callback`);
      frameCallback = null;
      video.currentTime = mediaTime;
      callback(now, { mediaTime });
    },
  };
  return video;
}

async function createHarness(initialVideo) {
  let videos = [initialVideo];
  let observerCallback = null;
  const workers = [];
  const diagnostics = [];
  let runtimeMessageListener = null;
  let storageListener = null;
  let rafId = 0;
  const rafCallbacks = new Map();

  class FakeWorker {
    constructor() { this.messages = []; this.terminated = false; this.onmessage = null; this.onerror = null; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }

  class FakeMutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage() {},
        getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
      };
    },
  };

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage(message, callback) { diagnostics.push(message); callback?.(); },
      onMessage: { addListener(callback) { runtimeMessageListener = callback; } },
    },
    storage: {
      sync: {
        get(_key, callback) { callback({ videoStabilizerSettings: { showDiagnostics: false, applyStabilization: true } }); },
        set(_value, callback) { callback?.(); },
      },
      onChanged: { addListener(callback) { storageListener = callback; } },
    },
  };

  const context = {
    console,
    chrome,
    document: {
      hidden: false,
      documentElement: {},
      body: {},
      getElementById: () => null,
      querySelectorAll: (selector) => selector === "video" ? videos : [],
      createElement: (tag) => tag === "canvas" ? canvas : { style: {}, remove() {} },
    },
    getComputedStyle: () => ({ display: "block" }),
    MutationObserver: FakeMutationObserver,
    Worker: FakeWorker,
    Blob: class Blob { constructor(parts, options) { this.parts = parts; this.options = options; } },
    URL: { createObjectURL: () => "blob:https://example.test/worker", revokeObjectURL() {} },
    Uint8ClampedArray,
    Math,
    Number,
    Object,
    String,
    Promise,
    Error,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame(callback) { rafId += 1; rafCallbacks.set(rafId, callback); return rafId; },
    cancelAnimationFrame(id) { rafCallbacks.delete(id); },
    addEventListener() {},
  };

  vm.runInNewContext(contentSource, context, { filename: "content.js" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(workers.length, 1, "content script should start one worker");
  const worker = workers[0];
  worker.onmessage({ data: { type: "ready", wasm: { ok: true, result: 42 } } });

  return {
    worker,
    diagnostics,
    setVideos(next) { videos = next; observerCallback?.(); },
    runtimeMessageListener: () => runtimeMessageListener,
    storageListener: () => storageListener,
  };
}

function frameMessages(worker) { return worker.messages.filter((message) => message.type === "frame"); }
function resetMessages(worker) { return worker.messages.filter((message) => message.type === "reset"); }
function frameResult(frame, overrides = {}) {
  return {
    type: "frame-result",
    id: frame.id,
    generation: frame.generation,
    processingMs: 1,
    result: {
      status: "ok",
      sourceWidth: frame.width,
      sourceHeight: frame.height,
      featureCount: 20,
      confidence: 0.9,
      correction: { x: -1, y: -1, angle: 0, scale: 1 },
    },
    ...overrides,
  };
}

test("old worker results are ignored after the primary video changes", async () => {
  const videoA = createVideo("a");
  const videoB = createVideo("b");
  const harness = await createHarness(videoA);

  videoA.fireFrame(100, 0.1);
  const frameA = frameMessages(harness.worker).at(-1);
  assert.ok(frameA);

  harness.setVideos([videoB]);
  videoB.fireFrame(200, 0.2);
  const frameB = frameMessages(harness.worker).at(-1);
  assert.ok(frameB);
  assert.ok(frameB.generation > frameA.generation, `${frameA.generation} -> ${frameB.generation}`);

  const beforeOldResult = harness.diagnostics.length;
  harness.worker.onmessage({ data: frameResult(frameA) });
  assert.equal(harness.diagnostics.length, beforeOldResult, "stale result must not update diagnostics or transform state");

  harness.worker.onmessage({ data: frameResult(frameB) });
  const latest = harness.diagnostics.at(-1);
  assert.equal(latest.type, "VS_DIAGNOSTIC_STATUS");
  assert.equal(latest.status.diagnostic.processedFrames, 1);
});

test("seeking and large media-time jumps reset tracking and invalidate in-flight frames", async () => {
  const video = createVideo("vod");
  const harness = await createHarness(video);

  video.fireFrame(100, 0.1);
  let frame = frameMessages(harness.worker).at(-1);
  harness.worker.onmessage({ data: frameResult(frame) });

  const generationBeforeSeek = frame.generation;
  video.fire("seeking");
  assert.equal(resetMessages(harness.worker).at(-1).reason, "seeking");
  video.fire("seeked");
  assert.equal(resetMessages(harness.worker).at(-1).reason, "seeked");

  video.fireFrame(200, 0.2);
  frame = frameMessages(harness.worker).at(-1);
  assert.ok(frame.generation > generationBeforeSeek);
  harness.worker.onmessage({ data: frameResult(frame) });

  const framesBeforeJump = frameMessages(harness.worker).length;
  video.fireFrame(300, 12);
  assert.equal(resetMessages(harness.worker).at(-1).reason, "timestamp-discontinuity");
  assert.equal(frameMessages(harness.worker).length, framesBeforeJump, "jump frame becomes a reset boundary, not motion input");
  const latest = harness.diagnostics.at(-1);
  assert.equal(latest.status.diagnostic.trackingStatus, "waiting-frame");
  assert.equal(latest.status.diagnostic.correction, null);
});

test("worker echoes generation on every frame result path", () => {
  const generationEchoes = workerSource.match(/generation: message\.generation/g) ?? [];
  assert.ok(generationEchoes.length >= 3, `expected generation on success and error paths, got ${generationEchoes.length}`);
});