/* ═══════════════════════════════════════════════════════════════════════════
   Opsdeck — analytics engine
   ═══════════════════════════════════════════════════════════════════════════
   Pure functions. No DOM, no globals, no I/O. Every export is deterministic
   and unit-tested against a known answer in tests.html.

   "AI" here means applied statistics and classical machine learning that
   actually run in the page — Holt-Winters forecasting, Theil-Sen robust
   regression, Mann-Kendall significance, MAD anomaly detection, k-means,
   logistic regression, Erlang-C queueing. Not a language model. Every number
   this file produces is reproducible, explainable, and carries its own test
   statistic, which is the property that matters for an operations console:
   an operator can be shown WHY a thing was flagged, not just that it was.

   Numerical conventions:
     · Series are plain arrays of finite Numbers, oldest-first.
     · Functions returning a p-value use a two-sided test unless documented.
     · Nothing here throws on short input; degenerate cases return a neutral
       result with `ok:false` so callers can render "not enough data" rather
       than a NaN.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ───────────────────────────── descriptive ───────────────────────────── */

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const clean = (xs) => (xs || []).filter(isNum);

export function mean(xs) {
  const a = clean(xs);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

export function median(xs) {
  const a = clean(xs).slice().sort((p, q) => p - q);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Sample standard deviation (n-1). Population when `pop` is true. */
export function stdev(xs, pop = false) {
  const a = clean(xs);
  if (a.length < 2) return 0;
  const mu = mean(a);
  const ss = a.reduce((s, x) => s + (x - mu) ** 2, 0);
  return Math.sqrt(ss / (pop ? a.length : a.length - 1));
}

/** Linear-interpolated quantile, q in [0,1]. Matches numpy's default. */
export function quantile(xs, q) {
  const a = clean(xs).slice().sort((p, r) => p - r);
  if (!a.length) return 0;
  const pos = (a.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** Median absolute deviation. Scaled by 1.4826 to estimate σ for normal data. */
export function mad(xs, scaled = true) {
  const a = clean(xs);
  if (!a.length) return 0;
  const med = median(a);
  const m = median(a.map(x => Math.abs(x - med)));
  return scaled ? m * 1.4826 : m;
}

export function sum(xs) { return clean(xs).reduce((s, x) => s + x, 0); }

/* ───────────────────────── distributions ───────────────────────── */

/** Abramowitz & Stegun 7.1.26 — |ε| < 1.5e-7. */
export function erf(x) {
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return s * y;
}

/** Standard normal CDF. */
export function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

/** Two-sided p-value for a z statistic. */
export function zToP(z) { return 2 * (1 - normalCdf(Math.abs(z))); }

/* ─────────────────────────── correlation ─────────────────────────── */

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { r: 0, p: 1, n, ok: false };
  const X = xs.slice(0, n), Y = ys.slice(0, n);
  const mx = mean(X), my = mean(Y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = X[i] - mx, b = Y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  const r = den === 0 ? 0 : num / den;
  // Fisher z-transform for significance; guards |r|→1 which would be infinite.
  const rc = Math.min(0.999999, Math.max(-0.999999, r));
  const z = n > 3 ? Math.atanh(rc) * Math.sqrt(n - 3) : 0;
  return { r, p: n > 3 ? zToP(z) : 1, n, ok: true };
}

const rankOf = (xs) => {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;                 // average rank for ties
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
};

/** Spearman rank correlation — monotonic, outlier-resistant. */
export function spearman(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { r: 0, p: 1, n, ok: false };
  return pearson(rankOf(xs.slice(0, n)), rankOf(ys.slice(0, n)));
}

/* ───────────────────────────── trend ───────────────────────────── */

/** Ordinary least squares. Returns slope, intercept, r². */
export function linreg(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: 0, intercept: n ? ys[0] : 0, r2: 0, ok: false };
  const X = xs.slice(0, n), Y = ys.slice(0, n);
  const mx = mean(X), my = mean(Y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (X[i] - mx) * (Y[i] - my); den += (X[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (Y[i] - (slope * X[i] + intercept)) ** 2;
    ssTot += (Y[i] - my) ** 2;
  }
  return { slope, intercept, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot, ok: true };
}

/**
 * Theil-Sen estimator: median of all pairwise slopes.
 * Chosen over OLS deliberately — a single freak day (one client dumping 40
 * appointments, one outage day at zero) drags an OLS trend line visibly,
 * and this console's whole job is telling an operator whether a real trend
 * exists. Theil-Sen tolerates up to ~29% contaminated points before it
 * breaks down. O(n²); capped below for long series.
 */
export function theilSen(xs, ys, maxPairs = 20000) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: 0, intercept: n ? ys[0] : 0, ok: false };
  const X = xs.slice(0, n), Y = ys.slice(0, n);
  const slopes = [];
  const total = (n * (n - 1)) / 2;
  const step = total > maxPairs ? Math.ceil(total / maxPairs) : 1;
  let c = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++, c++) {
      if (c % step) continue;
      const dx = X[j] - X[i];
      if (dx !== 0) slopes.push((Y[j] - Y[i]) / dx);
    }
  }
  if (!slopes.length) return { slope: 0, intercept: median(Y), ok: false };
  const slope = median(slopes);
  const intercept = median(Y.map((y, i) => y - slope * X[i]));
  return { slope, intercept, ok: true };
}

/**
 * Mann-Kendall trend test — nonparametric, no normality assumption.
 * Includes the standard tie correction and continuity correction.
 * Returns direction plus a p-value so the UI can say "rising, p=0.003"
 * instead of the useless "line looks like it goes up".
 */
export function mannKendall(ys) {
  const y = clean(ys);
  const n = y.length;
  if (n < 8) return { S: 0, z: 0, p: 1, trend: 'insufficient', ok: false, n };
  let S = 0;
  for (let i = 0; i < n - 1; i++)
    for (let j = i + 1; j < n; j++) S += Math.sign(y[j] - y[i]);

  const counts = new Map();
  for (const v of y) counts.set(v, (counts.get(v) || 0) + 1);
  let tieAdj = 0;
  for (const t of counts.values()) if (t > 1) tieAdj += t * (t - 1) * (2 * t + 5);

  const varS = (n * (n - 1) * (2 * n + 5) - tieAdj) / 18;
  if (varS <= 0) return { S, z: 0, p: 1, trend: 'flat', ok: false, n };
  const z = S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
  const p = zToP(z);
  const trend = p >= 0.05 ? 'flat' : z > 0 ? 'rising' : 'falling';
  return { S, z, p, trend, ok: true, n };
}

/* ──────────────────────── seasonality / decomposition ──────────────────────── */

/** Autocorrelation at lag k. */
export function acf(series, lag) {
  const y = clean(series);
  const n = y.length;
  if (n <= lag + 1) return 0;
  const mu = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    den += (y[i] - mu) ** 2;
    if (i + lag < n) num += (y[i] - mu) * (y[i + lag] - mu);
  }
  return den === 0 ? 0 : num / den;
}

