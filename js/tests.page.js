/* Extracted from tests.html. The server sends a strict CSP with
   script-src 'self' and no inline allowance, so inline <script> is blocked
   by design — that policy is the point, and the fix is to ship real files
   rather than punch an 'unsafe-inline' hole through it. */
import { runTests as runAnalytics } from '/js/analytics.test.js';
import { runTests as runIngest } from '/js/ingest.test.js';
import { runTests as runE2E } from '/js/ingest.e2e.test.js';
import { runTests as runAggregates } from '/js/aggregates.test.js';

const esc = (s) => String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const render = (id, r) => {
  document.getElementById('rows-' + id).innerHTML = r.results.map(x =>
    '<div class="row"><span class="dot ' + (x.pass ? 'pass' : 'fail') + '"></span>' +
    '<span class="nm">' + esc(x.name) + '</span><span class="ms">' + x.ms.toFixed(2) + 'ms</span></div>' +
    (x.pass ? '' : '<div class="err">' + esc(x.error) + '</div>')).join('');
  const el = document.getElementById('s-' + id);
  el.textContent = r.passed + '/' + r.total;
  el.style.color = r.passed === r.total ? 'var(--green)' : 'var(--red)';
};

const suites = [];
suites.push(['an', runAnalytics()]);
suites.push(['ag', runAggregates()]);
suites.push(['in', runIngest()]);

// The messy fixture is fetched rather than inlined so the suite tests the
// real file the app ships, not a copy that can drift away from it.
let e2e = { results: [{ name: 'fixture loads', pass: false, ms: 0, error: 'not run' }], passed: 0, total: 1 };
try {
  const res = await fetch('/fixtures/messy-clients.csv');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  e2e = runE2E(await res.text());
} catch (err) {
  e2e = { results: [{ name: 'messy fixture loads', pass: false, ms: 0, error: String(err) }], passed: 0, total: 1 };
}
suites.push(['e2', e2e]);

suites.forEach(([id, r]) => render(id, r));
const passed = suites.reduce((s, [, r]) => s + r.passed, 0);
const total = suites.reduce((s, [, r]) => s + r.total, 0);
const okAll = passed === total;
document.getElementById('score').textContent = passed + '/' + total;
document.getElementById('score').style.color = okAll ? 'var(--green)' : 'var(--red)';
document.getElementById('barfill').style.width = (passed / total * 100) + '%';
document.getElementById('summary').innerHTML = okAll
  ? 'All suites pass. ' + suites.map(([, r]) => r.total).join(' + ') + ' assertions across analytics, ingest and end-to-end import.'
  : (total - passed) + ' failing.';
document.title = (okAll ? '\u2713 ' : '\u2717 ') + passed + '/' + total + ' \u00b7 tests';
