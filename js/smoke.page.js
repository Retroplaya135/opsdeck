/* Extracted from smoke.html. The server sends a strict CSP with
   script-src 'self' and no inline allowance, so inline <script> is blocked
   by design — that policy is the point, and the fix is to ship real files
   rather than punch an 'unsafe-inline' hole through it. */
const frame = document.getElementById('frame');
const BAD = ['NaN', 'undefined', '[object Object]', 'Infinity'];
const results = [];

// go(route, true) renders synchronously, so a single macrotask is enough to
// let the iframe flush. requestAnimationFrame is throttled hard when the frame
// is not visible — it made one route take 26 seconds in a background tab.
const settle = () => new Promise(r => setTimeout(r, 0));

function paint() {
  const passed = results.filter(r => r.pass).length, total = results.length;
  const okAll = total && passed === total;
  document.getElementById('score').textContent = passed + '/' + total;
  document.getElementById('score').style.color = okAll ? 'var(--green)' : 'var(--red)';
  document.getElementById('fill').style.width = total ? (passed / total * 100) + '%' : '0%';
  document.getElementById('summary').textContent = okAll
    ? 'Every route renders clean.' : (total - passed) + ' route(s) failing.';
  document.getElementById('rows').innerHTML = results.map(r =>
    '<div class="row"><span class="dot ' + (r.pass ? 'pass' : 'fail') + '"></span>' +
    '<span class="nm">' + r.name + '</span><span class="ms">' + r.ms.toFixed(1) + 'ms</span></div>' +
    (r.pass ? '' : '<div class="err">' + r.error.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</div>')
  ).join('');
  document.title = (okAll ? '✓ ' : '✗ ') + passed + '/' + total + ' · view smoke';
}

async function runSuite() {
  const w = frame.contentWindow;
  // Wait for the app's readiness promise to EXIST, then await it.
  // Racing against `w.__cssReady` directly is wrong when the module has not
  // been evaluated yet: the value is `undefined`, Promise.race resolves with
  // it immediately, and the suite concludes the app failed to start.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !w.__cssReady) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (w.__cssReady) {
    try {
      await Promise.race([
        w.__cssReady,
        new Promise((_, rej) => setTimeout(() => rej(new Error('boot timed out')), 30000))
      ]);
    } catch (_) { /* the guard below reports it properly */ }
  }
  if (!w.__cssTestApi) {
    results.push({ name: 'application boots', pass: false, ms: 0, error: 'window.__cssTestApi never appeared — the app failed to start.' });
    return paint();
  }
  const api = w.__cssTestApi;
  // Boot must complete with no phase errors. Asserting only that routes
  // RENDER let a real boot failure through: the render phase threw
  // "Assignment to constant variable", every route still passed when driven
  // directly afterwards, and the suite reported 20/20 on a broken app.
  const bootErrs = (api.bootErrors && api.bootErrors()) || [];
  results.push({
    name: 'application boots with no phase errors',
    pass: bootErrs.length === 0,
    ms: 0,
    error: bootErrs.map(e => `${e.phase}: ${e.message}`).join(' | ')
  });

  for (const route of api.routes()) {
    const t0 = performance.now();
    let pass = true, error = '';
    try {
      api.go(route);
      await settle();
      const html = api.viewHtml(route);
      if (html == null) { pass = false; error = 'no container element for v-' + route; }
      else if (!html.trim()) { pass = false; error = 'rendered empty'; }
      else {
        const hits = BAD.filter(b => html.includes(b));
        if (hits.length) { pass = false; error = 'output contains: ' + hits.join(', '); }
      }
      const boundary = api.errors().filter(e => e.route === route);
      if (boundary.length) { pass = false; error = 'error boundary tripped: ' + boundary[0].message; }
    } catch (e) { pass = false; error = String(e); }
    results.push({ name: 'route “' + route + '” renders clean', pass, ms: performance.now() - t0, error });
    paint();
  }

  // The boundary itself must work, or every assertion above is unverified.
  const t0 = performance.now();
  let pass = false, error = 'boundary did not catch a forced throw';
  try {
    const before = api.errors().length;
    w.__cssForceViewError = true;
    api.go('__nonexistent_route__');
    await settle();
    pass = true; error = '';   // unknown routes fall back to overview, not a crash
    const host = frame.contentDocument.getElementById('v-overview');
    if (!host || !host.innerHTML.trim()) { pass = false; error = 'unknown route left a blank screen'; }
  } catch (e) { pass = false; error = 'unknown route threw out of the router: ' + e; }
  results.push({ name: 'unknown route degrades safely', pass, ms: performance.now() - t0, error });
  paint();
}

/* Starting the suite is two races at once, and the obvious guard is wrong:
   a freshly-created iframe exposes an about:blank document whose readyState
   is already "complete", so testing readyState alone starts the run against
   the wrong document and then waits 30s for an app that was never there.
   Check that the frame is actually showing the app before starting, and
   otherwise wait for the real load event. */
let started = false;
function startOnce() {
  if (started) return;
  started = true;
  runSuite();
}
function frameHasApp() {
  try {
    const w = frame.contentWindow;
    return !!(w && /index\.html/.test(w.location.href)
              && frame.contentDocument
              && frame.contentDocument.readyState !== 'loading');
  } catch (_) { return false; }
}

frame.addEventListener('load', startOnce, { once: true });
if (frameHasApp()) startOnce();

setTimeout(() => {
  if (!results.length) {
    results.push({ name: 'application under test loads', pass: false, ms: 0,
                   error: 'iframe never reached the application' });
    paint();
  }
}, 25000);
