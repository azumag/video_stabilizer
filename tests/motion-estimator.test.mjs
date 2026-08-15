import assert from "node:assert/strict";
import test from "node:test";

import {
  MotionStabilizer,
  detectFeatures,
  estimateSimilarityRansac,
  rgbaToGrayscale,
  trackFeatures,
} from "../extension/lib/motion-estimator.js";

function createPattern(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  let seed = 0x12345678;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const centers = Array.from({ length: 42 }, () => ({
    x: Math.floor(random() * width),
    y: Math.floor(random() * height),
    radius: 2 + Math.floor(random() * 7),
    value: 50 + Math.floor(random() * 190),
  }));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 18 + ((x * 3 + y * 2) % 35);
      for (const center of centers) {
        const dx = x - center.x;
        const dy = y - center.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= center.radius) {
          value = Math.max(value, center.value - distance * 12);
        }
      }
      if ((x % 31 < 3 && y % 23 < 12) || (y % 29 < 3 && x % 19 < 10)) {
        value = Math.min(255, value + 80);
      }
      const index = (y * width + x) * 4;
      rgba[index] = value;
      rgba[index + 1] = value;
      rgba[index + 2] = value;
      rgba[index + 3] = 255;
    }
  }
  return rgba;
}

function shiftGraySubpixel(gray, width, height, dx, dy) {
  const result = new Uint8Array(gray.length);
  const sample = (sourceX, sourceY) => {
    const clampedX = Math.min(width - 1, Math.max(0, sourceX));
    const clampedY = Math.min(height - 1, Math.max(0, sourceY));
    return gray[clampedY * width + clampedX];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - dx;
      const sourceY = y - dy;
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const fx = sourceX - x0;
      const fy = sourceY - y0;
      const top = sample(x0, y0) * (1 - fx) + sample(x0 + 1, y0) * fx;
      const bottom = sample(x0, y0 + 1) * (1 - fx) + sample(x0 + 1, y0 + 1) * fx;
      result[y * width + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return result;
}

function translateRgba(source, width, height, dx, dy) {
  const result = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - dx;
      const sourceY = y - dy;
      const targetIndex = (y * width + x) * 4;
      if (sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height) {
        const sourceIndex = (sourceY * width + sourceX) * 4;
        result[targetIndex] = source[sourceIndex];
        result[targetIndex + 1] = source[sourceIndex + 1];
        result[targetIndex + 2] = source[sourceIndex + 2];
        result[targetIndex + 3] = 255;
      } else {
        result[targetIndex + 3] = 255;
      }
    }
  }
  return result;
}

test("RGBA is converted to deterministic luma", () => {
  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
  ]);
  assert.deepEqual([...rgbaToGrayscale(rgba, 3, 1)], [76, 149, 28]);
});

test("feature detection and patch tracking recover a small translation", () => {
  const width = 128;
  const height = 96;
  const dx = 4;
  const dy = -3;
  const firstRgba = createPattern(width, height);
  const secondRgba = translateRgba(firstRgba, width, height, dx, dy);
  const first = rgbaToGrayscale(firstRgba, width, height);
  const second = rgbaToGrayscale(secondRgba, width, height);
  const options = {
    searchRadius: 7,
    maxFeatures: 100,
    maxPatchError: 45,
    uniquenessRatio: 0.99,
    forwardBackwardThreshold: 2.1,
  };
  const features = detectFeatures(first, width, height, options);
  const matches = trackFeatures(first, second, width, height, features, options);

  assert.ok(features.length >= 15, `expected features, got ${features.length}`);
  assert.ok(matches.length >= 8, `expected tracks, got ${matches.length}`);

  const model = estimateSimilarityRansac(matches, {
    ...options,
    ransacThreshold: 1.5,
    minInlierRatio: 0.4,
  });
  assert.ok(model);
  assert.ok(Math.abs(model.tx - dx) < 0.8, `tx=${model.tx}`);
  assert.ok(Math.abs(model.ty - dy) < 0.8, `ty=${model.ty}`);
  assert.ok(model.inlierRatio > 0.7, `inlierRatio=${model.inlierRatio}`);
});

test("bestPatch recovers sub-pixel motion instead of snapping it to zero", () => {
  // Regression: integer-only patch matching rounded any motion under ~0.5px
  // to exactly zero. MotionStabilizer's correction formula (smooth(trajectory)
  // - trajectory) then fed that rounding error straight back out as an
  // opposing CSS transform, so real footage with small/slow motion showed
  // visible jitter that the uncorrected source didn't have. A sub-pixel
  // shifted frame pair should recover a non-zero, roughly-correct estimate
  // instead of collapsing to 0.
  const width = 128;
  const height = 96;
  const dx = 0.3;
  const dy = -0.25;
  const first = rgbaToGrayscale(createPattern(width, height), width, height);
  const second = shiftGraySubpixel(first, width, height, dx, dy);
  const options = {
    searchRadius: 7,
    maxFeatures: 100,
    maxPatchError: 45,
    uniquenessRatio: 0.99,
    forwardBackwardThreshold: 2.1,
  };
  const features = detectFeatures(first, width, height, options);
  const matches = trackFeatures(first, second, width, height, features, options);
  assert.ok(matches.length >= 8, `expected tracks, got ${matches.length}`);

  const meanU = matches.reduce((sum, match) => sum + (match.u - match.x), 0) / matches.length;
  const meanV = matches.reduce((sum, match) => sum + (match.v - match.y), 0) / matches.length;
  assert.ok(Math.abs(meanU) > 0.1, `expected non-zero sub-pixel x recovery, got ${meanU}`);
  assert.ok(Math.abs(meanV) > 0.08, `expected non-zero sub-pixel y recovery, got ${meanV}`);
  assert.ok(Math.abs(meanU - dx) < 0.25, `meanU=${meanU} too far from dx=${dx}`);
  assert.ok(Math.abs(meanV - dy) < 0.25, `meanV=${meanV} too far from dy=${dy}`);
});

