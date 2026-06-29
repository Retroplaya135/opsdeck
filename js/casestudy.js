/* ═══════════════════════════════════════════════════════════════════════════
   Opsdeck — case study dataset
   ═══════════════════════════════════════════════════════════════════════════
   THIS IS MODEL DATA, NOT MEASURED DATA. Read ASSUMPTIONS below before
   quoting any number on this screen to a client.

   Why a documented case study instead of "10 demo clients":
   A dashboard demoed on arbitrary random numbers teaches an operator nothing
   and cannot be argued with. This module instead defines ONE program with a
   written parameter register — every rate, cost and distribution below is an
   explicit, named assumption with the reasoning attached, and the generator
   is seeded, so any figure in the UI can be traced back to the line here that
   produced it and reproduced exactly on another machine.

   What is honest about it:
     · Every parameter is declared, not buried in the generator.
     · Parameters are stated as ASSUMPTIONS with rationale. They are not
       citations. No external study is claimed or referenced, because
       inventing a citation would be worse than declaring an assumption.
     · The relationships between variables (ramp curves, seasonality, the
       connect→appointment→show→close funnel, no-show behaviour by daypart)
       are modelled deliberately so the analytics have real structure to
       find — not noise dressed up as signal.
     · Replace this whole module with a real loader and nothing downstream
       changes; the shapes are the contract. See README.
   ═══════════════════════════════════════════════════════════════════════════ */

import { mulberry32 } from './analytics.js';
import { DAY, TODAY } from './util.js';

export const PROGRAM = {
  name: 'Example Field Operations',
  subtitle: 'Appointment setting · 7-month operating record',
  kind: 'MODEL DATA — parameterised case study, not a live client account',
  horizonDays: 208,
  seed: 0x5CA1AB1E
};

/* ─────────────────────── assumption register ───────────────────────
   Each entry: the value used, and why that value. An operator reading
   the dashboard can audit the model by reading this table alone. */
export const ASSUMPTIONS = [
  { id:'dials_per_hour', label:'Dials per agent-hour', value:'14–19',
    rationale:'Power-dialer cadence with manual disposition between calls. Bounded below by wrap time, above by list quality.' },
  { id:'connect_rate', label:'Connect rate (live human reached)', value:'23% ± 6pp by daypart',
    rationale:'Modelled as daypart-dependent: late-morning and early-evening connect materially better than midday. This is the single largest driver of cost per appointment.' },
  { id:'appt_rate', label:'Appointment set per connect', value:'1.7% base, scaled by agent skill',
    rationale:'Cold consumer outbound, not warm transfer. Calibrated so the working roster averages ~0.56 booked per caller per day against the 0.6 target - the better callers clear it, the weaker ones miss, which is the only way the rating carries information. An earlier 11% draft (a warm-transfer figure) produced 5.9/day and made every caller look exceptional.' },
  { id:'show_rate', label:'Show rate on booked appointments', value:'68–78%',
    rationale:'Decays with booking lead time and improves with same-week confirmation contact. Both effects are modelled explicitly.' },
  { id:'close_rate', label:'Close rate on sat appointments', value:'28–42% by vertical',
    rationale:'Vertical-dependent. High-ticket trades (solar, roofing) close lower per sit but at much larger contract value.' },
  { id:'aht', label:'Average handle time', value:'165–210s',
    rationale:'Talking plus the notes written up afterwards. Used by the staffing calculator.' },
  { id:'ramp', label:'New-agent ramp', value:'21 days to full productivity',
    rationale:'Output follows a saturating curve, not a step. Callers inside the window count as still learning and are left out of performance decisions.' },
  { id:'seasonality', label:'Weekly seasonality', value:'Dials peak Mon/Tue; appointments land Mon-Sat, Sunday rare',
    rationale:'Two distinct patterns that are easy to conflate. Reachability drives WHEN agents dial (Mon/Tue best, Fri weak). Customer availability drives WHEN the appointment is set for (business days, Saturday sometimes, Sunday almost never). The Patterns view buckets by appointment date, so it shows the second pattern, not the first.' },
  { id:'bonus', label:'Human bonus per booked appointment', value:'$22',
    rationale:'Configurable in Settings; flows through payroll, client margin and P&L consistently.' },
  { id:'ai_seat', label:'AI seat cost per month', value:'$480',
    rationale:'Compute plus telephony per concurrent AI agent. Fixed cost, unlike human bonus which scales with output.' },
  { id:'overhead', label:'Monthly program overhead', value:'$4,900',
    rationale:'Management, QA, tooling, telephony base. Held flat so margin movement is attributable to delivery, not allocation changes.' }
];

