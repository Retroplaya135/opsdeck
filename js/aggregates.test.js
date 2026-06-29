/* Value assertions for the derived-metrics layer.

   The existing suites prove the maths engine is right and that views render
   without crashing. Neither proves the numbers a view DISPLAYS are correct —
   a view could show a confidently wrong figure and pass everything. These
   assertions check the arithmetic that produces grades, margins and health,
   against values recomputed independently from the raw rows. */
import * as G from './aggregates.js';
import { CLIENTS, CLIENT_BY, AGENTS, APPTS, LEADS, CFG, PROGRAM_OVERHEAD } from './state.js';
import { TODAY, DAY } from './util.js';

const T = [];
const test = (n, f) => T.push({ name: n, fn: f });
class Fail extends Error {}
const ok = (c, m) => { if (!c) throw new Fail(m || 'expected truthy'); };
const near = (a, b, eps, m) => {
  if (Math.abs(a - b) > (eps ?? 1e-9)) throw new Fail(`${m || ''} expected ${b}, got ${a}`);
};
const eq = (a, b, m) => { if (a !== b) throw new Fail(`${m || ''} expected ${b}, got ${a}`); };

/* ── window partitioning ── */
test('PAST and FUTURE partition APPTS with no overlap or loss', () => {
  eq(G.PAST.length + G.FUTURE.length, APPTS.length, 'every appointment lands in exactly one window');
  const now = TODAY.getTime();
  ok(G.PAST.every(a => a.t <= now), 'PAST holds nothing in the future');
  ok(G.FUTURE.every(a => a.t > now), 'FUTURE holds nothing in the past');
});

test('rebuildWindows restores the partition after a mutation', () => {
  const before = G.PAST.length;
  G.PAST.length = 0;                 // simulate a torn cache
  G.rebuildWindows();
  eq(G.PAST.length, before, 'rebuild is idempotent against the same data');
});

/* ── daySeries ── */
test('daySeries returns one bucket per day, oldest first, ending today', () => {
  const s = G.daySeries(30);
  eq(s.length, 30);
  eq(s[29].t, TODAY.getTime(), 'last bucket is today');
  eq(s[0].t, TODAY.getTime() - 29 * DAY, 'first bucket is 29 days back');
  for (let i = 1; i < s.length; i++) eq(s[i].t - s[i - 1].t, DAY, 'buckets are contiguous days');
});

test('daySeries totals equal a direct count over the same window', () => {
  const days = 30;
  const s = G.daySeries(days);
  const lo = TODAY.getTime() - (days - 1) * DAY;
  const direct = G.PAST.filter(a => a.t >= lo && a.t <= TODAY.getTime());
  eq(s.reduce((n, d) => n + d.booked, 0), direct.length, 'booked matches a raw filter');
  eq(s.reduce((n, d) => n + d.showed, 0),
     direct.filter(a => G.KEPT.has(a.outcome)).length, 'sat matches a raw filter');
  eq(s.reduce((n, d) => n + d.closed, 0),
     direct.filter(a => a.outcome === 'closed').length, 'closed matches a raw filter');
});

test('showed is always a subset of booked, per day', () => {
  for (const d of G.daySeries(90)) {
    ok(d.showed <= d.booked, `sat (${d.showed}) cannot exceed booked (${d.booked})`);
    ok(d.closed <= d.showed, `closed (${d.closed}) cannot exceed sat (${d.showed})`);
  }
});

/* ── agent statistics ── */
test('agentStats counts match a direct filter of the ledger', () => {
  const ag = G.activeAgents()[0];
  const st = G.agentStats(ag, 30);
  const lo = TODAY.getTime() - 29 * DAY;
  const mine = G.PAST.filter(a => a.agentId === ag.id && a.t >= lo);
  eq(st.total, mine.length, 'booked count');
  eq(st.shown, mine.filter(a => G.KEPT.has(a.outcome)).length, 'sat count');
  eq(st.closed, mine.filter(a => a.outcome === 'closed').length, 'closed count');
});

test('agentStats rates are internally consistent', () => {
  for (const ag of G.activeAgents().slice(0, 12)) {
    const st = G.agentStats(ag, 60);
    ok(st.sit >= 0 && st.sit <= 1, 'show rate is a proportion');
    ok(st.close >= 0 && st.close <= 1, 'close rate is a proportion');
    if (st.total) near(st.sit, st.shown / st.total, 1e-12, 'sit = shown/total');
    if (st.shown) near(st.close, st.closed / st.shown, 1e-12, 'close = closed/shown');
    ok(st.perDay >= 0, 'per-day is non-negative');
  }
});

test('agent grade follows the configured thresholds', () => {
  for (const ag of G.activeAgents()) {
    const st = G.agentStats(ag, 30);
    if (st.grade === 'keeper') ok(st.perDay >= CFG.keeperThreshold, 'keeper clears the keeper bar');
    if (st.grade === 'fire')   ok(st.perDay < CFG.fireThreshold, 'fire sits under the floor');
    if (st.grade === 'ramping') ok(st.tenureDays < CFG.rampDays, 'ramping is inside the ramp window');
    ok(['keeper','steady','fire','ramping','churned'].includes(st.grade), 'grade is a known value');
  }
});

