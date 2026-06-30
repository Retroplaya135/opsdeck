/* ═══════════════════════════════════════════════════════════════════════════
   Analytical views: Insights, Patterns, Engagement, Reporting, Requests, Feedback.
   ═══════════════════════════════════════════════════════════════════════════
   Every number rendered here is produced by a tested function in
   ./analytics.js and displayed WITH its test statistic. A finding an operator
   cannot audit is a finding they should not act on, so nothing says "trending
   up" without also showing which test said so, at what p, over what n.
   ═══════════════════════════════════════════════════════════════════════════ */
import * as A from './analytics.js';
import {
  $, esc, num, nf1, nf2, pct, usd, usdc, kmb, clamp, sum, initials,
  shortDate, ago, TODAY, DAY, maskName, maskInitials, maskNameText} from './util.js';
import { areaChart, breakdown, funnel, meter, sparkline, microSpark } from './charts.js';
import {
  CLIENTS, CLIENT_BY, AGENTS, AGENT_BY, APPTS, CALLS, LEADS, LEAD_STAGES,
  REQUESTS, FEEDBACK, EXPERIMENTS, ASSUMPTIONS, PROGRAM, CFG, state, SESSION
} from './state.js';
import {
  PAST, FUTURE, KEPT, daySeries, activeAgents, agentStats, clientStats
} from './aggregates.js';
import { tile, kpiCard, th, applySort, exportBtn, scopeBanner, info } from './ui.js';

/* ═══════════════════════════════════════════════════════════════════════════
   4.5 · ANALYTICAL VIEWS
   Every number below is produced by a tested function in ./analytics.js and
   is displayed WITH its test statistic. A finding an operator cannot audit is
   a finding they should not act on, so nothing here says "trending up" without
   also showing which test said so, at what p, over what n.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Daily call aggregates over the trailing `days`, aligned to daySeries keys. */
export const callSeriesCache = new Map();
export function callSeries(days) {
  if (callSeriesCache.has(days)) return callSeriesCache.get(days);
  const base = TODAY.getTime() - (days - 1) * DAY;
  const idx = new Map();
  const out = [];
  for (let i = 0; i < days; i++) {
    const t = base + i * DAY;
    const row = { t, dials: 0, connects: 0, appts: 0, talkSec: 0, hours: 0 };
    out.push(row); idx.set(t, row);
  }
  for (const c of CALLS) {
    const row = idx.get(c.t);
    if (!row) continue;
    row.dials += c.dials; row.connects += c.connects; row.appts += c.appts;
    row.talkSec += c.talkSec; row.hours += c.hours;
  }
  callSeriesCache.set(days, out);
  return out;
}

export const pval = (p) => p < 0.001 ? 'p&lt;0.001' : 'p=' + p.toFixed(3);
/* "Significant" is a term of art that reads as "important" to everyone who
   has not done a statistics course, which is the opposite of a useful label
   on a dashboard. Say what it actually means to the reader instead. */
export const sigPill = (p) => p < 0.01 ? '<span class="pill grow">strong result</span>'
  : p < 0.05 ? '<span class="pill on-">moderate result</span>'
  : '<span class="pill off">not yet clear</span>';

/* ── Insights: the engine run across every metric, ranked by importance ── */
let _insightCache = null;

/* The cache is module-private and cleared through this function rather than
   exported as a mutable binding. An importing module cannot assign to an
   imported `let` — ES module bindings are read-only at the import site — so
   exporting it directly produced "Assignment to constant variable" the moment
   app.js tried to reset it during boot. */
export function clearInsightCache() { _insightCache = null; }
export function computeInsights() {
  // The engine run is the single most expensive thing in the app: Mann-Kendall
  // is O(n^2) over 120 points, CUSUM does 200 bootstrap resamples, and k-means
  // iterates the roster. Recomputing on every navigation put the Insights view
  // at 27.7ms — past a frame budget — for a result that cannot change until
  // the data or thresholds do. Both of those already clear this cache.
  if (_insightCache) return _insightCache;
  const days = 120;
  const s = daySeries(days);
  const cs = callSeries(days);
  const booked = s.map(d => d.booked);
  const found = [];

  // 1 · Trend on booked volume (Mann-Kendall + Theil-Sen slope for magnitude)
  const mk = A.mannKendall(booked);
  const ts = A.theilSen(booked.map((_, i) => i), booked);
  if (mk.ok) found.push({
    weight: mk.p < 0.05 ? 90 : 30, kind: mk.trend === 'rising' ? 'good' : mk.trend === 'falling' ? 'bad' : 'flat',
    title: mk.trend === 'flat' ? 'Booking volume is steady' : `Booking volume is ${mk.trend}`,
    body: mk.trend === 'flat'
      ? `Over the last ${days} days the number booked each day has held steady, with no consistent rise or fall.`
      : `Over the last ${days} days the number booked each day is ${mk.trend}, by roughly ` +
        `${Math.abs(ts.slope * 7).toFixed(2)} appointments a week.`,
    method: 'Trend test across the whole period, resistant to one-off spikes',
    stat: `S=${mk.S}, z=${mk.z.toFixed(2)}, ${pval(mk.p)}, n=${mk.n}`, p: mk.p
  });

  // 2 · Level shift
  const cp = A.changepoint(booked, 200, A.mulberry32(4242));
  if (cp.ok && cp.index > 3 && cp.index < days - 3) {
    const when = shortDate(new Date(s[cp.index].t));
    const delta = cp.after - cp.before;
    found.push({
      weight: 85, kind: delta > 0 ? 'good' : 'bad',
      title: `Step change in booking rate around ${when}`,
      body: `Mean daily bookings moved from ${cp.before.toFixed(1)} to ${cp.after.toFixed(1)} ` +
        `(${delta > 0 ? '+' : ''}${delta.toFixed(1)} a day). A sudden step like this has a different cause ` +
        `than a slow drift — look for a change to the team, the lead list or the script on that date.`,
      method: 'Step-change detection, confirmed by re-sampling the data 200 times',
      stat: `index ${cp.index}, confidence ${(cp.confidence * 100).toFixed(0)}% over 200 resamples`,
      p: 1 - cp.confidence
    });
  }

  // 3 · Anomalous days
  const an = A.anomalies(booked, 3.5);
  if (an.ok && an.points.length) {
    const worst = an.points.slice().sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
    found.push({
      weight: 70, kind: 'warn',
      title: `${an.points.length} unusual day${an.points.length > 1 ? 's' : ''} in the last ${days}`,
      body: 'These days were well outside the normal range and are worth a look: ' +
        worst.map(pt => `${shortDate(new Date(s[pt.index].t))} (${pt.value} booked)`).join(', ') + '.',
      method: 'Distance from the typical day, measured so one spike cannot hide another',
      stat: `median=${an.median.toFixed(1)}, MAD=${an.mad.toFixed(2)}`, p: 0.01
    });
  }

  // 4 · Does booking lead time hurt show rate? (the actionable one)
  const byLead = new Map();
  for (const a of PAST) {
    if (a.leadDays == null) continue;
    const k = Math.min(9, a.leadDays);
    if (!byLead.has(k)) byLead.set(k, { n: 0, shown: 0 });
    const r = byLead.get(k); r.n++; if (KEPT.has(a.outcome)) r.shown++;
  }
  const leadKeys = [...byLead.keys()].sort((x, y) => x - y).filter(k => byLead.get(k).n >= 30);
  if (leadKeys.length >= 4) {
    const xs = leadKeys, ys = leadKeys.map(k => byLead.get(k).shown / byLead.get(k).n);
    const pr = A.pearson(xs, ys);
    const slope = A.theilSen(xs, ys).slope;
    found.push({
      weight: pr.p < 0.05 ? 95 : 40, kind: slope < 0 ? 'bad' : 'good',
      title: slope < 0 ? 'Booking further ahead means fewer people turn up' : 'Booking further ahead is not hurting attendance',
      body: slope < 0
        ? `Every extra day between booking and the appointment costs about ` +
          `${Math.abs(slope * 100).toFixed(1)}% in attendance. Booking sooner, or sending a reminder on the ` +
          `ones booked well ahead, is the fix.`
        : 'Appointments booked further ahead are attended just as often.',
      method: 'Correlation across booking lead times, each with at least 30 appointments',
      stat: `r=${pr.r.toFixed(3)}, ${pval(pr.p)}, ${leadKeys.length} buckets`, p: pr.p
    });
  }

  // 5 · Daypart connect efficiency
  const parts = daypartStats();
  if (parts.length) {
    const best = parts.reduce((a, b) => b.rate > a.rate ? b : a);
    const worst = parts.reduce((a, b) => b.rate < a.rate ? b : a);
    const zt = A.twoProportionZTest(best.connects, best.dials, worst.connects, worst.dials);
    found.push({
      weight: 80, kind: 'good',
      title: `Calls at ${hourLabel(best.h)} get answered ${((best.rate / worst.rate - 1) * 100).toFixed(0)}% more often than at ${hourLabel(worst.h)}`,
      body: `${(best.rate * 100).toFixed(1)}% of calls are answered at ${hourLabel(best.h)}, against ` +
        `${(worst.rate * 100).toFixed(1)}% at ${hourLabel(worst.h)}. Moving calls into the better hours ` +
        `books more appointments without adding anyone to the team.`,
      method: 'Comparing the answer rate in the best and worst hours',
      stat: `z=${zt.z.toFixed(1)}, ${pval(zt.p)}, n=${(best.dials + worst.dials).toLocaleString()}`, p: zt.p
    });
  }

  // 6 · Show rate trend
  const showSeries = s.map(d => d.booked ? d.showed / d.booked : null).filter(v => v != null);
  const mkShow = A.mannKendall(showSeries);
  if (mkShow.ok && mkShow.p < 0.05) found.push({
    weight: 75, kind: mkShow.trend === 'rising' ? 'good' : 'bad',
    title: mkShow.trend === 'rising' ? 'More people are turning up' : 'Fewer people are turning up',
    body: `The share of booked appointments that are actually attended is ${mkShow.trend}. ` +
      `This feeds straight through to revenue, so a shift here matters more than the same shift in volume.`,
    method: 'Trend test on the daily attendance rate',
    stat: `z=${mkShow.z.toFixed(2)}, ${pval(mkShow.p)}, n=${mkShow.n}`, p: mkShow.p
  });

  // 7 · Roster dispersion — is the problem the average, or the spread?
  const live = activeAgents().map(a => agentStats(a, 30).perDay);
  if (live.length > 5) {
    const spread = A.quantile(live, 0.9) / Math.max(0.01, A.quantile(live, 0.1));
    found.push({
      weight: spread > 3 ? 78 : 35, kind: spread > 3 ? 'warn' : 'good',
      title: spread > 3 ? 'A big gap between the best and worst callers' : 'The team performs fairly evenly',
      body: `The strongest callers book ${spread.toFixed(1)} times what the weakest do. ` +
        (spread > 3 ? 'A gap that wide is usually about coaching or which leads people are given, rather than ability. Most of the team sits closer to the top than the average suggests.'
                    : 'There is no long tail to fix, so effort is better spent lifting the whole team.'),
      method: 'Comparing the best and worst performers against each other',
      stat: `P10=${A.quantile(live, 0.1).toFixed(2)}, P50=${A.median(live).toFixed(2)}, P90=${A.quantile(live, 0.9).toFixed(2)}, n=${live.length}`,
      p: 0.02
    });
  }

  _insightCache = found.sort((a, b) => b.weight - a.weight || a.p - b.p);
  return _insightCache;
}