export { TODAY, DAY };

const rand = mulberry32(PROGRAM.seed);
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const rf = (lo, hi) => lo + rand() * (hi - lo);
const pick = (a) => a[Math.floor(rand() * a.length)];
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
/* Stochastic rounding. Math.round() on a small expectation is a silent data
   destroyer: at 3.4 connects x 1.7% the expected appointments per daypart is
   0.058, and Math.round() maps every one of those to zero, so the entire
   appointment stream disappears while the dial counts still look healthy.
   Carrying the fractional part as a Bernoulli probability preserves E[x]. */
const draw = (expected) => {
  if (!(expected > 0)) return 0;
  const whole = Math.floor(expected);
  return whole + (rand() < expected - whole ? 1 : 0);
};

/* ─────────────────────── accounts ─────────────────────── */
/* Four accounts and one that left. A young agency does not have nine clients
   on retainer, and a dataset that says it does makes every rate on the
   dashboard read as somebody else's numbers. Retainers are set at what a
   young agency actually charges. Names are invented, and are additionally
   masked in the interface — see `maskName` in util.js. */
export const CLIENTS = [
  {id:'c1', name:'Example Heating One',   vertical:'HVAC', status:'active',  flag:'watch',     mrr:3200, perAppt:58, since:'2026-02-09', seats:2, csm:'Operator One',   closeBase:0.34},
  {id:'c2', name:'Example Heating Two',   vertical:'HVAC', status:'active',  flag:'expansion', mrr:4400, perAppt:64, since:'2026-01-26', seats:2, csm:'Operator One',   closeBase:0.36},
  {id:'c3', name:'Example Climate Three', vertical:'HVAC', status:'active',  flag:null,        mrr:2800, perAppt:52, since:'2026-04-13', seats:1, csm:'Operator Two',   closeBase:0.33},
  {id:'c4', name:'Example Air Four',      vertical:'HVAC', status:'active',  flag:'expansion', mrr:5100, perAppt:71, since:'2026-03-02', seats:2, csm:'Operator Three', closeBase:0.31},
  {id:'c5', name:'Example Mechanical',    vertical:'HVAC', status:'churned', flag:null,        mrr:3400, perAppt:47, since:'2026-02-16', seats:0, csm:'Operator One',   closeBase:0.30,
   churnedOn:'2026-07-04', churnReason:'Owner sold the business; the buyer had an in-house team'}
];
export const CLIENT_BY = Object.fromEntries(CLIENTS.map(c => [c.id, c]));

/* ─────────────────────── roster ─────────────────────── */
const HUMAN_NAMES = Array.from({length: 32}, (_, i) => `Caller ${String(i + 1).padStart(2, '0')}`);

/* AI callers carry ordinary names too. "ARIA-03" told a customer they were
   talking to a machine before anyone said a word, which is the wrong default
   for a service sold on the call feeling normal. The distinction is not
   removed — it moves to the blue AI marker beside the name, where an operator
   sees it and a caller-facing transcript does not. */
const AI_NAMES = Array.from({length: 14}, (_, i) => `Automated caller ${String(i + 1).padStart(2, '0')}`);

export const AGENTS = [];
/* People who are trained and cleared to take calls but are not on an account
   right now. A young agency's real constraint is accounts, not callers, so
   the honest picture is a small number working and a bench behind them --
   showing 28 "live seats" implied a headcount the programme does not have.
   Kept out of AGENTS so no aggregate silently counts a bench member as
   producing: every rate on the dashboard divides by people who actually
   worked. */
export const BENCH = [];

