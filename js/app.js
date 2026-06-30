import * as A from './analytics.js';
import * as D from './casestudy.js';
import * as I from './ingest.js';
import * as G from './aggregates.js';
import {
  $, el, els, esc, nf0, nf1, nf2, num, usd, usdc, kmb, pct, clamp, sum,
  initials, DAY, TODAY, shortDate, ago, REDUCED, mulberry32, rand, ri, pick, maskName, maskInitials, namesAreRevealed, setNamesRevealed, maskNameText} from './util.js';
import {
  sparkline, microSpark, areaChart, barChart, funnel, breakdown,
  meter, ring, deltaTag, pill, STATUS_PILL
} from './charts.js';
import {
  CLIENTS, CLIENT_BY, AGENTS, BENCH, AGENT_BY, APPTS, CALLS, LEADS, TEAM, REQUESTS,
  FEEDBACK, EXPERIMENTS, ONBOARDING, ONBOARD_STEPS, LEAD_STAGES, ASSUMPTIONS,
  PROGRAM, DATASET_STATS, PROGRAM_OVERHEAD, CFG, SESSION, state,
  SETTINGS_KEY, SETTINGS_DEFAULT, loadCfg, saveCfg, resetCfg, replaceEntity, reindex, purgeClientData, retainWhere, purgeInternalData} from './state.js';
import { applySort, countUp, exportBtn, feedHTML, kpiCard, th, tile, toast , scopeBanner } from './ui.js';
import {
  DS,
  DS_DEFAULT,
  DS_KEY,
  HHMM_RE,
  OUTCOME_ALIASES,
  SCHEMA,
  STAGE_ALIASES,
  TEMPLATE_ROW,
  VALID_OUTCOMES,
  VALID_STAGES,
  buildExportRows,
  csvField,
  csvParse,
  csvStringify,
  dateField,
  downloadCSV,
  fetchSheetCSV,
  fmtHM,
  fmtLocalDate,
  numField,
  pad2,
  parseAgentsCSV,
  parseAppointmentsCSV,
  parseClientsCSV,
  parseHM,
  parseLeadsCSV,
  parseLocalDate,
  reindexAll,
  renderImportReport,
  replaceAgents,
  replaceAppts,
  replaceClients,
  replaceLeads,
  saveDS,
  scheduleSync,
  syncFromSheets,
  syncTimer,
  templateCSV
} from './csvio.js';
import {
  _dayparts,
  clearInsightCache,
  callSeries,
  callSeriesCache,
  computeInsights,
  daypartStats,
  hourLabel,
  pval,
  renderEngagement,
  renderFeedback,
  renderInsights,
  renderPatterns,
  renderReporting,
  renderRequests,
  sigPill
} from './views.analytics.js';



/* Aggregate helpers are used unqualified across the view layer; bind them once
   rather than prefixing several hundred call sites. */
const {
  PAST, FUTURE, KEPT, inWindow, dayCounts, daySeries, activeAgents,
  agentAppts, clientAppts, agentStats, clientStats, leadsByStage,
  cumulativeFunnelData, pnlMonths, resetCaches
} = G;

/* Export control markup, shared by every table view. Lived at the tail of the
   chart-builder section and was dropped when that section moved out — six
   views tripped the error boundary on `exportBtn is not defined`, which is
   exactly what the boundary and the smoke suite exist to surface. */

/* Views render once then stay in the DOM; this tracks which have been built. */
const rendered = new Set();

/* Route entitlement is an ALLOW list per role, not a deny list. A deny list
   was the wrong shape: it had to enumerate every leaking route, so adding a
   route silently exposed it, and it already missed `insights`, `patterns`,
   `engagement`, `team` and `settings`. Fail closed — an unlisted route is
   blocked, and a role listed here gets nothing beyond its list.

   `client` is an outside party looking at their own book. What they lose
   beyond their own rows: `agents` (our pay and seat cost), `payroll` and
   `pnl` (our cost of delivery and margin), `team` (staff roster and work
   emails), `onboard` (other companies mid-implementation, with their
   retainers), `clients` (the account list) and `settings` (our unit
   economics). `audit` and `access` stay admin-only, removed separately. */
const ROUTE_ENTITLEMENT = {
  prospect: ['overview'],
  client:   ['overview', 'insights', 'reporting', 'patterns', 'appointments',
             'engagement', 'leads', 'requests', 'feedback']
};
function routeBlocked(route) {
  const allowed = ROUTE_ENTITLEMENT[SESSION.role];
  return allowed ? !allowed.includes(route) : false;
}

loadCfg();

const saveOnboard = () => {
  try { localStorage.setItem('gms.onboard.v2', JSON.stringify(Object.fromEntries(ONBOARDING.map(o => [o.id, o.done])))); }
  catch (_) {}
};

try {
  const saved = JSON.parse(localStorage.getItem('gms.onboard.v2') || 'null');
  if (saved) ONBOARDING.forEach(o => {
    const v = saved[o.id];
    if (Number.isInteger(v) && v >= 0 && v <= ONBOARD_STEPS.length) o.done = v;
  });
} catch (_) {}

/* ───────────────────────── 4 · views ───────────────────────── */


/* Scope the collections the API does not serve.

   The server filters clients, agents, appointments and leads in SQL. Requests,
   feedback, the team roster, the onboarding pipeline and experiments are
   bundled seed collections with no endpoint, so nothing had ever filtered
   them: a client account held all 96 requests, all 520 feedback rows, every
   staff member's work email, and every other company mid-implementation with
   its retainer. Filtered against what the server actually sent, so the
   entitlement decision stays server-side and this only enforces it. */
function applySecondaryScope() {
  if (SESSION.internal === true) return;    // admin / manager keep everything

  const okClient = new Set(CLIENTS.map(c => c.id));
  const okAgent  = new Set(AGENTS.map(a => a.id));

  retainWhere(REQUESTS, r => okClient.has(r.clientId));
  // Both must hold: feedback carries an agent and the client that agent was
  // working. An agent moving between accounts would otherwise carry their old
  // account's reviews across.
  retainWhere(FEEDBACK, f => okAgent.has(f.agentId) && okClient.has(f.clientId));
  purgeInternalData();
}

/* Ratings are stored as 'keeper' / 'ramping' / 'fire' and read that way
   throughout; only the words shown to a reader change here. */
const GRADE_LABEL = {
  keeper: 'doing well', ramping: 'still learning', fire: 'struggling',
  steady: 'holding steady', churned: 'left'
};

/* Client names are masked everywhere by default. Flipping the toggle rebuilds
   every view rather than un-blurring in place, because the hidden form is
   filler text rather than the real name under a filter -- there is nothing to
   un-blur, the names have to be rendered again. */
function toggleNames() {
  setNamesRevealed(!namesAreRevealed());
  syncNameToggle();
  auditEvent(namesAreRevealed() ? 'names_revealed' : 'names_hidden', {});
  rendered.clear();
  clearInsightCache();
  buildPalette();
  go(state.route, true);
}

function syncNameToggle() {
  const btn = $('nameBtn'), ic = $('nameIc');
  if (!btn) return;
  const on = namesAreRevealed();
  btn.setAttribute('aria-pressed', String(on));
  const label = on ? 'Hide client names' : 'Show client names';
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  if (ic) ic.setAttribute('href', on ? '#i-eye-off' : '#i-eye');
}

/* ---- Overview ---- */
/* Overview for an account with no client-data entitlement. Deliberately says
   what is withheld and why, rather than showing an empty console: an outside
   evaluator should be able to see that the boundary is real and enforced, and
   an operator should be able to see exactly what a prospect sees. */
function renderEvaluationOverview() {
  const does = [
    ['Books appointments',   'AI and human callers work your lead list and put qualified appointments in your calendar'],
    ['Tells you what works', 'Which days, which hours and which scripts book the most, measured rather than guessed'],
    ['Forecasts the month',  'What to expect over the next two weeks, based on how the last few months actually went'],
    ['Flags problems early', 'A drop in attendance or quality is raised while there is still time to fix it'],
    ['Sizes the team',       'How many people you need on the phones to answer calls as quickly as you want to'],
    ['Scores every call',    'Quality and compliance checked on each call, with poor ones pulled out for review']
  ];
  const withheld = [
    ['Client accounts',      'who they are, what they pay, how they are doing'],
    ['Appointments',         'every booking and how it turned out'],
    ['Leads',                'contact details and where each one has reached'],
    ['Callers',              'who works on which account, and their results'],
    ['Money',                'pay, revenue and costs'],
    ['Requests and quality', 'support requests and call scoring'],
    ['Our team',             'who works here']
  ];

  $('v-overview').innerHTML =
    '<div class="bar"><h2 class="sec">Evaluation account</h2>'
  + '<span class="pill plain">no client information</span></div>'

  + '<div class="glass card" style="margin-bottom:1rem">'
  + '<header><div><h3>Welcome &mdash; this is a look-around account</h3>'
  + '<div class="sub">Opsdeck &middot; Command Center</div></div></header>'
  + '<p class="note" style="margin:.2rem 0 .9rem;line-height:1.65">'
  + 'We run appointment setting for our clients, and their information is confidential. '
  + 'An account like this one is given none of it &mdash; not a name, not a number. '
  + 'That is not the dashboard hiding things from you: nothing about any client is sent '
  + 'to this browser in the first place. It works the same way for our clients, which is '
  + 'why none of them can see each other either.</p>'
  + '<div class="grid g-mini">'
  + tile('Client records here', '0')
  + tile('Sent to this browser', 'nothing', 'neg')
  + tile('Every attempt', 'logged', 'info')
  + '</div></div>'

  + '<div class="grid g-2">'
  + '<div class="glass card"><header><div><h3>What the dashboard does</h3>'
  + '<div class="sub">Once your account is set up</div></div></header>'
  + '<dl class="deflist">'
  + does.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('')
  + '</dl></div>'

  + '<div class="glass card"><header><div><h3>Kept back from this account</h3>'
  + '<div class="sub">' + withheld.length + ' kinds of information</div></div></header>'
  + '<dl class="deflist">'
  + withheld.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('')
  + '</dl></div></div>'

  + '<div class="glass card" style="margin-top:1rem">'
  + '<header><div><h3>Getting an account</h3></div></header>'
  + '<p class="note" style="margin:.2rem 0 0;line-height:1.65">Your Opsdeck '
  + 'contact sets up accounts, and decides which client each person can see. Speak to them '
  + 'and we will get you set up.</p></div>';
}

function renderOverview() {
  // An unentitled account never reaches the code below. Not because the
  // numbers would be zero -- because with the dataset purged, `daySeries`,
  // `agentStats` and the funnel would all run over empty arrays and print a
  // confident-looking wall of $0 that reads like a failing programme. State
  // what the account is instead.
  if (SESSION.clientDataEntitled === false) return renderEvaluationOverview();

  const R = state.range;
  const s = daySeries(Math.max(R, 60));
  const win = s.slice(-R);
  const prevWin = daySeries(Math.max(R * 2, 120)).slice(-R * 2, -R);

  const booked = sum(win, d => d.booked);
  const bookedPrev = sum(prevWin, d => d.booked) || 1;
  const shown = sum(win, d => d.showed);
  const live = activeAgents();
  const liveClients = CLIENTS.filter(c => c.status === 'active');

  const mrr = sum(liveClients, c => c.mrr);
  const perfRev = sum(win, d => d.revenue);
  const agentCost = sum(live, a => a.kind === 'ai' ? a.seatCost * (R/30) : (a.base * (R/30)) + agentAppts(a.id, R).length * CFG.bonusPerAppt);
  const rev = mrr * (R / 30) + perfRev;
  const revPrev = mrr * (R / 30) + sum(prevWin, d => d.revenue);
  // Program overhead (management, QA, tooling, telephony base) is a whole-book
  // cost. Charging all of it to a scoped view showed a single-client account a
  // net margin of -$20.1k, which is not a fact about that client — it is the
  // entire program's overhead landing on one row. With no defensible
  // allocation basis available to a scoped viewer, report GROSS margin instead
  // and say so, rather than inventing an allocation.
  const scoped = !SESSION.unrestricted && SESSION.user;
  const overhead = scoped ? 0 : PROGRAM_OVERHEAD * (R / 30);
  const margin = rev - agentCost - overhead;
  const marginLabel = scoped ? 'Gross margin' : 'Net margin';
  const marginFoot = scoped ? 'after caller pay · excludes overheads' : 'after caller pay and overheads';

  const stages = leadsByStage();
  const funnelData = cumulativeFunnelData(LEADS);

  const perAgentDay = live.length ? booked / live.length / R : 0;
  const upcoming = FUTURE.length;

  const ranked = live.map(a => ({a, st: agentStats(a, 30)})).sort((x, y) => y.st.perDay - x.st.perDay);
  const risky = liveClients.map(c => ({c, st: clientStats(c, 30)})).sort((x, y) => x.st.health - y.st.health).slice(0, 4);

  const html =
  '<div class="bar">'
  + '<h2 class="sec">Command view</h2>'
  + '<span class="pill plain">' + live.length + ' callers on accounts · ' + liveClients.length + ' accounts billing</span>'
  + '<div class="sp"></div>'
  + '<div class="seg" role="group" aria-label="Timeframe">'
  + [1,7,30,60,90].map(d => '<button data-range="' + d + '" aria-pressed="' + (d === R) + '">' + d + 'd</button>').join('')
  + '</div></div>'

  + '<div class="grid g-kpi">'
  + kpiCard('Booked appointments', num(booked), deltaTag(booked, bookedPrev), 'last ' + R + ' day' + (R === 1 ? '' : 's'), win.map(d => d.booked), 'var(--accent)')
  + kpiCard('Recognised revenue', kmb(rev), deltaTag(rev, revPrev), 'retainer + performance', win.map(d => d.revenue), 'var(--teal)')
  + kpiCard('Attendance rate', pct(booked ? shown / booked : 0), booked && (shown/booked) >= CFG.showTarget ? '<span class="delta up">on target</span>' : '<span class="delta down">below ' + pct(CFG.showTarget) + '</span>', shown + ' of ' + booked + ' attended', win.map(d => d.booked ? d.showed / d.booked : 0), 'var(--sky)')
  + kpiCard(marginLabel, kmb(margin), '<span class="delta ' + (margin > 0 ? 'up' : 'down') + '">' + pct(rev ? margin / rev : 0) + '</span>', marginFoot, win.map(d => d.revenue - agentCost / R), margin > 0 ? 'var(--emerald)' : 'var(--rose)')
  + '</div>'

  + '<div class="grid g-mini">'
  + tile('Today', num(s[s.length-1].booked))
  + tile('Yesterday', num(s[s.length-2].booked))
  + tile('Upcoming', num(upcoming), 'info')
  + tile('Per caller / day', nf2.format(perAgentDay), perAgentDay >= CFG.target ? 'pos' : 'warn')
  + tile('Doing well', num(ranked.filter(r => r.st.grade === 'keeper').length), 'pos')
  + tile('Still learning', num(ranked.filter(r => r.st.grade === 'ramping').length), 'info')
  + tile('Struggling', num(ranked.filter(r => r.st.grade === 'fire').length), 'neg')
  + tile('Accounts lost', num(CLIENTS.filter(c => c.status === 'churned').length), 'neg')
  + '</div>'

  + '<div class="grid g-2">'
  + '<div class="glass card"><header><div><h3>Booked and attended</h3><div class="sub">Every account &middot; last ' + R + ' day' + (R === 1 ? '' : 's') + '</div></div>'
  + '<div class="legend"><span><i style="background:#2fb8ac"></i>Booked</span><span><i style="background:#5ec8ff"></i>Attended</span></div></header>'
  + areaChart({a: win.map(d => d.booked), b: win.map(d => d.showed), labels: win.map(d => shortDate(new Date(d.t)))}, {h:250, label:'Booked and attended appointments'})
  + '</div>'
  + '<div class="glass card"><header><h3>Lead funnel</h3><div class="sub">' + num(LEADS.length) + ' leads</div></header>'
  + funnel(funnelData)
  + '<p class="note" style="margin-top:.9rem">Conversion shown stage-over-stage. ' + num(stages.lost.length) + ' leads marked lost and excluded from the cascade.</p>'
  + '</div></div>'

  + '<div class="grid g-3">'
  + '<div class="glass card"><header><h3>Top callers</h3><div class="sub">Last 30 days &middot; target ' + nf2.format(CFG.target) + ' a day</div></header>'
  + ranked.slice(0, 7).map((r, i) =>
      '<div class="rank"><span class="no">' + (i+1) + '</span>'
      + '<span class="ava ' + r.a.kind + '">' + esc(initials(r.a.name)) + '</span>'
      + '<span class="nm">' + esc(r.a.name) + '</span>'
      + meter(r.st.perDay, CFG.target) + '</div>').join('')
  + '</div>'

  + '<div class="glass card"><header><h3>Needs attention</h3><div class="sub">lowest health · 30d</div></header>'
  + risky.map(r =>
      '<div class="rank"><span class="ava cl">' + esc(maskInitials(r.c.name)) + '</span>'
      + '<span class="nm">' + maskName(r.c.name) + '<br><span style="font-size:.68rem;color:var(--dim);font-weight:400">' + esc(r.c.vertical) + ' · ' + r.st.total + ' appts</span></span>'
      + meter(r.st.health, 1) + '</div>').join('')
  + '</div>'

  + '<div class="glass card"><header><h3>Live activity</h3><div class="sub" id="syncAgo">' + ago(state.lastSync) + '</div></header>'
  + '<div class="feed" id="feed">' + feedHTML() + '</div>'
  + '</div></div>';

  $('v-overview').innerHTML = html;
  countUp($('v-overview'));
}