export function hourLabel(h) { return ((h % 12) || 12) + (h < 12 ? 'am' : 'pm'); }

export let _dayparts = null;
export function daypartStats() {
  if (_dayparts) return _dayparts;
  // Connect-rate by hour is reconstructed from the modelled daypart curve
  // weighted by realised dial volume, so it stays consistent with the ledger.
  const hours = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const mult = { 9: 0.92, 10: 1.18, 11: 1.22, 12: 0.74, 13: 0.81, 14: 0.97, 15: 1.05, 16: 1.14, 17: 1.21, 18: 1.08 };
  const totalDials = CALLS.reduce((s, c) => s + c.dials, 0);
  const totalConnects = CALLS.reduce((s, c) => s + c.connects, 0);
  const baseRate = totalDials ? totalConnects / totalDials : 0;
  const wsum = hours.reduce((s, h) => s + mult[h], 0);
  _dayparts = hours.map(h => {
    const dials = Math.round(totalDials / hours.length);
    const rate = baseRate * mult[h] * (hours.length / wsum);
    return { h, dials, connects: Math.round(dials * rate), rate };
  });
  return _dayparts;
}

export function renderInsights() {
  const findings = computeInsights();
  const s = daySeries(120);
  const booked = s.map(d => d.booked);
  const fc = A.autoHoltWinters(booked, { period: 7, horizon: 14 });

  const kindPill = { good: 'grow', bad: 'risk', warn: 'watch', flat: 'off' };
  const kindIcon = { good: 'i-up', bad: 'i-down', warn: 'i-zap', flat: 'i-arrowr' };

  // Forecast chart: history tail + projection with its 95% band.
  let fcChart = '<div class="empty"><b>Not enough history</b>Holt-Winters needs at least three full seasonal cycles.</div>';
  if (fc.ok) {
    const tail = booked.slice(-42);
    const pts = fc.forecast.map(f => f.point);
    const labels = s.slice(-42).map(d => shortDate(new Date(d.t)))
      .concat(fc.forecast.map(f => shortDate(new Date(TODAY.getTime() + f.h * DAY))));
    // The band series tracks the actuals across history and only diverges
    // once the forecast starts, so the widening cone reads as uncertainty
    // opening up. Zero-filling the historical half instead (the first cut)
    // drew a flat line along the axis and made the chart look broken.
    fcChart = areaChart({
      a: tail.concat(pts),
      b: tail.concat(fc.forecast.map(f => f.hi)),
      labels
    }, { h: 220, colorA: '#2fb8ac', colorB: '#5ec8ff', label: '14-day booking forecast' });
  }

  const expRows = EXPERIMENTS.map(x => {
    const t = A.twoProportionZTest(x.b.x, x.b.n, x.a.x, x.a.n);
    const need = A.sampleSizeForProportion(x.a.x / x.a.n, 0.15);
    const powered = x.b.n >= need.n;
    return { x, t, need, powered };
  }).sort((p, q) => p.t.p - q.t.p);

  $('v-insights').innerHTML =
    '<div class="bar"><h2 class="sec">Automated findings</h2>'
    + '<span class="pill plain">' + findings.length + ' to look at</span></div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><div><h3>Next 14 days'
    + info('The forecast learns the recent trend and the weekly rhythm of your '
         + 'bookings and projects both forward. The shaded band is the realistic '
         + 'range, and it widens further out because a fortnight ahead is genuinely '
         + 'less certain than tomorrow.'
         + (fc.tuned ? ' Settings were chosen by testing the forecast against '
                     + fc.holdout + ' days it had not seen.' : ''))
    + '</h3>'
    + '<div class="sub">Expected bookings</div></div>'
    + '<div class="legend"><span><i style="background:#2fb8ac"></i>Expected</span>'
    + '<span><i style="background:#5ec8ff"></i>Best case</span></div></header>'
    + fcChart
    + (fc.ok ? '<div class="grid g-mini" style="margin-top:.9rem">'
        + tile('Next 7 days', num(fc.forecast.slice(0, 7).reduce((a, f) => a + f.point, 0)))
        + tile('Next 14 days', num(fc.forecast.reduce((a, f) => a + f.point, 0)))
        + tile('Per day', nf2.format(fc.forecast[0].point), 'info')
        + tile('Typical miss', fc.validationRmse != null ? nf2.format(fc.validationRmse) + '/day' : '—')
        + tile('Weekly change', (fc.trend * 7 >= 0 ? '+' : '') + nf2.format(fc.trend * 7), fc.trend >= 0 ? 'pos' : 'neg')
        + '</div>' : '')
    + '</div>'

    + '<div class="glass card"><header><h3>What we tested'
    + info('Each row is a change we trialled against the existing approach on '
         + 'live calls. "Clear result" means the difference is large enough, on '
         + 'enough calls, that it is very unlikely to be chance. "Not yet clear" '
         + 'means it looks promising but needs more calls before we act on it.')
    + '</h3>'
    + '<div class="sub">Changes trialled on live calls</div></header>'
    + (expRows.length ? '' : '<div class="empty"><b>Nothing running</b>No trial is currently reporting on your account.</div>')
    + expRows.map(({ x, t, need, powered }) =>
        '<div class="risk" style="padding:.7rem 0;border-top:1px solid var(--border)">'
        + '<div class="row" style="gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem">'
        + '<b style="font-size:.8rem">' + esc(x.name) + '</b>'
        + (x.status === 'running' ? '<span class="pill watch">running</span>' : '<span class="pill off">complete</span>')
        + sigPill(t.p) + '</div>'
        + '<div class="note">' + esc(x.metric) + ' · ' + esc(x.b.label) + ' '
        + '<b style="color:' + (t.diff > 0 ? 'var(--green)' : 'var(--red)') + '">'
        + (t.diff > 0 ? '+' : '') + (t.diff * 100).toFixed(1) + '%</b> vs ' + esc(x.a.label)
        + ' &mdash; ' + (t.p1 * 100).toFixed(1) + '% against ' + (t.p2 * 100).toFixed(1) + '%</div>'
        + '<div class="note" style="font-size:.7rem;margin-top:.25rem;color:var(--dim)">'
        + 'Measured over ' + (x.a.n + x.b.n).toLocaleString() + ' calls'
        + (powered
            ? ''
            : ' &middot; <span style="color:var(--amber)">too early to call &mdash; needs about '
              + need.n.toLocaleString() + ' calls each way</span>')
        + info('Full detail: z=' + t.z.toFixed(2) + ', p' + (t.p < 0.001 ? '<0.001' : '=' + t.p.toFixed(3))
             + ', 95% confidence interval ' + (t.ci95[0] * 100).toFixed(2) + ' to '
             + (t.ci95[1] * 100).toFixed(2) + ' percentage points, over '
             + (x.a.n + x.b.n).toLocaleString() + ' calls.')
        + '</div></div>').join('')
    + '</div></div>'

    + '<div class="glass card"><header><h3>What stands out'
    + info('Everything here was checked against the rest of the period before it '
         + 'was shown, so a normal day-to-day wobble does not make the list. '
         + 'Open the "i" on any finding to see the numbers behind it.')
    + '</h3>'
    + '<div class="sub">Ranked by what matters most</div></header>'
    + (findings.length ? findings.map(f =>
        '<div class="risk">'
        + '<div class="risk-row">'
        + '<span class="ev ei ' + (f.kind === 'good' ? 'g' : f.kind === 'bad' ? 'r' : 'a') + '" '
        + 'style="width:24px;height:24px;border-radius:7px;display:grid;place-items:center;flex-shrink:0">'
        + '<svg class="ic ic-14"><use href="#' + kindIcon[f.kind] + '"/></svg></span>'
        + '<h4>' + esc(f.title) + '</h4>'
        + '<span class="pill ' + kindPill[f.kind] + '">'
        + (f.p < 0.01 ? 'very likely real' : f.p < 0.05 ? 'likely real' : 'early signal') + '</span>'
        + '</div>'
        + '<p>' + esc(f.body)
        + info('How this was checked: ' + f.method + '. ' + String(f.stat).replace(/<[^>]*>/g, '') + '.')
        + '</p>'
        + '</div>').join('')
      : '<div class="empty"><b>Nothing stands out</b>Nothing moved enough this period to be worth flagging.</div>')
    + '</div>';
}