(function buildRoster(){
  const live = CLIENTS.filter(c => c.status === 'active');
  let n = 0, hi = 0, ai = 0;
  live.forEach((c, ci) => {
    const age = Math.round((TODAY.getTime() - new Date(c.since).getTime()) / DAY);
    for (let s = 0; s < c.seats; s++) {
      // Seat 0 is the founding seat and covers the account from day one, so a
      // client's volume series is continuous from its start date rather than
      // showing a phantom dead zone before its first agent happened to exist.
      const tenure = s === 0 ? age : clamp(ri(14, age), 14, age);
      const isAi = s % 2 === 0;
      AGENTS.push({
        id:'a'+(++n),
        name: isAi ? AI_NAMES[ai++ % AI_NAMES.length] : HUMAN_NAMES[hi++ % HUMAN_NAMES.length],
        kind: isAi ? 'ai' : 'human', clientId:c.id,
        startedAt: TODAY.getTime() - tenure*DAY, endedAt:null,
        base: isAi ? 0 : ri(1900,3200), seatCost: isAi ? 480 : 0,
        skill: (isAi ? 0.72 : 0.55) + rand() * (isAi ? 0.68 : 0.92),
        ahtSec: isAi ? ri(150,180) : ri(170,215),
        active:true
      });
    }
  });

  // Attrition history: people who did work here and no longer do. Kept in
  // AGENTS because their calls and appointments are real history.
  for (let i = 0; i < 4; i++) {
    const c = live[i % live.length];
    const age = Math.round((TODAY.getTime() - new Date(c.since).getTime()) / DAY);
    const endedAt = TODAY.getTime() - ri(8,60)*DAY;
    AGENTS.push({
      id:'a'+(++n), name: HUMAN_NAMES[hi++ % HUMAN_NAMES.length], kind:'human', clientId:c.id,
      startedAt: endedAt - clamp(ri(30,age),30,Math.max(30,age))*DAY, endedAt,
      base: ri(1900,3200), seatCost:0, skill: 0.42 + rand()*0.4, ahtSec: ri(180,220), active:false
    });
  }

  // The bench. Trained, cleared, waiting on an account to be signed.
  const READY = ['ready', 'ready', 'ready', 'training', 'ready', 'ready', 'training'];
  for (let i = 0; i < 19; i++) {
    const isAi = i % 3 === 2;
    BENCH.push({
      id:'b'+(i+1),
      name: isAi ? AI_NAMES[ai++ % AI_NAMES.length] : HUMAN_NAMES[hi++ % HUMAN_NAMES.length],
      kind: isAi ? 'ai' : 'human',
      state: READY[i % READY.length],
      clearedAt: TODAY.getTime() - ri(3, 120)*DAY,
      // Prior programme experience, where there is any. A bench member who
      // has worked here before is a different proposition from a new hire.
      priorDays: rand() < 0.45 ? ri(20, 180) : 0
    });
  }
})();

export const AGENT_BY = Object.fromEntries(AGENTS.map(a => [a.id, a]));

/* ─────────────────── daily engine: calls → appts → outcomes ───────────────────
   One pass produces the call ledger and the appointment ledger together, so
   connect-rate, appointment-rate and show-rate stay arithmetically consistent
   with each other. Generating them independently is how demo datasets end up
   with 40 appointments from 12 connects. */
export const CALLS = [];      // daily per-agent call aggregates
export const APPTS = [];      // one row per booked appointment

const DAYPART = [            // hour → connect multiplier (see assumption `connect_rate`)
  {h:9,  m:0.92}, {h:10, m:1.18}, {h:11, m:1.22}, {h:12, m:0.74},
  {h:13, m:0.81}, {h:14, m:0.97}, {h:15, m:1.05}, {h:16, m:1.14},
  {h:17, m:1.21}, {h:18, m:1.08}
];

