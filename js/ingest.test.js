/* Known-answer tests for the ingest layer.
   These encode the real-world failure modes that shipped before this module
   existed — silent thousands-separator truncation, NaN-to-zero coercion,
   ambiguous dates, duplicate keys, orphaned foreign keys. */
import * as I from './ingest.js';

const T = [];
const test = (n, f) => T.push({ name: n, fn: f });
class Fail extends Error {}
const ok = (c, m) => { if (!c) throw new Fail(m || 'expected truthy'); };
const eq = (a, b, m) => { if (a !== b) throw new Fail(`${m || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

/* ── the bug this module was written for ── */
test('thousands separators no longer truncate (the $8,400 → $8 bug)', () => {
  eq(I.parseNumber('8,400').value, 8400, 'plain grouping');
  eq(I.parseNumber('$8,400').value, 8400, 'with currency');
  eq(I.parseNumber('$8,400.00').value, 8400, 'with currency and cents');
  eq(I.parseNumber('1,234,567').value, 1234567, 'multiple groups');
  // The old behaviour, asserted so a regression is unmistakable:
  eq(parseFloat('8,400'), 8, 'parseFloat still truncates — that is why this exists');
});

test('unparseable numbers reject instead of becoming zero', () => {
  ok(!I.parseNumber('8400USD').ok, 'trailing letters must reject');
  ok(!I.parseNumber('abc').ok);
  ok(!I.parseNumber('1,5').ok, 'ambiguous comma rejects rather than guessing 15 or 1.5');
  // Rejecting is the point: the old path turned each of these into 0.
});

test('blanks are null, not zero', () => {
  for (const blank of ['', '  ', 'n/a', 'N/A', '-', '—', 'null', 'none']) {
    const r = I.parseNumber(blank);
    ok(r.ok, `"${blank}" should parse`);
    eq(r.value, null, `"${blank}" must be null, not 0 — a missing MRR is not a zero MRR`);
  }
});

test('accounting negatives and percentages', () => {
  eq(I.parseNumber('(1200)').value, -1200);
  eq(I.parseNumber('($1,200.50)').value, -1200.5);
  eq(I.parseNumber('73%').value, 0.73);
  eq(I.parseNumber('73%', { percentAsFraction: false }).value, 73);
});

test('every coercion is reported, so an operator can audit it', () => {
  ok(I.parseNumber('$8,400').coerced.includes('currency'));
  ok(I.parseNumber('$8,400').coerced.includes('thousands'));
  eq(I.parseNumber('8400').coerced, null, 'clean input reports no coercion');
});

/* ── dates ── */
test('ISO dates parse to local midnight without a timezone shift', () => {
  const r = I.parseDate('2026-08-18');
  ok(r.ok);
  eq(r.value.getFullYear(), 2026); eq(r.value.getMonth(), 7); eq(r.value.getDate(), 18);
  eq(r.value.getHours(), 0, 'local midnight');
});

test('ambiguous slash dates reject rather than silently guessing', () => {
  const amb = I.parseDate('03/04/2026');
  ok(!amb.ok, '3 March vs 4 April cannot be guessed');
  ok(amb.reason.includes('ambiguous'));
  // Resolvable when one component cannot be a month:
  const us = I.parseDate('08/18/2026');
  ok(us.ok && us.value.getMonth() === 7 && us.value.getDate() === 18, 'M/D/Y inferred');
  const eu = I.parseDate('18/08/2026');
  ok(eu.ok && eu.value.getMonth() === 7 && eu.value.getDate() === 18, 'D/M/Y inferred');
  // Or when the caller states the convention:
  const forced = I.parseDate('03/04/2026', { dayFirst: true });
  ok(forced.ok && forced.value.getMonth() === 3 && forced.value.getDate() === 3, 'D/M/Y per setting');
});

test('Excel serial dates are recognised, bare numbers are not', () => {
  const r = I.parseDate('46252');                       // 2026-08-18
  ok(r.ok, 'serial in range parses');
  eq(r.value.getFullYear(), 2026);
  ok(r.coerced.includes('Excel'));
  ok(!I.parseDate('42').ok, 'a small number is a quantity, not a date');
  ok(!I.parseDate('999999').ok, 'out-of-range serial rejects');
});

test('impossible calendar dates reject', () => {
  ok(!I.parseDate('2026-02-30').ok, 'Feb 30 does not exist');
  ok(!I.parseDate('2026-13-01').ok, 'month 13 does not exist');
  ok(I.parseDate('2024-02-29').ok, 'but leap day does');
});

/* ── enums ── */
test('enums are case-insensitive with alias support', () => {
  eq(I.parseEnum('ACTIVE', ['active','churned']).value, 'active');
  eq(I.parseEnum(' Churned ', ['active','churned']).value, 'churned');
  eq(I.parseEnum('cancelled', ['showed','canceled'], { aliases: { cancelled: 'canceled' } }).value, 'canceled');
  const bad = I.parseEnum('bogus', ['active','churned']);
  ok(!bad.ok, 'unknown value with no fallback rejects');
  const fb = I.parseEnum('bogus', ['active','churned'], { fallback: 'active' });
  ok(fb.ok && fb.value === 'active' && fb.coerced, 'fallback is applied AND reported');
});

/* ── row-set integrity ── */
test('duplicate primary keys are found', () => {
  const rows = [{id:'c1'},{id:'c2'},{id:'c1'},{id:'c3'},{id:'c2'}];
  const d = I.findDuplicates(rows, r => r.id);
  eq(d.length, 2);
  eq(d[0].key, 'c1'); eq(d[0].first, 0); eq(d[0].duplicate, 2);
});

test('orphaned foreign keys are found', () => {
  const rows = [{clientId:'c1'},{clientId:'c9'},{clientId:'c2'},{clientId:''}];
  const o = I.findOrphans(rows, r => r.clientId, new Set(['c1','c2']));
  eq(o.length, 1, 'only c9 is an orphan; blank is not a broken reference');
  eq(o[0].key, 'c9');
});

/* ── report ── */
test('report tracks accepted, rejected and coerced separately', () => {
  const rep = I.createReport('clients');
  rep.accept({id:'c1'}); rep.accept({id:'c2'});
  rep.reject(5, 'c3', 'mrr: not a number');
  rep.coerce(2, 'mrr', 'currency symbol');
  rep.warn('seats ignored');
  const s = rep.summary;
  eq(s.accepted, 2); eq(s.rejected, 1); eq(s.coerced, 1); eq(s.warnings, 1);
  eq(s.clean, false);
  eq(I.createReport('x').summary.clean, true, 'an untouched report is clean');
});

test('field() rejects a required bad value and warns on an optional one', () => {
  const rep = I.createReport('clients');
  const bad = I.field(rep, 3, 'c1', 'mrr', 'abc', I.parseNumber, { required: true });
  eq(bad, I.REQUIRED_FAIL);
  eq(rep.rejected.length, 1);
  // Unparseable rejects even when optional — losing "8400USD" to a silent 0
  // is exactly the corruption this module exists to prevent.
  const strict = I.field(rep, 4, 'c2', 'mrr', 'abc', I.parseNumber, { required: false, fallback: 0 });
  eq(strict, I.REQUIRED_FAIL, 'unparseable optional field still rejects the row');
  const soft = I.field(rep, 4, 'c2', 'seats', 'abc', I.parseNumber, { fallback: 0, lenient: true });
  eq(soft, 0, 'lenient fields fall back');
  eq(rep.warnings.length, 1, 'and are warned about, not hidden');
  const empty = I.field(rep, 5, 'c3', 'mrr', '', I.parseNumber, { required: true });
  eq(empty, I.REQUIRED_FAIL, 'empty required field rejects');
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
