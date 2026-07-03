#!/usr/bin/env python3
"""
Opsdeck — authenticating, tenant-scoped application server.

Standard library only. No pip, no virtualenv: an auth gate nobody can start
is not an auth gate.

    python3 server.py                      # run (bootstraps an admin on first use)
    python3 server.py adduser jane manager c1,c2
    python3 server.py passwd jane
    python3 server.py users
    python3 server.py audit [n]

Security model
--------------
* Real accounts. PBKDF2-HMAC-SHA256, 200k rounds, per-user salt (auth_store).
* Session = HttpOnly + SameSite=Strict cookie carrying `user.expiry.hmac`,
  signed with a per-process key. HttpOnly means page JS cannot read it, so an
  XSS bug cannot exfiltrate it. The per-process key means a restart ends every
  session and no signing key is ever written to disk.
* TENANT SCOPING IS ENFORCED HERE, on read, not in the browser. A `client`
  or `manager` account literally cannot fetch rows outside its scope — the
  rows are filtered out of the CSV before the response is written. Hiding
  them in the UI instead would be a suggestion, not a control.
* Login is rate limited per IP, and failures are uniform: no distinction
  between "no such user" and "wrong password", and the missing-user path
  still runs a PBKDF2 hash so latency does not enumerate accounts.
* Every security-relevant action is appended to var/audit.jsonl.
* Strict CSP (`script-src 'self'`, no inline), traversal containment,
  dotfile refusal, and var/ + data-source files are never servable.
"""

from __future__ import annotations

import csv
import getpass
import hashlib
import hmac
import http.cookies
import io
import json
import mimetypes
import os
import secrets
import socketserver
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import api_spec
import auth_store as store
import db
import logging_setup as log

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
COOKIE_NAME = "opsdeck_session"
SESSION_TTL = 12 * 3600
PUBLIC_PATHS = {"/login", "/login.js", "/api/login", "/healthz", "/readyz",
                "/openapi.json", "/favicon.ico"}
# /metrics and /api/logs are admin-gated below, not public: request rates,
# error counts and log contents are operational detail worth protecting.
# Never servable as static files, whatever the URL says.
FORBIDDEN_DIRS = {"var", "__pycache__", "data", "tools", "fixtures"}
DEFAULT_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self' https://docs.google.com; "
    "frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'"
)
_SIGNING_KEY = secrets.token_bytes(32)

# Set once at startup. The Secure attribute must NOT be sent over plain HTTP —
# a browser drops such a cookie entirely, which would silently break login on
# a loopback dev server.
TLS_ENABLED = False


def cookie_flags() -> str:
    return "; Secure" if TLS_ENABLED else ""

# CSRF: SameSite=Strict already blocks the classic cross-site form post, but
# it is one cookie attribute and not every client honours it identically.
# A double-submit token derived from the session — sent in a readable cookie,
# echoed in a header — costs nothing and does not depend on that attribute.
CSRF_COOKIE = "opsdeck_csrf"
CSRF_HEADER = "X-CSRF-Token"


def csrf_for(session_username: str) -> str:
    return hmac.new(_SIGNING_KEY, ("csrf:" + session_username).encode(), hashlib.sha256).hexdigest()[:32]


def csrf_ok(username: str, presented: str | None) -> bool:
    return bool(presented) and hmac.compare_digest(presented, csrf_for(username))

DATASETS = {
    "clients": ("clients.csv", "id"),
    "agents": ("agents.csv", "clientid"),
    "appts": ("appointments.csv", "clientid"),
    "leads": ("leads.csv", "clientid"),
}


# ───────────────────────────── sessions ─────────────────────────────

def _sign(msg: str) -> str:
    return hmac.new(_SIGNING_KEY, msg.encode(), hashlib.sha256).hexdigest()


def issue_session(username: str) -> str:
    payload = f"{username}.{int(time.time()) + SESSION_TTL}"
    return f"{payload}.{_sign(payload)}"


def read_session(raw: str | None) -> str | None:
    """Return the username if the cookie is well-formed, signed and unexpired."""
    if not raw or raw.count(".") < 2:
        return None
    username, exp, sig = raw.rsplit(".", 2)
    if not hmac.compare_digest(sig, _sign(f"{username}.{exp}")):
        return None
    try:
        if int(exp) <= time.time():
            return None
    except ValueError:
        return None
    return username


