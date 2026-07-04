#!/usr/bin/env bash
# Single entry point for every check. Exits non-zero if anything fails, so it
# works identically on a laptop and in CI — a test suite that only runs when
# someone remembers to run it is not a test suite.
set -uo pipefail
cd "$(dirname "$0")"

export PYTHONDONTWRITEBYTECODE=1
OPSDECK_TEST_VAR="$(mktemp -d "${TMPDIR:-/tmp}/opsdeck-tests.XXXXXX")"
export OPSDECK_VAR_DIR="$OPSDECK_TEST_VAR"
OPSDECK_SERVER_PID=""
OPSDECK_STATIC_PID=""
cleanup() {
  if [ -n "$OPSDECK_SERVER_PID" ] && kill -0 "$OPSDECK_SERVER_PID" 2>/dev/null; then
    kill "$OPSDECK_SERVER_PID" 2>/dev/null || true
    wait "$OPSDECK_SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$OPSDECK_STATIC_PID" ] && kill -0 "$OPSDECK_STATIC_PID" 2>/dev/null; then
    kill "$OPSDECK_STATIC_PID" 2>/dev/null || true
    wait "$OPSDECK_STATIC_PID" 2>/dev/null || true
  fi
  rm -rf "$OPSDECK_TEST_VAR"
}
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; OFF=$'\033[0m'

step() { printf "\n${BOLD}%s${OFF}\n" "$1"; }
ok()   { printf "  ${GRN}pass${OFF}  %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  ${RED}FAIL${OFF}  %s\n" "$1"; FAIL=$((FAIL+1)); }
run()  { if eval "$2" >/tmp/ci_out 2>&1; then ok "$1"; else bad "$1"; sed 's/^/        /' /tmp/ci_out | tail -15; fi; }

