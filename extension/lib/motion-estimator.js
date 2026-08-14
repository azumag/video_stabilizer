/** Phase 0 dependency-free motion estimator. */
export const DEFAULT_ESTIMATOR_OPTIONS = Object.freeze({
  trackingMaxDimension: 192,
  maxFeatures: 120,
  minFeatureDistance: 7,
  patchRadius: 2,
  searchRadius: 6,
  maxPatchError: 34,
  uniquenessRatio: 0.94,
  forwardBackwardThreshold: 1.75,
  ransacIterations: 120,
  ransacThreshold: 2.75,
  minTrackedPoints: 8,
  minInlierRatio: 0.42,
  smoothingRadius: 12,
  maxCorrectionRatio: 0.12,
  sceneCutThreshold: 58,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const optionsWith = (options) => ({ ...DEFAULT_ESTIMATOR_OPTIONS, ...options });

export function rgbaToGrayscale(rgba, width, height) {
  if (rgba.length !== width * height * 4) throw new RangeError("invalid RGBA length");
  const gray = new Uint8Array(width * height);
  for (let source = 0, target = 0; target < gray.length; source += 4, target += 1) {
    gray[target] = (77 * rgba[source] + 150 * rgba[source + 1] + 29 * rgba[source + 2]) >>> 8;
  }
  return gray;
}

function resize(gray, width, height, maxDimension) {
  const scale = Math.min(1, Math.max(32, maxDimension) / Math.max(width, height));
  const targetWidth = Math.max(16, Math.round(width * scale));
  const targetHeight = Math.max(16, Math.round(height * scale));
  if (targetWidth === width && targetHeight === height) {
    return { data: gray, width, height, scaleX: 1, scaleY: 1 };
  }
  const data = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / targetWidth));
      data[y * targetWidth + x] = gray[sourceY * width + sourceX];
    }
  }
  return { data, width: targetWidth, height: targetHeight, scaleX: targetWidth / width, scaleY: targetHeight / height };
}

function frameDifference(first, second) {
  let total = 0;
  let count = 0;
  for (let index = 0; index < first.length; index += 4) {
    total += Math.abs(first[index] - second[index]);
    count += 1;
  }
  return total / Math.max(1, count);
}

function cornerScore(gray, width, x, y) {
  let xx = 0; let yy = 0; let xy = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const index = (y + offsetY) * width + x + offsetX;
      const gx = gray[index + 1] - gray[index - 1];
      const gy = gray[index + width] - gray[index - width];
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
  }
  const determinant = xx * yy - xy * xy;
  return determinant > 0 ? determinant / (xx + yy + 1) : 0;
}

export function detectFeatures(gray, width, height, inputOptions = {}) {
  const options = optionsWith(inputOptions);
  const border = options.patchRadius + options.searchRadius + 3;
  const candidates = [];
  let maximum = 0;
  for (let y = border; y < height - border; y += 2) {
    for (let x = border; x < width - border; x += 2) {
      const score = cornerScore(gray, width, x, y);
      if (score > 0) { candidates.push({ x, y, score }); maximum = Math.max(maximum, score); }
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const selected = [];
  const minimumSquared = options.minFeatureDistance ** 2;
  for (const candidate of candidates) {
    if (candidate.score < maximum * 0.015 || selected.length >= options.maxFeatures) break;
    if (selected.every((point) => (point.x - candidate.x) ** 2 + (point.y - candidate.y) ** 2 >= minimumSquared)) {
      selected.push(candidate);
    }
  }
  return selected;
}

function patchError(first, second, width, x1, y1, x2, y2, radius) {
  let total = 0; let count = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      total += Math.abs(first[(y1 + dy) * width + x1 + dx] - second[(y2 + dy) * width + x2 + dx]);
      count += 1;
    }
  }
  return total / count;
}