class RateLimiter:
    def __init__(self, capacity: float, refill_per_sec: float):
        self.capacity, self.refill = capacity, refill_per_sec
        self._b: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._b.get(key, (self.capacity, now))
            tokens = min(self.capacity, tokens + (now - last) * self.refill)
            if tokens < 1:
                self._b[key] = (tokens, now)
                return False
            self._b[key] = (tokens - 1, now)
            if len(self._b) > 4096:
                cutoff = now - 3600
                self._b = {k: v for k, v in self._b.items() if v[1] > cutoff}
            return True


LOGIN_LIMITER = RateLimiter(8, 1 / 15.0)

LOGIN_PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="dark"/>
<title>Sign in · Opsdeck</title><style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e13;--text:#f5f7fa;--muted:#8f9aab;--dim:#68708a;--panel:rgba(255,255,255,.07);
--border:rgba(255,255,255,.13);--accent:#4A9BF5;--accent-ink:#04142e;
--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
body{font-family:var(--sans);background:var(--bg);color:var(--text);min-height:100vh;display:flex;
align-items:center;justify-content:center;padding:1.5rem;line-height:1.55}
body::before{content:'';position:fixed;top:-15%;left:-15%;width:65vw;height:65vh;pointer-events:none;
background:radial-gradient(ellipse,rgba(74,155,245,.20),transparent 65%)}
body::after{content:'';position:fixed;bottom:-20%;right:-15%;width:60vw;height:60vh;pointer-events:none;
background:radial-gradient(ellipse,rgba(139,92,246,.17),transparent 65%)}
.card{position:relative;z-index:1;width:100%;max-width:430px;border-radius:20px;background:var(--panel);
border:1px solid var(--border);padding:2rem 1.9rem 1.7rem;
box-shadow:inset 0 1px 0 rgba(255,255,255,.11),0 24px 60px -20px rgba(0,0,0,.9)}
.card::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
background:linear-gradient(128deg,rgba(255,255,255,.14) 0%,rgba(255,255,255,.035) 22%,transparent 46%)}
.card>*{position:relative}
.brand{display:flex;align-items:center;gap:.85rem;margin-bottom:1.6rem}
.mark{width:46px;height:46px;display:grid;place-items:center;flex-shrink:0;border-radius:12px;
background:radial-gradient(circle at 32% 24%,#6DF3BE 0%,#27CE92 46%,#0A7A54 100%);
box-shadow:0 2px 4px rgba(0,0,0,.5),0 0 14px rgba(39,206,146,.3),
inset 0 1px 1px rgba(255,255,255,.42),inset 0 -2px 5px rgba(0,0,0,.22);
font-weight:800;color:#04142e}
.wm b{display:block;font-size:1.05rem}
.wm>span{display:block;font-size:.6rem;color:var(--dim);letter-spacing:.09em;text-transform:uppercase;margin-top:.28rem}
.alt{display:flex;align-items:center;gap:.45rem;justify-content:center;margin-top:1.1rem;
font-size:.76rem;color:var(--dim)}
.alt a{color:var(--accent);text-decoration:none;font-weight:600}
.alt a:hover{text-decoration:underline}
.signup{margin-top:.85rem;padding:.7rem .85rem;border-radius:11px;font-size:.73rem;line-height:1.6;
background:rgba(74,155,245,.08);border:1px solid rgba(74,155,245,.25);color:var(--muted)}
.signup[hidden]{display:none}
label{display:block;font-size:.66rem;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
font-weight:650;margin:.85rem 0 .3rem}
input{width:100%;padding:.62rem .8rem;border-radius:11px;border:1px solid var(--border);
background:rgba(255,255,255,.04);color:var(--text);font-family:var(--mono);font-size:.85rem;outline:none}
input:focus{border-color:var(--accent)}
button{width:100%;margin-top:1.1rem;padding:.65rem;border-radius:11px;border:none;background:var(--accent);
color:var(--accent-ink);font-family:inherit;font-weight:700;font-size:.85rem;cursor:pointer}
button:hover{filter:brightness(1.1)}button:disabled{opacity:.5;cursor:default}
.err{display:none;margin-top:.85rem;padding:.6rem .8rem;border-radius:10px;font-size:.78rem;
background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#fca5a5}
.err.on{display:block}

</style></head><body>
<form class="card" id="f" autocomplete="off">
  <div class="brand">
    <div class="mark" aria-hidden="true">OD</div>
    <div class="wm">
      <b>Opsdeck</b>
      <span>Operations console</span>
    </div>
  </div>

  <label for="u">Username</label>
  <input id="u" name="username" type="text" autocomplete="username" spellcheck="false" autofocus/>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password"/>
  <button type="submit" id="b">Sign in</button>
  <div class="err" id="e"></div>

  <div class="alt">
    <span>Need access?</span>
    <a href="#" id="signupLink">Request an account</a>
  </div>
  <div class="signup" id="signupNote" hidden>
    Accounts are provisioned by your workspace administrator.
    Request one and we will confirm your role and which client accounts you are
    entitled to see before it is created.
  </div>
<script src="/login.js"></script></body></html>"""

LOGIN_JS = """document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = document.getElementById('e'), btn = document.getElementById('b');
  err.classList.remove('on'); btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        username: document.getElementById('u').value,
        password: document.getElementById('p').value
      })
    });
    if (r.ok) { window.location = '/index.html'; return; }
    err.textContent = r.status === 429
      ? 'Too many attempts. Wait a moment and try again.'
      : r.status === 423
      ? 'Account locked after too many attempts. Wait and try again.'
      : 'Those credentials are not valid.';
    err.classList.add('on');
  } catch (_) {
    err.textContent = 'Could not reach the server.';
    err.classList.add('on');
  } finally { btn.disabled = false; }
});