(function simulate(){
  const H = PROGRAM.horizonDays;
  for (let d = H; d >= -14; d--) {                    // negative d = scheduled ahead
    const date = TODAY.getTime() - d * DAY;
    const dow = new Date(date).getDay();
    const weekend = (dow === 0 || dow === 6) ? 0.15 : 1;
    // Weekly seasonality: Mon/Tue peak, Fri trough (assumption `seasonality`)
    const dowLift = [0.15, 1.14, 1.16, 1.04, 0.96, 0.82, 0.15][dow];
    const future = d < 0;
    // Slow programme-level improvement plus a mild annual cycle.
    const maturity = 1 + 0.22 * (1 - Math.exp(-(H - d) / 180));
    const annual = 1 + 0.08 * Math.sin((2 * Math.PI * (H - d)) / 365);

    for (const ag of AGENTS) {
      if (date < ag.startedAt) continue;
      if (ag.endedAt && date > ag.endedAt) continue;
      if (weekend < 0.5 && rand() > 0.25) continue;   // most weekends are dark

      const tenure = (date - ag.startedAt) / DAY;
      const ramp = 1 - Math.exp(-tenure / 21);        // saturating, see `ramp`
      const eff = ag.skill * clamp(ramp, 0.12, 1) * dowLift * weekend * maturity * annual;

      const hours = ag.kind === 'ai' ? 7.4 : rf(6.0, 7.4);
      const dials = Math.round(hours * rf(14, 19) * (ag.kind === 'ai' ? 1.22 : 1) * weekend);
      if (dials <= 0) continue;

      let connects = 0, appts = 0;
      const perHour = Math.max(1, Math.round(dials / DAYPART.length));
      for (const part of DAYPART) {
        const attempts = perHour;
        const cr = clamp(0.23 * part.m * (0.85 + eff * 0.3), 0.05, 0.55);
        const c = draw(attempts * cr);
        connects += c;
        const ar = clamp(0.017 * eff, 0.002, 0.09);
        const a = draw(c * ar);
        for (let k = 0; k < a; k++) {
          appts++;
          const cl = CLIENT_BY[ag.clientId];
          // Consumer home-services appointments are set for business days,
          // Saturday sometimes, Sunday almost never. Without this the booked
          // date inherits none of the weekday structure (the dial-day
          // weighting is applied above, then the appointment is pushed 1-9
          // days out), which flattens the week and inverts the profile the
          // Patterns view is meant to surface.
          let leadDays = ri(1, 9);
          let apptDate = date + leadDays * DAY;
          for (let guard = 0; guard < 8; guard++) {
            const wd = new Date(apptDate).getDay();
            // Spill in BOTH directions. Always nudging +1 pushes every
            // deflected weekend booking onto Monday, which produced a Monday
            // spike of ~22/day against ~12 elsewhere — an artefact of the
            // deflection rule, not a real reachability pattern.
            if (wd === 0 && rand() < 0.92) leadDays += (rand() < 0.5 ? 1 : -2);
            else if (wd === 6 && rand() < 0.55) leadDays += (rand() < 0.5 ? 2 : -1);
            else break;
            if (leadDays < 1) leadDays = 1;
            apptDate = date + leadDays * DAY;
          }
          const hm = part.h * 60 + (rand() < 0.5 ? 0 : 30);
          let outcome;
          if (apptDate > TODAY.getTime()) outcome = 'upcoming';
          else {
            // Show rate decays with lead time, recovers with confirmation.
            const confirmed = rand() < 0.72;
            const showP = clamp(0.78 - leadDays * 0.014 + (confirmed ? 0.06 : -0.09), 0.35, 0.9);
            const r = rand();
            if (r < showP) {
              outcome = rand() < clamp(cl.closeBase * (0.85 + eff * 0.2), 0.1, 0.6) ? 'closed' : 'showed';
            } else outcome = rand() < 0.62 ? 'noshow' : 'cancelled';
          }
          APPTS.push({ t: apptDate, hm, bookedOn: date, leadDays,
                       clientId: cl.id, agentId: ag.id, outcome, value: cl.perAppt });
        }
      }
      CALLS.push({ t: date, agentId: ag.id, clientId: ag.clientId,
                   dials, connects, appts, hours,
                   talkSec: connects * ag.ahtSec, ahtSec: ag.ahtSec });
    }
  }
  APPTS.sort((a, b) => a.t - b.t || a.hm - b.hm);
  CALLS.sort((a, b) => a.t - b.t);
})();

/* ─────────────────────── leads ─────────────────────── */
export const LEAD_STAGES = [
  {id:'new',       label:'New',        color:'#8f9aab'},
  {id:'contacted', label:'Contacted',  color:'#5ec8ff'},
  {id:'qualified', label:'Qualified',  color:'#8b5cf6'},
  {id:'booked',    label:'Booked',     color:'#2fb8ac'},
  {id:'showed',    label:'Showed',     color:'#2fb8ac'},
  {id:'closed',    label:'Closed won', color:'#10b981'}
];
const SOURCES = ['Meta Ads','Google LSA','Cold call','SMS reactivation','Referral','Website form','Aged list'];
const LEAD_NAMES = Array.from({length: 64}, (_, i) => `Lead ${String(i + 1).padStart(3, '0')}`);

export const LEADS = [];
(function buildLeads(){
  const live = CLIENTS.filter(c => c.status === 'active');
  const deck = ['new','new','new','new','new','contacted','contacted','contacted','contacted',
    'qualified','qualified','qualified','booked','booked','showed','showed','closed','lost','lost','lost'];
  const BAND = {new:[8,58], contacted:[22,72], qualified:[58,96], booked:[64,98],
                showed:[70,99], closed:[78,100], lost:[4,46]};
  for (let i = 0; i < 640; i++) {
    const c = pick(live), stage = pick(deck), b = BAND[stage];
    LEADS.push({ id:'l'+(i+1), name: pick(LEAD_NAMES), clientId:c.id, stage,
      source: pick(SOURCES), value: Math.round(c.perAppt * (6 + rand()*26)),
      score: ri(b[0], b[1]), t: TODAY.getTime() - ri(0,74)*DAY - ri(0,23)*3600000 });
  }
  LEADS.sort((a,b) => b.t - a.t);
})();