function bestPatch(first, second, width, height, x, y, options) {
  let best = { x, y, error: Infinity, second: Infinity };
  for (let dy = -options.searchRadius; dy <= options.searchRadius; dy += 1) {
    for (let dx = -options.searchRadius; dx <= options.searchRadius; dx += 1) {
      const candidateX = x + dx; const candidateY = y + dy;
      if (candidateX - options.patchRadius < 0 || candidateX + options.patchRadius >= width ||
          candidateY - options.patchRadius < 0 || candidateY + options.patchRadius >= height) continue;
      const error = patchError(first, second, width, x, y, candidateX, candidateY, options.patchRadius);
      if (error < best.error) best = { x: candidateX, y: candidateY, error, second: best.error };
      else if (error < best.second) best.second = error;
    }
  }
  return best;
}

export function trackFeatures(previous, current, width, height, features, inputOptions = {}) {
  const options = optionsWith(inputOptions);
  const matches = [];
  for (const feature of features) {
    const forward = bestPatch(previous, current, width, height, feature.x, feature.y, options);
    if (forward.error > options.maxPatchError || forward.error / forward.second > options.uniquenessRatio) continue;
    const backward = bestPatch(current, previous, width, height, forward.x, forward.y, options);
    if (Math.hypot(backward.x - feature.x, backward.y - feature.y) > options.forwardBackwardThreshold) continue;
    matches.push({ x: feature.x, y: feature.y, u: forward.x, v: forward.y, error: forward.error });
  }
  return matches;
}

function pairModel(first, second) {
  const px = second.x - first.x; const py = second.y - first.y;
  const qx = second.u - first.u; const qy = second.v - first.v;
  const denominator = px * px + py * py;
  if (denominator < 4) return null;
  const a = (qx * px + qy * py) / denominator;
  const b = (qy * px - qx * py) / denominator;
  const scale = Math.hypot(a, b);
  if (scale < 0.8 || scale > 1.2) return null;
  return { a, b, tx: first.u - a * first.x + b * first.y, ty: first.v - b * first.x - a * first.y };
}

function errorSquared(model, match) {
  const dx = model.a * match.x - model.b * match.y + model.tx - match.u;
  const dy = model.b * match.x + model.a * match.y + model.ty - match.v;
  return dx * dx + dy * dy;
}

function refine(matches, indices) {
  if (indices.length < 2) return null;
  let px = 0; let py = 0; let qx = 0; let qy = 0;
  for (const index of indices) { const point = matches[index]; px += point.x; py += point.y; qx += point.u; qy += point.v; }
  px /= indices.length; py /= indices.length; qx /= indices.length; qy /= indices.length;
  let numeratorA = 0; let numeratorB = 0; let denominator = 0;
  for (const index of indices) {
    const point = matches[index];
    const x = point.x - px; const y = point.y - py; const u = point.u - qx; const v = point.v - qy;
    numeratorA += x * u + y * v; numeratorB += x * v - y * u; denominator += x * x + y * y;
  }
  if (denominator < 1e-6) return null;
  const a = numeratorA / denominator; const b = numeratorB / denominator;
  return { a, b, tx: qx - a * px + b * py, ty: qy - b * px - a * py };
}

export function estimateSimilarityRansac(matches, inputOptions = {}, seed = 12345) {
  if (matches.length < 2) return null;
  const options = optionsWith(inputOptions);
  const threshold = options.ransacThreshold ** 2;
  let randomState = (seed ^ matches.length) >>> 0;
  const randomIndex = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % matches.length; };
  let best = [];
  for (let iteration = 0; iteration < options.ransacIterations; iteration += 1) {
    const first = randomIndex(); let second = randomIndex(); if (first === second) second = (second + 1) % matches.length;
    const model = pairModel(matches[first], matches[second]); if (!model) continue;
    const inliers = matches.map((point, index) => errorSquared(model, point) <= threshold ? index : -1).filter((index) => index >= 0);
    if (inliers.length > best.length) best = inliers;
  }
  let model = refine(matches, best); if (!model) return null;
  const inliers = matches.map((point, index) => errorSquared(model, point) <= threshold ? index : -1).filter((index) => index >= 0);
  model = refine(matches, inliers) ?? model;
  const scale = Math.hypot(model.a, model.b);
  return { ...model, scale, angle: Math.atan2(model.b, model.a), inlierCount: inliers.length, inlierRatio: inliers.length / matches.length };
}