document.getElementById('signupLink').addEventListener('click', (ev) => {
  ev.preventDefault();
  const n = document.getElementById('signupNote');
  n.hidden = !n.hidden;
});

// The console's user menu links here with ?signup=1, so arriving from "Sign
// up" lands on the request panel already open rather than on a hidden note
// the visitor has to go looking for.
if (new URLSearchParams(location.search).get('signup') === '1') {
  document.getElementById('signupNote').hidden = false;
}"""


# ───────────────────────────── data serving ─────────────────────────────

def _rows_to_csv(headers, rows) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(headers)
    w.writerows(rows)
    return buf.getvalue()


def _day_str(ms):
    return time.strftime("%Y-%m-%d", time.localtime((ms or 0) / 1000))


def scoped_dataset(kind: str, user: dict, limit: int, offset: int) -> tuple[str, int, int]:
    """
    Serve an entity from the database, filtered to the caller's scope IN SQL.
    Returns (csv_text, rows_served, total_in_scope).

    Scope is a WHERE clause, not a post-filter: there is no code path that
    materialises out-of-scope rows and then removes them, so none can leak
    through a forgotten branch.
    """
    scope = store.scope_of(user)
    total = db.counts(scope).get(kind, 0)

    if kind == "clients":
        rows = db.clients(scope, limit, offset)
        head = ["id","name","vertical","status","flag","mrr","perappt","since","seats","csm","churnedon","churnreason"]
        body = [[r["id"], r["name"], r["vertical"], r["status"], r["flag"] or "", r["mrr"],
                 r["per_appt"], r["since"], r["seats"], r["csm"],
                 r["churned_on"] or "", r["churn_reason"] or ""] for r in rows]
    elif kind == "agents":
        rows = db.agents(scope, limit, offset)
        head = ["id","name","kind","clientid","startedat","endedat","base","seatcost","active"]
        body = [[r["id"], r["name"], r["kind"], r["client_id"], _day_str(r["started_at"]),
                 _day_str(r["ended_at"]) if r["ended_at"] else "", r["base"], r["seat_cost"],
                 "true" if r["active"] else "false"] for r in rows]
    elif kind == "appts":
        rows = db.appointments(scope, limit, offset)
        head = ["date","time","clientid","agentid","outcome","value"]
        body = [[_day_str(r["day"]), f'{r["hm"]//60:02d}:{r["hm"]%60:02d}', r["client_id"],
                 r["agent_id"], r["outcome"], r["value"]] for r in rows]
    elif kind == "leads":
        rows = db.leads(scope, limit, offset)
        head = ["id","name","clientid","stage","source","value","score","date"]
        body = [[r["id"], r["name"], r["client_id"], r["stage"], r["source"], r["value"],
                 r["score"], _day_str(r["created"])] for r in rows]
    else:
        return "", 0, 0

    return _rows_to_csv(head, body), len(rows), total


# ───────────────────────────── HTTP ─────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "Opsdeck"
    sys_version = ""

    def _ip(self) -> str:
        return self.client_address[0] if self.client_address else "?"

    def _begin(self) -> float:
        log.new_request_id()
        return time.perf_counter()

    def _finish(self, t0: float, code: int, user=None) -> None:
        ms = (time.perf_counter() - t0) * 1000
        path = urlparse(self.path).path
        # Route label, not raw path: per-URL cardinality would blow up the
        # metric namespace the moment ids appear in a path.
        route = self._route_label(path)
        log.METRICS.inc("opsdeck_requests_total",
                        (("method", self.command), ("route", route), ("status", str(code))))
        log.METRICS.observe("opsdeck_request_duration_ms", ms)
        if code >= 500:
            log.METRICS.inc("opsdeck_errors_total", (("route", route),))

        lvl = "error" if code >= 500 else "warn" if code >= 400 else "info"
        # A slow request is worth a warning even when it succeeded — that is
        # the signal that precedes an outage, and a 200 hides it otherwise.
        if lvl == "info" and ms > 500:
            lvl = "warn"
        log.log(lvl, "http", method=self.command, path=path, route=route,
                status=code, ms=round(ms, 2), ip=self._ip(),
                user=(user or {}).get("username") if isinstance(user, dict) else user)
        log.clear_request()

    @staticmethod
    def _route_label(path: str) -> str:
        if path.startswith("/api/data/"):
            return "/api/data/:kind"
        if path.startswith("/api/"):
            return path
        if path.startswith("/js/"):
            return "/js/*"
        if path in ("/login", "/logout", "/healthz", "/readyz", "/metrics"):
            return path
        return "/static"

    def _sec(self, csp: str | None = None) -> None:
        self.send_header("Content-Security-Policy", csp or DEFAULT_CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        if TLS_ENABLED:
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    def _send(self, code: int, body: bytes, ctype: str, extra=None, *, csp: str | None = None) -> None:
        self._status = code
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._sec(csp)
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj, extra=None) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json", extra)

    def _redirect(self, to: str, extra=None) -> None:
        self.send_response(303)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self._sec()
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()

    def _user(self) -> dict | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(raw)
        except http.cookies.CookieError:
            return None
        m = jar.get(COOKIE_NAME)
        username = read_session(m.value if m else None)
        return store.get_user(username) if username else None

    def _resolve(self, url_path: str) -> Path | None:
        rel = url_path.lstrip("/") or "index.html"
        parts = Path(rel).parts
        if any(p.startswith(".") for p in parts):
            return None
        if parts and parts[0] in FORBIDDEN_DIRS:
            return None
        target = (ROOT / rel).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            return None
        return target if target.is_file() else None

    # ---------- GET ----------

    def do_GET(self) -> None:
        t0 = self._begin()
        try:
            self._route_get()
        finally:
            self._finish(t0, getattr(self, "_status", 0))

    def _route_get(self) -> None:
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)

        if path == "/healthz":
            # Liveness only: deliberately does not touch the database, so a
            # transient DB blip cannot make an orchestrator kill a process
            # that would have recovered.
            return self._json(200, {"status": "ok"})

        if path == "/readyz":
            # Readiness: should this instance receive traffic?
            try:
                ver = db.schema_version()
                ok = ver >= db.SCHEMA_VERSION
                return self._json(200 if ok else 503, {
                    "status": "ready" if ok else "migrating",
                    "schemaVersion": ver, "expected": db.SCHEMA_VERSION,
                    "users": store.has_any_user()})
            except Exception as e:
                return self._json(503, {"status": "unavailable", "error": str(e)[:120]})
        if path == "/openapi.json":
            # Public: a client cannot integrate against a contract it may not read,
            # and the document describes shapes, not data.
            return self._send(200, json.dumps(api_spec.SPEC, indent=2).encode(),
                              "application/json; charset=utf-8")

        if path == "/login":
            want = (qs.get("as") or [""])[0][:16]
            page = LOGIN_PAGE
            if want in store.ROLES:
                # Map a role to the demo account that carries it, so the
                # switcher lands on a usable form. Password is still required.
                demo = {"admin": "admin", "client": "client",
                        "manager": "dana", "prospect": "prospect"}.get(want, "")
                page = page.replace('id="u" name="username" type="text"',
                                    f'id="u" name="username" type="text" value="{demo}"')
                page = page.replace('autofocus/>\n  <label for="p">',
                                    '/>\n  <label for="p">')
                page = page.replace('id="p" name="password" type="password"',
                                    'id="p" name="password" type="password" autofocus')
            return self._send(200, page.encode(), "text/html; charset=utf-8")
        if path == "/login.js":
            return self._send(200, LOGIN_JS.encode(), "text/javascript; charset=utf-8")

        user = self._user()

        if path == "/logout":
            # ?as=<role> is a convenience for the role switcher: it clears the
            # session and lands on sign-in with that role's username prefilled.
            # It grants nothing — the password is still required.
            wanted = (qs.get("as") or [""])[0][:16]
            if user:
                store.audit("logout", user=user["username"], ip=self._ip())
            dest = "/login" + (f"?as={wanted}" if wanted in store.ROLES else "")
            return self._redirect(dest, [(
                "Set-Cookie", f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")])

        if not user:
            if "text/html" in (self.headers.get("Accept") or ""):
                return self._redirect("/login")
            return self._json(401, {"error": "unauthenticated"})

        # ---- API ----
        if path == "/api/me":
            scope = store.scope_of(user)
            return self._json(200, {
                "username": user["username"], "role": user["role"],
                "clients": sorted(scope) if scope is not None else None,
                "unrestricted": scope is None,
                "roleHelp": store.ROLE_HELP.get(user["role"], ""),
                "csrfToken": csrf_for(user["username"]),
                "schemaVersion": db.schema_version(),
                # The client uses this to hide surfaces it must not offer. The
                # hiding is convenience; the refusal above is the control.
                "clientDataEntitled": user["role"] not in store.NO_DATA_ROLES,
                # Gates the internal-only collections (team roster, onboarding
                # pipeline, experiments) which carry no client_id and so were
                # never touched by client scoping.
                "internal": store.is_internal(user),
            })

        if path.startswith("/api/data/"):
            kind = path.rsplit("/", 1)[-1]
            if kind not in DATASETS:
                return self._json(404, {"error": "unknown dataset"})

            # Defence in depth. scope_of() already returns an empty set for a
            # prospect, so the query would return nothing anyway — but an
            # explicit refusal means a future change to scoping cannot silently
            # start serving client rows to an evaluation account, and the
            # attempt is recorded rather than looking like an empty dataset.
            if user["role"] in store.NO_DATA_ROLES:
                store.audit("denied", user=user["username"], ip=self._ip(),
                            detail={"path": path, "reason": "role has no client-data entitlement"})
                log.warn("prospect_data_blocked", user=user["username"], kind=kind)
                return self._json(403, {
                    "error": "this account has no client-data entitlement",
                    "role": user["role"]})
            try:
                limit = min(100000, max(1, int((qs.get("limit") or ["50000"])[0])))
                offset = max(0, int((qs.get("offset") or ["0"])[0]))
            except ValueError:
                return self._json(400, {"error": "limit and offset must be integers"})

            text, served, total = scoped_dataset(kind, user, limit, offset)
            if served == 0 and total == 0:
                return self._json(404, {"error": "no rows", "kind": kind})

            # Weak ETag over the payload. The console re-fetches all four
            # datasets on every boot; without this each reload ships the full
            # appointment table again even when nothing changed.
            etag = 'W/"' + hashlib.sha256(text.encode()).hexdigest()[:24] + '"'
            if (self.headers.get("If-None-Match") or "") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Content-Length", "0")
                self._sec()
                self.end_headers()
                return

            store.audit("data.read", user=user["username"], ip=self._ip(),
                        detail={"kind": kind, "rows": served, "total": total,
                                "scoped": not store.scope_of(user) is None})
            return self._send(200, text.encode(), "text/csv; charset=utf-8", [
                ("ETag", etag),
                ("X-Total-Count", str(total)),
                ("X-Returned-Count", str(served)),
            ])

        if path == "/metrics":
            if user["role"] != "admin":
                store.audit("denied", user=user["username"], ip=self._ip(), detail={"path": path})
                return self._json(403, {"error": "admin only"})
            try:
                dbs = db.stats()
                extra = {
                    "opsdeck_db_clients": dbs["clients"], "opsdeck_db_agents": dbs["agents"],
                    "opsdeck_db_appointments": dbs["appointments"], "opsdeck_db_leads": dbs["leads"],
                    "opsdeck_db_size_bytes": dbs["sizeBytes"], "opsdeck_db_schema_version": dbs["schemaVersion"],
                    "opsdeck_users_total": len(store.list_users()),
                }
            except Exception:
                extra = {}
            body = log.METRICS.prometheus(extra).encode()
            return self._send(200, body, "text/plain; version=0.0.4; charset=utf-8")

        if path == "/api/logs":
            if user["role"] != "admin":
                store.audit("denied", user=user["username"], ip=self._ip(), detail={"path": path})
                return self._json(403, {"error": "admin only"})
            try:
                limit = min(500, max(1, int((qs.get("limit") or ["200"])[0])))
            except ValueError:
                limit = 200
            return self._json(200, {
                "entries": log.recent(limit, (qs.get("level") or [None])[0],
                                      (qs.get("event") or [None])[0]),
                "metrics": log.METRICS.snapshot(),
            })

        if path == "/api/audit":
            if user["role"] != "admin":
                store.audit("denied", user=user["username"], ip=self._ip(), detail={"path": path})
                return self._json(403, {"error": "admin only"})
            try:
                limit = min(1000, max(1, int((qs.get("limit") or ["300"])[0])))
            except ValueError:
                limit = 300
            return self._json(200, {"entries": store.read_audit(limit), "stats": store.audit_stats()})

        if path == "/api/db":
            if user["role"] != "admin":
                store.audit("denied", user=user["username"], ip=self._ip(), detail={"path": path})
                return self._json(403, {"error": "admin only"})
            return self._json(200, {"stats": db.stats(), "imports": db.import_runs(25)})

        if path == "/api/users":
            if user["role"] != "admin":
                store.audit("denied", user=user["username"], ip=self._ip(), detail={"path": path})
                return self._json(403, {"error": "admin only"})
            return self._json(200, {"users": store.list_users(), "roles": list(store.ROLES),
                                    "roleHelp": store.ROLE_HELP})

        if path == "/":
            return self._redirect("/index.html")

        target = self._resolve(path)
        if target is None:
            return self._json(404, {"error": "not found"})
        ctype, _ = mimetypes.guess_type(str(target))
        if target.suffix == ".js":
            ctype = "text/javascript; charset=utf-8"
        elif target.suffix == ".html":
            ctype = "text/html; charset=utf-8"
        elif target.suffix == ".csv":
            ctype = "text/csv; charset=utf-8"
        try:
            return self._send(200, target.read_bytes(), ctype or "application/octet-stream")
        except OSError:
            return self._json(500, {"error": "read error"})

    do_HEAD = do_GET

    # ---------- POST ----------

    def do_POST(self) -> None:
        t0 = self._begin()
        try:
            self._route_post()
        finally:
            self._finish(t0, getattr(self, "_status", 0))

    def _route_post(self) -> None:
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length < 0 or length > 1_048_576:
            return self._json(400, {"error": "bad request"})
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}

        if path == "/api/login":
            if not LOGIN_LIMITER.allow(self._ip()):
                store.audit("login.failure", user=str(body.get("username"))[:64],
                            ip=self._ip(), detail={"reason": "rate limited"})
                return self._json(429, {"error": "rate limited"})
            username = str(body.get("username") or "")[:128]
            state = store.lock_state(username)
            if state["locked"]:
                store.audit("login.locked", user=username[:64], ip=self._ip(),
                            detail={"remaining": state["remaining"]})
                log.warn("login_locked", user=username[:64], remaining=state["remaining"])
                return self._json(423, {"error": "account temporarily locked",
                                        "retryAfter": state["remaining"]})
            u = store.authenticate(username, str(body.get("password") or ""))
            if not u:
                store.audit("login.failure", user=username[:64], ip=self._ip(),
                            detail={"reason": "invalid credentials"})
                # Uniform message: no distinction between unknown user and
                # wrong password, so the response cannot enumerate accounts.
                return self._json(401, {"error": "invalid credentials"})
            store.audit("login.success", user=u["username"], ip=self._ip(),
                        detail={"role": u["role"]})
            return self._json(200, {"ok": True, "user": u["username"], "role": u["role"]}, [
                ("Set-Cookie",
                 f"{COOKIE_NAME}={issue_session(u['username'])}; Path=/; Max-Age={SESSION_TTL}; "
                 f"HttpOnly; SameSite=Strict{cookie_flags()}"),
                # Readable by design: the page must echo it back in a header.
                # It is not a credential on its own — it only proves the
                # request came from a document, not a cross-site form post.
                ("Set-Cookie",
                 f"{CSRF_COOKIE}={csrf_for(u['username'])}; Path=/; Max-Age={SESSION_TTL}; "
                 f"SameSite=Strict{cookie_flags()}"),
            ])

        user = self._user()
        if not user:
            return self._json(401, {"error": "unauthenticated"})

        # Every authenticated POST is state-changing and must carry the token.
        if not csrf_ok(user["username"], self.headers.get(CSRF_HEADER)):
            store.audit("csrf.reject", user=user["username"], ip=self._ip(),
                        detail={"path": path})
            log.warn("csrf_reject", path=path, user=user["username"])
            return self._json(403, {"error": "missing or invalid CSRF token"})

        if path == "/api/client-error":
            log.error("client_error",
                      user=user["username"],
                      message=str(body.get("message"))[:400],
                      source=str(body.get("source"))[:200],
                      stack=str(body.get("stack"))[:1200],
                      route=str(body.get("route"))[:64],
                      ua=str(self.headers.get("User-Agent"))[:160])
            log.METRICS.inc("opsdeck_client_errors_total", (("route", str(body.get("route"))[:32]),))
            return self._json(200, {"ok": True})

        if path == "/api/event":
            # Client-side activity (view opens, imports, exports, settings)
            # funnelled into the same log as server-side auth events, so one
            # timeline answers "what did this account actually do".
            action = str(body.get("action") or "")
            if action not in store.AUDIT_ACTIONS:
                return self._json(400, {"error": "unknown action"})
            store.audit(action, user=user["username"], ip=self._ip(), detail=body.get("detail"))
            return self._json(200, {"ok": True})

        return self._json(404, {"error": "not found"})

    def log_message(self, fmt: str, *args) -> None:
        # Suppressed: every request is already logged as structured JSON by
        # _finish(). Two access logs in different formats is worse than one.
        return


class ThreadingServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def wrap_tls(httpd, certfile: str, keyfile: str):
    """
    Wrap the listening socket in TLS.

    TLS 1.2 is the floor: everything below it has known breaks and no client
    that matters still needs it. Compression is disabled (CRIME) and the
    server picks the cipher rather than honouring client preference.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.options |= ssl.OP_NO_COMPRESSION | ssl.OP_CIPHER_SERVER_PREFERENCE
    ctx.load_cert_chain(certfile=certfile, keyfile=keyfile)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    return httpd


