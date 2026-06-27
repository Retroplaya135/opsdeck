"""
User store, session identity, and audit log. Standard library only.

Split out of server.py because these three concerns are what turn a shared
door key into an accountable system, and they are worth reading on their own:

  * Users are real accounts with PBKDF2-HMAC-SHA256 passwords (200k iterations,
    per-user 16-byte salt). Never a reversible secret on disk.
  * Every account carries a SCOPE — the client ids it may see. Scope is
    enforced server-side when data is served, never by hiding UI, because a
    filter applied in the browser is a suggestion.
  * Every security-relevant action appends one JSON line to an audit log:
    who, what, when, from where. Append-only by convention and by API — there
    is no update or delete path in this module.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path

VAR = Path(os.environ.get("OPSDECK_VAR_DIR", Path(__file__).resolve().parent / "var"))
USERS_FILE = VAR / "users.json"
AUDIT_FILE = VAR / "audit.jsonl"

PBKDF2_ROUNDS = 200_000
_lock = threading.Lock()

ROLES = ("admin", "manager", "client", "prospect")

# Lockout: N consecutive failures within a window locks the account for a
# cooling-off period. Rate limiting alone only slows an attacker down per-IP;
# a distributed attempt against one account walks straight past it.
LOCKOUT_THRESHOLD = 6
LOCKOUT_WINDOW = 15 * 60
LOCKOUT_DURATION = 15 * 60
MIN_PASSWORD_LEN = 10


class PasswordPolicyError(ValueError):
    pass


def check_password_policy(password: str) -> None:
    """
    Length first, because length dominates. Also refuse the handful of
    passwords that appear in every breach corpus — a 10-character password
    that is 'password12' is not protected by its length.
    """
    if not password or len(password) < MIN_PASSWORD_LEN:
        raise PasswordPolicyError(f"password must be at least {MIN_PASSWORD_LEN} characters")
    lowered = password.lower()
    banned = {"password12", "changeme12", "letmein123", "adminadmin", "1234567890",
              "qwertyuiop", "administrator"}
    if lowered in banned or lowered.strip("0123456789") == "":
        raise PasswordPolicyError("password is too predictable — choose something less common")
# Shown in the dashboard, so it is written for whoever reads it there.
ROLE_HELP = {
    "admin":    "Sees every account, and can manage who has access.",
    "manager":  "Sees the accounts they have been assigned.",
    "client":   "Sees their own account only.",
    "prospect": "Trying the product. Sees no client information at all.",
}

# A prospect is an outside party evaluating the product. They must never
# receive another company's data, so the scope is empty by construction and
# cannot be widened by assigning client ids — see scope_of().
NO_DATA_ROLES = frozenset({"prospect"})

# Roles held by someone outside the company. The distinction matters
# separately from client scoping: the internal team roster, the onboarding
# pipeline (other companies, with their retainers) and programme experiments
# carry no client_id at all, so scoping by client never touched them and a
# client account was being served all of it.
EXTERNAL_ROLES = frozenset({"client", "prospect"})


def is_internal(user) -> bool:
    return bool(user) and user.get("role") not in EXTERNAL_ROLES


# ───────────────────────────── password hashing ─────────────────────────────

def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt_hex, dk_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds))
        # Constant-time: a timing difference here leaks the hash prefix.
        return hmac.compare_digest(dk.hex(), dk_hex)
    except (ValueError, AttributeError):
        return False


# ───────────────────────────── user store ─────────────────────────────

def _read_users() -> dict:
    if not USERS_FILE.exists():
        return {"users": {}}
    try:
        return json.loads(USERS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {"users": {}}


def _write_users(db: dict) -> None:
    VAR.mkdir(exist_ok=True)
    tmp = USERS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(db, indent=2))
    # Atomic replace so a crash mid-write cannot leave a truncated user file
    # and lock every operator out of the console.
    os.replace(tmp, USERS_FILE)
    try:
        os.chmod(USERS_FILE, 0o600)
    except OSError:
        pass


def list_users() -> list[dict]:
    db = _read_users()
    return [
        {"username": u, "role": r["role"], "clients": r.get("clients", []),
         "created": r.get("created"), "lastLogin": r.get("lastLogin"),
         "locked": (r.get("lockedUntil") or 0) > time.time()}
        for u, r in sorted(db["users"].items())
    ]


def add_user(username: str, password: str, role: str, clients: list[str]) -> dict:
    if role not in ROLES:
        raise ValueError(f"role must be one of {', '.join(ROLES)}")
    check_password_policy(password)
    username = username.strip().lower()
    if not username:
        raise ValueError("username is required")
    with _lock:
        db = _read_users()
        if username in db["users"]:
            raise ValueError(f"user '{username}' already exists")
        db["users"][username] = {
            "password": hash_password(password),
            "role": role,
            "clients": clients,
            "created": int(time.time()),
            "lastLogin": None,
            "failures": [],
            "lockedUntil": None,
        }
        _write_users(db)
    return {"username": username, "role": role, "clients": clients}


def set_password(username: str, password: str) -> bool:
    check_password_policy(password)
    with _lock:
        db = _read_users()
        u = db["users"].get(username.strip().lower())
        if not u:
            return False
        u["password"] = hash_password(password)
        _write_users(db)
    return True


def delete_user(username: str) -> bool:
    with _lock:
        db = _read_users()
        if username.strip().lower() not in db["users"]:
            return False
        del db["users"][username.strip().lower()]
        _write_users(db)
    return True


def lock_state(username: str) -> dict:
    """Whether an account is currently locked, and for how long."""
    u = _read_users()["users"].get((username or "").strip().lower())
    if not u:
        return {"locked": False, "remaining": 0, "failures": 0}
    until = u.get("lockedUntil") or 0
    now = time.time()
    recent = [t for t in (u.get("failures") or []) if now - t < LOCKOUT_WINDOW]
    return {"locked": until > now, "remaining": max(0, int(until - now)), "failures": len(recent)}


def authenticate(username: str, password: str) -> dict | None:
    """
    Returns the user on success, None otherwise. Callers cannot distinguish
    "no such user" from "wrong password" from "locked" by return value; use
    lock_state() explicitly when a lockout message is wanted.
    """
    username = (username or "").strip().lower()
    db = _read_users()
    u = db["users"].get(username)
    if not u:
        # Hash regardless so a missing user costs the same time as a real one.
        # Without this, response latency enumerates valid usernames.
        hash_password(password or "")
        return None

    now = time.time()
    if (u.get("lockedUntil") or 0) > now:
        hash_password(password or "")          # keep timing flat while locked
        return None

    if not verify_password(password or "", u["password"]):
        with _lock:
            db = _read_users()
            rec = db["users"].get(username)
            if rec is not None:
                fails = [t for t in (rec.get("failures") or []) if now - t < LOCKOUT_WINDOW]
                fails.append(now)
                rec["failures"] = fails
                if len(fails) >= LOCKOUT_THRESHOLD:
                    rec["lockedUntil"] = now + LOCKOUT_DURATION
                    rec["failures"] = []
                _write_users(db)
        return None

    with _lock:
        db = _read_users()
        rec = db["users"].get(username)
        if rec is not None:
            rec["lastLogin"] = int(now)
            rec["failures"] = []          # a success clears the streak
            rec["lockedUntil"] = None
            _write_users(db)
    return {"username": username, "role": u["role"], "clients": u.get("clients", [])}


def get_user(username: str) -> dict | None:
    u = _read_users()["users"].get((username or "").strip().lower())
    if not u:
        return None
    return {"username": username.strip().lower(), "role": u["role"], "clients": u.get("clients", [])}


def has_any_user() -> bool:
    return bool(_read_users()["users"])


# ───────────────────────────── scoping ─────────────────────────────

def scope_of(user: dict) -> set[str] | None:
    """
    Client ids this user may see. None means unrestricted; an empty set means
    entitled to nothing.

    Applied at the point data is READ, so no code path can serve a row the
    caller is not entitled to — including the CSV exports, which are the
    easiest place to leak a whole table.
    """
    if not user:
        return set()
    role = user.get("role")
    if role == "admin":
        return None
    if role in NO_DATA_ROLES:
        # Deliberately ignores any client ids on the record. A prospect account
        # that somehow acquires an assignment still resolves to nothing, so a
        # mis-click in user administration cannot leak a client to an outsider.
        return set()
    return set(user.get("clients") or [])


def may_see(user: dict, client_id: str) -> bool:
    s = scope_of(user)
    return s is None or client_id in s


# ───────────────────────────── audit log ─────────────────────────────

AUDIT_ACTIONS = {
    "login.success", "login.failure", "logout", "session.expired",
    "data.read", "data.import", "data.export",
    "settings.change", "user.create", "user.delete", "view.open", "denied",
    "login.locked", "csrf.reject",
    "names_revealed", "names_hidden",
}


def audit(action: str, *, user: str | None = None, ip: str | None = None, detail=None) -> None:
    """
    Append one line to the audit log. Never raises: an audit failure must not
    take down the request it is describing, and a half-written line is worse
    than a missing one, so the write is a single atomic append.
    """
    try:
        VAR.mkdir(exist_ok=True)
        rec = {
            "t": round(time.time(), 3),
            "action": action,
            "user": user,
            "ip": ip,
            "detail": detail,
        }
        line = json.dumps(rec, separators=(",", ":"), default=str) + "\n"
        with _lock, open(AUDIT_FILE, "a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
    except Exception:
        pass


def read_audit(limit: int = 500, action_prefix: str | None = None) -> list[dict]:
    """Most recent first. Tolerates a corrupt line rather than failing the view."""
    if not AUDIT_FILE.exists():
        return []
    out = []
    try:
        with open(AUDIT_FILE, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return []
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if action_prefix and not str(rec.get("action", "")).startswith(action_prefix):
            continue
        out.append(rec)
        if len(out) >= limit:
            break
    return out


def audit_stats() -> dict:
    recs = read_audit(limit=5000)
    by_action: dict[str, int] = {}
    by_user: dict[str, int] = {}
    for r in recs:
        by_action[r.get("action", "?")] = by_action.get(r.get("action", "?"), 0) + 1
        if r.get("user"):
            by_user[r["user"]] = by_user.get(r["user"], 0) + 1
    return {
        "total": len(recs),
        "byAction": by_action,
        "byUser": by_user,
        "failures": by_action.get("login.failure", 0),
        "denials": by_action.get("denied", 0),
    }