/** Dominant seasonal period by peak autocorrelation within [minLag,maxLag]. */
export function detectPeriod(series, minLag = 2, maxLag = 30) {
  const n = clean(series).length;
  const hi = Math.min(maxLag, Math.floor(n / 2));
  let best = { lag: 0, r: -Infinity };
  for (let k = minLag; k <= hi; k++) {
    const r = acf(series, k);
    if (r > best.r) best = { lag: k, r };
  }
  return best.lag ? { period: best.lag, strength: best.r, ok: best.r > 0.2 }
                  : { period: 0, strength: 0, ok: false };
}

/**
 * Classical additive decomposition (STL-lite): centered moving-average trend,
 * phase-averaged seasonal, remainder. Enough to answer "is Tuesday actually
 * weak, or does Tuesday just sit under a falling trend" — which a raw
 * day-of-week average cannot distinguish and will happily get wrong.
 */
export function decompose(series, period) {
  const y = clean(series);
  const n = y.length;
  if (!period || n < period * 2) {
    return { trend: [], seasonal: [], resid: [], ok: false };
  }
  const half = Math.floor(period / 2);
  const trend = new Array(n).fill(null);
  for (let i = half; i < n - half; i++) {
    let acc = 0, w = 0;
    if (period % 2 === 0) {
      // even period needs the half-weighted endpoints (2×m centered MA)
      for (let k = -half; k <= half; k++) {
        const weight = (k === -half || k === half) ? 0.5 : 1;
        acc += y[i + k] * weight; w += weight;
      }
    } else {
      for (let k = -half; k <= half; k++) { acc += y[i + k]; w++; }
    }
    trend[i] = acc / w;
  }
  const byPhase = Array.from({ length: period }, () => []);
  for (let i = 0; i < n; i++) if (trend[i] != null) byPhase[i % period].push(y[i] - trend[i]);
  let seasonalIdx = byPhase.map(v => (v.length ? mean(v) : 0));
  const centre = mean(seasonalIdx);
  seasonalIdx = seasonalIdx.map(v => v - centre);            // sums to ~0
  const seasonal = y.map((_, i) => seasonalIdx[i % period]);
  const resid = y.map((v, i) => (trend[i] == null ? null : v - trend[i] - seasonal[i]));
  return { trend, seasonal, resid, seasonalIdx, ok: true };
}