# ───────────────────────────── CLI ─────────────────────────────

def _prompt_password(confirm: bool = True) -> str:
    if not sys.stdin.isatty():
        pw = secrets.token_urlsafe(12)
        print(f"  generated password: {pw}")
        return pw
    while True:
        pw = getpass.getpass("  password: ")
        if len(pw) < store.MIN_PASSWORD_LEN:
            print(f"  too short — minimum {store.MIN_PASSWORD_LEN} characters")
            continue
        if not confirm or pw == getpass.getpass("  confirm : "):
            return pw
        print("  did not match")


def cli(argv: list[str]) -> int:
    cmd = argv[0]
    if cmd == "adduser":
        if len(argv) < 3:
            print("usage: server.py adduser <username> <admin|manager|client> [c1,c2,...]")
            return 2
        username, role = argv[1], argv[2]
        clients = [c.strip() for c in (argv[3].split(",") if len(argv) > 3 else []) if c.strip()]
        if role != "admin" and not clients:
            print(f"  note: '{role}' with no client ids will see nothing until you assign some.")
        pw = _prompt_password()
        try:
            u = store.add_user(username, pw, role, clients)
        except ValueError as e:
            print(f"  error: {e}")
            return 1
        store.audit("user.create", user="cli", detail=u)
        print(f"  created {u['username']} ({u['role']}) scope={u['clients'] or 'ALL' if role=='admin' else u['clients']}")
        return 0

    if cmd == "passwd":
        if len(argv) < 2:
            print("usage: server.py passwd <username>")
            return 2
        pw = _prompt_password()
        print("  updated" if store.set_password(argv[1], pw) else "  no such user")
        return 0

    if cmd == "deluser":
        if len(argv) < 2:
            print("usage: server.py deluser <username>")
            return 2
        okd = store.delete_user(argv[1])
        if okd:
            store.audit("user.delete", user="cli", detail={"username": argv[1]})
        print("  deleted" if okd else "  no such user")
        return 0

    if cmd == "users":
        rows = store.list_users()
        if not rows:
            print("  no users yet")
            return 0
        print(f"  {'USERNAME':<16}{'ROLE':<10}{'SCOPE'}")
        for r in rows:
            scope = "ALL" if r["role"] == "admin" else (", ".join(r["clients"]) or "none")
            print(f"  {r['username']:<16}{r['role']:<10}{scope}")
        return 0

    if cmd == "audit":
        n = int(argv[1]) if len(argv) > 1 and argv[1].isdigit() else 40
        for r in reversed(store.read_audit(n)):
            ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["t"]))
            print(f"  {ts}  {str(r.get('user') or '-'):<14}{r['action']:<16}{json.dumps(r.get('detail') or {})}")
        return 0

    print(f"unknown command: {cmd}")
    return 2