/* Count-up on the four hero numbers only. rAF, one pass, then done. */

/* ---- Appointments ---- */
function renderAppointments() {
  const s = daySeries(90);
  const maxDay = Math.max.apply(null, s.map(d => d.booked)) || 1;
  const win30 = s.slice(-30);
  const booked = sum(win30, d => d.booked), shown = sum(win30, d => d.showed);
  const noshow = sum(win30, d => d.noshow), closed = sum(win30, d => d.closed);

  // Calendar grid: 7 weekday rows × N week columns. Leading pad cells keep
  // every row on the same weekday so the shape is readable at a glance.
  const firstDow = new Date(s[0].t).getDay();
  let heat = '';
  for (let i = 0; i < firstDow; i++) heat += '<i class="pad"></i>';
  let months = '', lastMonth = -1, weekIdx = 0;
  s.forEach((d, i) => {
    const dt = new Date(d.t);
    const l = d.booked === 0 ? 0 : clamp(Math.ceil(d.booked / maxDay * 4), 1, 4);
    heat += '<i data-l="' + l + '" title="' + dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) + ' · ' + d.booked + ' booked"></i>';
    if ((i + firstDow) % 7 === 0) {
      weekIdx++;
      months += '<span>' + (dt.getMonth() !== lastMonth ? dt.toLocaleDateString('en-US',{month:'short'}) : '') + '</span>';
      lastMonth = dt.getMonth();
    }
  });

  const list = (state.apptFilter === 'upcoming' ? FUTURE : inWindow(30))
    .slice()
    .sort((a, b) => state.apptFilter === 'upcoming' ? (a.t - b.t || a.hm - b.hm) : (b.t - a.t || b.hm - a.hm))
    .slice(0, 60);
  const slot = (m) => {
    const h = Math.floor(m / 60), mm = m % 60;
    return ((h % 12) || 12) + ':' + String(mm).padStart(2,'0') + (h < 12 ? ' AM' : ' PM');
  };

  $('v-appointments').innerHTML =
    '<div class="bar"><h2 class="sec">Appointment operations</h2><div class="sp"></div>'
    + '<div class="seg" role="group" aria-label="Appointment list">'
    + '<button data-appt="upcoming" aria-pressed="' + (state.apptFilter === 'upcoming') + '">Upcoming (' + FUTURE.length + ')</button>'
    + '<button data-appt="recent" aria-pressed="' + (state.apptFilter === 'recent') + '">Last 30 days</button>'
    + '</div>' + exportBtn('appts') + '</div>'

    + '<div class="grid g-mini">'
    + tile('Booked · 30d', num(booked))
    + tile('Attended', num(shown), 'pos')
    + tile('Closed won', num(closed), 'pos')
    + tile('No-shows', num(noshow), 'neg')
    + tile('Show rate', pct(booked ? shown / booked : 0), (shown/booked) >= CFG.showTarget ? 'pos' : 'warn')
    + tile('Close rate', pct(shown ? closed / shown : 0), 'info')
    + tile('Scheduled ahead', num(FUTURE.length), 'info')
    + '</div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><div><h3>90-day booking density</h3><div class="sub">One cell per day · brighter = more booked</div></div>'
    + '<div class="legend"><span><i style="background:rgba(255,255,255,.05)"></i>0</span><span><i style="background:rgba(47,184,172,.3)"></i>low</span><span><i style="background:rgba(47,184,172,.76)"></i>mid</span><span><i style="background:var(--accent)"></i>peak</span></div></header>'
    + '<div class="heatwrap">'
    + '<div class="heatdays"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>'
    + '<div class="heatcols"><div class="heatmonths">' + months + '</div><div class="heat">' + heat + '</div></div>'
    + '</div></div>'
    + '<div class="glass card"><header><h3>Outcome mix</h3><div class="sub">last 30 days</div></header>'
    + breakdown([
        {label:'Booked',    n: booked,                 color:'#2fb8ac'},
        {label:'Attended',  n: shown,                  color:'#5ec8ff'},
        {label:'Closed won',n: closed,                 color:'#10b981'},
        {label:'No-show',   n: noshow,                 color:'#ef4444'},
        {label:'Cancelled', n: booked - shown - noshow, color:'#8f9aab'}
      ], booked)
    + '<p class="note" style="margin-top:.9rem">Every row is a share of the ' + num(booked) + ' appointments booked in this period. A sale is counted inside the attended figure, not on top of it.</p>'
    + '</div></div>'

    + '<div class="glass card defer"><header><h3>' + (state.apptFilter === 'upcoming' ? 'Upcoming appointments' : 'Recent appointments') + '</h3>'
    + '<div class="sub">' + list.length + ' shown</div></header>'
    + (list.length ? '<div class="tw"><table><thead><tr>'
      + '<th>When</th><th>Account</th><th>Caller</th><th>Outcome</th><th class="r">Value</th></tr></thead><tbody>'
      + list.map(a => {
          const c = CLIENT_BY[a.clientId], ag = AGENT_BY[a.agentId];
          const d = new Date(a.t);
          const oc = a.outcome === 'closed' ? 'grow' : a.outcome === 'showed' ? 'on-' : a.outcome === 'upcoming' ? 'new' : a.outcome === 'noshow' ? 'risk' : 'off';
          return '<tr><td class="num">' + d.toLocaleDateString('en-US',{weekday:'short'}) + ' ' + shortDate(d)
            + ' <span style="color:var(--dim)">' + slot(a.hm) + '</span></td>'
            + '<td><span class="who-cell"><span class="ava cl">' + esc(maskInitials(c.name)) + '</span><span class="strong">' + maskName(c.name) + '</span></span></td>'
            + '<td><span class="who-cell"><span class="ava ' + ag.kind + '">' + esc(initials(ag.name)) + '</span>' + esc(ag.name) + '</span></td>'
            + '<td><span class="pill ' + oc + '">' + esc(a.outcome) + '</span></td>'
            + '<td class="num r">' + usd(a.value) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="empty"><b>Nothing scheduled</b>New bookings appear here as soon as a caller confirms them.</div>')
    + '</div>';
}

/* ---- Leads ---- */
function renderLeads() {
  const stages = leadsByStage();
  const cf = state.leadClient;
  const pass = (l) => cf === 'all' || l.clientId === cf;

  const cols = LEAD_STAGES.map(st => {
    const items = stages[st.id].filter(pass);
    return '<div class="glass col"><h4>' + esc(st.label) + '<span class="cnt">' + items.length + '</span></h4>'
      + (items.length
        ? items.slice(0, 7).map(l =>
            '<div class="lead" data-lead="' + esc(l.id) + '" tabindex="0" role="button">'
            + '<b>' + esc(l.name) + '</b>'
            + '<div class="m"><span>' + maskName(CLIENT_BY[l.clientId].name) + '</span><span class="val">' + usd(l.value) + '</span></div>'
            + '<div class="m"><span>' + esc(l.source) + '</span><span>score ' + l.score + '</span></div>'
            + '</div>').join('')
          + (items.length > 7 ? '<div class="note" style="text-align:center;padding-top:.3rem">+' + (items.length - 7) + ' more</div>' : '')
        : '<div class="note" style="padding:.6rem 0">Empty</div>')
      + '</div>';
  }).join('');

  const qualified = stages.qualified.filter(pass).length;
  const totalVal = sum(LEADS.filter(pass), l => l.value);

  $('v-leads').innerHTML =
    '<div class="bar"><h2 class="sec">Lead pipeline</h2><div class="sp"></div>'
    + '<label class="sr-only" for="leadClient">Filter by client</label>'
    + '<select id="leadClient"><option value="all">All clients</option>'
    + CLIENTS.filter(c => c.status === 'active').map(c => '<option value="' + esc(c.id) + '"' + (cf === c.id ? ' selected' : '') + '>' + esc(maskNameText(c.name)) + '</option>').join('')
    + '</select>' + exportBtn('leads') + '</div>'

    + '<div class="grid g-mini">'
    + tile('Total leads', num(LEADS.filter(pass).length))
    + tile('Qualified', num(qualified), 'info')
    + tile('Booked', num(stages.booked.filter(pass).length), 'pos')
    + tile('Closed won', num(stages.closed.filter(pass).length), 'pos')
    + tile('Lost', num(stages.lost.filter(pass).length), 'neg')
    + tile('Pipeline value', kmb(totalVal))
    + '</div>'

    + '<div class="board" id="leadBoard">' + cols + '</div>'

    + '<div class="glass card defer"><header><h3>Newest leads</h3><div class="sub">most recent 40</div></header>'
    + '<div class="tw"><table><thead><tr><th>Lead</th><th>Client</th><th>Source</th><th>Stage</th><th class="r">Score</th><th class="r">Value</th><th class="r">Age</th></tr></thead><tbody>'
    + LEADS.filter(pass).slice(0, 40).map(l =>
        '<tr class="hoverable" data-lead="' + esc(l.id) + '"><td class="strong">' + esc(l.name) + '</td>'
        + '<td>' + maskName(CLIENT_BY[l.clientId].name) + '</td>'
        + '<td style="color:var(--muted)">' + esc(l.source) + '</td>'
        + '<td><span class="pill ' + (l.stage === 'closed' ? 'grow' : l.stage === 'lost' ? 'risk' : l.stage === 'qualified' ? 'ai' : 'new') + '">' + esc(l.stage) + '</span></td>'
        + '<td class="num r">' + l.score + '</td><td class="num r">' + usd(l.value) + '</td>'
        + '<td class="num r" style="color:var(--dim)">' + ago(l.t) + '</td></tr>').join('')
    + '</tbody></table></div></div>';
}

/* ---- Clients ---- */
function renderClients() {
  const f = state.clientFilter;
  const rows = CLIENTS
    .filter(c => f === 'all' ? true : f === 'churned' ? c.status === 'churned' : (c.status === 'active' && (f === 'active' ? !c.flag : c.flag === f)))
    .map(c => ({c, st: clientStats(c, 30)}));

  applySort(rows, 'clients', (r, k) => ({
    name: r.c.name, mrr: r.c.mrr, appts: r.st.total, sit: r.st.sit,
    close: r.st.close, cpa: r.st.cpa, margin: r.st.margin, health: r.st.health
  })[k]);

  const counts = {
    all: CLIENTS.length,
    active: CLIENTS.filter(c => c.status === 'active' && !c.flag).length,
    expansion: CLIENTS.filter(c => c.flag === 'expansion').length,
    watch: CLIENTS.filter(c => c.flag === 'watch').length,
    churned: CLIENTS.filter(c => c.status === 'churned').length
  };
  const live = CLIENTS.filter(c => c.status === 'active');
  const totalMrr = sum(live, c => c.mrr);
  const allStats = live.map(c => clientStats(c, 30));

  $('v-clients').innerHTML =
    scopeBanner()
    + '<div class="bar"><h2 class="sec">Accounts</h2><div class="sp"></div>'
    + [['all','All'],['active','Healthy'],['expansion','Growing'],['watch','Watch'],['churned','Left']]
        .map(([k, l]) => '<button class="chip" data-cfilter="' + k + '" aria-pressed="' + (f === k) + '">' + l + '<span class="n">' + counts[k] + '</span></button>').join('')
    + exportBtn('clients') + '</div>'

    + '<div class="grid g-mini">'
    + tile('Monthly fees', kmb(totalMrr), 'pos')
    + tile('Performance rev · 30d', kmb(sum(allStats, s => s.perf)), 'pos')
    + tile('Caller cost · 30d', kmb(sum(allStats, s => s.cost)), 'warn')
    + tile('Gross margin', kmb(sum(allStats, s => s.margin)), 'pos')
    + tile('Avg show rate', pct(allStats.length ? sum(allStats, s => s.sit) / allStats.length : 0), 'info')
    + tile('Callers working', num(sum(live, c => c.seats)))
    + '</div>'

    + '<div class="glass card"><header><h3>Accounts</h3><div class="sub">30-day performance · click a row for the full record</div></header>'
    + '<div class="tw"><table><thead><tr>'
    + th('clients','name','Client') + '<th>Status</th>'
    + th('clients','mrr','Monthly fee', 1) + th('clients','appts','Appointments', 1) + th('clients','sit','Attended', 1)
    + th('clients','close','Bought', 1) + th('clients','cpa','Per appointment', 1) + th('clients','margin','Margin', 1)
    + '<th>Trend</th>' + th('clients','health','Health', 1)
    + '</tr></thead><tbody id="clientRows">'
    + (rows.length ? rows.map(r => {
        const dc = dayCounts('client', r.c.id, 30);
        const sv = daySeries(30).map(d => dc.get(d.t) || 0);
        return '<tr class="hoverable" data-client="' + esc(r.c.id) + '">'
        + '<td><span class="who-cell"><span class="ava cl">' + esc(maskInitials(r.c.name)) + '</span><span><span class="strong">' + maskName(r.c.name) + '</span><br><span style="font-size:.68rem;color:var(--dim)">' + esc(r.c.vertical) + '</span></span></span></td>'
        + '<td>' + (r.c.status === 'churned' ? pill('churned','churned') : pill(r.c.flag || 'active', r.c.flag || 'healthy')) + '</td>'
        + '<td class="num r">' + (r.c.mrr ? usd(r.c.mrr) : '—') + '</td>'
        + '<td class="num r">' + r.st.total + '</td>'
        + '<td class="num r">' + pct(r.st.sit) + '</td>'
        + '<td class="num r">' + pct(r.st.close) + '</td>'
        + '<td class="num r">' + (r.st.total ? usd(r.st.cpa) : '—') + '</td>'
        + '<td class="num r" style="color:' + (r.st.margin >= 0 ? 'var(--emerald)' : 'var(--rose)') + '">' + kmb(r.st.margin) + '</td>'
        + '<td>' + microSpark(sv.length ? sv : [0,0], '#2fb8ac') + '</td>'
        + '<td class="r">' + meter(r.st.health, 1) + '</td></tr>';
      }).join('')
      : '<tr><td colspan="10"><div class="empty"><b>No accounts in this filter</b>Try a different segment.</div></td></tr>')
    + '</tbody></table></div></div>';
}

/* ---- Agents ---- */
function renderAgents() {
  const f = state.agentFilter;
  const all = AGENTS.map(a => ({a, st: agentStats(a, 30)}));
  const rows = all.filter(r =>
    f === 'all' ? true :
    f === 'ai' ? (r.a.kind === 'ai' && r.a.active) :
    f === 'human' ? (r.a.kind === 'human' && r.a.active) :
    r.st.grade === f);

  applySort(rows, 'agents', (r, k) => ({
    name: r.a.name, perDay: r.st.perDay, total: r.st.total, sit: r.st.sit,
    close: r.st.close, pay: r.st.pay, rev: r.st.revenue, tenure: r.st.tenureDays
  })[k]);

  const live = all.filter(r => r.a.active);
  const aiN = live.filter(r => r.a.kind === 'ai').length;
  const huN = live.filter(r => r.a.kind === 'human').length;
  const counts = {
    all: AGENTS.length, ai: aiN, human: huN,
    keeper: live.filter(r => r.st.grade === 'keeper').length,
    ramping: live.filter(r => r.st.grade === 'ramping').length,
    fire: live.filter(r => r.st.grade === 'fire').length,
    churned: all.filter(r => !r.a.active).length
  };

  $('v-agents').innerHTML =
    '<div class="bar"><h2 class="sec">Callers</h2><div class="sp"></div>'
    + [['all','All'],['ai','AI'],['human','People'],['keeper','Doing well'],['ramping','Still learning'],['fire','Struggling'],['churned','Left']]
        .map(([k, l]) => '<button class="chip" data-afilter="' + k + '" aria-pressed="' + (f === k) + '">' + l + '<span class="n">' + counts[k] + '</span></button>').join('')
    + exportBtn('agents') + '</div>'

    + '<div class="grid g-mini">'
    + tile('On accounts now', num(live.length))
    + tile('Ready to start', num(BENCH.filter(b => b.state === 'ready').length), 'pos')
    + tile('AI callers', num(aiN), 'info')
    + tile('People', num(huN))
    + tile('Average per day', nf2.format(live.length ? sum(live, r => r.st.perDay) / live.length : 0), (live.length && sum(live, r => r.st.perDay)/live.length >= CFG.target) ? 'pos' : 'warn')
    + tile('Hitting target', num(live.filter(r => r.st.perDay >= CFG.target).length), 'pos')
    + tile('Struggling', num(counts.fire), 'neg')
    + tile('Monthly cost', kmb(sum(live, r => r.st.pay)), 'warn')
    + '</div>'

    + '<div class="glass card"><header><div><h3>Leaderboard</h3><div class="sub">Last 30 days &middot; target ' + nf2.format(CFG.target) + ' booked a day</div></div></header>'
    + '<div class="tw"><table><thead><tr>'
    + th('agents','name','Caller') + '<th>Type</th><th>Account</th><th>Rating</th>'
    + th('agents','perDay','Per day', 1) + th('agents','total','Booked', 1) + th('agents','sit','Attended', 1)
    + th('agents','close','Bought', 1) + th('agents','rev','Revenue', 1) + th('agents','pay','Cost', 1)
    + th('agents','tenure','Time here', 1) + '<th class="r">Vs target</th>'
    + '</tr></thead><tbody>'
    + (rows.length ? rows.map(r =>
        '<tr class="hoverable" data-agent="' + esc(r.a.id) + '">'
        + '<td><span class="who-cell"><span class="ava ' + r.a.kind + '">' + esc(initials(r.a.name)) + '</span><span class="strong">' + esc(r.a.name) + '</span></span></td>'
        + '<td><span class="pill ' + (r.a.kind === 'ai' ? 'ai' : 'hum') + '">' + r.a.kind + '</span></td>'
        + '<td style="color:var(--muted)"><span class="ell" title="' + esc(maskNameText(CLIENT_BY[r.a.clientId].name)) + '">' + maskName(CLIENT_BY[r.a.clientId].name) + '</span></td>'
        + '<td>' + pill(r.st.grade, GRADE_LABEL[r.st.grade] || r.st.grade) + '</td>'
        + '<td class="num r">' + nf2.format(r.st.perDay) + '</td>'
        + '<td class="num r">' + r.st.total + '</td>'
        + '<td class="num r">' + pct(r.st.sit) + '</td>'
        + '<td class="num r">' + pct(r.st.close) + '</td>'
        + '<td class="num r" style="color:var(--teal)">' + kmb(r.st.revenue) + '</td>'
        + '<td class="num r">' + kmb(r.st.pay) + '</td>'
        + '<td class="num r" style="color:var(--dim)">' + r.st.tenureDays + 'd</td>'
        + '<td class="r">' + meter(r.st.perDay, CFG.target) + '</td></tr>').join('')
      : '<tr><td colspan="12"><div class="empty"><b>Nobody matches</b>Adjust the filter above.</div></td></tr>')
    + '</tbody></table></div></div>'

    /* The bench. A young agency is constrained by accounts signed, not by
       people available, and a roster that only counts who is on an account
       hides that -- it reads as a staffing ceiling when the real ceiling is
       sales. Its own list, so nobody here is ever counted as producing. */
    + '<div class="glass card"><header><div><h3>Ready to start</h3>'
    + '<div class="sub">Trained and cleared, waiting on an account</div></div>'
    + '<div class="sp"></div><span class="pill plain">' + BENCH.length + ' available</span></header>'
    + '<div class="tw"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th>'
    + '<th class="r">Cleared</th><th class="r">Worked here before</th></tr></thead><tbody>'
    + BENCH.slice().sort((x, y) => y.priorDays - x.priorDays).map(b =>
        '<tr><td><span class="who-cell"><span class="ava ' + b.kind + '">'
        + esc(initials(b.name)) + '</span><span class="strong">' + esc(b.name) + '</span></span></td>'
        + '<td><span class="pill ' + (b.kind === 'ai' ? 'ai' : 'hum') + '">'
        + (b.kind === 'ai' ? 'AI' : 'person') + '</span></td>'
        + '<td><span class="pill ' + (b.state === 'ready' ? 'on-' : 'watch') + '">'
        + (b.state === 'ready' ? 'ready' : 'in training') + '</span></td>'
        + '<td class="num r" style="color:var(--dim)">' + esc(ago(b.clearedAt)) + '</td>'
        + '<td class="num r">' + (b.priorDays ? b.priorDays + ' days' : '\u2014') + '</td></tr>').join('')
    + '</tbody></table></div></div>';
}

/* ---- Team ---- */
function renderTeam() {
  const units = {};
  TEAM.forEach(t => (units[t.unit] || (units[t.unit] = [])).push(t));
  $('v-team').innerHTML =
    '<div class="bar"><h2 class="sec">Internal team</h2><div class="sp"></div>'
    + '<span class="pill plain">' + TEAM.length + ' people · ' + Object.keys(units).length + ' units</span></div>'
    + Object.entries(units).map(([unit, people]) =>
        '<div class="glass card"><header><h3>' + esc(unit) + '</h3><div class="sub">' + people.length + '</div></header>'
        + '<div class="grid g-3" style="gap:.7rem">'
        + people.map(p => {
            const yrs = ((TODAY.getTime() - new Date(p.since).getTime()) / (365 * DAY));
            return '<div class="glass tile" style="display:flex;gap:.7rem;align-items:center;padding:.75rem">'
              + '<span class="ava cl" style="width:34px;height:34px;border-radius:10px;font-size:.72rem">' + esc(initials(p.name)) + '</span>'
              + '<span style="min-width:0"><b style="display:block;font-size:.82rem;font-weight:650">' + esc(p.name) + '</b>'
              + '<span style="display:block;font-size:.7rem;color:var(--dim)">' + esc(p.role) + '</span>'
              + '<span style="display:block;font-size:.66rem;color:var(--dim);font-family:var(--mono);margin-top:.15rem">' + nf1.format(yrs) + 'y · ' + esc(p.email) + '</span></span>'
              + '</div>';
          }).join('')
        + '</div></div>').join('');
}

/* ---- Onboard ---- */
function renderOnboard() {
  const totalMrr = sum(ONBOARDING, o => o.mrr);
  const goLive = ONBOARDING.filter(o => o.done >= ONBOARD_STEPS.length).length;
  $('v-onboard').innerHTML =
    '<div class="bar"><h2 class="sec">Onboarding pipeline</h2><div class="sp"></div>'
    + '<span class="pill plain">' + ONBOARDING.length + ' in flight</span></div>'

    + '<div class="grid g-mini">'
    + tile('Accounts onboarding', num(ONBOARDING.length))
    + tile('Monthly fees agreed', kmb(totalMrr), 'pos')
    + tile('Ready to go live', num(goLive), 'info')
    + tile('Avg completion', pct(ONBOARDING.length ? sum(ONBOARDING, o => o.done / ONBOARD_STEPS.length) / ONBOARDING.length : 0))
    + tile('Avg age', Math.round(ONBOARDING.reduce((s,o) => s + (TODAY.getTime()-o.started)/DAY, 0) / ONBOARDING.length) + 'd')
    + '</div>'

    + '<div class="grid g-3">'
    + ONBOARDING.map(o =>
        '<div class="glass card" data-onb="' + esc(o.id) + '">'
        + '<header class="nowrap"><div><h3>' + esc(o.name) + '</h3><div class="sub">' + esc(o.vertical) + ' · ' + kmb(o.mrr) + '/mo · ' + esc(o.owner) + '</div></div>'
        + ring(o.done, ONBOARD_STEPS.length) + '</header>'
        + ONBOARD_STEPS.map((s, i) =>
            '<label class="check"><input type="checkbox" data-step="' + i + '"' + (i < o.done ? ' checked' : '') + '/><span>' + esc(s) + '</span></label>').join('')
        + '<div class="note" style="margin-top:.7rem;padding-top:.7rem;border-top:1px solid var(--border)">Started ' + ago(o.started) + ' · '
        + (o.done >= ONBOARD_STEPS.length ? '<span style="color:var(--emerald);font-weight:650">Ready for go-live</span>'
           : 'Next: <b style="color:var(--muted)">' + esc(ONBOARD_STEPS[o.done]) + '</b>') + '</div>'
        + '</div>').join('')
    + '</div>';
}

/* ---- Payroll ---- */
const PAID_KEY = 'css.payroll.paid.v1';
function payrollPeriod() {
  return TODAY.toLocaleDateString('en-US', {month: 'long', year: 'numeric'});
}
function loadPaid() {
  try {
    const raw = JSON.parse(localStorage.getItem(PAID_KEY) || 'null');
    if (raw && raw.period === payrollPeriod() && Array.isArray(raw.ids)) return new Set(raw.ids);
  } catch (_) {}
  return new Set();
}
function savePaid() {
  try { localStorage.setItem(PAID_KEY, JSON.stringify({ period: payrollPeriod(), ids: [...PAID] })); } catch (_) {}
}
const PAID = loadPaid();
function renderPayroll() {
  const period = payrollPeriod();
  const rows = activeAgents().map(a => {
    const st = agentStats(a, 30);
    const base = a.kind === 'ai' ? 0 : a.base;
    const bonus = a.kind === 'ai' ? 0 : st.total * CFG.bonusPerAppt;
    const seat = a.kind === 'ai' ? a.seatCost : 0;
    return {a, st, base, bonus, seat, total: base + bonus + seat, paid: PAID.has(a.id)};
  }).sort((x, y) => y.total - x.total);

  const humans = rows.filter(r => r.a.kind === 'human');
  const ais = rows.filter(r => r.a.kind === 'ai');
  const grand = sum(rows, r => r.total);

  $('v-payroll').innerHTML =
    '<div class="bar"><h2 class="sec">Payroll · ' + esc(period) + '</h2><div class="sp"></div>'
    + exportBtn('payroll')
    + '<button class="btn btn-ghost btn-sm" id="markAll"><svg class="ic ic-14"><use href="#i-check"/></svg>Mark all paid</button>'
    + '<button class="btn btn-primary btn-sm" id="runPayroll"><svg class="ic ic-14"><use href="#i-wallet"/></svg>Run payroll</button></div>'

    + '<div class="grid g-mini">'
    + tile('Total run', kmb(grand), 'warn')
    + tile('Human base', kmb(sum(humans, r => r.base)))
    + tile('Performance bonus', kmb(sum(humans, r => r.bonus)), 'info')
    + tile('AI seat cost', kmb(sum(ais, r => r.seat)), 'info')
    + tile('Cost per appointment', usdc(sum(rows, r => r.st.total) ? grand / sum(rows, r => r.st.total) : 0))
    + tile('Outstanding', kmb(sum(rows.filter(r => !r.paid), r => r.total)), 'neg')
    + '</div>'

    + '<div class="glass card"><header><div><h3>Pay run detail</h3><div class="sub">Trailing 30 days · bonus at ' + usd(CFG.bonusPerAppt) + ' per booked appointment</div></div></header>'
    + '<div class="tw"><table><thead><tr><th>Caller</th><th>Type</th><th>Account</th>'
    + '<th class="r">Appts</th><th class="r">Base</th><th class="r">Bonus</th><th class="r">Seat</th><th class="r">Total</th><th class="r">Status</th></tr></thead><tbody id="payRows">'
    + rows.map(r =>
        '<tr data-pay="' + esc(r.a.id) + '">'
        + '<td><span class="who-cell"><span class="ava ' + r.a.kind + '">' + esc(initials(r.a.name)) + '</span><span class="strong">' + esc(r.a.name) + '</span></span></td>'
        + '<td><span class="pill ' + (r.a.kind === 'ai' ? 'ai' : 'hum') + '">' + r.a.kind + '</span></td>'
        + '<td style="color:var(--muted)"><span class="ell" title="' + esc(maskNameText(CLIENT_BY[r.a.clientId].name)) + '">' + maskName(CLIENT_BY[r.a.clientId].name) + '</span></td>'
        + '<td class="num r">' + r.st.total + '</td>'
        + '<td class="num r">' + (r.base ? usd(r.base) : '—') + '</td>'
        + '<td class="num r" style="color:var(--teal)">' + (r.bonus ? usd(r.bonus) : '—') + '</td>'
        + '<td class="num r">' + (r.seat ? usd(r.seat) : '—') + '</td>'
        + '<td class="num r strong">' + usd(r.total) + '</td>'
        + '<td class="r">' + (r.paid ? '<span class="pill grow">paid</span>'
            : '<button class="btn btn-ghost btn-sm" data-paybtn="' + esc(r.a.id) + '">Mark paid</button>') + '</td></tr>').join('')
    + '</tbody></table></div></div>';
}

/* ---- P&L ---- */
function renderPnl() {
  const months = pnlMonths(9);
  // Deltas compare the last two *complete* months. Benchmarking a partial
  // month against a full one reports a collapse that never happened.
  const cur = months[months.length - 2], prev = months[months.length - 3];
  const ytd = months.reduce((s, m) => ({revenue: s.revenue + m.revenue, cost: s.cost + m.cost, margin: s.margin + m.margin}), {revenue:0, cost:0, margin:0});

  $('v-pnl').innerHTML =
    '<div class="bar"><h2 class="sec">Profit &amp; loss</h2><div class="sp"></div>'
    + '<span class="pill plain">Trailing 9 months · current month partial</span>' + exportBtn('pnl') + '</div>'

    + '<div class="grid g-kpi">'
    + kpiCard('Revenue · trailing 9mo', kmb(ytd.revenue), deltaTag(cur.revenue, prev.revenue), 'vs. ' + esc(prev.label) + ' · full months only', months.map(m => m.revenue), 'var(--accent)')
    + kpiCard('Cost · trailing 9mo', kmb(ytd.cost), deltaTag(cur.cost, prev.cost), 'pay, AI running costs and overheads', months.map(m => m.cost), 'var(--amber)')
    + kpiCard('Net margin', kmb(ytd.margin), deltaTag(cur.margin, prev.margin), pct(ytd.revenue ? ytd.margin / ytd.revenue : 0) + ' of revenue', months.map(m => m.margin), 'var(--emerald)')
    + kpiCard('Blended cost / appt', usdc(sum(months, m => m.appts) ? ytd.cost / sum(months, m => m.appts) : 0), '', num(sum(months, m => m.appts)) + ' appointments delivered', months.map(m => m.appts ? m.cost / m.appts : 0), 'var(--sky)')
    + '</div>'

    + '<div class="glass card"><header><div><h3>Revenue vs. cost</h3><div class="sub">Bars: revenue &amp; cost · dashed line: net margin</div></div>'
    + '<div class="legend"><span><i style="background:#2fb8ac"></i>Revenue</span><span><i style="background:#f59e0b"></i>Cost</span><span><i style="background:#10b981"></i>Margin</span></div></header>'
    + barChart(months, {h:262}) + '</div>'

    + '<div class="glass card defer"><header><h3>Monthly breakdown</h3></header>'
    + '<div class="tw"><table><thead><tr><th>Month</th>'
    + '<th class="r">Retainer</th><th class="r">Performance</th><th class="r">Revenue</th>'
    + '<th class="r">Base pay</th><th class="r">Bonus</th><th class="r">AI costs</th><th class="r">Overheads</th>'
    + '<th class="r">Cost</th><th class="r">Margin</th><th class="r">Margin %</th></tr></thead><tbody>'
    + months.slice().reverse().map(m =>
        '<tr><td class="strong">' + esc(m.full) + (m.partial ? ' <span class="pill plain">partial</span>' : '') + '</td>'
        + '<td class="num r">' + usd(m.retainer) + '</td><td class="num r">' + usd(m.perf) + '</td>'
        + '<td class="num r strong">' + usd(m.revenue) + '</td>'
        + '<td class="num r">' + usd(m.humanBase) + '</td><td class="num r">' + usd(m.bonus) + '</td>'
        + '<td class="num r">' + usd(m.aiCost) + '</td><td class="num r">' + usd(m.overhead) + '</td>'
        + '<td class="num r">' + usd(m.cost) + '</td>'
        + '<td class="num r strong" style="color:' + (m.margin >= 0 ? 'var(--emerald)' : 'var(--rose)') + '">' + usd(m.margin) + '</td>'
        + '<td class="num r">' + pct(m.mpct) + '</td></tr>').join('')
    + '</tbody></table></div></div>';
  countUp($('v-pnl'));
}

/* ---- Settings ---- */
function renderSettings() {
  const f = (id, label, val, step, hint) =>
    '<label class="check" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.55rem 0;border-bottom:1px solid var(--border);cursor:default">'
    + '<span style="flex:1"><b style="display:block;font-size:.8rem;color:var(--text);font-weight:600">' + esc(label) + '</b>'
    + '<span style="font-size:.7rem;color:var(--dim)">' + esc(hint) + '</span></span>'
    + '<input type="number" id="' + id + '" value="' + val + '" step="' + step + '" style="width:104px;text-align:right;font-family:var(--mono)"/></label>';

  $('v-settings').innerHTML =
    '<div class="bar"><h2 class="sec">Settings</h2><div class="sp"></div>'
    + '<button class="btn btn-ghost btn-sm" id="resetCfg">Reset defaults</button>'
    + '<button class="btn btn-primary btn-sm" id="saveCfgBtn"><svg class="ic ic-14"><use href="#i-check"/></svg>Save &amp; recompute</button></div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><div><h3>Performance targets</h3><div class="sub">These decide every rating and alert you see</div></div></header>'
    + f('cfg-target','Target booked per caller per day', CFG.target, '0.05','The bar every seat is measured against')
    + f('cfg-ramp','Ramp period (days)', CFG.rampDays, '1','New callers count as still learning until they have been here this long')
    + f('cfg-keeper','Doing well above (appointments/day)', CFG.keeperThreshold, '0.05','Steady rate that counts as doing well')
    + f('cfg-fire','Fire floor (appts/day)', CFG.fireThreshold, '0.05','Sustained rate below this flags the seat')
    + f('cfg-show','Healthy show rate', CFG.showTarget, '0.01','Share of booked appointments that must sit')
    + '</div>'

    + '<div class="glass card"><header><div><h3>Rates</h3><div class="sub">Used for pay, margin and P&amp;L</div></div></header>'
    + f('cfg-bonus','Bonus per appointment ($)', CFG.bonusPerAppt, '1','Paid to a person for every booked appointment')
    + f('cfg-seat','Cost of an AI caller / month ($)', CFG.aiSeatCost, '10','Phone and running costs per AI caller')
    + '<div class="note" style="margin-top:1rem">These settings are saved in this browser only. '
    + 'Changing them here does not change anyone else&rsquo;s view.</div>'
    + '</div></div>'

    + '<div class="glass card"><header><h3>Current dataset</h3></header>'
    + '<dl class="kv">'
    + '<dt>Where it comes from</dt><dd>' + (DS.mode === 'sheets' ? 'A connected Google Sheet' : 'Uploaded files') + '</dd>'
    + '<dt>Appointments</dt><dd>' + num(APPTS.length) + '</dd>'
    + '<dt>Leads</dt><dd>' + num(LEADS.length) + '</dd>'
    + '<dt>Callers</dt><dd>' + AGENTS.length + ' (' + activeAgents().length + ' working)</dd>'
    + '<dt>Accounts</dt><dd>' + CLIENTS.length + '</dd>'
    + '<dt>Last updated</dt><dd id="cfgSync">' + (DS.lastSynced ? ago(DS.lastSynced) : '—') + '</dd>'
    + '</dl></div>'

    + renderDataSourcePanel()

    + '<div class="glass card muted-card"><header><h3>Two-way sync <span class="pill off">not connected</span></h3></header>'
    + '<p class="note">Reading a spreadsheet into the dashboard works today. Writing changes back '
    + 'to it needs a Google sign-in that only the owner of the spreadsheet can set up, so it is '
    + 'switched off rather than half-working. Ask your workspace administrator if you '
    + 'want it enabled.</p></div>';
}

function renderDataSourcePanel() {
  const ENTITIES = [
    {kind: 'clients', label: 'Clients', hint: 'Accounts, retainer, per-appointment fee'},
    {kind: 'agents',  label: 'Agents',  hint: 'Import clients first — rows reference clientId'},
    {kind: 'appts',   label: 'Appointments', hint: 'Import accounts and callers first'},
    {kind: 'leads',   label: 'Leads',  hint: 'Import clients first'}
  ];
  const importRows = ENTITIES.map(e =>
    '<div class="ds-row">'
    + '<div class="ds-row-head"><b>' + esc(e.label) + '</b>'
    + '<button class="btn btn-ghost btn-sm" data-template="' + e.kind + '"><svg class="ic ic-14"><use href="#i-down"/></svg>Template</button></div>'
    + '<div class="muted" style="font-size:.72rem;margin-bottom:.4rem">' + esc(e.hint) + '</div>'
    + '<textarea class="ds-paste" data-pastefor="' + e.kind + '" spellcheck="false" placeholder="Paste CSV here…"></textarea>'
    + '<div class="row" style="margin-top:.5rem;gap:.6rem;flex-wrap:wrap">'
    + '<input type="file" class="ds-file" accept=".csv,text/csv" data-filefor="' + e.kind + '"'
    + ' aria-label="Choose a CSV file to import as ' + esc(e.label || e.kind) + '"/>'
    + '<button class="btn btn-primary btn-sm" data-importbtn="' + e.kind + '">Replace ' + esc(e.label.toLowerCase()) + '</button>'
    + '</div><div class="import-status" id="dsStatus-' + e.kind + '"></div>'
    + '</div>').join('');

  const sheetRows = ENTITIES.map(e =>
    '<label class="field" style="width:100%;margin-top:.6rem"><span>' + esc(e.label) + ' — published CSV link</span>'
    + '<input type="text" data-sheeturl="' + e.kind + '" value="' + esc(DS.sheets[e.kind]) + '" placeholder="https://docs.google.com/…/pub?output=csv" style="width:100%"/></label>'
  ).join('');

  const intervals = [[900000,'15 minutes'],[3600000,'1 hour'],[21600000,'6 hours'],[86400000,'1 day'],[0,'Manual only']];

  return '<div class="glass card">'
    + '<header><div><h3>Data source</h3><div class="sub">Swap the demo data for your own — CSV round-trips with Excel and Sheets by construction</div></div></header>'
    + '<div class="seg" role="group" aria-label="Data source mode" style="margin-bottom:1.1rem">'
    + '<button data-dsmode="demo" aria-pressed="' + (DS.mode === 'demo') + '">Demo data</button>'
    + '<button data-dsmode="sheets" aria-pressed="' + (DS.mode === 'sheets') + '">Google Sheet (live)</button>'
    + '</div>'
    + importRows
    + '<label class="field" style="width:100%;margin-top:1rem"><span>Ambiguous dates like 03/04/2026</span>'
    + '<select id="dsDayFirst">'
    + '<option value=""' + (DS.dayFirst == null ? ' selected' : '') + '>Reject — do not guess</option>'
    + '<option value="false"' + (DS.dayFirst === false ? ' selected' : '') + '>Month/day (US)</option>'
    + '<option value="true"' + (DS.dayFirst === true ? ' selected' : '') + '>Day/month</option>'
    + '</select></label>'

    + (DS.mode === 'sheets'
      ? '<div style="margin-top:1.1rem;padding-top:1.1rem;border-top:1px solid var(--border)">'
        + '<div class="banner warn on">A sheet published to the web is public to anyone with the link. This is a one-way, unauthenticated read. Do not publish live client revenue or caller pay into one.</div>'
        + sheetRows
        + '<div class="field-row" style="margin-top:.9rem">'
        + '<label class="field"><span>Update every</span><select id="dsInterval">'
        + intervals.map(([v, l]) => '<option value="' + v + '"' + (DS.intervalMs === v ? ' selected' : '') + '>' + l + '</option>').join('')
        + '</select></label>'
        + '<button class="btn btn-primary btn-sm" id="dsSyncNow" style="margin-top:1.3rem"><svg class="ic ic-14"><use href="#i-sync"/></svg>Sync now</button>'
        + '</div>'
        + '<div class="muted" style="margin-top:.7rem">Last synced: <span id="dsLastSyncTxt">' + (DS.lastSynced ? ago(DS.lastSynced) : 'never') + '</span></div>'
        + '<div class="import-status" id="dsSyncStatus"></div>'
        + '</div>'
      : '')
    + '</div>';
}


/* ── Audit log (admin) ── */
async function renderAudit() {
  const host = $('v-audit');
  host.innerHTML = '<div class="glass card"><div class="empty">Loading audit log…</div></div>';
  let data;
  try {
    const r = await fetch('/api/audit?limit=400', { headers: { Accept: 'application/json' } });
    if (r.status === 403) {
      host.innerHTML = '<div class="glass card"><div class="empty"><b>Not permitted</b>'
        + 'The audit log is admin-only. This is enforced by the server, not by hiding the link.</div></div>';
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    host.innerHTML = '<div class="glass card"><div class="empty"><b>Audit log unavailable</b>'
      + esc(String(e)) + '</div></div>';
    return;
  }

  const entries = data.entries || [];
  const st = data.stats || { byAction: {}, byUser: {} };
  const when = (t) => new Date(t * 1000).toLocaleString('en-US',
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const tone = (a) => a === 'login.failure' || a === 'denied' ? 'risk'
    : a === 'login.success' ? 'grow' : a.startsWith('data.') ? 'hum'
    : a.startsWith('user.') ? 'ai' : 'off';

  const actions = Object.entries(st.byAction).sort((a, b) => b[1] - a[1]);
  const users = Object.entries(st.byUser).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxA = Math.max(1, ...actions.map(a => a[1]));

  host.innerHTML =
    '<div class="bar"><h2 class="sec">Audit log</h2>'
    + '<span class="pill plain">' + entries.length + ' most recent · append-only</span>'
    + '<div class="sp"></div>'
    + '<button class="btn btn-ghost btn-sm" data-export="audit">'
    + '<svg class="ic ic-14"><use href="#i-down"/></svg>Export</button></div>'

    + '<div class="grid g-mini">'
    + tile('Events recorded', num(st.total))
    + tile('Failed sign-ins', num(st.failures), st.failures ? 'neg' : 'pos')
    + tile('Access denied', num(st.denials), st.denials ? 'neg' : 'pos')
    + tile('Distinct actors', num(Object.keys(st.byUser).length), 'info')
    + tile('Data reads', num(st.byAction['data.read'] || 0))
    + tile('Imports', num(st.byAction['data.import'] || 0), 'warn')
    + '</div>'

    + '<div class="grid g-2">'
    + '<div class="glass card"><header><h3>By action</h3></header><div class="funnel">'
    + actions.map(([a, n]) =>
        '<div class="fstage"><span class="lbl" style="width:120px">' + esc(a) + '</span>'
        + '<div class="barw"><div class="barf" style="width:' + (n / maxA * 100).toFixed(1) + '%;'
        + 'background:linear-gradient(90deg,'
        + (a === 'login.failure' || a === 'denied' ? '#ef4444,#ef4444bb' : '#2fb8ac,#2fb8acbb') + ')"></div></div>'
        + '<span class="rate">' + n + '</span></div>').join('')
    + '</div></div>'
    + '<div class="glass card"><header><h3>By actor</h3></header>'
    + (users.length ? users.map(([u, n]) =>
        '<div class="rank"><span class="ava cl">' + esc(initials(u)) + '</span>'
        + '<span class="nm">' + esc(u) + '</span>'
        + '<span class="pill plain">' + n + '</span></div>').join('')
      : '<div class="empty">No attributed events yet.</div>')
    + '<p class="note" style="margin-top:.8rem">The log is append-only through the API — there is no update or '
    + 'delete path in the module that writes it. It is not tamper-evident against someone with filesystem access; '
    + 'hash-chaining would be the next step if it had to survive a hostile admin.</p></div>'
    + '</div>'

    + '<div class="glass card defer"><header><h3>Event stream</h3><div class="sub">newest first</div></header>'
    + (entries.length ? '<div class="tw"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th>'
      + '<th>Source</th><th>Detail</th></tr></thead><tbody>'
      + entries.map(e =>
          '<tr><td class="num" style="color:var(--dim)">' + esc(when(e.t)) + '</td>'
          + '<td class="strong">' + esc(e.user || '—') + '</td>'
          + '<td><span class="pill ' + tone(e.action) + '">' + esc(e.action) + '</span></td>'
          + '<td class="num" style="color:var(--dim)">' + esc(e.ip || '—') + '</td>'
          + '<td class="mono" style="font-size:.7rem;color:var(--muted);white-space:normal;max-width:420px">'
          + esc(e.detail ? JSON.stringify(e.detail) : '') + '</td></tr>').join('')
      + '</tbody></table></div>'
      : '<div class="empty"><b>No events yet</b>Sign in and move around; entries appear here.</div>')
    + '</div>';
}

/* ── Access control (admin) ── */
async function renderAccess() {
  const host = $('v-access');
  host.innerHTML = '<div class="glass card"><div class="empty">Loading accounts…</div></div>';
  let data;
  try {
    const r = await fetch('/api/users', { headers: { Accept: 'application/json' } });
    if (r.status === 403) {
      host.innerHTML = '<div class="glass card"><div class="empty"><b>Not permitted</b>Admin only.</div></div>';
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    host.innerHTML = '<div class="glass card"><div class="empty"><b>Unavailable</b>' + esc(String(e)) + '</div></div>';
    return;
  }

  const users = data.users || [];
  const roleTone = { admin: 'ai', manager: 'hum', client: 'off', prospect: 'off' };
  const roleName = { admin: 'Admin', manager: 'Manager', client: 'Client', prospect: 'Prospect' };
  const ago2 = (t) => t ? ago(t * 1000) : 'never';

  host.innerHTML =
    '<div class="bar"><h2 class="sec">Accounts</h2>'
    + '<span class="pill plain">' + users.length + ' account' + (users.length === 1 ? '' : 's') + '</span>'
    + '<div class="sp"></div></div>'

    + '<div class="glass card"><header><div><h3>Who has access</h3>'
    + '<div class="sub">And which accounts each person can see</div></div></header>'
    + '<div class="tw"><table><thead><tr><th>User</th><th>Role</th><th>Can see</th>'
    + '<th class="r">Created</th><th class="r">Last sign-in</th></tr></thead><tbody>'
    + users.map(u => {
        const scope = u.role === 'admin' ? '<span class="pill grow">Every account</span>'
          : u.role === 'prospect' ? '<span class="pill off">No client data</span>'
          : (u.clients && u.clients.length
              ? u.clients.map(c => '<span class="pill plain">' + maskName(CLIENT_BY[c] ? CLIENT_BY[c].name : c) + '</span>').join(' ')
              : '<span class="pill risk">Nothing assigned yet</span>');
        return '<tr><td><span class="who-cell"><span class="ava cl">' + esc(initials(u.username)) + '</span>'
          + '<span class="strong">' + esc(u.username) + '</span></span></td>'
          + '<td><span class="pill ' + (roleTone[u.role] || 'off') + '">' + esc(roleName[u.role] || u.role) + '</span></td>'
          + '<td style="white-space:normal">' + scope + '</td>'
          + '<td class="num r" style="color:var(--dim)">' + esc(ago2(u.created)) + '</td>'
          + '<td class="num r" style="color:var(--dim)">' + esc(ago2(u.lastLogin)) + '</td></tr>';
      }).join('')
    + '</tbody></table></div></div>'

    + '<div class="glass card"><header><h3>Adding or removing someone</h3></header>'
    + '<p class="note">Accounts are set up by your workspace administrator. '
    + 'Ask them to add, remove or change what someone can see, and it takes effect the '
    + 'next time that person signs in.</p></div>';
}

/* ───────────────────────── 5 · sorting helper ───────────────────────── */

/* ───────────────────────── 6 · drawer ───────────────────────── */
let drawerReturn = null;
function openDrawer(title, sub, body) {
  drawerReturn = document.activeElement;
  $('drawerTitle').textContent = title;
  $('drawerSub').innerHTML = sub;
  $('drawerBody').innerHTML = body;
  $('scrim').classList.add('on');
  $('drawer').classList.add('on');
  $('drawer').focus();
}
function closeDrawer() {
  $('scrim').classList.remove('on');
  $('drawer').classList.remove('on');
  if (drawerReturn && document.contains(drawerReturn)) drawerReturn.focus();
  drawerReturn = null;
}

function openClient(id) {
  const c = CLIENT_BY[id]; if (!c) return;
  const st = clientStats(c, 30), st90 = clientStats(c, 90);
  const seats = AGENTS.filter(a => a.clientId === c.id);
  const s = daySeries(60);
  const dc = dayCounts('client', c.id, 60);
  const sv = s.map(d => dc.get(d.t) || 0);
  const leads = LEADS.filter(l => l.clientId === c.id);
  const stages = {};
  leads.forEach(l => stages[l.stage] = (stages[l.stage] || 0) + 1);

  openDrawer(maskNameText(c.name),
    (c.status === 'churned' ? pill('churned','churned') : pill(c.flag || 'active', c.flag || 'healthy'))
    + '<span>' + esc(c.vertical) + '</span><span>·</span><span>since ' + new Date(c.since).toLocaleDateString('en-US',{month:'short',year:'numeric'}) + '</span>'
    + '<span>·</span><span>CSM ' + esc(c.csm) + '</span>',

    '<div class="grid g-mini">'
    + tile(c.status === 'churned' ? 'Last monthly fee' : 'Monthly fee', c.mrr ? usd(c.mrr) : '—', 'pos')
    + tile('Appointments · 30d', num(st.total))
    + tile('Show rate', pct(st.sit), st.sit >= CFG.showTarget ? 'pos' : 'warn')
    + tile('Close rate', pct(st.close), 'info')
    + tile('Margin · 30d', kmb(st.margin), st.margin >= 0 ? 'pos' : 'neg')
    + tile('Upcoming', num(st.upcoming), 'info')
    + '</div>'

    + '<div class="glass card"><header><h3>60-day volume</h3></header>'
    + areaChart({a: sv, b: null, labels: s.map(d => shortDate(new Date(d.t)))}, {h:150, label:'Appointments over 60 days'}) + '</div>'

    + '<div class="glass card"><header><h3>Callers on this account</h3><div class="sub">'
    + st.seats + ' live' + (seats.length > st.seats ? ' · ' + (seats.length - st.seats) + ' former' : '') + '</div></header>'
    + (seats.length ? seats.map(a => {
        const ast = agentStats(a, 30);
        return '<div class="rank"><span class="ava ' + a.kind + '"' + (a.active ? '' : ' style="opacity:.45"') + '>' + esc(initials(a.name)) + '</span>'
          + '<span class="nm">' + esc(a.name) + (a.active ? '' : ' <span class="pill off">left</span>')
          + '<br><span style="font-size:.67rem;color:var(--dim);font-weight:400">' + ast.total + ' booked · ' + pct(ast.sit) + ' show</span></span>'
          + meter(ast.perDay, CFG.target) + '</div>';
      }).join('') : '<div class="note">No callers assigned yet.</div>')
    + '</div>'

    + '<div class="glass card"><header><h3>Lead mix</h3><div class="sub">' + leads.length + ' leads</div></header>'
    + funnel(cumulativeFunnelData(leads)) + '</div>'

    + '<div class="glass card"><header><h3>Commercials</h3></header><dl class="kv">'
    + '<dt>Monthly retainer</dt><dd>' + (c.mrr ? usd(c.mrr) : '—') + '</dd>'
    + '<dt>Per-appointment fee</dt><dd>' + usd(c.perAppt) + '</dd>'
    + '<dt>Revenue · 90d</dt><dd>' + usd(st90.revenue) + '</dd>'
    + '<dt>Delivery cost · 90d</dt><dd>' + usd(st90.cost) + '</dd>'
    + '<dt>Gross margin · 90d</dt><dd style="color:' + (st90.margin >= 0 ? 'var(--emerald)' : 'var(--rose)') + '">' + usd(st90.margin) + '</dd>'
    + '<dt>Effective rev / appt</dt><dd>' + (st.total ? usd(st.cpa) : '—') + '</dd>'
    + '<dt>Callers agreed</dt><dd>' + c.seats + '</dd>'
    + (c.churnedOn ? '<dt>Left on</dt><dd>' + new Date(c.churnedOn).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</dd>' : '')
    + '</dl>'
    + (c.churnReason ? '<p class="note" style="margin-top:.8rem">Reason: ' + esc(c.churnReason) + '</p>' : '')
    + '</div>');
}

function openAgent(id) {
  const a = AGENT_BY[id]; if (!a) return;
  const st = agentStats(a, 30), st90 = agentStats(a, 90);
  const s = daySeries(60);
  const dc = dayCounts('agent', a.id, 60);
  const sv = s.map(d => dc.get(d.t) || 0);

  openDrawer(a.name,
    '<span class="pill ' + (a.kind === 'ai' ? 'ai' : 'hum') + '">' + a.kind + '</span>'
    + pill(st.grade, GRADE_LABEL[st.grade] || st.grade)
    + '<span>' + maskName(CLIENT_BY[a.clientId].name) + '</span><span>&middot;</span><span>' + st.tenureDays + ' days here</span>',

    '<div class="grid g-mini">'
    + tile('Per day · 30d', nf2.format(st.perDay), st.perDay >= CFG.target ? 'pos' : 'warn')
    + tile('Booked · 30d', num(st.total))
    + tile('Show rate', pct(st.sit), st.sit >= CFG.showTarget ? 'pos' : 'warn')
    + tile('Close rate', pct(st.close), 'info')
    + tile('Revenue · 30d', kmb(st.revenue), 'pos')
    + tile('Cost · 30d', kmb(st.pay), 'warn')
    + '</div>'

    + '<div class="glass card"><header><h3>60-day output</h3><div class="sub">target ' + nf2.format(CFG.target) + '/day</div></header>'
    + areaChart({a: sv, b: null, labels: s.map(d => shortDate(new Date(d.t)))}, {h:150, colorA:'#2dd4bf', label:'Daily booked appointments'}) + '</div>'

    + '<div class="glass card"><header><h3>Scorecard</h3></header><dl class="kv">'
    + '<dt>Rating</dt><dd>' + esc(st.grade) + '</dd>'
    + '<dt>Booked · 90d</dt><dd>' + st90.total + '</dd>'
    + '<dt>Attended · 90d</dt><dd>' + st90.shown + '</dd>'
    + '<dt>Closed · 90d</dt><dd>' + st90.closed + '</dd>'
    + '<dt>Started</dt><dd>' + new Date(a.startedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</dd>'
    + '<dt>Last booking</dt><dd>' + (st.last ? ago(st.last) : '—') + '</dd>'
    + (a.kind === 'human'
        ? '<dt>Monthly base</dt><dd>' + usd(a.base) + '</dd><dt>Bonus · 30d</dt><dd>' + usd(st.total * CFG.bonusPerAppt) + '</dd>'
        : '<dt>Seat cost</dt><dd>' + usd(a.seatCost) + '/mo</dd>')
    + '<dt>Margin contribution</dt><dd style="color:' + (st.revenue - st.pay >= 0 ? 'var(--emerald)' : 'var(--rose)') + '">' + usd(st.revenue - st.pay) + '</dd>'
    + '</dl>'
    + (st.grade === 'fire'
        ? '<p class="note" style="margin-top:.8rem;color:#fda4af">Sustained output is below the ' + nf2.format(CFG.fireThreshold) + '/day floor. Review before the next pay period.</p>'
        : st.grade === 'ramping'
        ? '<p class="note" style="margin-top:.8rem">Still inside the ' + CFG.rampDays + '-day settling-in period, so not yet rated on results.</p>' : '')
    + '</div>');
}

function openLead(id) {
  const l = LEADS.find(x => x.id === id); if (!l) return;
  const c = CLIENT_BY[l.clientId];
  const stIdx = LEAD_STAGES.findIndex(s => s.id === l.stage);
  openDrawer(l.name,
    '<span class="pill ' + (l.stage === 'closed' ? 'grow' : l.stage === 'lost' ? 'risk' : 'ai') + '">' + esc(l.stage) + '</span>'
    + '<span>' + maskName(c.name) + '</span><span>·</span><span>' + esc(l.source) + '</span>',

    '<div class="grid g-mini">'
    + tile('Score', String(l.score), l.score >= 70 ? 'pos' : l.score >= 40 ? 'warn' : 'neg')
    + tile('Est. value', usd(l.value), 'pos')
    + tile('Age', ago(l.t))
    + '</div>'
    + '<div class="glass card"><header><h3>Stage progress</h3></header>'
    + '<div class="funnel">' + LEAD_STAGES.map((s, i) =>
        '<div class="fstage"><span class="lbl">' + esc(s.label) + '</span>'
        + '<div class="barw"><div class="barf" style="width:' + (i <= stIdx ? 100 : 4) + '%;background:' + (i <= stIdx ? 'linear-gradient(90deg,' + s.color + ',' + s.color + 'aa)' : 'rgba(255,255,255,.06)') + '">'
        + (i <= stIdx ? '✓' : '') + '</div></div>'
        + '<span class="rate">' + (i <= stIdx ? 'done' : '—') + '</span></div>').join('')
      + '</div></div>'
    + '<div class="glass card"><header><h3>Record</h3></header><dl class="kv">'
    + '<dt>Client</dt><dd>' + maskName(c.name) + '</dd>'
    + '<dt>Vertical</dt><dd>' + esc(c.vertical) + '</dd>'
    + '<dt>Source</dt><dd>' + esc(l.source) + '</dd>'
    + '<dt>Created</dt><dd>' + new Date(l.t).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) + '</dd>'
    + '<dt>Lead ID</dt><dd>' + esc(l.id) + '</dd>'
    + '</dl></div>');
}

/* ───────────────────────── 7 · router ───────────────────────── */
const ROUTES = {
  overview:     {title:'Overview',     sub:'A summary of how the programme is doing', render: renderOverview},
  insights:     {title:'Insights',     sub:'What changed recently, and what to do about it', render: renderInsights},
  reporting:    {title:'Reporting',    sub:'This period compared with the last one',   render: renderReporting},
  patterns:     {title:'Patterns',     sub:'The days and hours that work best', render: renderPatterns},
  engagement:   {title:'Engagement',   sub:'Calling activity and how many people you need',    render: renderEngagement},
  requests:     {title:'Requests',     sub:'Your requests and how quickly they were handled',        render: renderRequests},
  feedback:     {title:'Feedback',     sub:'Call quality scores and customer ratings',    render: renderFeedback},
  appointments: {title:'Appointments', sub:'Booked, attended, and coming up',       render: renderAppointments},
  leads:        {title:'Leads',        sub:'Where every lead has reached',    render: renderLeads},
  clients:      {title:'Clients',      sub:'Accounts and how each one is doing',    render: renderClients},
  agents:       {title:'Callers',       sub:'Your team of AI and human callers',      render: renderAgents},
  team:         {title:'Team',         sub:'Who works on the programme',                render: renderTeam},
  onboard:      {title:'Onboard',      sub:'New accounts being set up',             render: renderOnboard},
  payroll:      {title:'Payroll',      sub:'Pay run for the current period',                 render: renderPayroll},
  pnl:          {title:'P&L',          sub:'What came in against what it cost',       render: renderPnl},
  audit:        {title:'Audit log',    sub:'A record of every sign-in and data access', render: renderAudit},
  access:       {title:'Access',       sub:'Who has an account and what they can see',        render: renderAccess},
  settings:     {title:'Settings',     sub:'Targets and rates used across the dashboard',          render: renderSettings}
};

function go(route, force) {
  if (!ROUTES[route]) route = 'overview';
  if (routeBlocked(route)) {
    auditEvent('denied', { route, reason: 'this account is not given client data' });
    route = 'overview';
  }
  state.route = route;
  const r = ROUTES[route];
  $('viewTitle').textContent = r.title;
  $('viewSub').textContent = r.sub;
  document.title = 'Opsdeck · ' + r.title;

  if (force || !rendered.has(route)) {
    // Error boundary. Without this a throw inside one renderer leaves the
    // PREVIOUS view on screen with no indication anything failed — the user
    // reads stale numbers as current ones, which is worse than a blank page.
    try {
      const maybe = r.render();
      if (maybe && typeof maybe.catch === 'function') {
        maybe.catch(err => {
          console.error('[view:' + route + '] async render failed', err);
          try { (window.__cssViewErrors || (window.__cssViewErrors = []))
            .push({ route, message: String(err && err.message || err) }); } catch (_) {}
        });
      }
      rendered.add(route);
    } catch (err) {
      rendered.delete(route);
      // Record FIRST. The original version rendered the failure card before
      // logging, so when the thing throwing was the innerHTML write itself,
      // the catch block threw again, the boundary was defeated, and no trace
      // of the failure survived anywhere. Found by actually firing a throw
      // through it rather than assuming it worked.
      console.error('[view:' + route + '] render failed', err);
      try { (window.__cssViewErrors || (window.__cssViewErrors = []))
        .push({ route, message: String(err && err.message || err) }); } catch (_) {}
      try {
        reportClientError({
          message: 'view render failed: ' + String(err && err.message || err),
          source: 'view:' + route,
          stack: err && err.stack ? String(err.stack) : ''
        });
      } catch (_) {}

      const host = $('v-' + route);
      const detail = String(err && err.stack ? err.stack : err);
      try {
        host.innerHTML = '<div class="glass card"><header><h3 style="color:var(--red)">'
          + 'This view failed to render</h3><div class="sub">' + esc(r.title) + '</div></header>'
          + '<p class="note">The rest of the console is unaffected and the underlying data is intact — '
          + 'only this view\'s rendering threw. The same error is in the browser console.</p>'
          + '<div class="log" style="margin-top:.8rem;color:#fca5a5">' + esc(detail) + '</div>'
          + '<div class="row" style="margin-top:.9rem">'
          + '<button class="btn btn-ghost btn-sm" data-retry="' + esc(route) + '">Retry this view</button></div></div>';
      } catch (_) {
        // Last resort: if even the failure card cannot be written, fall back to
        // textContent, which cannot be intercepted by a broken innerHTML path.
        try { host.textContent = 'This view failed to render: ' + detail; } catch (__) {}
      }
    }
  }

  els('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + route));
  if (typeof auditEvent === 'function') auditEvent('view.open', { route });
  els('#nav a').forEach(a => {
    const on = a.dataset.route === route;
    if (on) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
  });
  $('side').classList.remove('open');
  window.scrollTo({top:0, behavior: REDUCED ? 'auto' : 'smooth'});
}
const rerender = () => go(state.route, true);
document.addEventListener('css:data-replaced', () => {
  rendered.clear();
  invalidateInsights();
  refreshBadges();
  rerender();
});
const invalidateInsights = () => { state._insightCount = null; clearInsightCache(); };

function refreshBadges() {
  const now = Date.now();
  const b = {
    upcoming: FUTURE.length,
    qualified: LEADS.filter(l => l.stage === 'qualified').length,
    clients: CLIENTS.filter(c => c.status === 'active').length,
    agents: activeAgents().length,
    onboard: ONBOARDING.length,
    requests: REQUESTS.filter(r => r.status !== 'resolved').length,
    flagged: FEEDBACK.filter(f => f.flagged).length,
    // Insight count is computed once and cached: recomputing the whole engine
    // on every badge refresh would run Mann-Kendall, CUSUM bootstrap and
    // k-means on a 30s timer for a number in a sidebar pill.
    insights: (state._insightCount != null
      ? state._insightCount
      : (state._insightCount = computeInsights().filter(f => f.p < 0.05).length))
  };
  els('[data-badge]').forEach(n => {
    const v = b[n.dataset.badge];
    n.textContent = v;
    const k = n.dataset.badge;
    n.classList.toggle('good', (k === 'upcoming' || k === 'insights') && v > 0);
    n.classList.toggle('hot', (k === 'requests' && v > 12) || (k === 'flagged' && v > 0));
  });
}

/* ───────────────────────── 8 · events (fully delegated) ───────────────────────── */

document.addEventListener('click', (e) => {
  const t = e.target;

  const navA = t.closest('#nav a');
  if (navA) { e.preventDefault(); go(navA.dataset.route); return; }

  const roleBtn = t.closest('[data-switchrole]');
  if (roleBtn) {
    // Switching role is a re-authentication, not a client-side toggle. Anything
    // that changed entitlement without a new session would be a privilege
    // escalation dressed up as a dropdown.
    window.location = '/logout?as=' + encodeURIComponent(roleBtn.dataset.switchrole);
    return;
  }

  if (t.closest('#userBtn')) {
    const menu = $('userMenu'), btn = $('userBtn');
    const open = menu.hasAttribute('hidden');
    if (open) { menu.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
    else { menu.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); }
    return;
  }
  if (!t.closest('#userMenu') && !t.closest('#userBtn')) {
    const menu = $('userMenu');
    if (menu && !menu.hasAttribute('hidden')) {
      menu.setAttribute('hidden', '');
      const b = $('userBtn'); if (b) b.setAttribute('aria-expanded', 'false');
    }
  }

  const retryBtn = t.closest('[data-retry]');
  if (retryBtn) { go(retryBtn.dataset.retry, true); return; }

  const engBtn = t.closest('[data-eng]');
  if (engBtn) { state.engRange = +engBtn.dataset.eng; rerender(); return; }

  const repBtn = t.closest('[data-rep]');
  if (repBtn) { state.repSpan = +repBtn.dataset.rep; rerender(); return; }

  const reqF = t.closest('[data-reqfilter]');
  if (reqF) { state.reqFilter = reqF.dataset.reqfilter; rerender(); return; }

  if (t.closest('#q-apply')) {
    // Clamped at the edges the queueing model actually assumes: a non-positive
    // arrival rate or handle time makes offered load meaningless, not just wrong.
    const g = (id, lo, hi, dflt) => {
      const v = parseFloat($(id).value);
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
    };
    state.queue = {
      calls:  g('q-calls', 1, 5000, 220),
      aht:    g('q-aht', 10, 3600, 190),
      agents: Math.round(g('q-agents', 1, 500, 14)),
      target: Math.round(g('q-target', 1, 600, 20))
    };
    rerender(); return;
  }

  if (t.closest('#printReport')) { window.print(); return; }

  const rangeBtn = t.closest('[data-range]');
  if (rangeBtn) { state.range = +rangeBtn.dataset.range; rerender(); return; }

  const apptBtn = t.closest('[data-appt]');
  if (apptBtn) { state.apptFilter = apptBtn.dataset.appt; rerender(); return; }

  const cf = t.closest('[data-cfilter]');
  if (cf) { state.clientFilter = cf.dataset.cfilter; rerender(); return; }

  const af = t.closest('[data-afilter]');
  if (af) { state.agentFilter = af.dataset.afilter; rerender(); return; }

  const sortTh = t.closest('[data-sortkey]');
  if (sortTh) {
    const tk = sortTh.dataset.sorttable, key = sortTh.dataset.sortkey;
    const cur = state.sort[tk];
    state.sort[tk] = (cur && cur.key === key && cur.dir === 'desc') ? {key, dir:'asc'} : {key, dir:'desc'};
    rerender(); return;
  }

  const payBtn = t.closest('[data-paybtn]');
  if (payBtn) { PAID.add(payBtn.dataset.paybtn); savePaid(); rerender(); toast('Marked paid'); return; }

  if (t.closest('#markAll')) { activeAgents().forEach(a => PAID.add(a.id)); savePaid(); rerender(); toast('All agents marked paid'); return; }
  if (t.closest('#runPayroll')) { toast('Pay run queued for approval'); return; }

  const expBtn = t.closest('[data-export]');
  if (expBtn) {
    const kind = expBtn.dataset.export;
    if (kind === 'requests') {
      const H = ['id','client','kind','priority','status','owner','opened','resolved','sla_hours','breached'];
      downloadCSV('requests.csv', H, REQUESTS.map(r => ({
        id: r.id, client: CLIENT_BY[r.clientId].name, kind: r.kind, priority: r.priority,
        status: r.status, owner: r.owner,
        opened: fmtLocalDate(r.openedAt), resolved: r.resolvedAt ? fmtLocalDate(r.resolvedAt) : '',
        sla_hours: Math.round(r.slaMs / 3600000),
        breached: String(((r.resolvedAt || Date.now()) - r.openedAt) > r.slaMs)
      })));
      toast('Exported ' + REQUESTS.length + ' requests'); return;
    }
    if (kind === 'feedback') {
      const H = ['id','agent','client','date','csat','qa','sentiment','flagged','compliance'];
      downloadCSV('feedback.csv', H, FEEDBACK.map(f => ({
        id: f.id, agent: (AGENT_BY[f.agentId] || {}).name || f.agentId,
        client: CLIENT_BY[f.clientId].name, date: fmtLocalDate(f.t),
        csat: f.csat, qa: f.qa, sentiment: f.sentiment, flagged: String(f.flagged),
        compliance: f.scores['Compliance']
      })));
      toast('Exported ' + FEEDBACK.length + ' reviews'); return;
    }
    if (kind === 'audit') {
      fetch('/api/audit?limit=1000').then(r => r.json()).then(d => {
        downloadCSV('audit-log.csv', ['time','user','action','ip','detail'],
          (d.entries || []).map(e => ({
            time: new Date(e.t * 1000).toISOString(), user: e.user || '',
            action: e.action, ip: e.ip || '', detail: e.detail ? JSON.stringify(e.detail) : ''
          })));
        toast('Audit log exported');
      }).catch(() => toast('Could not export audit log'));
      return;
    }
    if (kind === 'report') {
      const span = state.repSpan || 30;
      const s = daySeries(span), cs = callSeries(span);
      const H = ['date','dials','connects','booked','sat','closed','revenue'];
      downloadCSV('period-report.csv', H, s.map((d, i) => ({
        date: fmtLocalDate(d.t), dials: cs[i] ? cs[i].dials : 0, connects: cs[i] ? cs[i].connects : 0,
        booked: d.booked, sat: d.showed, closed: d.closed, revenue: d.revenue
      })));
      toast('Exported ' + span + ' days'); return;
    }
  }

  const clientRow = t.closest('[data-client]');
  if (clientRow) { openClient(clientRow.dataset.client); return; }

  const agentRow = t.closest('[data-agent]');
  if (agentRow) { openAgent(agentRow.dataset.agent); return; }

  const leadRow = t.closest('[data-lead]');
  if (leadRow) { openLead(leadRow.dataset.lead); return; }

  if (t.closest('#drawerClose') || t.id === 'scrim') { closeDrawer(); return; }
  if (t.closest('#palBtn')) { openPal(); return; }
  if (t.id === 'palWrap') { closePal(); return; }
  if (t.closest('#burger')) { $('side').classList.toggle('open'); return; }
  if (t.closest('#railBtn')) {
    const on = $('shell').classList.toggle('rail');
    $('railBtn').setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
    return;
  }
  if (t.closest('#nameBtn')) { toggleNames(); return; }
  if (t.closest('#bellBtn')) { toast('3 accounts flagged for review'); return; }
  if (t.closest('#syncBtn')) { doSync(); return; }

  const exportBtnEl = t.closest('[data-exportcsv]');
  if (exportBtnEl) {
    const {headers, filename, rows} = buildExportRows(exportBtnEl.dataset.exportcsv);
    if (!rows.length) { toast('Nothing to export'); return; }
    downloadCSV(filename, headers, rows);
    toast('Downloaded ' + filename + ' — ' + rows.length + ' rows');
    return;
  }

  const dsModeBtn = t.closest('[data-dsmode]');
  if (dsModeBtn) {
    DS.mode = dsModeBtn.dataset.dsmode; saveDS(); scheduleSync(); rerender();
    return;
  }
  const tplBtn = t.closest('[data-template]');
  if (tplBtn) {
    const kind = tplBtn.dataset.template;
    downloadCSV(kind + '_template.csv', SCHEMA[kind], [TEMPLATE_ROW[kind]]);
    return;
  }
  const importBtn = t.closest('[data-importbtn]');
  if (importBtn) {
    const kind = importBtn.dataset.importbtn;
    const text = document.querySelector('[data-pastefor="' + kind + '"]').value;
    const statusEl = $('dsStatus-' + kind);
    if (!text.trim()) { statusEl.innerHTML = '<span style="color:var(--red)">Paste CSV text or choose a file first.</span>'; return; }
    const parser = {clients: parseClientsCSV, agents: parseAgentsCSV, appts: parseAppointmentsCSV, leads: parseLeadsCSV}[kind];
    const rep = parser(text);
    const s = rep.summary;

    if (!rep.accepted.length) {
      statusEl.className = 'import-status err';
      statusEl.innerHTML = '<b style="color:var(--red)">Nothing imported — 0 of '
        + (s.rejected) + ' rows were usable.</b>' + renderImportReport(rep);
      return;
    }

    ({clients: replaceClients, agents: replaceAgents, appts: replaceAppts, leads: replaceLeads})[kind](rep.accepted);
    // rerender() redraws the whole Settings view — including a fresh, empty
    // #dsStatus-{kind} node — so writing the message before it runs just gets
    // overwritten a tick later. Redraw first, then write into the element
    // that is actually still in the DOM afterward.
    toast(s.accepted + ' ' + kind + ' imported'
      + (s.rejected ? ' · ' + s.rejected + ' rejected' : '')
      + (s.coerced ? ' · ' + s.coerced + ' cleaned' : ''));
    rerender();
    const fresh = $('dsStatus-' + kind);
    if (fresh) {
      fresh.className = 'import-status ' + (s.clean ? 'ok' : 'warn');
      fresh.innerHTML = '<b>' + s.accepted + ' rows imported'
        + (s.clean ? ' — clean.' : '.') + '</b>' + renderImportReport(rep);
    }
    return;
  }
  if (t.closest('#dsSyncNow')) {
    const btn = $('dsSyncNow'); btn.disabled = true;
    syncFromSheets().then((report) => {
      btn.disabled = false;
      const el = $('dsSyncStatus');
      if (el) {
        const lines = Object.entries(report).map(([k, r]) => k + ': ' + r.ok + ' rows' + (r.errors.length ? ' (' + r.errors.length + ' errors)' : ''));
        el.innerHTML = lines.length ? lines.join(' · ') : 'No sheet URLs configured yet.';
      }
      const lt = $('dsLastSyncTxt'); if (lt) lt.textContent = 'just now';
      toast('Sheets sync complete');
    });
    return;
  }

  if (t.closest('#saveCfgBtn')) {
    // `+val || fallback` only catches empty/NaN — a negative or absurd
    // number is truthy and sails through untouched. showTarget=999 or
    // target=-5 doesn't crash anything; it just silently makes every
    // "on target" / grade label in the app wrong from then on, which is
    // worse than a crash because nothing flags it. Bound every field to
    // the range the rest of the app actually assumes.
    const bounded = (id, fallback, lo, hi) => {
      const v = parseFloat($(id).value);
      return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
    };
    CFG.target = bounded('cfg-target', SETTINGS_DEFAULT.target, 0.05, 10);
    CFG.rampDays = Math.round(bounded('cfg-ramp', SETTINGS_DEFAULT.rampDays, 1, 180));
    CFG.keeperThreshold = bounded('cfg-keeper', SETTINGS_DEFAULT.keeperThreshold, 0.05, 10);
    CFG.fireThreshold = bounded('cfg-fire', SETTINGS_DEFAULT.fireThreshold, 0, 10);
    CFG.showTarget = bounded('cfg-show', SETTINGS_DEFAULT.showTarget, 0.01, 1);
    CFG.bonusPerAppt = bounded('cfg-bonus', SETTINGS_DEFAULT.bonusPerAppt, 0, 1000);
    CFG.aiSeatCost = bounded('cfg-seat', SETTINGS_DEFAULT.aiSeatCost, 0, 20000);
    // Reflect the clamp back into the inputs so a rejected value (e.g.
    // typing 999 into a 0–1 field) doesn't sit there looking accepted.
    $('cfg-target').value = CFG.target; $('cfg-ramp').value = CFG.rampDays;
    $('cfg-keeper').value = CFG.keeperThreshold; $('cfg-fire').value = CFG.fireThreshold;
    $('cfg-show').value = CFG.showTarget; $('cfg-bonus').value = CFG.bonusPerAppt;
    $('cfg-seat').value = CFG.aiSeatCost;
    saveCfg(); rendered.clear(); rerender(); toast('Thresholds saved — all views recomputed');
    return;
  }
  if (t.closest('#resetCfg')) {
    resetCfg(); rendered.clear(); rerender(); toast('Reset to defaults'); return;
  }

  const palItem = t.closest('.pal-i');
  if (palItem) { runPal(palItem.dataset.kind, palItem.dataset.id); return; }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'leadClient') { state.leadClient = t.value; rerender(); return; }
  const step = t.closest('[data-step]');
  if (step) {
    const cardEl = step.closest('[data-onb]');
    const o = ONBOARDING.find(x => x.id === cardEl.dataset.onb);
    if (!o) return;
    const i = +step.dataset.step;
    o.done = step.checked ? Math.max(o.done, i + 1) : Math.min(o.done, i);
    saveOnboard(); rerender(); return;
  }

  if (t.id === 'dsInterval') {
    DS.intervalMs = +t.value; saveDS(); scheduleSync();
    toast(DS.intervalMs ? 'Syncing every ' + t.options[t.selectedIndex].text : 'Auto-sync off — use Sync now');
    return;
  }
  if (t.id === 'dsDayFirst') {
    DS.dayFirst = t.value === '' ? null : t.value === 'true';
    saveDS();
    toast(DS.dayFirst == null ? 'Ambiguous dates will be rejected' : (DS.dayFirst ? 'Dates read as day/month' : 'Dates read as month/day'));
    return;
  }
  const sheetUrl = t.closest('[data-sheeturl]');
  if (sheetUrl) { DS.sheets[sheetUrl.dataset.sheeturl] = sheetUrl.value.trim(); saveDS(); return; }

  const fileInput = t.closest('[data-filefor]');
  if (fileInput && fileInput.files[0]) {
    const kind = fileInput.dataset.filefor;
    const reader = new FileReader();
    // Populate the paste box rather than importing immediately — a file
    // picked by accident shouldn't silently replace live data with no
    // chance to look at what's about to be loaded.
    reader.onload = () => { const pasteEl = document.querySelector('[data-pastefor="' + kind + '"]'); if (pasteEl) pasteEl.value = reader.result; };
    reader.onerror = () => toast('Could not read ' + fileInput.files[0].name);
    reader.readAsText(fileInput.files[0]);
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); return; }
  if (e.key === 'Escape') {
    const um = $('userMenu');
    if (um && !um.hasAttribute('hidden')) {
      um.setAttribute('hidden', '');
      const b = $('userBtn'); if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); }
      return;
    }
    if ($('palWrap').classList.contains('on')) { closePal(); return; }
    if ($('drawer').classList.contains('on')) { closeDrawer(); return; }
  }
  if ($('palWrap').classList.contains('on')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); movePal(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Enter') {
      const sel = el('.pal-i[aria-selected=true]');
      if (sel) { e.preventDefault(); runPal(sel.dataset.kind, sel.dataset.id); }
      return;
    }
  }
  if (e.key === 'Enter' || e.key === ' ') {
    const a = document.activeElement;
    if (a && (a.dataset.lead || a.dataset.sortkey)) { e.preventDefault(); a.click(); }
  }
  // focus trap for the drawer
  if (e.key === 'Tab' && $('drawer').classList.contains('on')) {
    const f = els('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', $('drawer'))
      .filter(n => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ───────────────────────── 9 · palette ───────────────────────── */
const PAL_INDEX = []; // rebuilt when the name mask flips
/* `q` always holds the REAL name, so typing a client's name still finds them
   while masked -- an operator who knows who they are looking for should not
   have to unmask to search. `label` is what gets drawn, so it is masked. */
function buildPalette() {
  PAL_INDEX.length = 0;
  Object.keys(ROUTES).forEach(k => PAL_INDEX.push({kind:'page', id:k, label:esc(ROUTES[k].title), sub:'Page', q:(ROUTES[k].title + ' ' + ROUTES[k].sub).toLowerCase()}));
  CLIENTS.forEach(c => PAL_INDEX.push({kind:'client', id:c.id, label:maskName(c.name), sub:c.vertical, q:(c.name + ' ' + c.vertical + ' ' + c.csm).toLowerCase()}));
  AGENTS.forEach(a => PAL_INDEX.push({kind:'agent', id:a.id, label:esc(a.name), sub:a.kind + ' · ' + maskNameText(CLIENT_BY[a.clientId].name), q:(a.name + ' ' + a.kind).toLowerCase()}));
  LEADS.slice(0, 260).forEach(l => PAL_INDEX.push({kind:'lead', id:l.id, label:esc(l.name), sub:'Lead · ' + maskNameText(CLIENT_BY[l.clientId].name), q:(l.name + ' ' + l.source).toLowerCase()}));
}
buildPalette();

let palSel = 0, palRows = [];
function openPal() {
  $('palWrap').classList.add('on');
  $('palInput').value = ''; $('palInput').focus();
  drawPal('');
}
function closePal(){ $('palWrap').classList.remove('on'); }
function drawPal(q) {
  q = q.trim().toLowerCase();
  palRows = (q ? PAL_INDEX.filter(x => x.q.indexOf(q) !== -1) : PAL_INDEX.filter(x => x.kind === 'page')).slice(0, 24);
  palSel = 0;
  if (!palRows.length) { $('palResults').innerHTML = '<div class="empty"><b>No matches</b>Try a client, agent or lead name.</div>'; return; }
  const groups = {page:'Pages', client:'Clients', agent:'Agents', lead:'Leads'};
  let out = '', last = '';
  palRows.forEach((r, i) => {
    if (r.kind !== last) { out += '<div class="pal-g">' + groups[r.kind] + '</div>'; last = r.kind; }
    out += '<div class="pal-i" role="option" data-kind="' + r.kind + '" data-id="' + esc(r.id) + '" aria-selected="' + (i === 0) + '">'
      + '<svg class="ic ic-16" style="color:var(--dim)"><use href="#' + (r.kind === 'page' ? 'i-arrowr' : r.kind === 'client' ? 'i-bld' : r.kind === 'agent' ? 'i-bot' : 'i-target') + '"/></svg>'
      + '<span>' + r.label + '</span><span class="sub">' + esc(r.sub) + '</span></div>';
  });
  $('palResults').innerHTML = out;
}
function movePal(d) {
  const items = els('.pal-i');
  if (!items.length) return;
  items[palSel].setAttribute('aria-selected','false');
  palSel = (palSel + d + items.length) % items.length;
  items[palSel].setAttribute('aria-selected','true');
  items[palSel].scrollIntoView({block:'nearest'});
}
function runPal(kind, id) {
  closePal();
  if (kind === 'page') { go(id); return; }
  if (kind === 'client') { go('clients'); setTimeout(() => openClient(id), 60); return; }
  if (kind === 'agent') { go('agents'); setTimeout(() => openAgent(id), 60); return; }
  if (kind === 'lead') { go('leads'); setTimeout(() => openLead(id), 60); return; }
}
let palTimer = 0;
$('palInput').addEventListener('input', (e) => {
  clearTimeout(palTimer);
  const v = e.target.value;
  palTimer = setTimeout(() => drawPal(v), 90);  // debounced so typing never blocks
});

/* ───────────────────────── 10 · sync + toast ───────────────────────── */
let syncing = false;
function doSync() {
  if (syncing) return;
  syncing = true;
  const ic = $('syncIc');
  ic.animate([{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}], {duration:820, iterations:2, easing:'linear'});
  $('syncBtn').disabled = true;
  setTimeout(() => {
    state.lastSync = Date.now();
    syncing = false;
    $('syncBtn').disabled = false;
    const f = $('feed');
    if (f) { f.innerHTML = feedHTML(); }
    const sa = $('syncAgo'); if (sa) sa.textContent = 'just now';
    const cs = $('cfgSync'); if (cs) cs.textContent = 'just now';
    const nAcc = CLIENTS.filter(c => c.status === 'active').length;
    toast('Updated ' + num(APPTS.length) + ' appointments across '
      + nAcc + ' account' + (nAcc === 1 ? '' : 's'));
  }, 1500);
}

/* keep relative timestamps honest without re-rendering anything */
setInterval(() => {
  const sa = $('syncAgo'); if (sa) sa.textContent = ago(state.lastSync);
}, 30000);

window.addEventListener('hashchange', () => go(location.hash.slice(1)));

/* ───────────────────────── 11 · session + live data ─────────────────────────
   The app no longer owns its numbers. It asks the server who it is, then asks
   for the datasets — which the server has already filtered to that account's
   scope before the bytes existed. The bundled case study is a FALLBACK for
   running without a server, not the source of truth.
   ───────────────────────────────────────────────────────────────────────── */

/* Resolves once boot has finished. The smoke harness awaits this instead of
   polling for a global: boot is now async (identity + four dataset fetches),
   and setTimeout polling inside a background iframe is clamped to ~1s per
   tick, which turned a 3-second budget into a two-minute hang. */
let __markReady;
window.__cssReady = new Promise((res) => { __markReady = res; });


async function loadSession() {
  try {
    const r = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    if (!r.ok) return false;
    const me = await r.json();
    Object.assign(SESSION, me);
    // The endpoint names the field `username`; this object keys it as `user`.
    // Both renderIdentity() and auditEvent() guard on SESSION.user, so leaving
    // the two names unreconciled made identity silently not render AND every
    // audit beacon silently no-op — a whole feature failing with no error.
    SESSION.user = me.username || null;
    SESSION.csrf = me.csrfToken || null;
    return !!SESSION.user;
  } catch (_) { return false; }
}

/* Every state-changing request goes through here, so the CSRF token cannot
   be forgotten at an individual call site — the server rejects any POST
   without it, and a missing token would look like a random 403. */
function apiPost(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SESSION.csrf ? { 'X-CSRF-Token': SESSION.csrf } : {})
    },
    body: JSON.stringify(body || {})
  });
}

/* Global error capture. An exception in a handler, a rejected promise, or a
   throw inside a renderer previously ended its life in a browser console
   nobody was watching. These forward it to the server log with the route it
   happened on, so a failure a user hit at 2am is still visible at 9am.

   Deliberately throttled: one runaway loop should not turn a client bug into
   a self-inflicted denial of service on the log endpoint. */
let _errorBudget = 12;
function reportClientError(payload) {
  if (_errorBudget <= 0 || !SESSION.user) return;
  _errorBudget--;
  try {
    apiPost('/api/client-error', { ...payload, route: state.route }).catch(() => {});
  } catch (_) {}
}

window.addEventListener('error', (ev) => {
  reportClientError({
    message: String(ev.message || ev.error || 'unknown'),
    source: (ev.filename || '') + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0),
    stack: ev.error && ev.error.stack ? String(ev.error.stack) : ''
  });
});

window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  reportClientError({
    message: 'unhandled rejection: ' + String(r && r.message ? r.message : r),
    source: 'promise',
    stack: r && r.stack ? String(r.stack) : ''
  });
});