/* ─────────────────────────── anomaly / changepoint ─────────────────────────── */

/**
 * Robust anomaly detection via MAD z-scores.
 * Deliberately not mean/σ: a genuine spike inflates σ and then hides itself
 * (masking). The median and MAD are unmoved by the very outlier being hunted.
 */
export function anomalies(series, threshold = 3.5) {
  const y = clean(series);
  if (y.length < 5) return { points: [], ok: false };
  const med = median(y);
  const m = mad(y);
  if (m === 0) return { points: [], ok: false, degenerate: true };
  const points = [];
  y.forEach((v, i) => {
    const z = (v - med) / m;
    if (Math.abs(z) >= threshold) points.push({ index: i, value: v, z, dir: z > 0 ? 'high' : 'low' });
  });
  return { points, median: med, mad: m, threshold, ok: true };
}

/**
 * CUSUM changepoint on the standardized series. Returns the single most
 * likely level shift and a bootstrap confidence estimate — "the number moved
 * on Jul 14" is far more actionable to an ops lead than "the number moved".
 */
export function changepoint(series, bootstraps = 200, rng = Math.random) {
  const y = clean(series);
  const n = y.length;
  if (n < 10) return { index: -1, confidence: 0, ok: false };
  const cusumRange = (arr) => {
    const mu = mean(arr);
    // The changepoint estimator is argmax|S_t|, tracked separately from the
    // hi/lo range used for the bootstrap magnitude. Deriving `at` from
    // whichever of hi/lo updated last is wrong: S_t returns to ~0 by
    // construction, so floating-point dust on the final step (+1e-15) can
    // beat hi=0 and pin the changepoint to the last index. That is exactly
    // what the planted-shift test caught.
    let s = 0, lo = 0, hi = 0, at = 0, maxAbs = -1;
    for (let i = 0; i < arr.length; i++) {
      s += arr[i] - mu;
      if (s > hi) hi = s;
      if (s < lo) lo = s;
      const a = Math.abs(s);
      if (a > maxAbs) { maxAbs = a; at = i; }
    }
    return { diff: hi - lo, at };
  };
  const base = cusumRange(y);
  let beaten = 0;
  for (let b = 0; b < bootstraps; b++) {
    const sh = y.slice();
    for (let i = sh.length - 1; i > 0; i--) {           // Fisher-Yates
      const j = Math.floor(rng() * (i + 1));
      [sh[i], sh[j]] = [sh[j], sh[i]];
    }
    if (cusumRange(sh).diff < base.diff) beaten++;
  }
  const confidence = beaten / bootstraps;
  return {
    index: base.at, confidence, ok: confidence >= 0.9,
    before: mean(y.slice(0, base.at + 1)), after: mean(y.slice(base.at + 1))
  };
}

/* ─────────────────────────── forecasting ─────────────────────────── */

/**
 * Holt-Winters additive triple exponential smoothing.
 * Additive rather than multiplicative because appointment counts legitimately
 * hit zero on holidays, and a multiplicative seasonal index is undefined there.
 */