def bootstrap_admin() -> tuple[str, str] | None:
    """First run with no users: create an admin so the console is reachable."""
    if store.has_any_user():
        return None
    pw = os.environ.get("OPSDECK_ADMIN_PASSWORD") or secrets.token_urlsafe(12)
    store.add_user("admin", pw, "admin", [])
    store.audit("user.create", user="bootstrap", detail={"username": "admin", "role": "admin"})
    return ("admin", pw)


def main() -> None:
    if len(sys.argv) > 1:
        raise SystemExit(cli(sys.argv[1:]))

    global TLS_ENABLED
    cert = os.environ.get("OPSDECK_TLS_CERT")
    key = os.environ.get("OPSDECK_TLS_KEY")
    TLS_ENABLED = bool(cert and key)

    # Migrate before binding the port. Serving requests against a schema the
    # code does not expect is worse than a slightly slower start.
    mig = db.migrate()
    if mig["applied"]:
        log.info("migrations_applied", versions=mig["applied"])

    port = int(os.environ.get("OPSDECK_PORT", "8420"))
    host = os.environ.get("OPSDECK_HOST", "127.0.0.1")
    created = bootstrap_admin()

    bar = "─" * 66
    print(f"\n{bar}\n  Opsdeck\n{bar}")
    print(f"  URL        {'https' if TLS_ENABLED else 'http'}://{host}:{port}/")
    print(f"  Transport  {'TLS 1.2+ · Secure cookies · HSTS' if TLS_ENABLED else 'plain HTTP (loopback only)'}")
    if created:
        print(f"\n  A first admin account was created:")
        print(f"    username   {created[0]}")
        print(f"    password   {created[1]}")
        print(f"  Change it with:  python3 server.py passwd admin")
    else:
        print(f"  Accounts   {len(store.list_users())} (python3 server.py users)")
    dbs = db.stats()
    print(f"\n  Database   var/console.db · schema v{dbs['schemaVersion']} · {dbs['journalMode'].upper()} · "
          f"{dbs['sizeBytes']/1024:.0f} KB")
    print(f"             {dbs['clients']} clients · {dbs['agents']} agents · "
          f"{dbs['appointments']:,} appointments · {dbs['leads']} leads")
    if dbs["clients"] == 0:
        print("             empty — run: python3 tools/load_csv.py")
    print(f"  Audit      var/audit.jsonl")
    print(f"  Sessions   {SESSION_TTL // 3600}h, ended by a restart")
    print(f"  Bound to   {host} only\n{bar}\n")

    scheme = "https" if TLS_ENABLED else "http"
    log.info("server_start", host=host, port=port, tls=TLS_ENABLED,
             schema=db.schema_version(), users=len(store.list_users()))
    with ThreadingServer((host, port), Handler) as httpd:
        if TLS_ENABLED:
            wrap_tls(httpd, cert, key)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


# LIMITATIONS
#   * TLS is optional via OPSDECK_TLS_CERT + OPSDECK_TLS_KEY. Loopback-bound by default
#     so the cookie never crosses a network. Put a terminator in front (or set
#     the cert env vars) and add Secure to the cookie before binding wider.
#   * Sessions are in-process; a restart logs everyone out. Deliberate.
#   * The audit log is append-only by API but not tamper-evident. Hash-chaining
#     it would be the next step if it needed to survive a hostile admin.
#   * Static /data, /tools, /fixtures and /var are never served. Live rows go
#     through /api/data, scoped in SQL.
if __name__ == "__main__":
    main()
