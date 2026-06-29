/* ═══════════════════════════════════════════════════════════════════════════
   Shared mutable state: entity arrays, settings, view state.
   ═══════════════════════════════════════════════════════════════════════════
   Extracted so the coupling is explicit and one-directional. Everything
   downstream imports FROM here; nothing here imports a view.

   The arrays are exported as `const` and mutated in place (length = 0, push)
   rather than reassigned. That is deliberate: every renderer, cache and
   closure captured these exact references at module-evaluation time, so a
   reassignment would leave all of them pointing at the previous dataset while
   appearing to succeed.
   ═══════════════════════════════════════════════════════════════════════════ */
import * as D from './casestudy.js';

/* Entity arrays. Seeded from the bundled case study; replaced in place when
   the server supplies live data. */
export const CLIENTS   = D.CLIENTS;
export const CLIENT_BY = D.CLIENT_BY;
export const AGENTS    = D.AGENTS;
export const BENCH     = D.BENCH;   // trained, cleared, not on an account
export const AGENT_BY  = D.AGENT_BY;
export const APPTS     = D.APPTS;
export const CALLS     = D.CALLS;
export const LEADS     = D.LEADS;
export const TEAM      = D.TEAM;
export const REQUESTS  = D.REQUESTS;
export const FEEDBACK  = D.FEEDBACK;
export const EXPERIMENTS = D.EXPERIMENTS;
export const ONBOARDING  = D.ONBOARDING;
export const ONBOARD_STEPS = D.ONBOARD_STEPS;
export const LEAD_STAGES = D.LEAD_STAGES;
export const ASSUMPTIONS = D.ASSUMPTIONS;
export const PROGRAM     = D.PROGRAM;
export const DATASET_STATS = D.DATASET_STATS;

/* Whole-program monthly overhead: management, QA, tooling, telephony base.
   Held flat so margin movement is attributable to delivery, not to changes in
   how cost is allocated. */
export const PROGRAM_OVERHEAD = 4900;

export const SETTINGS_KEY = 'gms.settings.v2';
export const SETTINGS_DEFAULT = {
  target: 0.6, rampDays: 21, fireThreshold: 0.35, keeperThreshold: 0.75,
  showTarget: 0.70, bonusPerAppt: 22, aiSeatCost: 480
};

/* Mutated in place for the same reason as the arrays: aggregates close over
   this object, so reassigning it would silently orphan every reader. */
export const CFG = { ...SETTINGS_DEFAULT };

export function loadCfg() {
  try { Object.assign(CFG, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) {}
  return CFG;
}
export function saveCfg() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(CFG)); } catch (_) {}
}
export function resetCfg() {
  Object.keys(CFG).forEach(k => delete CFG[k]);
  Object.assign(CFG, SETTINGS_DEFAULT);
  saveCfg();
}

/* Session identity, populated at boot from /api/me. */
export const SESSION = {
  user: null, role: null, clients: null, unrestricted: false,
  // Both default to the restrictive value. If the server ever stops sending
  // them, an account loses data it was entitled to — which is visible and
  // reported. The other direction hands an outside party a client's book and
  // looks like nothing happened.
  internal: false, clientDataEntitled: false,
  live: false, source: 'case study', csrf: null, datasets: null
};

/* Transient view state: current route, filters, sort, queue inputs. */
export const state = {
  route: 'overview', range: 60, clientFilter: 'all', agentFilter: 'all',
  leadClient: 'all', apptFilter: 'upcoming', sort: {},
  lastSync: Date.now() - 4 * 60000,
  engRange: 30, repSpan: 30, reqFilter: 'open',
  queue: { calls: 220, aht: 190, agents: 14, target: 20 },
  _insightCount: null
};

/* Replace an entity array in place and re-derive everything that depends on
   it. Callers must go through these rather than assigning, so no code path
   can leave an index or cache pointing at the previous dataset. */
export function replaceEntity(name, rows) {
  const target = { clients: CLIENTS, agents: AGENTS, appts: APPTS, leads: LEADS }[name];
  if (!target) throw new Error('unknown entity: ' + name);
  target.length = 0;
  for (const r of rows) target.push(r);
  if (name === 'leads') LEADS.sort((a, b) => b.t - a.t);
  reindex();
}

/* Hard purge for an account with no client-data entitlement.

   Removing the nav links and 403-ing the API was NOT enough: `loadLiveData`
   treats a 403 as "no live data" and leaves the bundled case study in place,
   so a prospect was rendered the full programme book off the seed. The rule
   now is that the browser of an unentitled account holds no client dataset at
   all — purged before the first render, so there is nothing to leak whether
   through a view, the console, or an export.

   Mutated in place for the same reason as everything else here: every module
   captured these references at evaluation time. */
export function purgeClientData() {
  [CLIENTS, AGENTS, BENCH, APPTS, CALLS, LEADS, TEAM, REQUESTS, FEEDBACK,
   EXPERIMENTS, ONBOARDING].forEach(a => { a.length = 0; });
  [CLIENT_BY, AGENT_BY].forEach(m => Object.keys(m).forEach(k => delete m[k]));
  Object.keys(DATASET_STATS).forEach(k => { delete DATASET_STATS[k]; });
  Object.keys(PROGRAM).forEach(k => { delete PROGRAM[k]; });
}

/* Drop rows in place. Same reason as everything else in this file: the arrays
   are captured references, so filter-and-reassign would leave every renderer
   pointing at the unfiltered original. */
export function retainWhere(arr, keep) {
  const kept = arr.filter(keep);
  arr.length = 0;
  for (const r of kept) arr.push(r);
  return kept.length;
}

/* Collections that carry no client_id and so were never touched by the SQL
   scope filter: the internal staff roster with work emails, the onboarding
   pipeline (other companies, with their retainers), and programme
   experiments. A client account was being served all three from the bundled
   seed. An outside party gets none of it. */
export function purgeInternalData() {
  [TEAM, ONBOARDING, EXPERIMENTS, BENCH].forEach(a => { a.length = 0; });
}

export function reindex() {
  Object.keys(CLIENT_BY).forEach(k => delete CLIENT_BY[k]);
  CLIENTS.forEach(c => { CLIENT_BY[c.id] = c; });
  Object.keys(AGENT_BY).forEach(k => delete AGENT_BY[k]);
  AGENTS.forEach(a => { AGENT_BY[a.id] = a; });
}