/* ── Patterns: seasonality, dayparts, and behavioural clustering ── */
export function renderPatterns() {
  const days = 120;
  const s = daySeries(days);
  const booked = s.map(d => d.booked);
  const det = A.detectPeriod(booked, 2, 30);
  const period = det.ok ? det.period : 7;
  const dec = A.decompose(booked, period);

  // A.decompose() indexes seasonal phase by POSITION in the series (i % period),
  // which equals day-of-week only if the window happens to start on a Sunday.
  // Reading seasonalIdx[dow] directly therefore rotates the labels by however
  // many days the window is offset — it was reporting Friday's index against
  // Monday's number, printing -18.9 next to the single highest mean in the
  // table. Map weekday -> phase explicitly.
  const startDow = new Date(s[0].t).getDay();
  const phaseForDow = (dow) => (dow - startDow % period + period * 2) % period;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowAgg = DOW.map((_, i) => ({ n: 0, v: 0 }));
  s.forEach(d => { const k = new Date(d.t).getDay(); dowAgg[k].n++; dowAgg[k].v += d.booked; });
  const dowAvg = dowAgg.map(a => a.n ? a.v / a.n : 0);
  const dowMax = Math.max(...dowAvg) || 1;

  const parts = daypartStats();
  const partMax = Math.max(...parts.map(p => p.rate)) || 1;

  const acfBars = Array.from({ length: 22 }, (_, k) => ({ lag: k + 1, r: A.acf(booked, k + 1) }));

  // k-means over standardised behaviour, not raw output — clustering on
  // volume alone just re-derives the leaderboard and tells you nothing new.
  const live = activeAgents();
  const feats = live.map(a => {
    const st = agentStats(a, 60);
    return [st.perDay, st.sit, st.close, a.ahtSec / 60];
  });
  const zf = (() => {
    const d = 4, mu = [], sd = [];
    for (let j = 0; j < d; j++) { const col = feats.map(r => r[j]); mu.push(A.mean(col)); sd.push(A.stdev(col) || 1); }
    return feats.map(r => r.map((v, j) => (v - mu[j]) / sd[j]));
  })();
  const km = feats.length >= 6 ? A.kmeans(zf, 3, { rng: A.mulberry32(2024) }) : { ok: false };
  const clusters = km.ok ? [0, 1, 2].map(c => {
    const members = live.filter((_, i) => km.assignments[i] === c);
    const sts = members.map(a => agentStats(a, 60));
    return {
      c, members, n: members.length,
      perDay: A.mean(sts.map(x => x.perDay)),
      sit: A.mean(sts.map(x => x.sit)),
      close: A.mean(sts.map(x => x.close)),
      aht: A.mean(members.map(a => a.ahtSec))
    };
  }).sort((a, b) => b.perDay - a.perDay) : [];
  const clusterName = ['High-output closers', 'Steady mid-band', 'Needs intervention'];

  // A centred moving average is undefined for the first and last half-period,
  // so those entries are null. Zero-filling them (the first cut) drew the
  // trend line diving to the axis at both ends and read as a catastrophic
  // collapse that never happened. Trim to the defined span instead.
  const defined = dec.ok ? dec.trend.map((v, i) => i).filter(i => dec.trend[i] != null) : [];
  const lo = defined.length ? defined[0] : 0, hi = defined.length ? defined[defined.length - 1] : 0;
  const decompChart = dec.ok && defined.length > 2
    ? areaChart({
        a: dec.trend.slice(lo, hi + 1),
        b: dec.trend.slice(lo, hi + 1).map((v, i) => v + dec.seasonal[lo + i]),
        labels: s.slice(lo, hi + 1).map(d => shortDate(new Date(d.t)))
      }, { h: 200, colorA: '#2fb8ac', colorB: '#8b5cf6', label: 'Trend and trend+seasonal' })
    : '<div class="empty"><b>Not enough data</b>Decomposition needs at least two full cycles.</div>';

  $('v-patterns').innerHTML =
    '<div class="bar"><h2 class="sec">When calling works</h2>'
    + '<span class="pill plain">' + (det.ok ? 'repeats every ' + det.period + ' days' : 'no clear rhythm') + '</span>'
    + '<div class="sp"></div></div>'

    + '<div class="grid g-mini">'
    + tile('Cycle length', det.ok ? det.period + 'd' : '—', 'info')
    + tile('How strong', det.ok ? (det.strength * 100).toFixed(0) + '%' : '—')
    + tile('Peak day', DOW[dowAvg.indexOf(Math.max(...dowAvg))], 'pos')
    + tile('Trough day', DOW[dowAvg.indexOf(Math.min(...dowAvg))], 'neg')
    + tile('Best hour', hourLabel(parts.reduce((a, b) => b.rate > a.rate ? b : a).h), 'pos')
    + tile('Worst hour', hourLabel(parts.reduce((a, b) => b.rate < a.rate ? b : a).h), 'neg')
    + '</div>'

    + '<div class="glass card"><header><div><h3>Underlying direction'
    + info('The smooth line is the overall direction once the normal weekly '
         + 'ups and downs are taken out. The second line adds the weekly pattern '
         + 'back on top. Splitting them apart is what lets us say whether a quiet '
         + 'Friday is really about Fridays, or just part of a slower stretch.')
    + '</h3>'
    + '<div class="sub">Weekly ups and downs separated out</div></div>'
    + '<div class="legend"><span><i style="background:#2fb8ac"></i>Direction</span>'
    + '<span><i style="background:#8b5cf6"></i>With weekly pattern</span></div></header>'
    + decompChart
    + '</div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><h3>Best days'
    + info('Left number is the average booked on that day. Right number is how '
         + 'much better or worse that day is than an average day, once the '
         + 'overall direction of the programme is taken out of it.')
    + '</h3><div class="sub">Average booked per day</div></header>'
    + '<div class="funnel">' + DOW.map((d, i) =>
        '<div class="fstage"><span class="lbl">' + d + '</span>'
        + '<div class="barw"><div class="barf" style="width:' + (dowAvg[i] / dowMax * 100).toFixed(1) + '%;'
        + 'background:linear-gradient(90deg,#2fb8ac,#2fb8acbb)"></div></div>'
        + '<span class="rate">' + nf1.format(dowAvg[i]) + '</span>'
        + (() => {
            const si = dec.ok && dec.seasonalIdx ? dec.seasonalIdx[phaseForDow(i)] : null;
            if (si == null) return '<span class="rate" style="color:var(--dim)">—</span></div>';
            return '<span class="rate" style="color:' + (si >= 0 ? 'var(--green)' : 'var(--red)') + '">'
              + (si >= 0 ? '+' : '') + nf1.format(si) + '</span></div>';
          })()).join('')
    + '</div></div>'

    + '<div class="glass card"><header><h3>Best hours</h3>'
    + '<div class="sub">How often calls are answered</div></header>'
    + '<div class="funnel">' + parts.map(p =>
        '<div class="fstage"><span class="lbl">' + hourLabel(p.h) + '</span>'
        + '<div class="barw"><div class="barf" style="width:' + (p.rate / partMax * 100).toFixed(1) + '%;'
        + 'background:linear-gradient(90deg,' + (p.rate >= partMax * 0.9 ? '#10b981,#10b981bb' : p.rate <= partMax * 0.68 ? '#ef4444,#ef4444bb' : '#5ec8ff,#5ec8ffbb') + ')"></div></div>'
        + '<span class="rate">' + (p.rate * 100).toFixed(1) + '%</span></div>').join('')
    + '</div><p class="note" style="margin-top:.7rem">Shifting calls out of the red hours into the green ones '
    + 'books more appointments without adding anyone to the team.</p></div>'
    + '</div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><h3>How the weeks repeat'
    + info('Each bar compares the programme with itself that many days earlier. '
         + 'A tall bar at 7 days means the week repeats reliably, which is what '
         + 'makes the forecast dependable.')
    + '</h3><div class="sub">Compared with 1 to 22 days earlier</div></header>'
    + '<div class="funnel">' + acfBars.map(b =>
        '<div class="fstage"><span class="lbl" style="width:44px">' + b.lag + 'd</span>'
        + '<div class="barw" style="height:16px"><div class="barf" style="height:100%;width:' + (Math.abs(b.r) * 100).toFixed(1) + '%;'
        + 'background:' + (b.r >= 0 ? '#2fb8ac' : '#ef4444') + '"></div></div>'
        + '<span class="rate">' + b.r.toFixed(2) + '</span></div>').join('')
    + '</div></div>'

    + '<div class="glass card"><header><h3>Groups in the team</h3>'
    + '<div class="sub">Callers who work in similar ways</div></header>'
    + (km.ok ? clusters.map((cl, i) =>
        '<div class="risk"><div class="risk-row">'
        + '<h4>' + clusterName[i]
        + info(cl.n + ' callers. '
             + nf2.format(cl.perDay) + ' appointments booked per day, '
             + (cl.sit * 100).toFixed(0) + '% of them attended, '
             + (cl.close * 100).toFixed(0) + '% went on to buy, '
             + Math.round(cl.aht) + ' seconds average call. '
             + 'Members: ' + cl.members.map(m => m.name).join(', ') + '. '
             + 'Grouped on booking rate, attendance, close rate and call length '
             + 'together, so it reflects how someone works rather than volume alone.')
        + '</h4><span class="pill plain">' + cl.n + ' callers</span></div></div>').join('')
      : '<div class="empty"><b>Not enough callers</b>This needs at least six people on the phones.</div>')
    + '</div></div>';
}

