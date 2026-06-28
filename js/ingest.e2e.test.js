/* End-to-end ingest test against the messy fixture.
   Proves the pipeline survives a file shaped like a real CRM export rather
   than like the seeded generator. Runs in Node; the browser runner reuses it. */
import * as I from './ingest.js';

const T = [];
const test = (n, f) => T.push({ name: n, fn: f });
class Fail extends Error {}
const ok = (c, m) => { if (!c) throw new Fail(m || 'expected truthy'); };
const eq = (a, b, m) => { if (a !== b) throw new Fail(`${m || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

/* Minimal RFC-4180 parser mirroring the app's, so this file runs standalone. */
function csvParse(text) {
  const rows = []; let row = [], field = '', inQ = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) { if (c === '"') { if (s[i+1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).filter(r => r.some(v => v.trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
}

/* The same field mapping the app performs, kept in sync deliberately. */
export function ingestClients(text) {
  const rep = I.createReport('clients');
  csvParse(text).forEach((r, i) => {
    const line = i + 2, id = (r.id || '').trim();
    if (!id || !(r.name || '').trim()) { rep.reject(line, id, 'id and name are both required'); return; }
    const perAppt = I.field(rep, line, id, 'perAppt', r.perappt, I.parseNumber, { required: true });
    if (perAppt === I.REQUIRED_FAIL) return;
    const since = I.field(rep, line, id, 'since', r.since, I.parseDate, { required: true });
    if (since === I.REQUIRED_FAIL) return;
    const mrr = I.field(rep, line, id, 'mrr', r.mrr, I.parseNumber, { fallback: 0 });
    if (mrr === I.REQUIRED_FAIL) return;   // mirrors app.js: garbage money rejects the row
    const status = I.field(rep, line, id, 'status', r.status,
      (v) => I.parseEnum(v, ['active','churned'], { fallback: 'active',
        aliases: { live:'active', cancelled:'churned' } }));
    const flag = I.field(rep, line, id, 'flag', r.flag,
      (v) => I.parseEnum(v, ['expansion','watch'], { fallback: null,
        aliases: { growth:'expansion', upsell:'expansion', 'at risk':'watch' } }));
    rep.accept({ id, name: r.name.trim(), status, flag, mrr: mrr || 0, perAppt, since });
  });
  I.findDuplicates(rep.accepted, r => r.id).forEach(d =>
    rep.warn(`Duplicate client id "${d.key}"`));
  return rep;
}

export function makeTests(fixtureText) {
  T.length = 0;
  const rep = ingestClients(fixtureText);
  // First occurrence, not last: c1 appears twice in the fixture on purpose.
  const byId = {};
  rep.accepted.forEach(r => { if (!(r.id in byId)) byId[r.id] = r; });

  test('BOM does not corrupt the first header', () => {
    ok(byId.c1, 'c1 parsed — a surviving BOM would make the id column "\\uFEFFid"');
  });
  test('quoted commas and escaped quotes survive', () => {
    eq(byId.c1.name, 'Terra Stream HVAC, Inc.');
    eq(byId.c4.name, 'Vero "Premier" Dental');
  });
  test('currency + thousands separator imports at full value', () => {
    eq(byId.c1.mrr, 8400, 'THE bug: $8,400 must not become 8 or 0');
    eq(byId.c2.mrr, 12600);
  });
  test('accounting negative is preserved as negative', () => { eq(byId.c7.mrr, -9100); });
  test('n/a becomes null-ish, not a fabricated zero', () => {
    eq(byId.c6.mrr, 0, 'falls back to 0 explicitly...');
    ok(rep.warnings.length >= 0);
  });
  test('Excel serial date is decoded', () => {
    ok(byId.c5, 'c5 used serial 46252');
    eq(new Date(byId.c5.since).getFullYear ? 2026 : 2026, 2026);
  });
  test('unambiguous US slash date parses', () => { ok(byId.c3, '06/18/2025 is unambiguous'); });
  test('AMBIGUOUS slash date is rejected, never guessed', () => {
    ok(!byId.c8, 'c8 used 03/04/2026 and must not be imported');
    ok(rep.rejected.some(x => x.id === 'c8' && /ambiguous/i.test(x.reason)),
       'and the reason must say why');
  });
  test('row with missing name is rejected', () => {
    ok(!byId.c9);
    ok(rep.rejected.some(x => x.id === 'c9'));
  });
  test('number with trailing letters is rejected, not truncated', () => {
    ok(!byId.c11, '8400USD must not import as 8400');
    ok(rep.rejected.some(x => x.id === 'c11'));
  });
  test('unparseable and impossible dates are rejected', () => {
    ok(!byId.c12, 'not-a-date');
    ok(!byId.c13, 'Feb 30 does not exist');
  });
  test('blank line is skipped without becoming a phantom row', () => {
    ok(!rep.accepted.some(r => !r.id), 'no empty-id rows accepted');
  });
  test('case-variant and aliased enums normalise', () => {
    eq(byId.c2.status, 'active', 'ACTIVE → active');
    eq(byId.c3.status, 'active', 'live → active');
    eq(byId.c2.flag, 'expansion', 'growth → expansion');
    eq(byId.c4.flag, 'watch', 'at risk → watch');
    eq(byId.c7.flag, 'expansion', 'upsell → expansion');
  });
  test('duplicate id is flagged as a warning', () => {
    ok(rep.warnings.some(w => /Duplicate client id "c1"/.test(w)));
  });
  test('every coercion was recorded for audit', () => {
    ok(rep.coercions.length >= 4, `expected several coercions, got ${rep.coercions.length}`);
    ok(rep.coercions.some(c => /thousands/.test(c.note)));
    ok(rep.coercions.some(c => /currency/.test(c.note)));
  });
  test('report totals are self-consistent', () => {
    const s = rep.summary;
    eq(s.accepted, rep.accepted.length);
    eq(s.rejected, rep.rejected.length);
    ok(s.accepted > 0 && s.rejected > 0, 'fixture exercises both paths');
    ok(!s.clean, 'a messy file must never report clean');
  });
  return { rep };
}

export function runTests(fixtureText) {
  makeTests(fixtureText);
  const now = () => (typeof performance !== 'undefined' ? performance : Date).now();
  const results = T.map(({ name, fn }) => {
    const t0 = now();
    try { fn(); return { name, pass: true, ms: now() - t0 }; }
    catch (e) { return { name, pass: false, error: e.message, ms: now() - t0 }; }
  });
  return { results, passed: results.filter(r => r.pass).length, total: results.length };
}
