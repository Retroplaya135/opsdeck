/* Static checks on the ES module graph.

   Both of these caught real breakage during the split, and neither shows up
   in a syntax check: a module that calls a helper it never imported parses
   perfectly and fails only when that specific line executes — which for a
   view means only when someone navigates to it. */
import { readdirSync, readFileSync } from 'node:fs';

const files = readdirSync('js').filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
const read = (f) => readFileSync('js/' + f, 'utf8');

const exportsOf = {}, importsOf = {}, localsOf = {}, depsOf = {};
for (const f of files) {
  const s = read(f);
  exportsOf[f] = new Set([...s.matchAll(/^export\s+(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
  const imp = new Set();
  for (const m of s.matchAll(/import \{([^}]*)\} from '\.\/([A-Za-z0-9._-]+)'/g))
    for (const n of m[1].split(',')) { const t = n.trim().split(' as ').pop().trim(); if (t) imp.add(t); }
  for (const m of s.matchAll(/import \* as ([A-Za-z_$][\w$]*) from/g)) imp.add(m[1]);
  importsOf[f] = imp;
  const loc = new Set([...s.matchAll(/^(?:export\s+)?(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
  for (const m of s.matchAll(/const \{([^}]*)\}\s*=/g))
    for (const n of m[1].split(',')) { const t = n.trim(); if (t) loc.add(t); }
  localsOf[f] = loc;
  depsOf[f] = new Set([...s.matchAll(/from '\.\/([A-Za-z0-9._-]+)'/g)].map(m => m[1]));
}

let failed = 0;

// 1 · calls a helper it never imported
for (const f of files) {
  const s = read(f);
  for (const other of files) {
    if (other === f) continue;
    for (const name of exportsOf[other]) {
      if (importsOf[f].has(name) || localsOf[f].has(name)) continue;
      if (new RegExp(`(?<![\\w.$'"])${name}\\s*\\(`).test(s)) {
        console.error(`  FAIL  ${f} calls ${name}() from ${other} without importing it`);
        failed++;
      }
    }
  }
}

// 2 · import cycles
const seen = new Set();
function walk(node, path) {
  if (path.includes(node)) {
    console.error(`  FAIL  import cycle: ${[...path.slice(path.indexOf(node)), node].join(' -> ')}`);
    failed++;
    return;
  }
  if (seen.has(node)) return;
  seen.add(node);
  for (const d of depsOf[node] || []) walk(d, [...path, node]);
}
for (const f of files) walk(f, []);

if (failed) process.exit(1);
console.log(`module graph clean: ${files.length} modules, no missing imports, no cycles`);