/* ─────────────────── script experiments (A/B) ─────────────────── */
export const EXPERIMENTS = [
  { id:'x1', name:'Asking permission before pitching', metric:'Appointments per answered call',
    startedOn:'2026-06-02', endedOn:'2026-07-14', status:'complete',
    a:{label:'Straight into the pitch',   n:2841, x:298},
    b:{label:'Ask permission first',      n:2794, x:371} },
  { id:'x2', name:'Sending a second reminder text', metric:'Appointments attended',
    startedOn:'2026-06-20', endedOn:'2026-07-28', status:'complete',
    a:{label:'One text, the day before',              n:1204, x:842},
    b:{label:'Day before, plus 2 hours before',       n:1188, x:919} },
  { id:'x3', name:'Offering a time window instead of a fixed slot', metric:'Appointments per answered call',
    startedOn:'2026-07-20', endedOn:null, status:'running',
    a:{label:'Fixed time',        n:906,  x:97},
    b:{label:'Choice of window',  n:889,  x:108} },
  { id:'x4', name:'AI qualifying the lead before a person takes over', metric:'Sales made after the appointment',
    startedOn:'2026-05-11', endedOn:'2026-06-22', status:'complete',
    a:{label:'Straight to a person',      n:604, x:191},
    b:{label:'AI qualifies first',        n:611, x:203} }
];

/* ─────────────────── QA / CSAT feedback ─────────────────── */
const QA_CRITERIA = ['Opening','Discovery','Objection handling','Compliance','Close','Wrap accuracy'];
export const FEEDBACK = [];
(function buildFeedback(){
  const live = AGENTS.filter(a => a.active);
  for (let i = 0; i < 520; i++) {
    const ag = pick(live);
    // Base skill sets the CENTRE; the spread has to be wide enough to produce
    // a genuine negative tail. A narrower first draft (2.9 + skill*1.4 with
    // +-0.5 noise) yielded 4.49 average, +95 NPS and literally zero detractors
    // across 390 reviews — a distribution no contact centre has ever had, and
    // one that left the flagged-review workflow with nothing to show.
    const base = clamp(2.35 + ag.skill * 1.25 + rf(-0.35, 0.35), 1, 5);
    const scores = {};
    for (const c of QA_CRITERIA) scores[c] = clamp(Math.round((base + rf(-1.1, 1.1)) * 2) / 2, 1, 5);
    // ~8% of contacts go badly for reasons unrelated to the agent (wrong
    // number, hostile prospect, billing dispute) — modelled explicitly so the
    // detractor tail exists rather than being smoothed away.
    const sour = rand() < 0.08;
    const csat = clamp(Math.round(base + rf(-1.3, 1.15) - (sour ? 2.2 : 0)), 1, 5);
    FEEDBACK.push({
      id:'f'+(i+1), agentId: ag.id, clientId: ag.clientId,
      t: TODAY.getTime() - ri(0, 120) * DAY,
      csat, qa: +(Object.values(scores).reduce((s,v)=>s+v,0) / QA_CRITERIA.length).toFixed(2),
      scores,
      // Rule-based tag, not a language model: derived deterministically from
      // the numeric score so it can never disagree with the number beside it.
      sentiment: csat >= 4 ? 'positive' : csat === 3 ? 'neutral' : 'negative',
      flagged: csat <= 2 || scores['Compliance'] <= 2.5
    });
  }
  FEEDBACK.sort((a,b) => b.t - a.t);
})();

/* ─────────────────── client requests / tickets ─────────────────── */
const REQ_KINDS = ['Script change','Add seat','Pause campaign','Reporting change','Lead list refresh',
                   'Calendar integration','Billing question','Territory expansion','Compliance review'];
