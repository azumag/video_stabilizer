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