test("estimateSimilarityRansac's hint keeps tracking the same cluster instead of flipping to a newly-larger one", () => {
  // Regression: without a hint, RANSAC always adopts whichever cluster of
  // matches is currently largest. A scene with a static background and a
  // moving foreground (e.g. a streamer's face-cam over game footage) can have
  // the foreground cluster grow to outnumber the background from one frame to
  // the next, which used to make the estimated model jump onto the
  // foreground's unrelated motion, producing a large spurious correction.
  const clusterA = (count) => Array.from({ length: count }, (_, index) => {
    const x = 10 + (index % 5) * 15;
    const y = 10 + Math.floor(index / 5) * 15;
    return { x, y, u: x, v: y }; // identity transform (the static background)
  });
  const clusterB = (count) => Array.from({ length: count }, (_, index) => {
    const x = 5 + (index % 7) * 10;
    const y = 60 + Math.floor(index / 7) * 10;
    return { x, y, u: x + 20, v: y - 15 }; // tx=20, ty=-15 (the moving foreground)
  });
  const options = { ransacIterations: 200, ransacThreshold: 0.5, minTrackedPoints: 2, hintAgreementRatio: 0.9 };

  const frameNMatches = [...clusterA(15), ...clusterB(14)];
  const modelN = estimateSimilarityRansac(frameNMatches, options);
  assert.ok(modelN);
  assert.ok(Math.abs(modelN.tx) < 0.1, `frame N should lock onto the larger cluster A, tx=${modelN.tx}`);

  const frameN1Matches = [...clusterA(15), ...clusterB(16)];

  const withoutHint = estimateSimilarityRansac(frameN1Matches, options);
  assert.ok(withoutHint);
  assert.ok(Math.abs(withoutHint.tx - 20) < 0.1, `without a hint, cluster B (now larger) should win, tx=${withoutHint.tx}`);

  const hint = { a: modelN.a, b: modelN.b, tx: modelN.tx, ty: modelN.ty };
  const withHint = estimateSimilarityRansac(frameN1Matches, options, 12345, hint);
  assert.ok(withHint);
  assert.ok(Math.abs(withHint.tx) < 0.1, `with a hint, should stay on cluster A instead of flipping, tx=${withHint.tx}`);
});

test("MotionStabilizer rejects a single spurious motion spike instead of applying it", () => {
  // Regression: a single-frame RANSAC mis-lock used to feed straight into
  // trajectory and show up as a large, one-frame correction spike. A steady
  // run of small consistent motions followed by one wildly different frame
  // should be rejected like a tracking failure instead of being applied.
  const width = 160;
  const height = 100;
  const base = createPattern(width, height);
  const stabilizerOptions = {
    trackingMaxDimension: 160,
    searchRadius: 8,
    smoothingRadius: 8,
    sceneCutThreshold: 255,
    maxPatchError: 45,
    uniquenessRatio: 0.99,
    forwardBackwardThreshold: 2.1,
    spikeThreshold: 2.5,
  };
  const stabilizer = new MotionStabilizer(stabilizerOptions);
  let frame = base;
  assert.equal(stabilizer.processRgba(frame, width, height, 0).status, "initialized");
  for (let step = 1; step <= 4; step += 1) {
    frame = translateRgba(base, width, height, step, 0);
    const result = stabilizer.processRgba(frame, width, height, step / 30);
    assert.equal(result.status, "ok", JSON.stringify(result));
  }
  const spikeFrame = translateRgba(base, width, height, 40, 30);
  const spikeResult = stabilizer.processRgba(spikeFrame, width, height, 5 / 30);
  assert.equal(spikeResult.status, "tracking-failed", JSON.stringify(spikeResult));
});

