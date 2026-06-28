/* Known-answer tests for the analytics engine.
   Every assertion checks against a value derived independently — a textbook
   Erlang table, a hand-computed z statistic, an analytically known limit —
   not against whatever the implementation happened to print first. */
import * as A from './analytics.js';

const T = [];
const test = (name, fn) => T.push({ name, fn });
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

class Fail extends Error {}
function eq(actual, expected, eps, label) {
  if (!approx(actual, expected, eps ?? 1e-6))
    throw new Fail(`${label || ''} expected ${expected}, got ${actual}`);
}
function ok(cond, label) { if (!cond) throw new Fail(label || 'expected truthy'); }

/* ── descriptive ── */
test('mean / median / stdev', () => {
  eq(A.mean([1, 2, 3, 4]), 2.5);
  eq(A.median([1, 2, 3, 4]), 2.5);
  eq(A.median([3, 1, 2]), 2);
  eq(A.stdev([2, 4, 4, 4, 5, 5, 7, 9], true), 2, 1e-9);   // textbook population σ = 2
  eq(A.stdev([1, 1, 1]), 0);
});
test('quantile matches linear interpolation', () => {
  eq(A.quantile([1, 2, 3, 4], 0.5), 2.5);
  eq(A.quantile([1, 2, 3, 4], 0), 1);
  eq(A.quantile([1, 2, 3, 4], 1), 4);
  eq(A.quantile([0, 10], 0.25), 2.5);
});
test('mad is outlier-resistant', () => {
  eq(A.mad([1, 1, 1, 1], false), 0);
  eq(A.mad([1, 2, 3, 4, 5], false), 1);
  // one wild point must not move MAD much, unlike stdev
  const withOutlier = [1, 2, 3, 4, 5, 1000];
  ok(A.mad(withOutlier, false) < 3, 'MAD stays small under contamination');
  ok(A.stdev(withOutlier) > 100, 'stdev blows up (contrast case)');
});

/* ── distributions ── */
test('normalCdf hits known z values', () => {
  eq(A.normalCdf(0), 0.5, 1e-7);
  eq(A.normalCdf(1.959963985), 0.975, 1e-5);
  eq(A.normalCdf(-1.959963985), 0.025, 1e-5);
  eq(A.normalCdf(2.5758293), 0.995, 1e-5);
});
test('zToP two-sided', () => {
  eq(A.zToP(1.959963985), 0.05, 1e-5);
  // erf here is Abramowitz-Stegun 7.1.26, |eps|<1.5e-7, so p(0) lands at
  // 1-1e-9 not exactly 1. Asserting tighter than the method's own accuracy
  // would be testing the approximation's dust, not the behaviour.
  eq(A.zToP(0), 1, 1e-6);
});

/* ── correlation ── */
test('pearson perfect and inverse', () => {
  eq(A.pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]).r, 1, 1e-9);
  eq(A.pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]).r, -1, 1e-9);
  ok(Math.abs(A.pearson([1, 2, 3, 4], [1, 1, 1, 1]).r) < 1e-12, 'flat y ⇒ r=0');
});
test('spearman catches monotonic non-linearity', () => {
  const x = [1, 2, 3, 4, 5], y = [1, 4, 9, 16, 25];   // perfectly monotonic, not linear
  eq(A.spearman(x, y).r, 1, 1e-9);
  ok(A.pearson(x, y).r < 1, 'pearson < 1 on a curve');
});