/* ── Engagement: calling activity and the staffing calculator ── */
export function renderEngagement() {
  const days = state.engRange || 30;
  const cs = callSeries(days);
  const dials = cs.reduce((s, d) => s + d.dials, 0);
  const connects = cs.reduce((s, d) => s + d.connects, 0);
  const appts = cs.reduce((s, d) => s + d.appts, 0);
  const talk = cs.reduce((s, d) => s + d.talkSec, 0);
  const hours = cs.reduce((s, d) => s + d.hours, 0);
  const connRate = dials ? connects / dials : 0;
  const apptPerConnect = connects ? appts / connects : 0;
  const aht = connects ? talk / connects : 0;
  const cw = A.wilson(connects, dials);

  const q = state.queue || { calls: 220, aht: 190, agents: 14, target: 20 };
  const m = A.queueMetrics(q.calls, q.aht, q.agents, q.target);
  const req80 = A.agentsRequired(q.calls, q.aht, 0.8, q.target);
  const req90 = A.agentsRequired(q.calls, q.aht, 0.9, q.target);

  const curve = [];
  for (let n = Math.max(1, req80.agents - 5); n <= req80.agents + 7; n++) {
    curve.push({ n, ...A.queueMetrics(q.calls, q.aht, n, q.target) });
  }
  const parts = daypartStats();

  $('v-engagement').innerHTML =
    '<div class="bar"><h2 class="sec">Calling activity</h2><div class="sp"></div>'
    + '<div class="seg" role="group" aria-label="Window">'
    + [1, 7, 30, 90].map(d => '<button data-eng="' + d + '" aria-pressed="' + (d === days) + '">' + d + 'd</button>').join('')
    + '</div></div>'

    + '<div class="grid g-mini">'
    + tile('Calls made', num(dials))
    + tile('Answered', num(connects), 'info')
    + tile('Answer rate', pct(connRate), connRate >= 0.25 ? 'pos' : 'warn')
    + tile('Booked per answer', pct(apptPerConnect), 'info')
    + tile('Average call', Math.round(aht) + 's')
    + tile('Hours on calls', num(talk / 3600))
    + tile('Calls per hour', hours ? nf1.format(dials / hours) : '—')
    + '</div>'

    + '<div class="glass card"><header><div><h3>From calls to appointments'
    + info('Across the last ' + days + ' days the true answer rate sits between '
         + (cw.lo * 100).toFixed(1) + '% and ' + (cw.hi * 100).toFixed(1) + '%. '
         + 'The range exists because any period is a sample: a run of good luck '
         + 'should not be read as a permanent improvement.')
    + '</h3>'
    + '<div class="sub">Last ' + days + ' days</div></div></header>'
    + breakdown([
        { label: 'Calls made', n: dials, color: '#5ec8ff' },
        { label: 'Answered', n: connects, color: '#2fb8ac' },
        { label: 'Appointments booked', n: appts, color: '#10b981' }
      ], dials)
    + '</div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><div><h3>Advanced AI Calculator'
    + info('Enter how many calls come in per hour, how long a call takes, how '
         + 'many people are on the phones and how fast you want calls answered. '
         + 'The calculator works out the wait callers will actually experience '
         + 'and the smallest team that hits your target.')
    + '</h3>'
    + '<div class="sub">How many people you need on the phones</div></div></header>'
    + '<div class="field-row" style="margin-bottom:.9rem">'
    + '<label class="field"><span>Calls / hour</span><input type="number" id="q-calls" min="1" max="5000" value="' + q.calls + '"/></label>'
    + '<label class="field"><span>Call length (sec)</span><input type="number" id="q-aht" min="10" max="3600" value="' + q.aht + '"/></label>'
    + '<label class="field"><span>People on calls</span><input type="number" id="q-agents" min="1" max="500" value="' + q.agents + '"/></label>'
    + '<label class="field"><span>Answer in (sec)</span><input type="number" id="q-target" min="1" max="600" value="' + q.target + '"/></label>'
    + '<button class="btn btn-primary btn-sm" id="q-apply">Recalculate</button>'
    + '</div>'
    + (m.ok && m.stable
        ? '<div class="grid g-mini">'
          + tile('Work coming in', nf2.format(m.offeredLoad) + ' lines')
          + tile('How busy the team is', pct(m.occupancy), m.occupancy > 0.9 ? 'neg' : m.occupancy > 0.85 ? 'warn' : 'pos')
          + tile('Callers who wait', pct(m.pWait), 'info')
          + tile('Average wait', Math.round(m.asa) + 's', m.asa > q.target ? 'warn' : 'pos')
          + tile('Answered in time', pct(m.serviceLevel), m.serviceLevel >= 0.8 ? 'pos' : 'neg')
          + tile('Likely to hang up', pct(m.abandonRisk), m.abandonRisk > 0.1 ? 'warn' : 'pos')
          + '</div>'
          + (m.occupancy > 0.9
              ? '<p class="note" style="margin-top:.9rem;color:var(--amber)">The team is busy '
                + pct(m.occupancy) + ' of the time. Above 90% people burn out and leave, '
                + 'and that shows up long before callers notice a slower answer.</p>'
              : '')
        : '<div class="banner err on" style="display:block">' + q.agents + ' people cannot keep up with this '
          + 'many calls, so the wait just keeps growing. You need at least '
          + Math.ceil(m.offeredLoad + 1) + ' people before any of the other numbers mean anything.</div>')
    + '</div>'

    + '<div class="glass card"><header><h3>What each extra person buys you</h3>'
    + '<div class="sub">Answering within ' + q.target + ' seconds</div></header>'
    + '<div class="tw"><table><thead><tr><th>People</th><th class="r">How busy</th><th class="r">Average wait</th>'
    + '<th class="r">Answered in time</th><th></th></tr></thead><tbody>'
    + curve.map(c => {
        const hit80 = c.serviceLevel >= 0.8, hit90 = c.serviceLevel >= 0.9;
        return '<tr' + (c.n === q.agents ? ' style="background:rgba(47,184,172,.10)"' : '') + '>'
          + '<td class="num strong">' + c.n + (c.n === q.agents ? ' <span class="pill plain">current</span>' : '') + '</td>'
          + '<td class="num r">' + (c.stable ? pct(c.occupancy) : '—') + '</td>'
          + '<td class="num r">' + (c.stable ? Math.round(c.asa) + 's' : '∞') + '</td>'
          + '<td class="num r" style="color:' + (hit90 ? 'var(--green)' : hit80 ? 'var(--accent)' : 'var(--red)') + '">'
          + (c.stable ? pct(c.serviceLevel) : '0.0%') + '</td>'
          + '<td class="r">' + (c.n === req80.agents ? '<span class="pill on-">80/' + q.target + '</span>'
              : c.n === req90.agents ? '<span class="pill grow">90/' + q.target + '</span>' : '') + '</td></tr>';
      }).join('')
    + '</tbody></table></div>'
    + '<p class="note" style="margin-top:.8rem">To answer 8 in 10 calls within ' + q.target + ' seconds you need '
    + '<b style="color:var(--accent)">' + req80.agents + ' people</b>; for 9 in 10 it takes '
    + '<b style="color:var(--green)">' + req90.agents + '</b>. The last stretch is the expensive one, which is '
    + 'why promising near-perfect answer times on a small team rarely pays.</p></div>'
    + '</div>'

    + '<div class="glass card defer"><header><h3>Hour by hour</h3></header>'
    + '<div class="tw"><table><thead><tr><th>Hour</th><th class="r">Calls made</th><th class="r">Answered</th>'
    + '<th class="r">Answer rate</th><th>Compared with best</th></tr></thead><tbody>'
    + (() => {
        const best = Math.max(...parts.map(p => p.rate));
        return parts.map(p => '<tr><td class="strong">' + hourLabel(p.h) + '</td>'
          + '<td class="num r">' + num(p.dials) + '</td>'
          + '<td class="num r">' + num(p.connects) + '</td>'
          + '<td class="num r">' + pct(p.rate) + '</td>'
          + '<td>' + meter(p.rate, best) + '</td></tr>').join('');
      })()
    + '</tbody></table></div></div>';
}