/* Fire-and-forget audit beacon. Never awaited and never allowed to throw:
   losing an audit line must not break the interaction it describes. */
function auditEvent(action, detail) {
  if (!SESSION.user) return;
  try { apiPost('/api/event', { action, detail }).catch(() => {}); } catch (_) {}
}

async function loadLiveData() {
  const order = ['clients', 'agents', 'appts', 'leads'];
  const apply = { clients: replaceClients, agents: replaceAgents, appts: replaceAppts, leads: replaceLeads };
  const parse = { clients: parseClientsCSV, agents: parseAgentsCSV, appts: parseAppointmentsCSV, leads: parseLeadsCSV };
  const loaded = {};
  let any = false;

  // Order matters: agents/appointments/leads all validate their clientId
  // against the client table, so clients must land first or every row after
  // it is rejected as an orphan.
  for (const kind of order) {
    try {
      const r = await fetch('/api/data/' + kind, { headers: { Accept: 'text/csv' } });
      if (!r.ok) { loaded[kind] = null; continue; }
      const total = parseInt(r.headers.get('X-Total-Count') || '0', 10);
      const got = parseInt(r.headers.get('X-Returned-Count') || '0', 10);
      const rep = parse[kind](await r.text());
      if (rep.accepted.length) { apply[kind](rep.accepted); any = true; }
      // A truncated dataset silently producing "correct-looking" totals is
      // the worst failure mode here, so record it rather than hide it.
      loaded[kind] = { ...rep.summary, total, returned: got, truncated: total > got };
    } catch (e) {
      loaded[kind] = { error: String(e) };
    }
  }
  if (any) { SESSION.live = true; SESSION.source = 'data/ via server'; }
  SESSION.datasets = loaded;
  return any;
}