export class MotionStabilizer {
  constructor(options = {}) { this.options = optionsWith(options); this.reset(); }
  configure(options = {}) { this.options = optionsWith({ ...this.options, ...options }); this.reset(); }
  reset() { this.previous = null; this.trajectory = { x: 0, y: 0, angle: 0, logScale: 0 }; this.history = [{ ...this.trajectory }]; this.correction = { x: 0, y: 0, angle: 0, logScale: 0 }; this.frame = 0; }

  result(status, width, height, extra = {}) {
    return { status, sourceWidth: width, sourceHeight: height, featureCount: 0, trackedCount: 0, inlierCount: 0, inlierRatio: 0, confidence: 0,
      motion: { x: 0, y: 0, angle: 0, scale: 1 }, correction: { x: this.correction.x, y: this.correction.y, angle: this.correction.angle, scale: Math.exp(this.correction.logScale) }, ...extra };
  }

  processRgba(input, width, height, timestamp = 0) {
    const rgba = input instanceof ArrayBuffer ? new Uint8ClampedArray(input) : input;
    const current = resize(rgbaToGrayscale(rgba, width, height), width, height, this.options.trackingMaxDimension);
    this.frame += 1;
    if (!this.previous || this.previous.width !== current.width || this.previous.height !== current.height) {
      this.reset(); this.previous = current; return this.result("initialized", width, height);
    }
    if (frameDifference(this.previous.data, current.data) >= this.options.sceneCutThreshold) {
      this.reset(); this.previous = current; return this.result("scene-cut", width, height);
    }
    const features = detectFeatures(this.previous.data, current.width, current.height, this.options);
    const matches = trackFeatures(this.previous.data, current.data, current.width, current.height, features, this.options);
    const model = matches.length >= this.options.minTrackedPoints ? estimateSimilarityRansac(matches, this.options, this.frame * 2654435761) : null;
    if (!model || model.inlierRatio < this.options.minInlierRatio) {
      this.previous = current; this.correction.x *= 0.84; this.correction.y *= 0.84; this.correction.angle *= 0.84; this.correction.logScale *= 0.84;
      return this.result("tracking-failed", width, height, { featureCount: features.length, trackedCount: matches.length, inlierCount: model?.inlierCount ?? 0, inlierRatio: model?.inlierRatio ?? 0 });
    }
    const motion = { x: model.tx / current.scaleX, y: model.ty / current.scaleY, angle: model.angle, scale: model.scale };
    this.trajectory.x += motion.x; this.trajectory.y += motion.y; this.trajectory.angle += motion.angle; this.trajectory.logScale += Math.log(motion.scale);
    this.history.push({ ...this.trajectory }); while (this.history.length > this.options.smoothingRadius) this.history.shift();
    const smooth = this.history.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y, angle: sum.angle + point.angle, logScale: sum.logScale + point.logScale }), { x: 0, y: 0, angle: 0, logScale: 0 });
    for (const key of Object.keys(smooth)) smooth[key] /= this.history.length;
    this.correction = { x: clamp(smooth.x - this.trajectory.x, -width * this.options.maxCorrectionRatio, width * this.options.maxCorrectionRatio),
      y: clamp(smooth.y - this.trajectory.y, -height * this.options.maxCorrectionRatio, height * this.options.maxCorrectionRatio),
      angle: clamp(smooth.angle - this.trajectory.angle, -0.1, 0.1), logScale: clamp(smooth.logScale - this.trajectory.logScale, -0.08, 0.08) };
    this.previous = current;
    const confidence = clamp(model.inlierRatio * Math.min(1, matches.length / 30), 0, 1);
    return this.result("ok", width, height, { timestamp, featureCount: features.length, trackedCount: matches.length, inlierCount: model.inlierCount, inlierRatio: model.inlierRatio, confidence, motion,
      correction: { x: this.correction.x, y: this.correction.y, angle: this.correction.angle, scale: Math.exp(this.correction.logScale) } });
  }
}