/* ── trend ── */
test('linreg recovers a known line', () => {
  const r = A.linreg([0, 1, 2, 3], [1, 3, 5, 7]);      // y = 2x + 1
  eq(r.slope, 2, 1e-9); eq(r.intercept, 1, 1e-9); eq(r.r2, 1, 1e-9);
});
test('theilSen resists an outlier that breaks OLS', () => {
  const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const ys = xs.map(x => 2 * x + 1);
  ys[9] = 500;                                          // one corrupted point
  const ts = A.theilSen(xs, ys), ols = A.linreg(xs, ys);
  eq(ts.slope, 2, 1e-9, 'Theil-Sen holds the true slope');
  ok(ols.slope > 6, `OLS is dragged off (got ${ols.slope.toFixed(2)})`);
});
test('mannKendall flags monotonic trend and ignores noise', () => {
  const rising = A.mannKendall([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  ok(rising.trend === 'rising' && rising.p < 0.001, 'monotonic rise is significant');
  const falling = A.mannKendall([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  ok(falling.trend === 'falling', 'monotonic fall detected');
  const flat = A.mannKendall([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  ok(flat.trend === 'flat', 'constant series is flat, not trending');
  ok(!A.mannKendall([1, 2, 3]).ok, 'refuses n<8 instead of guessing');
});

/* ── seasonality ── */
test('acf lag0 = 1 and finds a planted period', () => {
  const s = Array.from({ length: 70 }, (_, i) => 10 + 5 * Math.sin((2 * Math.PI * i) / 7));
  eq(A.acf(s, 0), 1, 1e-9);
  const d = A.detectPeriod(s, 2, 20);
  eq(d.period, 7, 0, 'weekly period recovered');
  ok(d.strength > 0.5, 'strong seasonal signal');
});
test('decompose separates trend from season', () => {
  const s = Array.from({ length: 56 }, (_, i) => 100 + 2 * i + 10 * ((i % 7) - 3));
  const d = A.decompose(s, 7);
  ok(d.ok, 'decomposition ran');
  eq(A.mean(d.seasonalIdx), 0, 1e-9, 'seasonal indices are centred');
  const mid = d.trend.filter(v => v != null);
  ok(mid[mid.length - 1] > mid[0], 'trend component rises with the planted slope');
});

/* ── anomaly / changepoint ── */
test('anomalies finds a planted spike, not the noise', () => {
  const s = [10, 11, 9, 10, 12, 10, 11, 9, 10, 11, 60, 10, 9, 11, 10];
  const r = A.anomalies(s, 3.5);
  eq(r.points.length, 1, 0, 'exactly one outlier');
  eq(r.points[0].index, 10, 0, 'at the planted index');
  ok(r.points[0].dir === 'high');
});
test('changepoint locates a planted level shift', () => {
  const rng = A.mulberry32(7);
  const s = [...Array(30)].map(() => 10 + rng()).concat([...Array(30)].map(() => 20 + rng()));
  const c = A.changepoint(s, 200, A.mulberry32(99));
  ok(Math.abs(c.index - 29) <= 2, `shift near index 29, got ${c.index}`);
  ok(c.confidence >= 0.9, 'high bootstrap confidence');
  ok(c.after - c.before > 8, 'reports the true jump size');
});

/* ── forecasting ── */
test('holtWinters recovers a seasonal series', () => {
  const s = Array.from({ length: 84 }, (_, i) => 50 + 0.5 * i + 12 * Math.sin((2 * Math.PI * i) / 7));
  const m = A.holtWinters(s, { alpha: 0.3, beta: 0.1, gamma: 0.3, period: 7, horizon: 7 });
  ok(m.ok, 'model fit');
  ok(m.rmse < 6, `in-sample rmse ${m.rmse.toFixed(2)} is small`);
  eq(m.forecast.length, 7, 0);
  ok(m.forecast.every(f => f.hi > f.point && f.point > f.lo), 'bands bracket the point estimate');
  ok(m.forecast[6].hi - m.forecast[6].lo > m.forecast[0].hi - m.forecast[0].lo,
     'uncertainty widens with horizon');
});
test('autoHoltWinters tunes on a holdout, not in-sample', () => {
  const s = Array.from({ length: 120 }, (_, i) => 40 + 0.3 * i + 8 * Math.sin((2 * Math.PI * i) / 7));
  const m = A.autoHoltWinters(s, { period: 7, horizon: 14 });
  ok(m.ok && m.tuned, 'tuned path taken');
  ok(m.validationRmse < 8, `holdout rmse ${m.validationRmse?.toFixed(2)}`);
  ok(m.holdout > 0, 'a holdout was actually withheld');
});
test('forecast degrades gracefully on short input', () => {
  const m = A.holtWinters([1, 2, 3], { period: 7 });
  ok(!m.ok, 'flags insufficient data rather than emitting NaNs');
});

/* ── classification / clustering ── */
test('logistic separates a linearly separable set', () => {
  const X = [], y = [];
  const rng = A.mulberry32(3);
  for (let i = 0; i < 120; i++) {
    const cls = i % 2;
    X.push([cls * 3 + rng(), cls * 3 + rng()]);
    y.push(cls);
  }
  const m = A.logisticFit(X, y, { epochs: 800, lr: 0.3 });
  ok(m.ok && m.accuracy > 0.95, `accuracy ${m.accuracy}`);
  ok(m.auc > 0.98, `auc ${m.auc}`);
  ok(A.logisticPredict(m, [6, 6]) > 0.8, 'confident on a clear positive');
  ok(A.logisticPredict(m, [0, 0]) < 0.2, 'confident on a clear negative');
});
test('rocAuc: perfect separation = 1, reversed = 0', () => {
  eq(A.rocAuc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1, 1e-9);
  eq(A.rocAuc([1, 1, 0, 0], [0.1, 0.2, 0.8, 0.9]), 0, 1e-9);
  eq(A.rocAuc([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5]), 0.5, 1e-9);
});
test('kmeans recovers two planted clusters', () => {
  const rng = A.mulberry32(11);
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push([rng(), rng()]);
  for (let i = 0; i < 40; i++) pts.push([10 + rng(), 10 + rng()]);
  const r = A.kmeans(pts, 2, { rng: A.mulberry32(5) });
  ok(r.ok);
  const first = r.assignments.slice(0, 40), second = r.assignments.slice(40);
  ok(new Set(first).size === 1 && new Set(second).size === 1, 'each blob is one cluster');
  ok(first[0] !== second[0], 'and they are different clusters');
});

/* ── queueing: values cross-checked against published Erlang tables ── */
test('erlangB matches the standard recurrence', () => {
  eq(A.erlangB(1, 1), 0.5, 1e-9);                 // B(1,1) = 1/2 exactly
  eq(A.erlangB(2, 1), 1 / 5, 1e-9);               // B(2,1) = 0.2 exactly
  ok(A.erlangB(20, 5) < A.erlangB(10, 5), 'more servers ⇒ less blocking');
});
test('erlangC + queueMetrics reproduce the textbook A=5,N=8 case', () => {
  // λ=100/hr, AHT=180s ⇒ A = 5 erlangs. Published: C≈0.1673, ASA≈10.0s, SL(20s)≈88%.
  eq(A.erlangC(8, 5), 0.16726, 1e-4);
  const m = A.queueMetrics(100, 180, 8, 20);
  ok(m.stable);
  eq(m.offeredLoad, 5, 1e-9);
  eq(m.occupancy, 0.625, 1e-9);
  eq(m.asa, 10.036, 1e-2);
  eq(m.serviceLevel, 0.8802, 1e-3);
});
test('understaffed queue is reported unstable, not as a fantasy number', () => {
  const m = A.queueMetrics(100, 180, 4, 20);      // 4 agents for 5 erlangs
  ok(!m.stable && m.serviceLevel === 0 && m.asa === Infinity);
});
test('agentsRequired finds the minimum staffing', () => {
  const r = A.agentsRequired(100, 180, 0.8, 20);
  eq(r.agents, 8, 0, 'needs 8 seats for 80/20');
  ok(A.queueMetrics(100, 180, 7, 20).serviceLevel < 0.8, 'and 7 genuinely misses');
});

/* ── inference ── */
test('twoProportionZTest matches a hand-computed z', () => {
  const r = A.twoProportionZTest(45, 100, 30, 100);   // z = 0.15/0.068465 = 2.1909
  eq(r.z, 2.19089, 1e-4);
  eq(r.p, 0.02846, 1e-4);
  ok(r.significant);
  eq(r.diff, 0.15, 1e-9);
  ok(r.ci95[0] > 0, 'CI excludes zero, consistent with p<0.05');
});
test('twoProportionZTest calls a null difference null', () => {
  const r = A.twoProportionZTest(50, 100, 50, 100);
  eq(r.z, 0, 1e-12); ok(!r.significant);
});
test('sampleSize grows as the effect shrinks', () => {
  const big = A.sampleSizeForProportion(0.2, 0.5);
  const small = A.sampleSizeForProportion(0.2, 0.1);
  ok(small.n > big.n * 5, 'detecting a 10% lift costs far more than a 50% lift');
  // p1=0.20 vs p2=0.30 at 80% power / alpha .05 needs ~294 per arm.
  // Verified independently against the standard formula, not read off the
  // implementation: the first draft of this test guessed 30-200 and was wrong.
  eq(big.n, 294, 0, 'known sample-size table value');
});
test('wilson interval matches hand computation', () => {
  const w = A.wilson(45, 100);
  eq(w.lo, 0.35614, 1e-4);
  eq(w.hi, 0.54756, 1e-4);
  const edge = A.wilson(0, 20);
  ok(edge.lo === 0 && edge.hi > 0 && edge.hi < 0.2, 'stays inside [0,1] at the boundary');
});

/* ── cohorts / utils ── */
test('cohortMatrix builds retention rates', () => {
  const rows = [
    { c: '2026-01', p: [0, 1, 2] }, { c: '2026-01', p: [0, 1] }, { c: '2026-01', p: [0] },
    { c: '2026-02', p: [0, 1] },    { c: '2026-02', p: [0] }
  ];
  const m = A.cohortMatrix(rows, { cohortOf: r => r.c, periodsOf: r => r.p, maxPeriods: 3 });
  eq(m.length, 2, 0);
  eq(m[0].size, 3, 0);
  eq(m[0].rates[0], 1, 1e-9);
  eq(m[0].rates[1], 2 / 3, 1e-9);
  eq(m[0].rates[2], 1 / 3, 1e-9);
});
test('normalize maps to 0..1 and survives flat input', () => {
  const n = A.normalize([0, 5, 10]);
  eq(n[0], 0); eq(n[1], 0.5); eq(n[2], 1);
  ok(A.normalize([3, 3, 3]).every(v => v === 0.5), 'flat ⇒ 0.5, never NaN');
});
test('mulberry32 is deterministic and in range', () => {
  const a = A.mulberry32(42), b = A.mulberry32(42);
  for (let i = 0; i < 50; i++) {
    const v = a();
    eq(v, b(), 1e-15, 'same seed ⇒ same stream');
    ok(v >= 0 && v < 1, 'stays in [0,1)');
  }
});

export function runTests() {
  const results = T.map(({ name, fn }) => {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    try { fn(); return { name, pass: true, ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0 }; }
    catch (e) { return { name, pass: false, error: e.message, ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0 }; }
  });
  return { results, passed: results.filter(r => r.pass).length, total: results.length };
}