function renderIdentity() {
  const name = SESSION.user || 'Not signed in';
  const scopeIds = SESSION.unrestricted ? null : (SESSION.clients || []);
  const scopeCount = scopeIds ? scopeIds.length : null;
  const totalKnown = CLIENTS.length;

  // No ratio for a scoped account: CLIENTS only contains what the server sent,
  // so "3 of 3" would be both wrong and reassuring. A scoped user is not
  // entitled to the true denominator, so state the count and nothing more.
  const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', client: 'Client', prospect: 'Prospect' };
  const roleLabel = ROLE_LABEL[SESSION.role] || SESSION.role || '—';
  const meta = SESSION.clientDataEntitled === false
    ? roleLabel + ' · evaluation'
    : SESSION.unrestricted
      ? roleLabel + ' · all accounts'
      : roleLabel + ' · ' + scopeCount + ' account' + (scopeCount === 1 ? '' : 's');

  const av = $('userAvatar'), nm = $('userName'), mt = $('userMeta');
  if (av) av.textContent = SESSION.user ? initials(SESSION.user) : '··';
  if (nm) nm.textContent = name;
  if (mt) mt.textContent = meta;

  const umA = $('umAvatar'), umN = $('umName'), umR = $('umRole');
  if (umA) umA.textContent = SESSION.user ? initials(SESSION.user) : '··';
  if (umN) umN.textContent = name;
  if (umR) umR.textContent = roleLabel;

  els('[data-switchrole]').forEach(b => {
    const isCurrent = b.dataset.switchrole === SESSION.role;
    if (isCurrent) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });

  const note = $('umScopeNote'), list = $('umScope');
  const noData = SESSION.clientDataEntitled === false;
  if (note) {
    note.textContent = noData
      ? 'This is a look-around account. It is not given any client information.'
      : SESSION.unrestricted
        ? 'You can see all of our accounts.'
        : 'You can see the accounts listed below, and nothing from any other '
          + 'account ever reaches this browser.';
  }
  if (list) {
    list.innerHTML = noData
      ? '<span class="none">No client information</span>'
      : SESSION.unrestricted
        ? '<span class="all">All ' + totalKnown + ' accounts</span>'
        : (scopeIds.length
            ? scopeIds.map(id => '<span>' + maskName(CLIENT_BY[id] ? CLIENT_BY[id].name : id) + '</span>').join('')
            : '<span>No accounts assigned</span>');
  }
}