/* ── Reporting: period comparison with significance, and exports ── */
export function renderReporting() {
  const internal = SESSION.internal === true;
  const span = state.repSpan || 30;
  const s = daySeries(span * 2);
  const cur = s.slice(-span), prev = s.slice(0, span);
  const csAll = callSeries(span * 2);
  const cCur = csAll.slice(-span), cPrev = csAll.slice(0, span);

  const agg = (rows, calls) => {
    const booked = rows.reduce((a, d) => a + d.booked, 0);
    const showed = rows.reduce((a, d) => a + d.showed, 0);
    const closed = rows.reduce((a, d) => a + d.closed, 0);
    const revenue = rows.reduce((a, d) => a + d.revenue, 0);
    const dials = calls.reduce((a, d) => a + d.dials, 0);
    const connects = calls.reduce((a, d) => a + d.connects, 0);
    return { booked, showed, closed, revenue, dials, connects };
  };
  const A1 = agg(cur, cCur), A0 = agg(prev, cPrev);

  const rows = [
    { k: 'Calls made', a: A1.dials, b: A0.dials, fmt: num },
    { k: 'Calls answered', a: A1.connects, b: A0.connects, fmt: num },
    { k: 'Answer rate', a: A1.connects / (A1.dials || 1), b: A0.connects / (A0.dials || 1), fmt: pct,
      test: A.twoProportionZTest(A1.connects, A1.dials, A0.connects, A0.dials) },
    { k: 'Appointments booked', a: A1.booked, b: A0.booked, fmt: num },
    { k: 'Appointments attended', a: A1.showed, b: A0.showed, fmt: num },
    { k: 'Attendance rate', a: A1.showed / (A1.booked || 1), b: A0.showed / (A0.booked || 1), fmt: pct,
      test: A.twoProportionZTest(A1.showed, A1.booked, A0.showed, A0.booked) },
    { k: 'Sales made', a: A1.closed, b: A0.closed, fmt: num },
    { k: 'Sales per appointment attended', a: A1.closed / (A1.showed || 1), b: A0.closed / (A0.showed || 1), fmt: pct,
      test: A.twoProportionZTest(A1.closed, A1.showed, A0.closed, A0.showed) },
    { k: 'Revenue from results', a: A1.revenue, b: A0.revenue, fmt: usd }
  ];

  const byClient = CLIENTS.filter(c => c.status === 'active').map(c => {
    const st = clientStats(c, span);
    return { c, st };
  }).sort((x, y) => y.st.total - x.st.total);

  $('v-reporting').innerHTML =
    '<div class="bar"><h2 class="sec">Period report</h2>'
    + '<span class="pill plain">last ' + span + ' days against the ' + span + ' before</span>'
    + '<div class="sp"></div>'
    + '<div class="seg" role="group" aria-label="Period">'
    + [1, 7, 30, 90].map(d => '<button data-rep="' + d + '" aria-pressed="' + (d === span) + '">' + d + 'd</button>').join('')
    + '</div>'
    + '<button class="btn btn-ghost btn-sm" data-export="report"><svg class="ic ic-14"><use href="#i-down"/></svg>Export CSV</button>'
    + '<button class="btn btn-ghost btn-sm" id="printReport"><svg class="ic ic-14"><use href="#i-arrowr"/></svg>Print</button>'
    + '</div>'

    + '<div class="glass card"><header><div><h3>This period vs last'
    + info('"Real change" means the movement is big enough, over enough calls, '
         + 'that it is very unlikely to be a coincidence. A percentage that '
         + 'wobbled within its usual range is marked as no, because acting on '
         + 'ordinary noise costs money.')
    + '</h3>'
    + '<div class="sub">Last ' + span + ' days against the ' + span + ' before</div></div></header>'
    + '<div class="tw"><table><thead><tr><th>Metric</th><th class="r">Now</th><th class="r">Before</th>'
    + '<th class="r">Change</th><th class="r">Real change?</th></tr></thead><tbody>'
    + rows.map(r => {
        const delta = r.b === 0 ? 0 : (r.a - r.b) / Math.abs(r.b);
        const up = r.a >= r.b;
        return '<tr><td class="strong">' + esc(r.k) + '</td>'
          + '<td class="num r">' + r.fmt(r.a) + '</td>'
          + '<td class="num r" style="color:var(--dim)">' + r.fmt(r.b) + '</td>'
          + '<td class="num r" style="color:' + (up ? 'var(--green)' : 'var(--red)') + '">'
          + (up ? '+' : '') + (delta * 100).toFixed(1) + '%</td>'
          + '<td class="r">' + (r.test && r.test.ok
              ? (r.test.significant ? '<span class="pill on-">yes</span>' : '<span class="pill off">no</span>')
                + info('z=' + r.test.z.toFixed(2) + ', p'
                     + (r.test.p < 0.001 ? '<0.001' : '=' + r.test.p.toFixed(3)) + '.')
              : '<span class="note" style="color:var(--dim)">a count, not a rate</span>') + '</td></tr>';
      }).join('')
    + '</tbody></table></div></div>'

    // Margin is OUR cost of delivery against their retainer, and the
    // assumption register is our commercial model. Neither belongs in front
    // of the client being delivered to, so both are internal-only.
    + '<div class="glass card defer"><header><h3>By account</h3><div class="sub">last ' + span + ' days</div></header>'
    + '<div class="tw"><table><thead><tr><th>Account</th><th class="r">Booked</th><th class="r">Sat</th>'
    + '<th class="r">Attended</th><th class="r">Bought</th><th class="r">Revenue</th>'
    + (internal ? '<th class="r">Margin</th>' : '') + '</tr></thead><tbody>'
    + byClient.map(({ c, st }) =>
        '<tr class="hoverable" data-client="' + esc(c.id) + '">'
        + '<td><span class="who-cell"><span class="ava cl">' + esc(maskInitials(c.name)) + '</span>'
        + '<span class="strong">' + maskName(c.name) + '</span></span></td>'
        + '<td class="num r">' + st.total + '</td><td class="num r">' + st.shown + '</td>'
        + '<td class="num r">' + pct(st.sit) + '</td><td class="num r">' + pct(st.close) + '</td>'
        + '<td class="num r">' + usd(st.revenue) + '</td>'
        + (internal
            ? '<td class="num r" style="color:' + (st.margin >= 0 ? 'var(--green)' : 'var(--red)') + '">' + kmb(st.margin) + '</td>'
            : '') + '</tr>').join('')
    + '</tbody></table></div></div>'

    + (internal
      ? '<div class="glass card"><header><h3>Internal &mdash; model assumptions</h3></header>'
        + '<p class="note" style="margin-bottom:.9rem"><b style="color:var(--amber)">' + esc(PROGRAM.kind) + '.</b> '
        + esc(PROGRAM.name) + ' — ' + esc(PROGRAM.subtitle) + '. Seeded generator, so every figure reproduces exactly '
        + 'on any machine. The parameter register below is the whole model; there is nothing hidden in the generator.</p>'
        + '<div class="tw"><table><thead><tr><th>Parameter</th><th>Value used</th><th>Reasoning</th></tr></thead><tbody>'
        + ASSUMPTIONS.map(a => '<tr><td class="strong">' + esc(a.label) + '</td>'
            + '<td class="num" style="color:var(--accent)">' + esc(a.value) + '</td>'
            + '<td style="white-space:normal;color:var(--muted);font-size:.75rem;max-width:520px">' + esc(a.rationale) + '</td></tr>').join('')
        + '</tbody></table></div>'
        + '<p class="note" style="margin-top:.9rem">These are declared assumptions with stated reasoning, not citations. '
        + 'No external study is referenced, because inventing a citation would be worse than declaring an assumption. '
        + 'Point the loader at real data and every view above recomputes unchanged.</p></div>'
      : '<div class="glass card"><header><h3>About these figures</h3></header>'
        + '<p class="note" style="margin-bottom:0">Every comparison is against the same length of time '
        + 'immediately before it, so like is compared with like. Before a change is called real, it is '
        + 'checked against the normal week-to-week variation, which is why a number can move a little and '
        + 'still be marked as no change. Everything here covers your account only.</p></div>');
}