export function holtWinters(series, { alpha = 0.3, beta = 0.1, gamma = 0.1, period = 7, horizon = 14 } = {}) {
  const y = clean(series);
  const n = y.length;
  if (!period || n < period * 2) return { fitted: [], forecast: [], sse: Infinity, ok: false };

  const seasons = Math.floor(n / period);
  const seasonMeans = [];
  for (let s = 0; s < seasons; s++) seasonMeans.push(mean(y.slice(s * period, (s + 1) * period)));

  let level = seasonMeans[0];
  let trend = seasons > 1 ? (seasonMeans[1] - seasonMeans[0]) / period : 0;
  const seasonal = [];
  for (let i = 0; i < period; i++) {
    const vals = [];
    for (let s = 0; s < seasons; s++) {
      const v = y[s * period + i];
      if (isNum(v) && isNum(seasonMeans[s])) vals.push(v - seasonMeans[s]);
    }
    seasonal.push(vals.length ? mean(vals) : 0);
  }

  const fitted = [];
  let sse = 0;
  for (let t = 0; t < n; t++) {
    const sIdx = t % period;
    const pred = level + trend + seasonal[sIdx];
    fitted.push(pred);
    const err = y[t] - pred;
    sse += err * err;
    const prevLevel = level;
    level = alpha * (y[t] - seasonal[sIdx]) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonal[sIdx] = gamma * (y[t] - level) + (1 - gamma) * seasonal[sIdx];
  }

  // Residual σ drives the prediction band; widened by √h so the cone opens
  // with horizon instead of pretending day 14 is as certain as day 1.
  const resid = y.map((v, i) => v - fitted[i]);
  const sigma = stdev(resid);
  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    const point = level + h * trend + seasonal[(n + h - 1) % period];
    const band = 1.96 * sigma * Math.sqrt(h);
    forecast.push({
      h, point,
      lo: point - band,
      hi: point + band
    });
  }
  return { fitted, forecast, sse, rmse: Math.sqrt(sse / n), sigma, level, trend, seasonal, ok: true };
}

/**
 * Coarse grid search over the three smoothing constants, scored by
 * out-of-sample error on a holdout tail rather than in-sample SSE —
 * in-sample fit is trivially gamed by α→1 (memorise the last point) and
 * would pick a model that forecasts terribly.
 */
export function autoHoltWinters(series, { period = 7, horizon = 14, holdout = 0 } = {}) {
  const y = clean(series);
  const hold = holdout || Math.min(period * 2, Math.max(period, Math.floor(y.length * 0.2)));
  if (y.length < period * 3) {
    return { ...holtWinters(y, { period, horizon }), tuned: false, holdout: 0 };
  }
  const train = y.slice(0, y.length - hold);
  const test = y.slice(y.length - hold);
  const grid = [0.05, 0.15, 0.3, 0.5, 0.7, 0.9];
  let best = null;
  for (const a of grid) for (const b of grid) for (const g of grid) {
    const m = holtWinters(train, { alpha: a, beta: b, gamma: g, period, horizon: hold });
    if (!m.ok) continue;
    let err = 0;
    for (let i = 0; i < test.length; i++) err += (test[i] - m.forecast[i].point) ** 2;
    const rmse = Math.sqrt(err / test.length);
    if (!best || rmse < best.rmse) best = { alpha: a, beta: b, gamma: g, rmse };
  }
  if (!best) return { ...holtWinters(y, { period, horizon }), tuned: false, holdout: hold };
  const final = holtWinters(y, { ...best, period, horizon });
  return { ...final, alpha: best.alpha, beta: best.beta, gamma: best.gamma,
           validationRmse: best.rmse, tuned: true, holdout: hold };
}

/* ──────────────────────── classification / clustering ──────────────────────── */

const standardize = (X) => {
  const d = X[0].length;
  const mu = [], sd = [];
  for (let j = 0; j < d; j++) {
    const col = X.map(r => r[j]);
    mu.push(mean(col));
    sd.push(stdev(col) || 1);
  }
  return { Z: X.map(r => r.map((v, j) => (v - mu[j]) / sd[j])), mu, sd };
};

/**
 * Binary logistic regression, batch gradient descent with L2.
 * Features are standardized internally and the scaling is carried in the
 * model, so callers pass raw units both to fit and to predict.
 */