const REQ_PRIORITY = ['low','normal','high','urgent'];
const SLA_HOURS = { urgent: 4, high: 12, normal: 48, low: 120 };
export const REQUESTS = [];
(function buildRequests(){
  const live = CLIENTS.filter(c => c.status === 'active');
  for (let i = 0; i < 96; i++) {
    const c = pick(live);
    const priority = REQ_PRIORITY[Math.min(3, Math.floor(Math.pow(rand(), 1.7) * 4))];
    const slaMs = SLA_HOURS[priority] * 3600000;
    const open = rand() < 0.26;
    // Open tickets have to be RECENT. Drawing their open date from the same
    // 60-day window as resolved ones meant a 4-hour-SLA urgent ticket could
    // sit open for seven weeks, so effectively every open row rendered as
    // breached with the SLA meter pinned at 100% — a generator artefact that
    // looked like a catastrophic service failure.
    const openedAt = open
      ? TODAY.getTime() - Math.round(slaMs * rf(0.05, 1.4)) - ri(0, 2) * 3600000
      : TODAY.getTime() - ri(1, 60) * DAY - ri(0, 23) * 3600000;
    // Most work lands inside SLA; the tail that misses is what the view is for.
    const resolveMs = open ? null
      : Math.round(slaMs * (rand() < 0.82 ? rf(0.12, 0.95) : rf(1.02, 1.9)));
    REQUESTS.push({
      id:'r'+(i+1), clientId:c.id, kind: pick(REQ_KINDS), priority,
      openedAt, status: open ? (rand() < 0.3 ? 'waiting' : 'open') : 'resolved',
      resolvedAt: open ? null : openedAt + resolveMs,
      slaMs, breached: open ? (Date.now() - openedAt) > slaMs : resolveMs > slaMs,
      owner: pick(['Operator One','Operator Two','Operator Three','Reviewer One'])
    });
  }
  REQUESTS.sort((a,b) => b.openedAt - a.openedAt);
})();

/* ─────────────────────── team / onboarding ─────────────────────── */
export const TEAM = [
  {name:'Operator One',   role:'Operations lead',       unit:'Leadership', since:'2024-02-01', email:'operator.one@example.com'},
  {name:'Operator Two',   role:'Client success lead',   unit:'Success',    since:'2024-06-14', email:'operator.two@example.com'},
  {name:'Operator Three', role:'Client success manager',unit:'Success',    since:'2025-01-20', email:'operator.three@example.com'},
  {name:'Operator Four',  role:'Client success manager',unit:'Success',    since:'2025-07-08', email:'operator.four@example.com'},
  {name:'Recruiter One',  role:'Recruiting lead',       unit:'Talent',     since:'2024-11-03', email:'recruiter.one@example.com'},
  {name:'Reviewer One',   role:'Quality reviewer',      unit:'Quality',    since:'2025-03-17', email:'reviewer.one@example.com'},
  {name:'Engineer One',   role:'Platform engineer',     unit:'Platform',   since:'2025-05-05', email:'engineer.one@example.com'},
  {name:'Analyst One',    role:'Data analyst',          unit:'Platform',   since:'2025-09-22', email:'analyst.one@example.com'},
  {name:'Finance One',    role:'Finance operator',      unit:'Finance',    since:'2024-08-30', email:'finance.one@example.com'}
];

export const ONBOARD_STEPS = ['Contract signed','Discovery call','Offer & script approved',
  'CRM / calendar connected','Numbers provisioned','Agent seats assigned','Pilot dials complete','Go-live'];
export const ONBOARDING = [
  {id:'o1', name:'Example Garage Doors', vertical:'Garage Doors', mrr:9600,  owner:'Operator Three', started: TODAY.getTime()-4*DAY,  done:6},
  {id:'o2', name:'Example Insurance',    vertical:'Insurance',    mrr:14200, owner:'Operator One',   started: TODAY.getTime()-11*DAY, done:8},
  {id:'o3', name:'Example Auto Detail',  vertical:'Automotive',   mrr:5400,  owner:'Operator Two',   started: TODAY.getTime()-2*DAY,  done:2},
  {id:'o4', name:'Example Chiropractic', vertical:'Chiropractic', mrr:6300,  owner:'Operator Three', started: TODAY.getTime()-8*DAY,  done:5},
  {id:'o5', name:'Example Landscaping',  vertical:'Landscaping',  mrr:7800,  owner:'Operator One',   started: TODAY.getTime()-1*DAY,  done:1}
];

export const DATASET_STATS = {
  appointments: APPTS.length,
  callDays: CALLS.length,
  dials: CALLS.reduce((s,c)=>s+c.dials,0),
  connects: CALLS.reduce((s,c)=>s+c.connects,0),
  leads: LEADS.length,
  agents: AGENTS.length,
  feedback: FEEDBACK.length,
  requests: REQUESTS.length,
  experiments: EXPERIMENTS.length,
  horizonDays: PROGRAM.horizonDays
};