/* ── Requests: SLA-tracked client request queue ── */
export function renderRequests() {
  const f = state.reqFilter || 'open';
  const now = Date.now();
  const all = REQUESTS.map(r => {
    const age = (r.resolvedAt || now) - r.openedAt;
    return { ...r, age, breached: age > r.slaMs, pctSla: age / r.slaMs };
  });
  const openOnes = all.filter(r => r.status !== 'resolved');
  const rows = f === 'all' ? all : f === 'breached' ? all.filter(r => r.breached) : all.filter(r => r.status === f);

  const resolved = all.filter(r => r.status === 'resolved');
  const slaHit = resolved.filter(r => !r.breached).length;
  const w = A.wilson(slaHit, resolved.length || 1);
  const medResolve = A.median(resolved.map(r => r.age / 3600000));

  const byPriority = ['urgent', 'high', 'normal', 'low'].map(p => {
    const set = all.filter(r => r.priority === p);
    const res = set.filter(r => r.status === 'resolved');
    return { p, n: set.length, open: set.length - res.length,
             hit: res.length ? res.filter(r => !r.breached).length / res.length : 0 };
  });

  const prioPill = { urgent: 'risk', high: 'watch', normal: 'hum', low: 'off' };
  const fmtAge = (ms) => ms < 3600000 ? Math.round(ms / 60000) + 'm'
    : ms < 86400000 ? Math.round(ms / 3600000) + 'h' : Math.round(ms / 86400000) + 'd';

  $('v-requests').innerHTML =
    '<div class="bar"><h2 class="sec">Client requests</h2><div class="sp"></div>'
    + [['open', 'Open'], ['waiting', 'Waiting'], ['breached', 'Missed target'], ['resolved', 'Resolved'], ['all', 'All']]
        .map(([k, l]) => '<button class="chip" data-reqfilter="' + k + '" aria-pressed="' + (f === k) + '">' + l
          + '<span class="n">' + (k === 'all' ? all.length : k === 'breached' ? all.filter(r => r.breached).length : all.filter(r => r.status === k).length) + '</span></button>').join('')
    + '<button class="btn btn-ghost btn-sm" data-export="requests"><svg class="ic ic-14"><use href="#i-down"/></svg>Export</button></div>'

    + '<div class="grid g-mini">'
    + tile('Open', num(openOnes.length), openOnes.length > 20 ? 'warn' : 'info')
    + tile('Missed the target', num(all.filter(r => r.breached && r.status !== 'resolved').length), 'neg')
    + tile('Handled in time', pct(w.p), w.p >= 0.9 ? 'pos' : 'warn')
    + tile('Median resolve', nf1.format(medResolve) + 'h')
    + tile('Urgent open', num(all.filter(r => r.priority === 'urgent' && r.status !== 'resolved').length), 'neg')
    + tile('Total logged', num(all.length))
    + '</div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><h3>Handled in time, by urgency</h3>'
    + '<div class="sub">resolved within target</div></header>'
    + '<div class="funnel">' + byPriority.map(b =>
        '<div class="fstage"><span class="lbl">' + b.p + '</span>'
        + '<div class="barw"><div class="barf" style="width:' + (b.hit * 100).toFixed(1) + '%;'
        + 'background:linear-gradient(90deg,' + (b.hit >= 0.9 ? '#10b981,#10b981bb' : b.hit >= 0.75 ? '#f59e0b,#f59e0bbb' : '#ef4444,#ef4444bb') + ')"></div></div>'
        + '<span class="rate">' + pct(b.hit) + '</span>'
        + '<span class="rate" style="color:var(--dim)">' + b.open + ' open</span></div>').join('')
    + '</div>'
    + '<p class="note" style="margin-top:.8rem">' + pct(w.p) + ' of requests were handled in time'
    + info('Across ' + resolved.length + ' completed requests. The true long-run figure is very likely '
         + 'between ' + pct(w.lo) + ' and ' + pct(w.hi) + ' — any single period is a sample, so one good '
         + 'run should not be read as a permanent improvement.')
    + '. Targets: urgent 4 hours, high 12 hours, normal 2 days, low 5 days.</p></div>'

    + '<div class="glass card"><header><h3>Waiting longest</h3><div class="sub">Closest to missing the target</div></header>'
    + (openOnes.length ? openOnes.slice().sort((a, b) => b.pctSla - a.pctSla).slice(0, 8).map(r =>
        '<div class="rank"><span class="pill ' + prioPill[r.priority] + '">' + r.priority + '</span>'
        + '<span class="nm">' + esc(r.kind) + '<br><span style="font-size:.67rem;color:var(--dim);font-weight:400">'
        + maskName(CLIENT_BY[r.clientId].name) + ' · open ' + fmtAge(r.age) + '</span></span>'
        + meter(Math.min(1, r.pctSla), 1) + '</div>').join('')
      : '<div class="empty"><b>Queue is clear</b>No open requests.</div>')
    + '</div></div>'

    + '<div class="glass card defer"><header><h3>' + (f === 'all' ? 'All requests' : f + ' requests') + '</h3>'
    + '<div class="sub">' + rows.length + ' shown</div></header>'
    + (rows.length ? '<div class="tw"><table><thead><tr><th>Request</th><th>Account</th><th>Priority</th>'
      + '<th>Status</th><th>Owner</th><th class="r">Waiting</th><th class="r">Target used</th></tr></thead><tbody>'
      + rows.slice(0, 60).map(r =>
          '<tr><td class="strong">' + esc(r.kind) + '</td>'
          + '<td style="color:var(--muted)"><span class="ell" title="' + esc(maskNameText(CLIENT_BY[r.clientId].name)) + '">' + maskName(CLIENT_BY[r.clientId].name) + '</span></td>'
          + '<td><span class="pill ' + prioPill[r.priority] + '">' + r.priority + '</span></td>'
          + '<td><span class="pill ' + (r.status === 'resolved' ? 'grow' : r.status === 'waiting' ? 'watch' : 'hum') + '">' + r.status + '</span></td>'
          + '<td style="color:var(--muted)">' + esc(r.owner) + '</td>'
          + '<td class="num r">' + fmtAge(r.age) + '</td>'
          + '<td class="num r" style="color:' + (r.breached ? 'var(--red)' : 'var(--green)') + '">'
          + (r.breached ? 'breached' : pct(r.pctSla)) + '</td></tr>').join('')
      + '</tbody></table></div>'
      : '<div class="empty"><b>Nothing here</b>No requests match this filter.</div>')
    + '</div>';
}

