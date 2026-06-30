/* ═══════════════════════════════════════════════════════════════════════════
   Spreadsheet interchange: CSV export, CSV import, Google Sheets read-sync.
   ═══════════════════════════════════════════════════════════════════════════
   Three tiers, each honestly scoped to what it actually does:

     · CSV export/import — works today, zero setup, round-trips with Excel and
       Sheets because CSV is the one format both genuinely agree on.
     · Sheets read-sync   — a GET against a published-to-web CSV URL. Nothing
       more, and no setup beyond File > Share > Publish to web.
     · Sheets write-back  — NOT implemented. Writing needs Google OAuth and a
       Cloud client only the account owner can create. Scaffolded in Settings
       and left visibly disabled rather than faked.

   Parsing primitives live in ./ingest.js because they are pure and therefore
   testable; this module only maps fields onto them and owns the UI wiring.
   ═══════════════════════════════════════════════════════════════════════════ */
import * as I from './ingest.js';
import { $, esc, clamp, TODAY, DAY } from './util.js';
import { activeAgents, agentStats, pnlMonths, resetCaches } from './aggregates.js';
import { clearInsightCache } from './views.analytics.js';
import {
  CLIENTS, CLIENT_BY, AGENTS, AGENT_BY, APPTS, LEADS, LEAD_STAGES, CFG, state, reindex
} from './state.js';

/* ───────────────────────── 1.5 · data source (CSV + Sheets) ─────────────────────────
   Three tiers, each honestly scoped to what it actually does:
     · CSV export/import  — works today, zero setup, round-trips with Excel/Sheets
       because CSV is the one format both actually agree on.
     · Sheets read-sync   — works today, zero setup beyond File ▸ Share ▸ Publish to
       web ▸ CSV in Sheets. It's a GET against a public URL, nothing more.
     · Sheets write-sync  — NOT implemented here. Writing to a Sheet needs Google's
       OAuth (a Cloud project + client ID only the account owner can create) and
       loading Google's identity script, which would make "0 subresource requests"
       a lie the moment it's turned on. Scaffolded and documented in Settings,
       left honestly disabled rather than faked.
   ───────────────────────────────────────────────────────────────────────────── */

