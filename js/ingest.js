/* ═══════════════════════════════════════════════════════════════════════════
   Opsdeck — ingest layer
   ═══════════════════════════════════════════════════════════════════════════
   Pure functions for turning a real-world CSV export into validated rows.
   No DOM, no globals — so it can be unit tested, which is the whole point.

   Why this exists as its own module:
   The seeded case-study data is clean by construction. Real CRM and
   spreadsheet exports are not, and the failure mode is not a crash — it is
   silent corruption. `parseFloat("8,400")` returns 8. An $8,400 retainer
   becomes $8, no error is raised, and every margin figure downstream is
   quietly wrong. `parseFloat("$8,400")` returns NaN, which the old code
   coerced to 0. Both of those shipped.

   The contract here is: coerce what is unambiguously recoverable, record
   every coercion so a human can audit it, and REJECT anything ambiguous
   rather than guessing. A row that is silently wrong is worse than a row
   that is loudly missing.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ───────────────────────────── numbers ───────────────────────────── */

const CURRENCY = /[$£€¥₹]/g;
const NULLISH = new Set(['', '-', '–', '—', 'n/a', 'na', 'null', 'nil', 'none', '#n/a', 'undefined']);

/**
 * Parse a number out of a spreadsheet cell.
 * Handles: currency symbols, thousands separators, accounting negatives
 * "(1200)", trailing/leading whitespace, percentages (returned as the
 * fraction), explicit blanks. Rejects anything with leftover letters rather
 * than silently truncating — "8400USD" is a data problem, not a number.
 *
 * @returns {{ok:boolean, value:number|null, coerced:string|null, reason:string|null}}
 */
export function parseNumber(raw, { percentAsFraction = true } = {}) {
  const s0 = String(raw == null ? '' : raw).trim();
  if (NULLISH.has(s0.toLowerCase())) return { ok: true, value: null, coerced: null, reason: null };

  let s = s0;
  const notes = [];

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); notes.push('accounting negative'); }

  if (CURRENCY.test(s)) { s = s.replace(CURRENCY, ''); notes.push('currency symbol'); }
  CURRENCY.lastIndex = 0;

  let isPercent = false;
  if (s.trim().endsWith('%')) { isPercent = true; s = s.replace(/%\s*$/, ''); notes.push('percent'); }

  // Thousands separators. Only strip commas that sit in a grouping position;
  // "1,5" is not 15 in any locale we can safely assume, so it is rejected.
  if (s.includes(',')) {
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s.trim())) {
      s = s.replace(/,/g, '');
      notes.push('thousands separator');
    } else {
      return { ok: false, value: null, coerced: null,
               reason: `ambiguous comma in "${s0}" — not a thousands grouping` };
    }
  }

  s = s.replace(/\s+/g, '').trim();
  if (s === '' || s === '-') return { ok: true, value: null, coerced: null, reason: null };

  if (!/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) {
    return { ok: false, value: null, coerced: null, reason: `"${s0}" is not a number` };
  }

  let v = Number(s);
  if (!Number.isFinite(v)) return { ok: false, value: null, coerced: null, reason: `"${s0}" is not finite` };
  if (negative) v = -v;
  if (isPercent && percentAsFraction) v = v / 100;

  return { ok: true, value: v, coerced: notes.length ? notes.join(' + ') : null, reason: null };
}

/* ───────────────────────────── dates ───────────────────────────── */

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const SLASH = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);   // Excel's day 0, incl. its 1900 leap bug offset

const mkLocal = (y, m, d) => {
  // Built from components, never `new Date("YYYY-MM-DD")`, which parses as UTC
  // midnight and then shifts the calendar date by one for any zone east of UTC.
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) ? dt : null;
};

/**
 * Parse a date cell.
 * Accepts ISO (YYYY-MM-DD), unambiguous slash formats, and Excel serial
 * numbers. Explicitly REJECTS ambiguous slash dates like 03/04/2026, where
 * US and European readings disagree and guessing silently shifts a whole
 * quarter of appointments. `dayFirst` resolves them when the caller knows.
 */
export function parseDate(raw, { dayFirst = null } = {}) {
  const s = String(raw == null ? '' : raw).trim();
  if (NULLISH.has(s.toLowerCase())) return { ok: true, value: null, coerced: null, reason: null };

  const iso = ISO.exec(s);
  if (iso) {
    const d = mkLocal(+iso[1], +iso[2], +iso[3]);
    return d ? { ok: true, value: d, coerced: null, reason: null }
             : { ok: false, value: null, coerced: null, reason: `"${s}" is not a real calendar date` };
  }

  const sl = SLASH.exec(s);
  if (sl) {
    const a = +sl[1], b = +sl[2], y = +sl[3];
    const aIsDay = a > 12, bIsDay = b > 12;
    if (aIsDay && bIsDay) return { ok: false, value: null, coerced: null, reason: `"${s}" has no valid month` };
    let day, mon, note;
    if (aIsDay)       { day = a; mon = b; note = 'D/M/Y inferred'; }
    else if (bIsDay)  { day = b; mon = a; note = 'M/D/Y inferred'; }
    else if (dayFirst === true)  { day = a; mon = b; note = 'D/M/Y per setting'; }
    else if (dayFirst === false) { day = b; mon = a; note = 'M/D/Y per setting'; }
    else return { ok: false, value: null, coerced: null,
                  reason: `"${s}" is ambiguous — could be ${a}/${b} or ${b}/${a}. Use YYYY-MM-DD or set a date order.` };
    const d = mkLocal(y, mon, day);
    return d ? { ok: true, value: d, coerced: note, reason: null }
             : { ok: false, value: null, coerced: null, reason: `"${s}" is not a real calendar date` };
  }

  // Excel serial. Bounded to 1990-2100 so a stray quantity column does not
  // get quietly reinterpreted as a date.
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n >= 32874 && n <= 73415) {
      const utc = new Date(EXCEL_EPOCH + n * 86400000);
      const d = mkLocal(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
      if (d) return { ok: true, value: d, coerced: 'Excel serial date', reason: null };
    }
    return { ok: false, value: null, coerced: null, reason: `"${s}" is a bare number, not a date` };
  }

  return { ok: false, value: null, coerced: null, reason: `"${s}" is not a recognised date format` };
}