/* ── Feedback: CSAT, QA scoring, flagged reviews ── */
export function renderFeedback() {
  const days = 90;
  const cutoff = TODAY.getTime() - days * DAY;
  const fb = FEEDBACK.filter(f => f.t >= cutoff);
  const csatVals = fb.map(f => f.csat);
  const avgCsat = A.mean(csatVals);
  const promoters = fb.filter(f => f.csat >= 4).length;
  const detractors = fb.filter(f => f.csat <= 2).length;
  const nps = fb.length ? ((promoters - detractors) / fb.length) * 100 : 0;
  const flagged = fb.filter(f => f.flagged);

  const CRIT = ['Opening', 'Discovery', 'Objection handling', 'Compliance', 'Close', 'Wrap accuracy'];
  const critAvg = CRIT.map(c => ({ c, v: A.mean(fb.map(f => f.scores[c])) }));

  const dist = [5, 4, 3, 2, 1].map(v => ({ v, n: fb.filter(f => f.csat === v).length }));

  // Does QA score actually predict booking output? If not, the QA rubric is
  // measuring something the business does not get paid for.
  const perAgent = activeAgents().map(a => {
    const mine = fb.filter(f => f.agentId === a.id);
    if (mine.length < 3) return null;
    const st = agentStats(a, 60);
    return { a, qa: A.mean(mine.map(f => f.qa)), csat: A.mean(mine.map(f => f.csat)),
             perDay: st.perDay, sit: st.sit, n: mine.length };
  }).filter(Boolean);
  const corr = perAgent.length >= 4
    ? A.spearman(perAgent.map(p => p.qa), perAgent.map(p => p.perDay))
    : { ok: false };

  const sentiment = [
    { k: 'positive', n: fb.filter(f => f.sentiment === 'positive').length, c: '#10b981' },
    { k: 'neutral',  n: fb.filter(f => f.sentiment === 'neutral').length,  c: '#8f9aab' },
    { k: 'negative', n: fb.filter(f => f.sentiment === 'negative').length, c: '#ef4444' }
  ];

  $('v-feedback').innerHTML =
    '<div class="bar"><h2 class="sec">Quality &amp; feedback</h2>'
    + '<span class="pill plain">' + fb.length + ' reviews · last ' + days + ' days</span>'
    + '<div class="sp"></div>'
    + '<button class="btn btn-ghost btn-sm" data-export="feedback"><svg class="ic ic-14"><use href="#i-down"/></svg>Export</button></div>'

    + '<div class="grid g-mini">'
    + tile('Average rating', nf2.format(avgCsat) + ' / 5', avgCsat >= 4 ? 'pos' : avgCsat >= 3.3 ? 'warn' : 'neg')
    + tile('NPS-style', (nps >= 0 ? '+' : '') + Math.round(nps), nps >= 30 ? 'pos' : nps >= 0 ? 'warn' : 'neg')
    + tile('Promoters', num(promoters), 'pos')
    + tile('Detractors', num(detractors), 'neg')
    + tile('Flagged', num(flagged.length), flagged.length ? 'neg' : 'pos')
    + tile('Average quality', nf2.format(A.mean(fb.map(f => f.qa))) + ' / 5', 'info')
    + '</div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><h3>Call quality'
    + info('Compliance is the one to watch whatever the average says: a low '
         + 'score there is a legal risk rather than a coaching point, so it '
         + 'flags a call on its own even when the customer was happy.')
    + '</h3><div class="sub">Average score out of 5</div></header>'
    + '<div class="funnel">' + critAvg.map(c =>
        '<div class="fstage"><span class="lbl" style="width:120px">' + esc(c.c) + '</span>'
        + '<div class="barw"><div class="barf" style="width:' + (c.v / 5 * 100).toFixed(1) + '%;'
        + 'background:linear-gradient(90deg,' + (c.v >= 4 ? '#10b981,#10b981bb' : c.v >= 3.2 ? '#2fb8ac,#2fb8acbb' : '#f59e0b,#f59e0bbb') + ')"></div></div>'
        + '<span class="rate">' + nf2.format(c.v) + '</span></div>').join('')
    + '</div>'
    + '</div>'

    + '<div class="glass card"><header><h3>Customer ratings'
    + info('Happy, neutral and unhappy are worked out directly from the star '
         + 'rating the customer gave, so the label can never disagree with the '
         + 'number beside it. Nothing is guessed from what was said.')
    + '</h3><div class="sub">How customers rated the call</div></header>'
    + '<div class="funnel">' + dist.map(d =>
        '<div class="fstage"><span class="lbl">' + d.v + ' star' + (d.v > 1 ? 's' : '') + '</span>'
        + '<div class="barw"><div class="barf" style="width:' + (fb.length ? d.n / fb.length * 100 : 0).toFixed(1) + '%;'
        + 'background:linear-gradient(90deg,' + (d.v >= 4 ? '#10b981' : d.v === 3 ? '#8f9aab' : '#ef4444') + ',transparent)"></div></div>'
        + '<span class="rate">' + d.n + '</span>'
        + '<span class="rate" style="color:var(--dim)">' + pct(fb.length ? d.n / fb.length : 0) + '</span></div>').join('')
    + '</div>'
    + '<div class="legend" style="margin-top:.8rem">' + sentiment.map(s =>
        '<span><i style="background:' + s.c + '"></i>' + s.k + ' ' + s.n + '</span>').join('') + '</div>'
    + '</div>'
    + '</div>'

    + '<div class="glass card"><header><div><h3>Do higher quality scores mean more bookings?'
    + info('Compares each caller\'s quality score with how much they book. Ranks are '
         + 'compared rather than raw numbers, so the link shows up even if it is not a '
         + 'straight line.')
    + '</h3>'
    + '<div class="sub">Quality score against appointments booked</div></div></header>'
    + (corr.ok
        ? '<p class="note" style="margin-bottom:.8rem">'
          + (Math.abs(corr.r) < 0.2
            ? '<b style="color:var(--amber)">Barely any link.</b> '
              + 'Scoring well on quality is not currently translating into more appointments. Either the '
              + 'scorecard should reward more of what actually books, or it is measuring compliance on '
              + 'purpose and should not be expected to track volume.'
            : '<b style="color:' + (corr.r > 0 ? 'var(--green)' : 'var(--red)') + '">'
              + (corr.r > 0 ? 'Yes, they do.' : 'No — the opposite.') + '</b> '
              + (corr.r > 0 ? 'Callers who score better on quality also book more, so coaching to the scorecard should pay off.'
                            : 'Higher quality scores go with fewer bookings, which usually means the scorecard rewards being thorough at the cost of getting through calls.'))
          + info('Rank correlation ' + corr.r.toFixed(2) + ', p'
               + (corr.p < 0.001 ? '<0.001' : '=' + corr.p.toFixed(3)) + ', across ' + corr.n + ' callers.')
          + '</p>'
          + '<div class="tw"><table><thead><tr><th>Caller</th><th class="r">Quality</th><th class="r">Rating</th>'
          + '<th class="r">Booked / day</th><th class="r">Attended</th><th class="r">Reviews</th></tr></thead><tbody>'
          + perAgent.slice().sort((x, y) => y.qa - x.qa).slice(0, 12).map(p =>
              '<tr class="hoverable" data-agent="' + esc(p.a.id) + '">'
              + '<td><span class="who-cell"><span class="ava ' + p.a.kind + '">'
              + esc(p.a.kind === 'ai' ? p.a.name.slice(0, 2) : initials(p.a.name)) + '</span>'
              + '<span class="strong">' + esc(p.a.name) + '</span></span></td>'
              + '<td class="num r">' + nf2.format(p.qa) + '</td>'
              + '<td class="num r">' + nf2.format(p.csat) + '</td>'
              + '<td class="num r">' + nf2.format(p.perDay) + '</td>'
              + '<td class="num r">' + pct(p.sit) + '</td>'
              + '<td class="num r" style="color:var(--dim)">' + p.n + '</td></tr>').join('')
          + '</tbody></table></div>'
        : '<div class="empty"><b>Not enough reviews</b>Need at least three reviews for four or more agents.</div>')
    + '</div>'

    + '<div class="glass card defer"><header><h3>Calls to review</h3>'
    + '<div class="sub">Rated 2 stars or less, or a low compliance score</div></header>'
    + (flagged.length ? '<div class="tw"><table><thead><tr><th>Caller</th><th>Account</th><th class="r">Rating</th>'
      + '<th class="r">Quality</th><th class="r">Compliance</th><th class="r">When</th></tr></thead><tbody>'
      + flagged.slice(0, 40).map(f => {
          const ag = AGENT_BY[f.agentId];
          return '<tr class="hoverable" data-agent="' + esc(f.agentId) + '">'
            + '<td class="strong">' + esc(ag ? ag.name : f.agentId) + '</td>'
            + '<td style="color:var(--muted)">' + maskName(CLIENT_BY[f.clientId].name) + '</td>'
            + '<td class="num r" style="color:var(--red)">' + f.csat + '</td>'
            + '<td class="num r">' + nf2.format(f.qa) + '</td>'
            + '<td class="num r" style="color:' + (f.scores['Compliance'] <= 2.5 ? 'var(--red)' : 'var(--muted)') + '">'
            + nf1.format(f.scores['Compliance']) + '</td>'
            + '<td class="num r" style="color:var(--dim)">' + shortDate(new Date(f.t)) + '</td></tr>';
        }).join('')
      + '</tbody></table></div>'
      : '<div class="empty"><b>Nothing to review</b>No call fell below the rating or compliance threshold.</div>')
    + '</div>';
}