step "Syntax"
for f in js/*.js; do
  cp "$f" /tmp/_c.mjs
  if node --check /tmp/_c.mjs >/dev/null 2>&1; then ok "$f"; else bad "$f"; node --check /tmp/_c.mjs 2>&1 | sed 's/^/        /'; fi
done
for f in *.py tools/*.py; do
  run "$f" "python3 -c \"import ast,pathlib; ast.parse(pathlib.Path('$f').read_text(encoding='utf-8'), filename='$f')\""
done

step "Unit suites (headless)"
node --input-type=module -e "
import('./js/analytics.test.js').then(({runTests})=>{
  const r=runTests();
  r.results.filter(x=>!x.pass).forEach(x=>console.error('  '+x.name+': '+x.error));
  console.log(r.passed+'/'+r.total);
  process.exit(r.passed===r.total?0:1);});" >/tmp/a.txt 2>&1 \
  && ok "analytics engine $(cat /tmp/a.txt)" || { bad "analytics engine"; cat /tmp/a.txt | sed 's/^/        /'; }

node --input-type=module -e "
import('./js/aggregates.test.js').then(({runTests})=>{
  const r=runTests();
  r.results.filter(x=>!x.pass).forEach(x=>console.error('  '+x.name+': '+x.error));
  console.log(r.passed+'/'+r.total);
  process.exit(r.passed===r.total?0:1);});" >/tmp/ag.txt 2>&1 \
  && ok "aggregate values $(cat /tmp/ag.txt)" || { bad "aggregate values"; cat /tmp/ag.txt | sed 's/^/        /'; }

node --input-type=module -e "
import('./js/ingest.test.js').then(({runTests})=>{
  const r=runTests();
  r.results.filter(x=>!x.pass).forEach(x=>console.error('  '+x.name+': '+x.error));
  console.log(r.passed+'/'+r.total);
  process.exit(r.passed===r.total?0:1);});" >/tmp/b.txt 2>&1 \
  && ok "ingest unit $(cat /tmp/b.txt)" || { bad "ingest unit"; cat /tmp/b.txt | sed 's/^/        /'; }

node --input-type=module -e "
Promise.all([import('./js/ingest.e2e.test.js'),import('fs')]).then(([m,fs])=>{
  const r=m.runTests(fs.readFileSync('fixtures/messy-clients.csv','utf8'));
  r.results.filter(x=>!x.pass).forEach(x=>console.error('  '+x.name+': '+x.error));
  console.log(r.passed+'/'+r.total);
  process.exit(r.passed===r.total?0:1);});" >/tmp/c.txt 2>&1 \
  && ok "messy CSV end-to-end $(cat /tmp/c.txt)" || { bad "messy CSV end-to-end"; cat /tmp/c.txt | sed 's/^/        /'; }

step "Module graph"
run "every module parses in a browser" "node tools/check_parse.mjs"
run "no missing cross-module imports, no cycles" "node tools/check_modules.mjs"

step "Database"
run "synthetic fixtures load"  "python3 tools/load_csv.py --verify"
run "migrations apply cleanly"  "python3 -c \"import db; db.migrate(); assert db.schema_version()==db.SCHEMA_VERSION\""
run "indices are used"          "python3 tools/check_indices.py"
run "referential integrity"     "python3 -c \"
import sys; sys.path.insert(0,'tools')
from load_csv import verify
p = verify()
assert not p, p\""

step "API contract"
OPSDECK_TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
export OPSDECK_PORT="$OPSDECK_TEST_PORT"
export OPSDECK_TEST_BASE="http://127.0.0.1:$OPSDECK_TEST_PORT"
python3 server.py >"$OPSDECK_TEST_VAR/server.log" 2>&1 &
OPSDECK_SERVER_PID=$!
READY=0
for _ in $(seq 1 50); do
  if python3 -c "import urllib.request; urllib.request.urlopen('$OPSDECK_TEST_BASE/healthz', timeout=1).read()" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.1
done
if [ "$READY" -eq 1 ]; then ok "isolated server starts"; else bad "isolated server starts"; tail -20 "$OPSDECK_TEST_VAR/server.log" | sed 's/^/        /'; fi
run "spec matches the running server" "python3 tools/check_api_contract.py"
kill "$OPSDECK_SERVER_PID" 2>/dev/null || true
wait "$OPSDECK_SERVER_PID" 2>/dev/null || true
OPSDECK_SERVER_PID=""

step "Security"
run "password policy rejects weak"  "python3 -c \"
import auth_store as a
for bad in ['short','1234567890','password12']:
    try: a.check_password_policy(bad); raise SystemExit('accepted '+bad)
    except a.PasswordPolicyError: pass\""
run "scope: empty set yields nothing" "python3 -c \"
import db; assert len(db.appointments(scope=set()))==0\""
run "scope: SQL-level filtering"      "python3 -c \"
import db
a=len(db.appointments(scope=None)); s=len(db.appointments(scope={'c1'}))
assert 0 < s < a, (s,a)\""
run "TLS: Secure+HSTS only under TLS" "python3 -c \"
import server
assert server.cookie_flags() == '', 'plain HTTP must not set Secure'
server.TLS_ENABLED = True
assert server.cookie_flags() == '; Secure', 'TLS must set Secure'
server.TLS_ENABLED = False\""
run "no secrets in source"            "! grep -rInE 'password[[:space:]]*=[[:space:]]*[\\\"'\\''][^\\\"'\\'']{6,}' --include='*.py' --include='*.js' . | grep -v test | grep -v 'password policy' | grep -q ."

step "Accessibility"
if command -v node >/dev/null && [ -n "${A11Y:-}" ]; then
  OPSDECK_BROWSER_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
  OPSDECK_BROWSER_BASE="http://127.0.0.1:$OPSDECK_BROWSER_PORT"
  python3 -m http.server "$OPSDECK_BROWSER_PORT" --bind 127.0.0.1 >"$OPSDECK_TEST_VAR/static.log" 2>&1 &
  OPSDECK_STATIC_PID=$!
  READY=0
  for _ in $(seq 1 50); do
    if python3 -c "import urllib.request; urllib.request.urlopen('$OPSDECK_BROWSER_BASE/tests.html', timeout=1).read()" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 0.1
  done
  if [ "$READY" -eq 1 ]; then
    run "browser suites" "BROWSER_BASE='$OPSDECK_BROWSER_BASE' node tools/run_browser_suites.mjs"
    run "contrast + DOM rules" "A11Y_BASE='$OPSDECK_BROWSER_BASE' node tools/check_a11y.mjs"
  else
    bad "isolated browser fixture server starts"
    tail -20 "$OPSDECK_TEST_VAR/static.log" | sed 's/^/        /'
  fi
  kill "$OPSDECK_STATIC_PID" 2>/dev/null || true
  wait "$OPSDECK_STATIC_PID" 2>/dev/null || true
  OPSDECK_STATIC_PID=""
else
  printf "  ${DIM}skip${OFF}  browser and accessibility checks (needs Chrome; set A11Y=1 to run)\n"
fi

step "Result"
TOTAL=$((PASS+FAIL))
if [ "$FAIL" -eq 0 ]; then
  printf "  ${GRN}%d/%d checks passed${OFF}\n\n" "$PASS" "$TOTAL"
  exit 0
else
  printf "  ${RED}%d of %d checks FAILED${OFF}\n\n" "$FAIL" "$TOTAL"
  exit 1
fi
