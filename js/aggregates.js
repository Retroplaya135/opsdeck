/* ═══════════════════════════════════════════════════════════════════════════
   Derived metrics over the entity arrays.
   ═══════════════════════════════════════════════════════════════════════════
   Extracted from the view layer so it can be unit tested — these functions
   decide every grade, margin and health score in the product, and previously
   the only way to check them was to look at a rendered page.

   Memoised throughout: the console re-reads the same windows on every
   navigation, and the caches are pure functions of immutable-per-dataset
   inputs. resetCaches() is called whenever the data underneath changes.
   ═══════════════════════════════════════════════════════════════════════════ */
import * as A from './analytics.js';
import { DAY, TODAY, clamp, sum } from './util.js';
import { CLIENTS, CLIENT_BY, AGENTS, AGENT_BY, APPTS, LEADS, LEAD_STAGES, CFG, PROGRAM_OVERHEAD } from './state.js';

/* PAST/FUTURE are arrays, not snapshots: rebuildWindows() refills them in
   place after a data replace so every closure that captured them stays
   correct. Reassigning would silently orphan those readers. */
export const PAST = APPTS.filter(a => a.t <= TODAY.getTime());
export const FUTURE = APPTS.filter(a => a.t > TODAY.getTime());
export const KEPT = new Set(['showed', 'closed']);
export const apptFees = (rows) => sum(rows.filter(r => KEPT.has(r.outcome)), r => r.value);

export function rebuildWindows() {
  PAST.length = 0; FUTURE.length = 0;
  const now = TODAY.getTime();
  for (const a of APPTS) (a.t <= now ? PAST : FUTURE).push(a);
}



/* PAST is immutable, so every one of these is a pure function of (days) and
   safe to memoise for the life of the page. Without the caches, drawing the
   client table re-scanned all ~3k appointment rows once per client per day —
   ~900k comparisons for one render, and the single biggest cost in the app. */
export const winCache = new Map(), agentCache = new Map(), clientCache = new Map(), dayCountCache = new Map();

export function inWindow(days) {
  let hit = winCache.get(days);
  if (hit) return hit;
  const hi = TODAY.getTime(), lo = hi - (days - 1) * DAY;
  hit = PAST.filter(a => a.t >= lo && a.t <= hi);
  winCache.set(days, hit);
  return hit;
}

export function byKey(cache, keyer, id, days) {
  const k = id + '|' + days;
  let hit = cache.get(k);
  if (hit) return hit;
  hit = inWindow(days).filter(a => keyer(a) === id);
  cache.set(k, hit);
  return hit;
}

/* Per-day counts for one entity, as a Map keyed by day timestamp — turns the
   sparkline build from O(days × rows) into one linear pass. */
export function dayCounts(kind, id, days) {
  const k = kind + '|' + id + '|' + days;
  let hit = dayCountCache.get(k);
  if (hit) return hit;
  hit = new Map();
  const rows = kind === 'client' ? clientAppts(id, days) : agentAppts(id, days);
  for (const a of rows) hit.set(a.t, (hit.get(a.t) || 0) + 1);
  dayCountCache.set(k, hit);
  return hit;
}

/* day-bucketed series, computed once per (days) value and memoised */
export const seriesCache = new Map();
export function daySeries(days) {
  if (seriesCache.has(days)) return seriesCache.get(days);
  const out = [];
  const base = TODAY.getTime() - (days - 1) * DAY;
  const idx = new Map();
  for (let i = 0; i < days; i++) {
    const t = base + i * DAY;
    const row = {t, booked:0, showed:0, closed:0, noshow:0, revenue:0};
    out.push(row); idx.set(t, row);
  }
  for (const a of PAST) {
    const row = idx.get(a.t);
    if (!row) continue;
    row.booked++;
    if (a.outcome === 'showed' || a.outcome === 'closed') { row.showed++; row.revenue += a.value; }
    if (a.outcome === 'closed') row.closed++;
    if (a.outcome === 'noshow') row.noshow++;
  }
  seriesCache.set(days, out);
  return out;
}

export const activeAgents = () => AGENTS.filter(a => a.active);
export const agentAppts = (id, days) => byKey(agentCache, a => a.agentId, id, days);
export const clientAppts = (id, days) => byKey(clientCache, a => a.clientId, id, days);

export function agentStats(ag, days) {
  const rows = agentAppts(ag.id, days);
  const tenureDays = clamp(Math.round(((ag.endedAt || TODAY.getTime()) - ag.startedAt) / DAY), 1, 9999);
  const span = Math.min(days, tenureDays);
  const shown = rows.filter(r => KEPT.has(r.outcome)).length;
  const closed = rows.filter(r => r.outcome === 'closed').length;
  const last = rows.length ? Math.max.apply(null, rows.map(r => r.t)) : null;
  const perDay = rows.length / span;
  let grade;
  if (!ag.active) grade = 'churned';
  else if (tenureDays < CFG.rampDays) grade = 'ramping';
  else if (perDay >= CFG.keeperThreshold) grade = 'keeper';
  else if (perDay < CFG.fireThreshold) grade = 'fire';
  else grade = 'steady';
  // Revenue attributed to a seat = its share of the client's retainer plus
  // the per-appointment fees it actually earned. Fees alone would show every
  // human seat as loss-making, which is an artefact of the model, not truth.
  const cl = CLIENT_BY[ag.clientId];
  const seatsOnAccount = Math.max(1, AGENTS.filter(x => x.clientId === ag.clientId && x.active).length);
  const retainerShare = (cl.mrr / seatsOnAccount) * (days / 30);
  return {
    rows, tenureDays, perDay, total: rows.length, shown, closed,
    sit: rows.length ? shown / rows.length : 0,
    close: shown ? closed / shown : 0,
    last, grade,
    revenue: retainerShare + apptFees(rows),
    pay: ag.kind === 'ai' ? ag.seatCost * (days / 30) : (ag.base * (days / 30)) + rows.length * CFG.bonusPerAppt
  };
}

