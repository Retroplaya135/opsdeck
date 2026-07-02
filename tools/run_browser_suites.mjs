/* Drive the browser suites headlessly for CI.
   Uses Chrome's own --dump-dom after the suites have settled, then asserts on
   the document title, which each runner sets to "✓ n/n" or "✗ n/n". */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const CHROME = process.env.CHROME_PATH
  || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');
const BASE = process.env.BROWSER_BASE || 'http://127.0.0.1:8499';

const PAGES = [
  ['engine + ingest suites', `${BASE}/tests.html`],
  ['view smoke suite',       `${BASE}/smoke.html`],
];

let failed = 0;
for (const [label, url] of PAGES) {
  let dom = '';
  try {
    const { stdout } = await run(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=25000', '--dump-dom', url
    ], { maxBuffer: 32 * 1024 * 1024 });
    dom = stdout;
  } catch (e) {
    console.error(`  FAIL  ${label} — chrome error: ${e.message}`);
    failed++;
    continue;
  }
  const m = dom.match(/<title>([^<]*)<\/title>/);
  const title = m ? m[1].trim() : '(no title)';
  if (title.includes('✓')) {
    console.log(`  pass  ${label} — ${title}`);
  } else {
    console.error(`  FAIL  ${label} — ${title}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
