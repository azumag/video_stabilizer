import {
  MotionStabilizer,
  DEFAULT_ESTIMATOR_OPTIONS,
} from "./lib/motion-estimator.js";

let stabilizer = new MotionStabilizer();
let initialized = false;
let wasmStatus = {
  ok: false,
  result: null,
  error: null,
};

async function initializeWasmProbe() {
  const wasmUrl = new URL("./wasm/probe.wasm", import.meta.url);
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`WASM fetch failed with HTTP ${response.status}`);
    }

    let instance;
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        const streamed = await WebAssembly.instantiateStreaming(response.clone(), {});
        instance = streamed.instance;
      } catch {
        const bytes = await response.arrayBuffer();
        const instantiated = await WebAssembly.instantiate(bytes, {});
        instance = instantiated.instance;
      }
    } else {
      const bytes = await response.arrayBuffer();
      const instantiated = await WebAssembly.instantiate(bytes, {});
      instance = instantiated.instance;
    }

    const result = instance.exports.add(20, 22);
    if (result !== 42) {
      throw new Error(`Unexpected WASM probe result: ${result}`);
    }

    wasmStatus = { ok: true, result, error: null };
  } catch (error) {
    wasmStatus = {
      ok: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return wasmStatus;
}

function safePostMessage(message) {
  try {
    self.postMessage(message);
  } catch (error) {
    self.postMessage({
      type: "worker-error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data ?? {};

  if (message.type === "init") {
    stabilizer = new MotionStabilizer({
      ...DEFAULT_ESTIMATOR_OPTIONS,
      ...(message.options ?? {}),
    });
    const wasm = await initializeWasmProbe();
    initialized = true;
    safePostMessage({
      type: "ready",
      wasm,
      capabilities: {
        offscreenCanvas: typeof OffscreenCanvas !== "undefined",
        webAssembly: typeof WebAssembly !== "undefined",
        moduleWorker: true,
      },
      workerUrl: self.location.href,
    });
    return;
  }

  if (message.type === "configure") {
    stabilizer.configure(message.options ?? {});
    safePostMessage({ type: "configured" });
    return;
  }

  if (message.type === "reset") {
    stabilizer.reset(message.reason ?? "requested");
    safePostMessage({ type: "reset-complete", reason: message.reason ?? "requested" });
    return;
  }

  if (message.type !== "frame") {
    return;
  }

  if (!initialized) {
    safePostMessage({
      type: "frame-result",
      id: message.id,
      error: "Worker has not been initialized",
    });
    return;
  }

  const startedAt = performance.now();
  try {
    const result = stabilizer.processRgba(
      message.buffer,
      message.width,
      message.height,
      message.timestamp,
    );
    safePostMessage({
      type: "frame-result",
      id: message.id,
      processingMs: performance.now() - startedAt,
      result,
    });
  } catch (error) {
    safePostMessage({
      type: "frame-result",
      id: message.id,
      processingMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