export function clientStats(c, days) {
  const rows = clientAppts(c.id, days);
  const shown = rows.filter(r => KEPT.has(r.outcome)).length;
  const closed = rows.filter(r => r.outcome === 'closed').length;
  const seats = AGENTS.filter(a => a.clientId === c.id && a.active);
  const cost = sum(seats, a => a.kind === 'ai' ? a.seatCost * (days/30) : (a.base * (days/30)) + agentAppts(a.id, days).length * CFG.bonusPerAppt);
  // Current-period retainer is zero once the account has left. Historical
  // months still bill `c.mrr` (last fee) in pnlMonths, which already filters
  // on churnedOn. Using last fee here would keep a departed account looking
  // like live MRR in the 30-day client table.
  const retainer = (c.status === 'churned' ? 0 : (c.mrr || 0)) * (days / 30);
  const perf = apptFees(rows);
  const rev = retainer + perf;
  const sit = rows.length ? shown / rows.length : 0;
  const close = shown ? closed / shown : 0;
  // Each term is individually capped at its own weight, so a strong account
  // can't overflow one dimension and mask a weak one — without that, half the
  // book pegs at a flat 1.00 and the column stops discriminating.
  const health = 0.30 * clamp(sit / CFG.showTarget, 0, 1)
               + 0.30 * clamp((rows.length / Math.max(1, seats.length) / days) / CFG.target, 0, 1)
               + 0.20 * clamp(close / 0.45, 0, 1)
               + 0.20 * (c.flag === 'expansion' ? 1 : c.flag === 'watch' ? 0.35 : 0.8);
  return {
    rows, total: rows.length, shown, closed, seats: seats.length, sit, close,
    upcoming: FUTURE.filter(a => a.clientId === c.id).length,
    cpa: rows.length ? rev / rows.length : 0,
    perf, revenue: rev, cost, margin: rev - cost,
    health: clamp(health, 0, 1)
  };
}

export const leadsByStage = () => {
  const m = {};
  for (const s of LEAD_STAGES) m[s.id] = [];
  m.lost = [];
  for (const l of LEADS) (m[l.stage] || (m[l.stage] = [])).push(l);
  return m;
};

export const STAGE_RANK = Object.fromEntries(LEAD_STAGES.map((s, i) => [s.id, i]));
/* Every lead has exactly one CURRENT stage — fine for a kanban column count,
   wrong for a funnel's stage-over-stage rate. A lead currently "showed" is
   not counted as having also passed through "booked", so raw per-stage
   counts can rise from one row to the next (they did: 37 booked, 47 showed
   — a 127% "conversion"). A funnel needs *cumulative* reach: how many leads
   got at least this far, which is monotonically non-increasing by
   construction regardless of how the current-stage histogram happens to
   fall. leadsByStage()/the kanban board are unaffected — they're counting
   the right thing for what they show. */
export function cumulativeFunnelData(leadsSubset) {
  return LEAD_STAGES.map((st, i) => ({
    label: st.label, color: st.color,
    n: leadsSubset.filter(l => l.stage !== 'lost' && STAGE_RANK[l.stage] >= i).length
  }));
}

export function pnlMonths(n) {
  const out = [];
  const cur = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(cur.getFullYear(), cur.getMonth() - i, 1);
    const end = new Date(cur.getFullYear(), cur.getMonth() - i + 1, 1);
    const rows = PAST.filter(a => a.t >= start.getTime() && a.t < end.getTime());
    // Billed that month = signed before the month ended AND not yet churned
    // when it began. Without both tests every month bills the same flat
    // number and the revenue line stops telling you anything.
    const billed = CLIENTS.filter(c =>
      new Date(c.since).getTime() < end.getTime()
      && (!c.churnedOn || new Date(c.churnedOn).getTime() >= start.getTime()));
    const retainer = sum(billed, c => c.mrr || 0);
    const perf = apptFees(rows);
    const humanBase = sum(AGENTS.filter(a => a.kind === 'human' && a.startedAt < end.getTime() && (!a.endedAt || a.endedAt > start.getTime())), a => a.base);
    const bonus = rows.filter(r => AGENT_BY[r.agentId] && AGENT_BY[r.agentId].kind === 'human').length * CFG.bonusPerAppt;
    const aiCost = AGENTS.filter(a => a.kind === 'ai' && a.startedAt < end.getTime() && (!a.endedAt || a.endedAt > start.getTime())).length * CFG.aiSeatCost;
    const overhead = PROGRAM_OVERHEAD;
    const revenue = retainer + perf;
    const cost = humanBase + bonus + aiCost + overhead;
    out.push({
      label: start.toLocaleDateString('en-US',{month:'short'}),
      full: start.toLocaleDateString('en-US',{month:'long', year:'numeric'}),
      revenue, retainer, perf, humanBase, bonus, aiCost, overhead, cost,
      margin: revenue - cost, mpct: revenue ? (revenue - cost) / revenue : 0,
      appts: rows.length, partial: i === 0
    });
  }
  return out;
}



/* Every cache here derives from the entity arrays. A data replace must clear
   all of them together — a stale window cache beside fresh rows renders last
   period's numbers as current, with nothing to indicate it. */
export function resetCaches() {
  seriesCache.clear(); winCache.clear(); agentCache.clear();
  clientCache.clear(); dayCountCache.clear();
  rebuildWindows();
}