export function parseLocalDate(str) {
  // 'new Date("YYYY-MM-DD")' parses as UTC midnight per spec, then
  // .setHours(0,0,0,0) reinterprets that instant in the *local* zone — which
  // silently shifts the calendar date by one for any timezone east of UTC.
  // Every day-bucketed chart in this app keys off exact local-midnight
  // timestamps (see TODAY / daySeries), so an off-by-one here doesn't error,
  // it just makes an imported appointment vanish from its own day's column.
  // Building the Date from y/m/d components sidesteps the UTC round-trip.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  d.setHours(0, 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}
export const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export function parseHM(str, fallback) {
  const m = HHMM_RE.exec(String(str || '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : fallback;
}
export const pad2 = (n) => String(n).padStart(2, '0');
// Local-getter formatting on export, local-component construction on import
// (parseLocalDate above) — the matched pair that keeps a date the same
// calendar day on a round trip. toISOString() would silently break that:
// it always renders in UTC, so exporting a local-midnight timestamp near a
// timezone boundary can print the *previous* day.
export const fmtLocalDate = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
export const fmtHM = (m) => pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);

/* ---- CSV: parse (RFC4180 — quoted commas/quotes/newlines) + stringify ---- */
export function csvParse(text) {
  const rows = []; let row = [], field = '', inQ = false;
  const s = String(text || '').replace(/^﻿/, ''); // strip a BOM from Excel/Sheets exports
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1)
    .filter(r => r.some(v => v.trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
}
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function csvStringify(headers, rows) {
  return [headers.join(',')].concat(rows.map(r => headers.map(h => csvField(r[h])).join(','))).join('\r\n');
}
export function downloadCSV(filename, headers, rows) {
  const blob = new Blob([csvStringify(headers, rows)], {type: 'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ---- per-entity schemas: header order doubles as the import contract ---- */
export const SCHEMA = {
  clients: ['id','name','vertical','status','flag','mrr','perappt','since','seats','csm','churnedon','churnreason'],
  agents:  ['id','name','kind','clientid','startedat','endedat','base','seatcost','active'],
  appts:   ['date','time','clientid','agentid','outcome','value'],
  leads:   ['id','name','clientid','stage','source','value','score','date']
};
export const TEMPLATE_ROW = {
  clients: {id:'c1', name:'Example Roofing, Inc.', vertical:'Roofing', status:'active', flag:'', mrr:9000, perappt:80, since:'2026-01-15', seats:2, csm:'Operator One', churnedon:'', churnreason:''},
  agents:  {id:'a1', name:'Jordan Reyes', kind:'human', clientid:'c1', startedat:'2026-02-01', endedat:'', base:2400, seatcost:'', active:'true'},
  appts:   {date:'2026-08-01', time:'14:30', clientid:'c1', agentid:'a1', outcome:'showed', value:80},
  leads:   {id:'l1', name:'Sam Okafor', clientid:'c1', stage:'qualified', source:'Google LSA', value:900, score:72, date:'2026-08-01'}
};
export function templateCSV(kind) {
  const h = SCHEMA[kind];
  return csvStringify(h, [TEMPLATE_ROW[kind]]);
}

/* Export headers equal import headers (SCHEMA above) for the four raw
   entities — an exported file is a valid re-import by construction, not
   just by claim. Payroll/P&L are computed reports, not raw entities: they
   export what's on screen but round-trip nowhere, which is the correct
   distinction (nothing imports "payroll" back into agent base pay). */
export function buildExportRows(kind) {
  const period = TODAY.toLocaleDateString('en-US', {month: 'long', year: 'numeric'});
  if (kind === 'clients') return {
    headers: SCHEMA.clients, filename: 'clients.csv',
    rows: CLIENTS.map(c => ({id: c.id, name: c.name, vertical: c.vertical, status: c.status, flag: c.flag || '',
      mrr: c.mrr, perappt: c.perAppt, since: c.since, seats: c.seats, csm: c.csm,
      churnedon: c.churnedOn || '', churnreason: c.churnReason || ''}))
  };
  if (kind === 'agents') return {
    headers: SCHEMA.agents, filename: 'agents.csv',
    rows: AGENTS.map(a => ({id: a.id, name: a.name, kind: a.kind, clientid: a.clientId,
      startedat: fmtLocalDate(a.startedAt), endedat: a.endedAt ? fmtLocalDate(a.endedAt) : '',
      base: a.base, seatcost: a.seatCost, active: String(a.active)}))
  };
  if (kind === 'appts') return {
    headers: SCHEMA.appts, filename: 'appointments.csv',
    rows: APPTS.map(a => ({date: fmtLocalDate(a.t), time: fmtHM(a.hm), clientid: a.clientId,
      agentid: a.agentId, outcome: a.outcome, value: a.value}))
  };
  if (kind === 'leads') return {
    headers: SCHEMA.leads, filename: 'leads.csv',
    rows: LEADS.map(l => ({id: l.id, name: l.name, clientid: l.clientId, stage: l.stage,
      source: l.source, value: l.value, score: l.score, date: fmtLocalDate(l.t)}))
  };
  if (kind === 'payroll') {
    const headers = ['agent','type','client','appts','base','bonus','seat','total','period'];
    const rows = activeAgents().map(a => {
      const st = agentStats(a, 30);
      const base = a.kind === 'ai' ? 0 : a.base;
      const bonus = a.kind === 'ai' ? 0 : st.total * CFG.bonusPerAppt;
      const seat = a.kind === 'ai' ? a.seatCost : 0;
      return {agent: a.name, type: a.kind, client: CLIENT_BY[a.clientId].name, appts: st.total,
        base, bonus, seat, total: base + bonus + seat, period};
    });
    return {headers, filename: 'payroll_' + period.replace(' ', '_') + '.csv', rows};
  }
  if (kind === 'pnl') {
    const headers = ['month','retainer','performance','revenue','human_base','bonus','ai_seats','overhead','cost','margin','margin_pct'];
    const rows = pnlMonths(9).map(m => ({month: m.full, retainer: m.retainer, performance: m.perf,
      revenue: m.revenue, human_base: m.humanBase, bonus: m.bonus, ai_seats: m.aiCost,
      overhead: m.overhead, cost: m.cost, margin: m.margin, margin_pct: (m.mpct * 100).toFixed(1) + '%'}));
    return {headers, filename: 'pnl_trailing_9mo.csv', rows};
  }
  return {headers: [], filename: 'export.csv', rows: []};
}

export const VALID_OUTCOMES = ['upcoming','showed','closed','noshow','cancelled'];
export const OUTCOME_ALIASES = {
  // Spellings a real CRM export actually emits. Mapped explicitly rather than
  // falling through to a default, because silently turning "no show" into
  // "showed" inverts the single most important metric in the product.
  'no show':'noshow', 'no-show':'noshow', 'noshow':'noshow', 'missed':'noshow', 'dna':'noshow',
  'cancelled':'cancelled', 'canceled':'cancelled', 'cancel':'cancelled',
  'attended':'showed', 'sat':'showed', 'kept':'showed', 'complete':'showed', 'completed':'showed',
  'won':'closed', 'sold':'closed', 'closed won':'closed', 'closed-won':'closed',
  'scheduled':'upcoming', 'booked':'upcoming', 'pending':'upcoming'
};
export const VALID_STAGES = LEAD_STAGES.map(s => s.id).concat('lost');
export const STAGE_ALIASES = {
  'new lead':'new', 'open':'new', 'fresh':'new',
  'attempted':'contacted', 'in progress':'contacted', 'working':'contacted',
  'qualified':'qualified', 'sql':'qualified', 'mql':'qualified',
  'appointment set':'booked', 'appt set':'booked', 'scheduled':'booked',
  'attended':'showed', 'sat':'showed',
  'won':'closed', 'closed won':'closed', 'sold':'closed',
  'dead':'lost', 'disqualified':'lost', 'dq':'lost', 'closed lost':'lost'
};

/* ─────────────────────────── CSV parsers ───────────────────────────
   Each returns a full ingest report — accepted rows, rejected rows with a
   reason, every coercion applied, and integrity warnings — not a bare count.
   The parsing primitives live in ./ingest.js because they are pure and
   therefore testable; these functions only map fields onto them.

   Rule: coerce what is unambiguously recoverable, record it, and reject what
   is ambiguous. The previous version used parseFloat() directly, which turned
   "$8,400" into 0 and "8,400" into 8 with no warning anywhere. */

export const numField  = (raw) => I.parseNumber(raw);
export const dateField = (raw) => I.parseDate(raw, { dayFirst: DS.dayFirst == null ? null : DS.dayFirst });

export function parseClientsCSV(text) {
  const rep = I.createReport('clients');
  const parsed = csvParse(text);
  if (!parsed.length) rep.warn('File contained no data rows.');

  parsed.forEach((r, i) => {
    const line = i + 2, id = (r.id || '').trim();
    if (!id || !(r.name || '').trim()) { rep.reject(line, id, 'id and name are both required'); return; }

    const perAppt = I.field(rep, line, id, 'perAppt', r.perappt, numField, { required: true });
    if (perAppt === I.REQUIRED_FAIL) return;
    const since = I.field(rep, line, id, 'since', r.since, dateField, { required: true });
    if (since === I.REQUIRED_FAIL) return;

    // mrr rejects on garbage (it is money); seats is lenient (a bad seat
    // count is a nuisance, not a financial misstatement).
    const mrr = I.field(rep, line, id, 'mrr', r.mrr, numField, { fallback: 0 });
    if (mrr === I.REQUIRED_FAIL) return;
    const seats = I.field(rep, line, id, 'seats', r.seats, numField, { fallback: 0, lenient: true });
    const status = I.field(rep, line, id, 'status', r.status,
      (v) => I.parseEnum(v, ['active','churned'], { fallback: 'active',
        aliases: { live:'active', running:'active', cancelled:'churned', lost:'churned', ended:'churned' } }));
    const flag = I.field(rep, line, id, 'flag', r.flag,
      (v) => I.parseEnum(v, ['expansion','watch'], { fallback: null,
        aliases: { growth:'expansion', upsell:'expansion', 'at risk':'watch', risk:'watch' } }));
    const churnedOn = I.field(rep, line, id, 'churnedOn', r.churnedon, dateField, { fallback: null });

    rep.accept({
      id, name: r.name.trim(), vertical: (r.vertical || '').trim() || 'General',
      status, flag: flag || null, mrr: mrr || 0, perAppt,
      since: fmtLocalDate(since.getTime()), seats: Math.max(0, Math.round(seats || 0)),
      csm: (r.csm || '').trim() || 'Unassigned',
      churnedOn: churnedOn ? fmtLocalDate(churnedOn.getTime()) : undefined,
      churnReason: (r.churnreason || '').trim() || undefined,
      closeBase: 0.33
    });
  });

  I.findDuplicates(rep.accepted, (r) => r.id).forEach(d =>
    rep.warn(`Duplicate client id "${d.key}" — the later row wins on lookup.`));
  return rep;
}

export function parseAgentsCSV(text) {
  const rep = I.createReport('agents');
  const known = new Set(CLIENTS.map(c => c.id));
  csvParse(text).forEach((r, i) => {
    const line = i + 2, id = (r.id || '').trim();
    if (!id || !(r.name || '').trim()) { rep.reject(line, id, 'id and name are both required'); return; }
    if (!known.has((r.clientid || '').trim())) {
      rep.reject(line, id, `clientId "${r.clientid}" does not exist — import clients first`); return;
    }
    const started = I.field(rep, line, id, 'startedAt', r.startedat, dateField, { required: true });
    if (started === I.REQUIRED_FAIL) return;

    const ended = I.field(rep, line, id, 'endedAt', r.endedat, dateField, { fallback: null });
    if (ended && ended.getTime() < started.getTime()) {
      rep.reject(line, id, 'endedAt is before startedAt'); return;
    }
    const kind = I.field(rep, line, id, 'kind', r.kind,
      (v) => I.parseEnum(v, ['ai','human'], { fallback: 'human',
        aliases: { bot:'ai', virtual:'ai', automated:'ai', person:'human', rep:'human', sdr:'human' } }));
    const base = I.field(rep, line, id, 'base', r.base, numField, { fallback: 0 });
    if (base === I.REQUIRED_FAIL) return;
    const seat = I.field(rep, line, id, 'seatCost', r.seatcost, numField, { fallback: null });
    if (seat === I.REQUIRED_FAIL) return;
    const activeRaw = String(r.active == null ? '' : r.active).trim().toLowerCase();
    const explicitlyInactive = ['false','0','no','n','inactive','terminated'].includes(activeRaw);

    rep.accept({
      id, name: r.name.trim(), kind, clientId: r.clientid.trim(),
      startedAt: started.getTime(), endedAt: ended ? ended.getTime() : null,
      base: kind === 'human' ? Math.max(0, base || 0) : 0,
      seatCost: kind === 'ai' ? (seat == null ? CFG.aiSeatCost : Math.max(0, seat)) : 0,
      skill: 0.6, ahtSec: 180,
      active: !explicitlyInactive && !ended
    });
  });
  I.findDuplicates(rep.accepted, (r) => r.id).forEach(d =>
    rep.warn(`Duplicate agent id "${d.key}" — the later row wins on lookup.`));
  return rep;
}

export function parseAppointmentsCSV(text) {
  const rep = I.createReport('appts');
  const knownC = new Set(CLIENTS.map(c => c.id));
  const knownA = new Set(AGENTS.map(a => a.id));
  let orphanC = 0, orphanA = 0;

  csvParse(text).forEach((r, i) => {
    const line = i + 2;
    const d = I.field(rep, line, '', 'date', r.date, dateField, { required: true });
    if (d === I.REQUIRED_FAIL) return;
    const cid = (r.clientid || '').trim(), aid = (r.agentid || '').trim();
    if (!knownC.has(cid)) { orphanC++; rep.reject(line, cid, `clientId "${cid}" does not exist`); return; }
    if (!knownA.has(aid)) { orphanA++; rep.reject(line, aid, `agentId "${aid}" does not exist — import agents first`); return; }

    // Outcome is never defaulted by guessing. If it is unreadable the row is
    // rejected: inventing "showed" for an unparseable value would inflate the
    // headline show rate with rows nobody verified.
    const outcome = I.field(rep, line, cid, 'outcome', r.outcome,
      (v) => {
        const s = String(v == null ? '' : v).trim();
        if (!s) return { ok: true, value: d.getTime() > TODAY.getTime() ? 'upcoming' : null,
                         coerced: 'blank outcome → inferred from date', reason: null };
        return I.parseEnum(s, VALID_OUTCOMES, { aliases: OUTCOME_ALIASES });
      }, { required: true });
    if (outcome === I.REQUIRED_FAIL) return;

    const value = I.field(rep, line, cid, 'value', r.value, numField, { fallback: null });
    if (value === I.REQUIRED_FAIL) return;
    rep.accept({
      t: d.getTime(), hm: parseHM(r.time, 9 * 60), bookedOn: d.getTime(), leadDays: 0,
      clientId: cid, agentId: aid, outcome,
      value: value == null ? (CLIENT_BY[cid] ? CLIENT_BY[cid].perAppt : 0) : value
    });
  });
  if (orphanC) rep.warn(`${orphanC} row(s) referenced an unknown client.`);
  if (orphanA) rep.warn(`${orphanA} row(s) referenced an unknown agent.`);
  return rep;
}

export function parseLeadsCSV(text) {
  const rep = I.createReport('leads');
  const known = new Set(CLIENTS.map(c => c.id));
  csvParse(text).forEach((r, i) => {
    const line = i + 2, id = (r.id || '').trim();
    if (!id || !(r.name || '').trim()) { rep.reject(line, id, 'id and name are both required'); return; }
    if (!known.has((r.clientid || '').trim())) {
      rep.reject(line, id, `clientId "${r.clientid}" does not exist`); return;
    }
    const d = I.field(rep, line, id, 'date', r.date, dateField, { fallback: new Date(TODAY) });
    const stage = I.field(rep, line, id, 'stage', r.stage,
      (v) => I.parseEnum(v, VALID_STAGES, { fallback: 'new', aliases: STAGE_ALIASES }));
    const value = I.field(rep, line, id, 'value', r.value, numField, { fallback: 0 });
    if (value === I.REQUIRED_FAIL) return;
    const score = I.field(rep, line, id, 'score', r.score, numField, { fallback: 50, lenient: true });
    rep.accept({
      id, name: r.name.trim(), clientId: r.clientid.trim(), stage,
      source: (r.source || '').trim() || 'Unknown',
      value: Math.max(0, value || 0),
      score: clamp(Math.round(score == null ? 50 : score), 0, 100),
      t: d.getTime()
    });
  });
  I.findDuplicates(rep.accepted, (r) => r.id).forEach(d =>
    rep.warn(`Duplicate lead id "${d.key}" — the later row wins on lookup.`));
  return rep;
}


/* Renders an ingest report. Rejections and coercions are shown separately
   and in full (capped for display) — an import that silently drops rows is
   how a dashboard ends up confidently wrong. */
export function renderImportReport(rep) {
  const s = rep.summary;
  if (s.clean && !s.warnings) return '';
  const cap = (arr, n) => arr.length > n
    ? arr.slice(0, n).concat([{ __more: arr.length - n }]) : arr;
  let out = '<div class="import-detail">';

  out += '<div class="import-tally">'
    + '<span class="pill grow">' + s.accepted + ' accepted</span>'
    + (s.rejected ? '<span class="pill risk">' + s.rejected + ' rejected</span>' : '')
    + (s.coerced ? '<span class="pill watch">' + s.coerced + ' cleaned</span>' : '')
    + (s.warnings ? '<span class="pill off">' + s.warnings + ' warnings</span>' : '')
    + '</div>';

  if (rep.rejected.length) {
    out += '<div class="import-group"><b>Rejected — not imported</b><ul>'
      + cap(rep.rejected, 12).map(x => x.__more
          ? '<li class="more">+' + x.__more + ' more</li>'
          : '<li>Line ' + x.line + (x.id ? ' <code>' + esc(x.id) + '</code>' : '') + ' — ' + esc(x.reason) + '</li>'
        ).join('') + '</ul></div>';
  }
  if (rep.coercions.length) {
    // Grouped by field+note so 400 identical currency-symbol strips read as
    // one line rather than 400.
    const groups = new Map();
    rep.coercions.forEach(c => {
      const k = c.field + ' · ' + c.note;
      groups.set(k, (groups.get(k) || 0) + 1);
    });
    out += '<div class="import-group"><b>Cleaned automatically</b><ul>'
      + [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([k, n]) => '<li>' + esc(k) + ' <span class="more">×' + n + '</span></li>').join('')
      + '</ul></div>';
  }
  if (rep.warnings.length) {
    out += '<div class="import-group"><b>Warnings</b><ul>'
      + cap(rep.warnings, 8).map(w => w.__more
          ? '<li class="more">+' + w.__more + ' more</li>' : '<li>' + esc(w) + '</li>').join('')
      + '</ul></div>';
  }
  return out + '</div>';
}

/* Mutating the seed consts in place (rather than reassigning) because every
   render function, drawer, and cache closed over these exact array/object
   references at load time — a reassignment would leave all of them pointing
   at the old, stale data. */
export function reindexAll() {
  // Index rebuild + window rebuild + cache clear must happen together. The
  // caches now live in ./aggregates.js, so this delegates rather than reaching
  // across the module boundary at the private Map objects — which would have
  // thrown a ReferenceError on the first CSV import after the extraction.
  reindex();
  resetCaches();
  state._insightCount = null;
  clearInsightCache();
}

export function replaceClients(rows) { CLIENTS.length = 0; rows.forEach(r => CLIENTS.push(r)); reindexAll(); }
export function replaceAgents(rows)  { AGENTS.length = 0; rows.forEach(r => AGENTS.push(r)); reindexAll(); }
export function replaceAppts(rows)   { APPTS.length = 0; rows.forEach(r => APPTS.push(r)); reindexAll(); }
export function replaceLeads(rows)   { LEADS.length = 0; rows.forEach(r => LEADS.push(r)); LEADS.sort((a, b) => b.t - a.t); reindexAll(); }

/* ---- Sheets read-sync: a GET against a "Publish to web ▸ CSV" URL ---- */
export const DS_KEY = 'gms.datasource.v1';
export const DS_DEFAULT = {mode: 'demo', sheets: {clients: '', agents: '', appts: '', leads: ''}, intervalMs: 86400000, lastSynced: null, dayFirst: null};
export let DS = Object.assign({}, DS_DEFAULT, {sheets: Object.assign({}, DS_DEFAULT.sheets)});
try {
  const savedDS = JSON.parse(localStorage.getItem(DS_KEY) || 'null');
  if (savedDS && typeof savedDS === 'object') {
    if (savedDS.mode === 'demo' || savedDS.mode === 'sheets') DS.mode = savedDS.mode;
    if (savedDS.sheets) Object.keys(DS.sheets).forEach(k => { if (typeof savedDS.sheets[k] === 'string') DS.sheets[k] = savedDS.sheets[k]; });
    if (Number.isFinite(savedDS.intervalMs) && savedDS.intervalMs >= 0) DS.intervalMs = savedDS.intervalMs;
    if (Number.isFinite(savedDS.lastSynced)) DS.lastSynced = savedDS.lastSynced;
    if (savedDS.dayFirst === true || savedDS.dayFirst === false) DS.dayFirst = savedDS.dayFirst;
  }
} catch (_) {}
export const saveDS = () => { try { localStorage.setItem(DS_KEY, JSON.stringify(DS)); } catch (_) {} };

export let syncTimer = null;
export function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (DS.mode === 'sheets' && DS.intervalMs > 0) syncTimer = setInterval(() => { syncFromSheets(); }, DS.intervalMs);
}
export async function fetchSheetCSV(url) {
  const r = await fetch(url, {cache: 'no-store'});
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
/* Order matters: clients before agents/appointments/leads, so foreign-key
   validation in the parsers above has something real to check against
   instead of rejecting every row on the first sync. */
export async function syncFromSheets() {
  const order = ['clients', 'agents', 'appts', 'leads'];
  const parsers = {clients: parseClientsCSV, agents: parseAgentsCSV, appts: parseAppointmentsCSV, leads: parseLeadsCSV};
  const applyFns = {clients: replaceClients, agents: replaceAgents, appts: replaceAppts, leads: replaceLeads};
  const report = {};
  for (const kind of order) {
    const url = DS.sheets[kind];
    if (!url) continue;
    try {
      const text = await fetchSheetCSV(url);
      const rep = parsers[kind](text);
      if (rep.accepted.length) applyFns[kind](rep.accepted);
      report[kind] = {
        ok: rep.accepted.length,
        errors: rep.rejected.map(x => `Line ${x.line}${x.id ? ' (' + x.id + ')' : ''}: ${x.reason}`)
                  .concat(rep.warnings),
        coerced: rep.coercions.length
      };
    } catch (e) {
      report[kind] = {ok: 0, errors: ['Fetch failed: ' + e.message]};
    }
  }
  DS.lastSynced = Date.now();
  saveDS();
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('css:data-replaced'));
  }
  return report;
}