export function logisticFit(X, y, { epochs = 600, lr = 0.1, l2 = 0.01 } = {}) {
  if (!X.length || X.length !== y.length) return { ok: false };
  const { Z, mu, sd } = standardize(X);
  const d = Z[0].length;
  let w = new Array(d).fill(0), b = 0;
  const sig = (t) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, t))));
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const p = sig(Z[i].reduce((s, v, j) => s + v * w[j], 0) + b);
      const err = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / Z.length + l2 * w[j]);
    b -= lr * (gb / Z.length);
  }
  const model = { w, b, mu, sd, ok: true };
  const preds = X.map(r => logisticPredict(model, r));
  const acc = preds.filter((p, i) => (p >= 0.5 ? 1 : 0) === y[i]).length / y.length;
  return { ...model, accuracy: acc, auc: rocAuc(y, preds) };
}

export function logisticPredict(model, x) {
  if (!model || !model.ok) return 0.5;
  const z = x.reduce((s, v, j) => s + ((v - model.mu[j]) / model.sd[j]) * model.w[j], model.b);
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));
}

/** Area under ROC via the rank (Mann-Whitney U) identity. */
export function rocAuc(labels, scores) {
  const pos = [], neg = [];
  labels.forEach((l, i) => (l === 1 ? pos : neg).push(scores[i]));
  if (!pos.length || !neg.length) return 0.5;
  const ranks = rankOf(scores);
  let rp = 0;
  labels.forEach((l, i) => { if (l === 1) rp += ranks[i]; });
  return (rp - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/** k-means with k-means++ seeding. Deterministic when `rng` is seeded. */
export function kmeans(points, k, { iters = 60, rng = Math.random } = {}) {
  const n = points.length;
  if (!n || k < 1 || k > n) return { ok: false, centroids: [], assignments: [] };
  const d = points[0].length;
  const dist2 = (a, b) => { let s = 0; for (let i = 0; i < d; i++) s += (a[i] - b[i]) ** 2; return s; };

  const centroids = [points[Math.floor(rng() * n)].slice()];
  while (centroids.length < k) {
    const dd = points.map(p => Math.min(...centroids.map(c => dist2(p, c))));
    const tot = dd.reduce((s, v) => s + v, 0);
    let r = rng() * tot, pick = 0;
    for (let i = 0; i < n; i++) { r -= dd[i]; if (r <= 0) { pick = i; break; } }
    centroids.push(points[pick].slice());
  }

  let assignments = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const dv = dist2(points[i], centroids[c]); if (dv < bd) { bd = dv; bi = c; } }
      if (assignments[i] !== bi) { assignments[i] = bi; moved = true; }
    }
    for (let c = 0; c < k; c++) {
      const members = points.filter((_, i) => assignments[i] === c);
      if (!members.length) continue;
      for (let j = 0; j < d; j++) centroids[c][j] = mean(members.map(m => m[j]));
    }
    if (!moved && it > 0) break;
  }
  const inertia = points.reduce((s, p, i) => s + dist2(p, centroids[assignments[i]]), 0);
  return { centroids, assignments, inertia, k, ok: true };
}

/* ──────────────────────── queueing (call centre) ──────────────────────── */

/**
 * Erlang-B via the numerically stable recurrence (no factorials, so it does
 * not overflow at realistic agent counts).
 * @param {number} N servers  @param {number} A offered load in erlangs
 */
export function erlangB(N, A) {
  let inv = 1;                       // inv = 1/B
  for (let i = 1; i <= N; i++) inv = 1 + (i / A) * inv;
  return 1 / inv;
}

/** Erlang-C: probability an arriving call has to wait at all. */
export function erlangC(N, A) {
  if (A <= 0) return 0;
  if (N <= A) return 1;                              // unstable queue
  const b = erlangB(N, A);
  return b / (1 - (A / N) * (1 - b));
}

/**
 * Full staffing picture for a voice queue.
 * @param callsPerHour arrival rate λ
 * @param ahtSec       average handle time (talk + wrap)
 * @param agents       staffed seats
 * @param targetSec    service-level answer threshold (e.g. 20s)
 */
export function queueMetrics(callsPerHour, ahtSec, agents, targetSec = 20) {
  const A = (callsPerHour * ahtSec) / 3600;          // erlangs
  if (agents <= 0) return { ok: false, offeredLoad: A };
  const stable = agents > A;
  const pWait = erlangC(agents, A);
  const asa = stable ? (pWait * ahtSec) / (agents - A) : Infinity;
  const serviceLevel = stable ? 1 - pWait * Math.exp(-((agents - A) * targetSec) / ahtSec) : 0;
  return {
    ok: true, offeredLoad: A, agents, stable,
    occupancy: A / agents, pWait, asa, serviceLevel,
    abandonRisk: stable ? pWait * (1 - Math.exp(-((agents - A) * 30) / ahtSec)) : 1
  };
}