/* ───────────────────────────── enums / text ───────────────────────────── */

/** Case- and whitespace-insensitive enum match with an optional alias table. */
export function parseEnum(raw, allowed, { fallback = null, aliases = {} } = {}) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return { ok: true, value: fallback, coerced: null, reason: null };
  if (allowed.includes(s)) return { ok: true, value: s, coerced: null, reason: null };
  if (aliases[s]) return { ok: true, value: aliases[s], coerced: `"${raw}" → "${aliases[s]}"`, reason: null };
  if (fallback !== null) return { ok: true, value: fallback, coerced: `"${raw}" unrecognised → "${fallback}"`, reason: null };
  return { ok: false, value: null, coerced: null,
           reason: `"${raw}" is not one of: ${allowed.join(', ')}` };
}

/* ───────────────────────── row-set validation ───────────────────────── */

/**
 * Duplicate primary keys. A CRM export with the same id twice is common
 * (a joined query without DISTINCT) and silently produces two rows that
 * later lookups resolve inconsistently depending on iteration order.
 */
export function findDuplicates(rows, keyOf) {
  const seen = new Map(), dupes = [];
  rows.forEach((r, i) => {
    const k = keyOf(r);
    if (k == null || k === '') return;
    if (seen.has(k)) dupes.push({ key: k, first: seen.get(k), duplicate: i });
    else seen.set(k, i);
  });
  return dupes;
}

/** Rows whose foreign key does not resolve against a known key set. */
export function findOrphans(rows, fkOf, knownKeys) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys);
  const orphans = [];
  rows.forEach((r, i) => {
    const fk = fkOf(r);
    if (fk != null && fk !== '' && !known.has(fk)) orphans.push({ index: i, key: fk });
  });
  return orphans;
}

/* ───────────────────────── report accumulator ───────────────────────── */

/**
 * Collects the outcome of an import so the UI can show what happened to
 * every row, instead of a bare "imported 412 rows" that hides the 38 that
 * were quietly dropped.
 */
export function createReport(kind) {
  return {
    kind, accepted: [], rejected: [], coercions: [], warnings: [],
    reject(line, id, reason) { this.rejected.push({ line, id, reason }); },
    coerce(line, field, note) { this.coercions.push({ line, field, note }); },
    warn(message) { this.warnings.push(message); },
    accept(row) { this.accepted.push(row); },
    get summary() {
      return {
        kind: this.kind,
        accepted: this.accepted.length,
        rejected: this.rejected.length,
        coerced: this.coercions.length,
        warnings: this.warnings.length,
        clean: this.rejected.length === 0 && this.coercions.length === 0
      };
    }
  };
}

/**
 * Read one field through a parser, recording coercions and rejections.
 * Returns the value, or REQUIRED_FAIL if the row must be rejected.
 * Unparseable values reject by default; pass `lenient` to downgrade to a
 * warning. Blank values take `fallback` unless `required`.
 */
export const REQUIRED_FAIL = Symbol('required-fail');

export function field(report, line, id, name, raw, parser,
                      { required = false, fallback = null, lenient = false } = {}) {
  const r = parser(raw);
  if (!r.ok) {
    // An UNPARSEABLE value rejects the row even when the field is optional.
    // This is the whole point of the module: "8400USD" in an mrr column is a
    // value we know exists and cannot read. Falling back to 0 there does not
    // lose a field, it loses $8,400 of revenue silently — the same class of
    // corruption as the parseFloat truncation this replaced. A genuinely
    // BLANK value is different and still takes the fallback below.
    // `lenient` opts out for fields where garbage really is ignorable.
    if (lenient) {
      report.warn(`Line ${line}${id ? ' (' + id + ')' : ''}: ${name} ignored — ${r.reason}`);
      return fallback;
    }
    report.reject(line, id, `${name}: ${r.reason}`);
    return REQUIRED_FAIL;
  }
  if (r.coerced) report.coerce(line, name, r.coerced);
  if (r.value === null || r.value === undefined) {
    if (required) { report.reject(line, id, `${name} is required but empty`); return REQUIRED_FAIL; }
    return fallback;
  }
  return r.value;
}

export const VERSION = '1.0.0';
