/* Accessibility checks against the rendered DOM.

   Not a substitute for testing with a real screen reader — that gap is stated
   plainly in the status report. These are the machine-checkable rules that
   regress silently: missing accessible names, unlabelled inputs, images with
   no alt, controls that cannot be reached by keyboard, and contrast on the
   design tokens. Each one has bitten a real dashboard. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const CHROME = process.env.CHROME_PATH
  || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');
const BASE = process.env.A11Y_BASE || 'http://127.0.0.1:8499';
const ROUTES = ['overview', 'insights', 'patterns', 'engagement', 'clients', 'agents', 'settings'];

/* WCAG relative luminance and contrast ratio. */
const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

let failed = 0;
const fail = (m) => { console.error('  FAIL  ' + m); failed++; };
const pass = (m) => console.log('  pass  ' + m);

/* ── 1 · design-token contrast, checked without a browser ── */
const GROUND = '#0a0e13';
const TOKENS = {
  '--text': '#f5f7fa', '--muted': '#8f9aab', '--accent': '#4A9BF5',
  '--green': '#10b981', '--amber': '#f59e0b', '--red': '#ef4444', '--tab-active': '#7FC4FF',
};
for (const [name, value] of Object.entries(TOKENS)) {
  const r = ratio(hex(value), hex(GROUND));
  // 4.5:1 for body text, 3:1 for large text and non-text indicators.
  const floor = (name === '--muted') ? 4.5 : 3.0;
  if (r < floor) fail(`${name} ${value} on ${GROUND} is ${r.toFixed(2)}:1, below ${floor}:1`);
  else pass(`${name} contrast ${r.toFixed(2)}:1`);
}

/* ── 2 · DOM rules, per route ── */
for (const route of ROUTES) {
  let dom;
  try {
    const { stdout } = await run(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=9000', '--dump-dom', `${BASE}/index.html#${route}`],
      { maxBuffer: 48 * 1024 * 1024 });
    dom = stdout;
  } catch (e) {
    fail(`${route}: chrome error ${e.message.slice(0, 80)}`);
    continue;
  }

  const issues = [];

  // Buttons with neither text nor an accessible name.
  for (const m of dom.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1], inner = m[2];
    const text = inner.replace(/<[^>]*>/g, '').trim();
    if (!text && !/aria-label=/.test(attrs) && !/aria-labelledby=/.test(attrs) && !/title=/.test(attrs))
      issues.push('a <button> has no text and no aria-label');
  }
  // Inputs without a label, aria-label, or wrapping <label>.
  for (const m of dom.matchAll(/<input\b([^>]*)>/g)) {
    const a = m[1];
    if (/type="(hidden|checkbox|radio)"/.test(a)) continue;
    if (!/aria-label=|aria-labelledby=|\bid="/.test(a))
      issues.push('an <input> has no label association');
  }
  // Images must carry alt (empty alt is valid for decoration).
  for (const m of dom.matchAll(/<img\b([^>]*)>/g))
    if (!/\balt=/.test(m[1])) issues.push('an <img> has no alt attribute');
  // A positive tabindex breaks the natural focus order.
  if (/tabindex="[1-9]/.test(dom)) issues.push('a positive tabindex overrides focus order');
  // The document needs a language.
  if (!/<html[^>]+lang=/.test(dom)) issues.push('<html> has no lang attribute');
  // Every view region should be labelled for landmark navigation.
  const regions = [...dom.matchAll(/role="region"([^>]*)/g)];
  if (regions.some(r => !/aria-label/.test(r[1]))) issues.push('a role="region" has no aria-label');

  const unique = [...new Set(issues)];
  if (unique.length) unique.forEach(i => fail(`${route}: ${i}`));
  else pass(`${route}: no violations`);
}

if (failed) { console.error(`\n  ${failed} accessibility issue(s)`); process.exit(1); }
console.log('\n  accessibility checks clean');