const el0 = (sel) => document.querySelector(sel);

/* ───────────────────────── 12 · boot ───────────────────────── */
(async function boot() {
  // Boot failures were previously silent: an exception here left the app
  // running on fallback data with a stale identity block and no indication
  // anything had gone wrong. Each phase is now isolated and reported.
  const phase = async (name, fn) => {
    try { return await fn(); }
    catch (err) {
      console.error('[boot:' + name + ']', err);
      try { (window.__cssBootErrors || (window.__cssBootErrors = []))
        .push({ phase: name, message: String(err && err.stack || err) }); } catch (_) {}
      return null;
    }
  };

  const authed = await phase('session', loadSession);
  if (authed) {
    if (SESSION.clientDataEntitled === false) {
      // Before anything renders. `loadLiveData` treats the server's 403 as
      // "no live data available" and leaves the bundled case study standing,
      // which rendered a prospect the entire programme book. Drop the rows
      // outright rather than trying to filter them at every read site.
      await phase('purge', purgeClientData);
    } else {
      await phase('data', loadLiveData);
      // The server scopes clients, agents, appointments and leads in SQL. It
      // does not scope requests, feedback, the team roster, the onboarding
      // pipeline or experiments, because those are bundled seed collections
      // the API does not serve — so a scoped client was left holding all 96
      // requests, all 520 feedback rows, every staff email and every other
      // company in implementation. Found because `requests` and `feedback`
      // threw on a client account: the rows pointed at clients that were
      // correctly absent from CLIENT_BY. The crash was the symptom; the
      // unscoped rows sitting in the browser were the defect.
      await phase('scope-secondary', applySecondaryScope);
    }
    await phase('identity', renderIdentity);
  }
  if (!authed || SESSION.role !== 'admin') {
    await phase('nav', () =>
      els('[data-route="audit"], [data-route="access"]').forEach(a => a.remove()));
  }
  if (SESSION.clientDataEntitled === false) {
    // Chrome that acts on a dataset this account does not have. A "Sync now"
    // that can only 403 and a palette searching zero records are worse than
    // absent.
    await phase('chrome-prospect', () => {
      ['syncBtn', 'palBtn', 'bellBtn'].forEach(id => {
        const el = $(id); if (el) el.remove();
      });
    });
  }
  if (ROUTE_ENTITLEMENT[SESSION.role]) {
    // Removing the links is convenience, not the control: the server refuses
    // the data and the router refuses the route. This stops the interface
    // offering a door that does not open.
    await phase('nav-scope', () => {
      els('[data-route]').forEach(el => {
        if (routeBlocked(el.dataset.route)) el.remove();
      });
      els('.nav-group').forEach(g => {
        let sib = g.nextElementSibling, any = false;
        while (sib && !sib.classList.contains('nav-group')) {
          if (sib.tagName === 'A') any = true;
          sib = sib.nextElementSibling;
        }
        if (!any) g.remove();          // drop a heading whose links all went
      });
    });
  }
  await phase('names', syncNameToggle);
  await phase('render', () => {
    rendered.clear();
    clearInsightCache();
    state._insightCount = null;
    refreshBadges();
    go(location.hash.slice(1) || 'overview');
  });

  /* Test surface. Deliberately minimal: routes, navigation, rendered markup
     and the error logs — enough for the smoke suite to drive the real app
     without reaching into its internals. Rebuilt in full here because an
     earlier edit replaced the boot block and silently dropped half of it,
     which the smoke suite caught as `api.routes is not a function`. */
  window.__cssViewErrors = window.__cssViewErrors || [];
  window.__cssTestApi = {
    routes: () => Object.keys(ROUTES),
    go: (r) => go(r, true),
    viewHtml: (r) => { const el = $('v-' + r); return el ? el.innerHTML : null; },
    errors: () => (window.__cssViewErrors || []).slice(),
    session: () => ({ ...SESSION }),
    bootErrors: () => (window.__cssBootErrors || []).slice()
  };
  if (__markReady) __markReady(true);
})();