test('an agent inside the ramp window is never graded fire', () => {
  // Grading a two-day-old seat as a fire candidate is the specific mistake
  // the ramp window exists to prevent.
  const ramping = AGENTS.filter(a => a.active &&
    (TODAY.getTime() - a.startedAt) / DAY < CFG.rampDays);
  for (const ag of ramping) eq(G.agentStats(ag, 30).grade, 'ramping');
});

/* ── client statistics ── */
test('clientStats revenue and cost decompose correctly', () => {
  for (const c of CLIENTS.filter(x => x.status === 'active').slice(0, 6)) {
    const st = G.clientStats(c, 30);
    const retainer = c.mrr;                       // 30 days = one month
    const perf = st.rows.filter(r => G.KEPT.has(r.outcome)).reduce((n, r) => n + r.value, 0);
    near(st.perf, perf, 1e-6, 'perf credits showed/closed fees only');
    near(st.revenue, retainer + perf, 1e-6, 'revenue = retainer + kept performance fees');
    near(st.margin, st.revenue - st.cost, 1e-6, 'margin = revenue - cost');
    ok(st.cost >= 0, 'cost is non-negative');
  }
});

test('client health stays inside [0,1] and rewards better performance', () => {
  const scored = CLIENTS.filter(c => c.status === 'active')
    .map(c => ({ c, st: G.clientStats(c, 30) }));
  for (const { st } of scored) ok(st.health >= 0 && st.health <= 1, 'health is bounded');
  // Not every dimension is monotonic on its own, but an account that is better
  // on show rate, volume AND close rate must not score lower.
  for (const a of scored) for (const b of scored) {
    if (a.st.sit > b.st.sit && a.st.close > b.st.close &&
        a.st.total > b.st.total && a.c.flag === b.c.flag) {
      ok(a.st.health >= b.st.health - 1e-9,
         `strictly better account scored lower (${a.st.health} < ${b.st.health})`);
    }
  }
});

/* ── funnel ── */
test('cumulative funnel is monotonically non-increasing', () => {
  // The bug this replaced showed 127% conversion because per-stage counts
  // were used where cumulative reach was needed.
  const f = G.cumulativeFunnelData(LEADS);
  for (let i = 1; i < f.length; i++) {
    ok(f[i].n <= f[i - 1].n,
       `stage ${f[i].label} (${f[i].n}) exceeds ${f[i-1].label} (${f[i-1].n})`);
  }
});

/* ── P&L ── */
test('P&L rows are internally consistent', () => {
  for (const m of G.pnlMonths(6)) {
    near(m.revenue, m.retainer + m.perf, 1e-6, 'revenue decomposes');
    near(m.cost, m.humanBase + m.bonus + m.aiCost + m.overhead, 1e-6, 'cost decomposes');
    near(m.margin, m.revenue - m.cost, 1e-6, 'margin = revenue - cost');
    if (m.revenue) near(m.mpct, m.margin / m.revenue, 1e-12, 'margin % matches');
    eq(m.overhead, PROGRAM_OVERHEAD, 'overhead is the declared constant');
  }
});

test('P&L retainer is last billed MRR, never a leftover $7300', () => {
  const barwood = CLIENTS.find(c => c.id === 'c5');
  ok(barwood && barwood.mrr > 0 && barwood.mrr !== 7300, 'churned account keeps its last retainer');
  const cap = CLIENTS.filter(c => c.status === 'active').reduce((n, c) => n + c.mrr, 0) + barwood.mrr;
  for (const m of G.pnlMonths(9)) {
    ok(m.retainer !== 7300, 'retired magic constant is gone');
    ok(m.retainer <= cap + 1e-6, 'retainer is the sum of billed accounts');
  }
});

test('P&L performance fees match KEPT appointments in each month', () => {
  const cur = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
  G.pnlMonths(6).forEach((m, i, arr) => {
    const start = new Date(cur.getFullYear(), cur.getMonth() - (arr.length - 1 - i), 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const rows = G.PAST.filter(a => a.t >= start.getTime() && a.t < end.getTime());
    near(m.perf, G.apptFees(rows), 1e-6, m.full);
  });
});

test('P&L months are chronological and end with a partial current month', () => {
  const ms = G.pnlMonths(6);
  eq(ms.length, 6);
  eq(ms[5].partial, true, 'the current month is flagged partial');
  ok(ms.slice(0, 5).every(m => !m.partial), 'earlier months are complete');
});

/* ── caching ── */
test('memoised reads return equal values on repeat', () => {
  const a = G.daySeries(45).map(d => d.booked);
  const b = G.daySeries(45).map(d => d.booked);
  eq(JSON.stringify(a), JSON.stringify(b), 'cached series is stable');
  const ag = G.activeAgents()[0];
  eq(G.agentAppts(ag.id, 30).length, G.agentAppts(ag.id, 30).length, 'cached agent window is stable');
});

test('resetCaches does not change the values, only recomputes them', () => {
  const before = G.daySeries(30).reduce((n, d) => n + d.booked, 0);
  G.resetCaches();
  const after = G.daySeries(30).reduce((n, d) => n + d.booked, 0);
  eq(after, before, 'clearing a cache must not move a number');
});

export function runTests() {
  const now = () => (typeof performance !== 'undefined' ? performance : Date).now();
  const results = T.map(({ name, fn }) => {
    const t0 = now();
    try { fn(); return { name, pass: true, ms: now() - t0 }; }
    catch (e) { return { name, pass: false, error: e.message, ms: now() - t0 }; }
  });
  return { results, passed: results.filter(r => r.pass).length, total: results.length };
}