/** Smallest agent count meeting a service-level target. */
export function agentsRequired(callsPerHour, ahtSec, targetSL = 0.8, targetSec = 20, maxAgents = 500) {
  const A = (callsPerHour * ahtSec) / 3600;
  for (let n = Math.max(1, Math.ceil(A)); n <= maxAgents; n++) {
    const m = queueMetrics(callsPerHour, ahtSec, n, targetSec);
    if (m.ok && m.serviceLevel >= targetSL) return { agents: n, ...m };
  }
  return { agents: maxAgents, ok: false, offeredLoad: A };
}

/* ─────────────────────────── inference ─────────────────────────── */

/**
 * Two-proportion z-test — the correct test for "did script B actually beat
 * script A", as opposed to eyeballing two percentages that differ by noise.
 */
export function twoProportionZTest(x1, n1, x2, n2) {
  if (!n1 || !n2) return { ok: false, p: 1, z: 0 };
  const p1 = x1 / n1, p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { ok: false, p: 1, z: 0, p1, p2 };
  const z = (p1 - p2) / se;
  const p = zToP(z);
  // Unpooled SE for the CI (pooled SE is only correct under H0).
  const seU = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return {
    ok: true, z, p, p1, p2, diff: p1 - p2,
    lift: p2 === 0 ? 0 : (p1 - p2) / p2,
    ci95: [(p1 - p2) - 1.96 * seU, (p1 - p2) + 1.96 * seU],
    significant: p < 0.05
  };
}

/** Per-arm sample size for a two-proportion test (80% power at α=0.05 by default). */
export function sampleSizeForProportion(baseline, mde, power = 0.8, alpha = 0.05) {
  const zA = 1.959963985, zB = power === 0.8 ? 0.841621234 : 1.2815515655;
  const p1 = baseline, p2 = baseline * (1 + mde);
  const pBar = (p1 + p2) / 2;
  if (p2 <= 0 || p2 >= 1 || p1 <= 0 || p1 >= 1) return { ok: false, n: Infinity };
  const n = Math.pow(zA * Math.sqrt(2 * pBar * (1 - pBar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)), 2)
    / Math.pow(p2 - p1, 2);
  return { ok: true, n: Math.ceil(n), baseline, mde, power, alpha };
}

/** Wilson score interval — correct at small n and near 0/1, unlike normal approx. */
export function wilson(x, n, z = 1.959963985) {
  if (!n) return { lo: 0, hi: 0, p: 0, ok: false };
  const p = x / n, z2 = z * z;
  const den = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { p, lo: Math.max(0, (centre - half) / den), hi: Math.min(1, (centre + half) / den), ok: true };
}

/* ─────────────────────────── cohorts ─────────────────────────── */

/**
 * Retention matrix. `rows` need a cohort key and a period index per event.
 * Returns counts and rates keyed cohort → period.
 */
export function cohortMatrix(entities, { cohortOf, periodsOf, maxPeriods = 12 }) {
  const cohorts = new Map();
  for (const e of entities) {
    const c = cohortOf(e);
    if (c == null) continue;
    if (!cohorts.has(c)) cohorts.set(c, { key: c, size: 0, periods: new Array(maxPeriods).fill(0) });
    const row = cohorts.get(c);
    row.size++;
    for (const p of periodsOf(e)) if (p >= 0 && p < maxPeriods) row.periods[p]++;
  }
  const out = [...cohorts.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return out.map(r => ({ ...r, rates: r.periods.map(v => (r.size ? v / r.size : 0)) }));
}

/* ─────────────────────────── scoring helpers ─────────────────────────── */

/** Min-max normalise to [0,1]; flat input maps to 0.5 rather than NaN. */
export function normalize(xs) {
  const a = clean(xs);
  if (!a.length) return [];
  const lo = Math.min(...a), hi = Math.max(...a);
  return xs.map(v => (!isNum(v) ? 0.5 : hi === lo ? 0.5 : (v - lo) / (hi - lo)));
}

/** Deterministic PRNG so every derived statistic is reproducible run to run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const VERSION = '1.0.0';