test("MotionStabilizer recovers once a faster motion becomes sustained instead of rejecting it forever", () => {
  // Regression: the spike gate's recentMotion buffer used to update only on
  // accepted frames, so once real motion exceeded spikeThreshold/frame, every
  // later frame of that same motion kept comparing against a stale median and
  // was rejected forever (verified during review: 12 consecutive frames of a
  // steady, fully-trackable pan never recovered). Feeding the buffer
  // regardless of accept/reject lets a *sustained* new motion become the
  // buffer's majority within a few frames, reopening the gate.
  const width = 160;
  const height = 100;
  const base = createPattern(width, height);
  const stabilizer = new MotionStabilizer({
    trackingMaxDimension: 160,
    searchRadius: 10,
    smoothingRadius: 8,
    sceneCutThreshold: 255,
    maxPatchError: 45,
    uniquenessRatio: 0.99,
    forwardBackwardThreshold: 2.1,
    spikeThreshold: 2.5,
  });
  let offset = 0;
  assert.equal(stabilizer.processRgba(base, width, height, 0).status, "initialized");
  for (let step = 1; step <= 3; step += 1) {
    offset += 1; // warm-up: 1px/frame, well under spikeThreshold
    const result = stabilizer.processRgba(translateRgba(base, width, height, offset, 0), width, height, step / 30);
    assert.equal(result.status, "ok", JSON.stringify(result));
  }
  const statuses = [];
  for (let step = 4; step <= 10; step += 1) {
    offset += 6; // sustained pan well above spikeThreshold
    statuses.push(stabilizer.processRgba(translateRgba(base, width, height, offset, 0), width, height, step / 30).status);
  }
  assert.ok(statuses.includes("ok"), `expected the sustained pan to eventually be accepted, got ${JSON.stringify(statuses)}`);
});

test("RANSAC rejects outliers and estimates a similarity transform", () => {
  const angle = 0.035;
  const scale = 1.012;
  const a = Math.cos(angle) * scale;
  const b = Math.sin(angle) * scale;
  const tx = 3.5;
  const ty = -2.25;
  const matches = [];

  for (let index = 0; index < 30; index += 1) {
    const x = 10 + (index % 6) * 13;
    const y = 8 + Math.floor(index / 6) * 11;
    matches.push({
      x,
      y,
      u: a * x - b * y + tx,
      v: b * x + a * y + ty,
    });
  }
  matches.push(
    { x: 2, y: 3, u: 90, v: 10 },
    { x: 70, y: 40, u: 1, v: 80 },
    { x: 20, y: 70, u: 110, v: 2 },
  );

  const model = estimateSimilarityRansac(matches, {
    ransacThreshold: 0.5,
    ransacIterations: 100,
  });
  assert.ok(model);
  assert.ok(Math.abs(model.tx - tx) < 1e-6);
  assert.ok(Math.abs(model.ty - ty) < 1e-6);
  assert.ok(Math.abs(model.angle - angle) < 1e-6);
  assert.ok(Math.abs(model.scale - scale) < 1e-6);
  assert.equal(model.inlierCount, 30);
});

test("MotionStabilizer detects a scene cut even when only a stride-4 sample would miss it", () => {
  // Regression test for #2: frameDifference() used to walk the grayscale
  // buffer (1 byte/pixel) with a stride of 4, so it only ever compared the
  // pixels at x % 4 === 0. A frame where exactly those columns stay black
  // and everything else turns white looks unchanged to that sampling, even
  // though ~75% of the frame changed.
  const width = 64;
  const height = 64;
  const firstRgba = new Uint8ClampedArray(width * height * 4).fill(0);
  for (let index = 3; index < firstRgba.length; index += 4) firstRgba[index] = 255; // alpha
  const secondRgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x % 4 === 0 ? 0 : 255;
      const index = (y * width + x) * 4;
      secondRgba[index] = value;
      secondRgba[index + 1] = value;
      secondRgba[index + 2] = value;
      secondRgba[index + 3] = 255;
    }
  }

  const stabilizer = new MotionStabilizer({ trackingMaxDimension: width, sceneCutThreshold: 58 });
  assert.equal(stabilizer.processRgba(firstRgba, width, height, 0).status, "initialized");
  const result = stabilizer.processRgba(secondRgba, width, height, 1 / 30);
  assert.equal(result.status, "scene-cut", JSON.stringify(result));
});

test("MotionStabilizer returns an opposing correction for translated frames", () => {
  const width = 160;
  const height = 100;
  const first = createPattern(width, height);
  const second = translateRgba(first, width, height, 3, 2);
  const stabilizer = new MotionStabilizer({
    trackingMaxDimension: 160,
    searchRadius: 6,
    smoothingRadius: 8,
    sceneCutThreshold: 255,
    maxPatchError: 45,
    uniquenessRatio: 0.99,
    forwardBackwardThreshold: 2.1,
  });

  assert.equal(stabilizer.processRgba(first, width, height, 0).status, "initialized");
  const result = stabilizer.processRgba(second, width, height, 1 / 30);

  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.ok(Math.abs(result.motion.x - 3) < 1, `motion.x=${result.motion.x}`);
  assert.ok(Math.abs(result.motion.y - 2) < 1, `motion.y=${result.motion.y}`);
  assert.ok(result.correction.x < 0, `correction.x=${result.correction.x}`);
  assert.ok(result.correction.y < 0, `correction.y=${result.correction.y}`);
  assert.ok(result.confidence > 0.2, `confidence=${result.confidence}`);
});
