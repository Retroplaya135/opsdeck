#!/usr/bin/env node
/* Parse every browser module the way the browser will.

   This exists because a duplicate `function renderEvaluationOverview` was
   introduced by an edit and reached the browser. Nothing caught it:
   `check_modules.mjs` reads the import graph, not the syntax; the smoke suite
   drives the app, but the app never started, so it had nothing to assert on;
   and the error boundary is inside app.js, which had itself failed to parse.
   The whole page was blank and every automated gate was green.

   A SyntaxError here is a hard failure. Anything else — `document is not
   defined`, a missing DOM API — means the file parsed and then hit the
   runtime, which is the expected outcome for a module written for a browser.
*/
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || 'js');
const files = readdirSync(dir).filter(f => f.endsWith('.js')).sort();
const failures = [];

for (const f of files) {
  try {
    await import(pathToFileURL(join(dir, f)).href);
  } catch (err) {
    if (err instanceof SyntaxError) {
      failures.push({ f, message: err.message });
      console.log('  SYNTAX  ' + f + ' — ' + err.message);
      continue;
    }
    console.log('  ok      ' + f + '  (parsed; runtime: ' + String(err.message).split('\n')[0] + ')');
    continue;
  }
  console.log('  ok      ' + f);
}

if (failures.length) {
  console.error('\n' + failures.length + ' module(s) would not parse in a browser');
  process.exit(1);
}
console.log('\nall ' + files.length + ' modules parse');
