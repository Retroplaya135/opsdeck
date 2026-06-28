"""
SQLite data layer: schema, migrations, indices, transactions, scoped queries.

Replaces reading CSV files off disk on every request. That approach had no
transactions (a half-written import left the app in a torn state), no indices
(every scoped read was a full scan and a string compare per row), no schema
(a malformed column was discovered at render time, three screens away from
the cause), and no concurrency story at all.

Design notes worth stating:
  * WAL journal mode so a long read cannot block a write, and vice versa.
    This is the single most important pragma for a read-heavy console.
  * Foreign keys are ON. They are off by default in SQLite per connection,
    which is a foot-gun: declaring a REFERENCES clause and never enabling
    enforcement gives the appearance of integrity without any.
  * Scope is applied in SQL (`WHERE client_id IN (...)`), not by filtering
    rows in Python after the fact. The database never hands out rows the
    caller is not entitled to, so there is no post-filter to forget.
  * Migrations are forward-only and recorded, so an existing database is
    upgraded in place rather than silently expecting a fresh one.
  * Connections are per-thread. sqlite3 objects are not safe to share across
    threads, and the server is threaded.
"""

from __future__ import annotations

import contextlib
import os
import sqlite3
import threading
import time
from pathlib import Path

VAR = Path(os.environ.get("OPSDECK_VAR_DIR", Path(__file__).resolve().parent / "var"))
DB_PATH = VAR / "console.db"
_local = threading.local()

SCHEMA_VERSION = 3


# ───────────────────────────── connection ─────────────────────────────

def connect() -> sqlite3.Connection:
    """Per-thread connection. Re-used within a thread, never shared across."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=8000")
    conn.execute("PRAGMA synchronous=NORMAL")
    _local.conn = conn
    return conn


@contextlib.contextmanager
def tx():
    """
    Explicit transaction. isolation_level=None means autocommit by default,
    so writes that must land together are wrapped here rather than relying
    on the driver's implicit behaviour.
    """
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


# ───────────────────────────── migrations ─────────────────────────────

MIGRATIONS: list[tuple[int, str]] = [
    (1, """
        CREATE TABLE IF NOT EXISTS clients (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            vertical     TEXT NOT NULL DEFAULT 'General',
            status       TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','churned')),
            flag         TEXT CHECK (flag IN ('expansion','watch') OR flag IS NULL),
            mrr          REAL NOT NULL DEFAULT 0 CHECK (mrr >= 0),
            per_appt     REAL NOT NULL CHECK (per_appt >= 0),
            since        TEXT NOT NULL,
            seats        INTEGER NOT NULL DEFAULT 0 CHECK (seats >= 0),
            csm          TEXT NOT NULL DEFAULT 'Unassigned',
            churned_on   TEXT,
            churn_reason TEXT
        );

        CREATE TABLE IF NOT EXISTS agents (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            kind       TEXT NOT NULL CHECK (kind IN ('ai','human')),
            client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            started_at INTEGER NOT NULL,
            ended_at   INTEGER,
            base       REAL NOT NULL DEFAULT 0 CHECK (base >= 0),
            seat_cost  REAL NOT NULL DEFAULT 0 CHECK (seat_cost >= 0),
            aht_sec    INTEGER NOT NULL DEFAULT 180,
            active     INTEGER NOT NULL DEFAULT 1,
            CHECK (ended_at IS NULL OR ended_at >= started_at)
        );

        CREATE TABLE IF NOT EXISTS appointments (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            day        INTEGER NOT NULL,
            hm         INTEGER NOT NULL DEFAULT 540 CHECK (hm BETWEEN 0 AND 1439),
            client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            outcome    TEXT NOT NULL
                       CHECK (outcome IN ('upcoming','showed','closed','noshow','cancelled')),
            value      REAL NOT NULL DEFAULT 0 CHECK (value >= 0),
            lead_days  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS leads (
            id        TEXT PRIMARY KEY,
            name      TEXT NOT NULL,
            client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            stage     TEXT NOT NULL,
            source    TEXT NOT NULL DEFAULT 'Unknown',
            value     REAL NOT NULL DEFAULT 0 CHECK (value >= 0),
            score     INTEGER NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
            created   INTEGER NOT NULL
        );
    """),
    (2, """
        -- Every scoped read filters by client_id and orders by day; without
        -- these the console does a full table scan per request.
        CREATE INDEX IF NOT EXISTS ix_agents_client       ON agents(client_id);
        CREATE INDEX IF NOT EXISTS ix_appt_client_day     ON appointments(client_id, day);
        CREATE INDEX IF NOT EXISTS ix_appt_day            ON appointments(day);
        CREATE INDEX IF NOT EXISTS ix_appt_agent          ON appointments(agent_id);
        CREATE INDEX IF NOT EXISTS ix_leads_client_stage  ON leads(client_id, stage);
        CREATE INDEX IF NOT EXISTS ix_leads_created       ON leads(created);
    """),
    (3, """
        -- Import provenance: which file, when, how many rows survived. Without
        -- this an operator cannot answer "where did this number come from".
        CREATE TABLE IF NOT EXISTS import_runs (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        INTEGER NOT NULL,
            actor     TEXT,
            entity    TEXT NOT NULL,
            source    TEXT,
            accepted  INTEGER NOT NULL DEFAULT 0,
            rejected  INTEGER NOT NULL DEFAULT 0,
            coerced   INTEGER NOT NULL DEFAULT 0,
            note      TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_import_ts ON import_runs(ts);
    """),
]


def migrate() -> dict:
    """Apply pending migrations. Forward-only, recorded, idempotent."""
    conn = connect()
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations ("
                 "version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
    done = {r["version"] for r in conn.execute("SELECT version FROM schema_migrations")}
    applied = []
    for version, sql in MIGRATIONS:
        if version in done:
            continue
        # executescript() issues an implicit COMMIT before it runs, which
        # silently ends the surrounding BEGIN and makes the migration
        # non-atomic (and then blows up on the explicit COMMIT). Execute the
        # statements individually so DDL and the version record land together
        # or not at all — SQLite DDL is transactional, so this is worth having.
        # Strip `--` line comments BEFORE splitting: a comment containing a
        # semicolon ("...orders by day; without these...") otherwise splits
        # mid-sentence and the remainder is fed to SQLite as a statement.
        stripped = "\n".join(
            line for line in sql.splitlines() if not line.strip().startswith("--"))
        statements = [st.strip() for st in stripped.split(";") if st.strip()]
        with tx() as c:
            for st in statements:
                c.execute(st)
            c.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?,?)",
                      (version, int(time.time())))
        applied.append(version)
    return {"applied": applied, "at": max(done | {0} | set(applied))}


def schema_version() -> int:
    conn = connect()
    try:
        row = conn.execute("SELECT MAX(version) AS v FROM schema_migrations").fetchone()
        return row["v"] or 0
    except sqlite3.OperationalError:
        return 0


# ───────────────────────────── scoped reads ─────────────────────────────

def _scope_clause(scope: set[str] | None, col: str = "client_id") -> tuple[str, list]:
    """
    Build a scope predicate. `None` means unrestricted; an EMPTY set means
    entitled to nothing, which must render as a false predicate rather than
    an absent one — the difference between "see everything" and "see nothing"
    is one missing WHERE clause.
    """
    if scope is None:
        return "", []
    if not scope:
        return f" AND 1=0", []
    marks = ",".join("?" * len(scope))
    return f" AND {col} IN ({marks})", sorted(scope)


def clients(scope=None, limit=1000, offset=0):
    where, args = _scope_clause(scope, "id")
    sql = f"SELECT * FROM clients WHERE 1=1{where} ORDER BY id LIMIT ? OFFSET ?"
    return [dict(r) for r in connect().execute(sql, [*args, limit, offset])]


def agents(scope=None, limit=5000, offset=0):
    where, args = _scope_clause(scope)
    sql = f"SELECT * FROM agents WHERE 1=1{where} ORDER BY id LIMIT ? OFFSET ?"
    return [dict(r) for r in connect().execute(sql, [*args, limit, offset])]


def appointments(scope=None, limit=50000, offset=0, since_day=None):
    where, args = _scope_clause(scope)
    day = ""
    if since_day is not None:
        day = " AND day >= ?"
        args = [*args, since_day]
    sql = (f"SELECT * FROM appointments WHERE 1=1{where}{day} "
           f"ORDER BY day, hm LIMIT ? OFFSET ?")
    return [dict(r) for r in connect().execute(sql, [*args, limit, offset])]


def leads(scope=None, limit=5000, offset=0):
    where, args = _scope_clause(scope)
    sql = f"SELECT * FROM leads WHERE 1=1{where} ORDER BY created DESC LIMIT ? OFFSET ?"
    return [dict(r) for r in connect().execute(sql, [*args, limit, offset])]


def counts(scope=None) -> dict:
    """Row counts per entity within scope — used for pagination headers."""
    out = {}
    for name, table, col in (("clients", "clients", "id"),
                             ("agents", "agents", "client_id"),
                             ("appts", "appointments", "client_id"),
                             ("leads", "leads", "client_id")):
        where, args = _scope_clause(scope, col)
        row = connect().execute(f"SELECT COUNT(*) AS n FROM {table} WHERE 1=1{where}", args).fetchone()
        out[name] = row["n"]
    return out


def stats() -> dict:
    c = connect()
    q = lambda s: c.execute(s).fetchone()[0]
    return {
        "schemaVersion": schema_version(),
        "clients": q("SELECT COUNT(*) FROM clients"),
        "agents": q("SELECT COUNT(*) FROM agents"),
        "appointments": q("SELECT COUNT(*) FROM appointments"),
        "leads": q("SELECT COUNT(*) FROM leads"),
        "sizeBytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
        "journalMode": c.execute("PRAGMA journal_mode").fetchone()[0],
        "foreignKeys": bool(c.execute("PRAGMA foreign_keys").fetchone()[0]),
    }


def record_import(actor, entity, source, accepted, rejected, coerced, note=None):
    with tx() as c:
        c.execute("INSERT INTO import_runs (ts,actor,entity,source,accepted,rejected,coerced,note) "
                  "VALUES (?,?,?,?,?,?,?,?)",
                  (int(time.time()), actor, entity, source, accepted, rejected, coerced, note))


def import_runs(limit=50):
    return [dict(r) for r in connect().execute(
        "SELECT * FROM import_runs ORDER BY ts DESC LIMIT ?", (limit,))]


# ───────────────────────────── bulk load ─────────────────────────────

def replace_entity(entity: str, rows: list[dict]) -> int:
    """
    Replace an entity wholesale inside ONE transaction. Either the new set
    lands completely or the old set is untouched — a partial import leaving
    agents pointing at deleted clients is exactly what the transaction is for.
    Insert order respects foreign keys.
    """
    table = {"clients": "clients", "agents": "agents",
             "appts": "appointments", "leads": "leads"}[entity]
    cols = {
        "clients": ("id","name","vertical","status","flag","mrr","per_appt","since","seats","csm","churned_on","churn_reason"),
        "agents":  ("id","name","kind","client_id","started_at","ended_at","base","seat_cost","aht_sec","active"),
        "appts":   ("day","hm","client_id","agent_id","outcome","value","lead_days"),
        "leads":   ("id","name","client_id","stage","source","value","score","created"),
    }[entity]
    marks = ",".join("?" * len(cols))
    with tx() as c:
        # Children first so foreign keys never dangle mid-transaction.
        if table == "clients":
            c.execute("DELETE FROM appointments"); c.execute("DELETE FROM leads")
            c.execute("DELETE FROM agents"); c.execute("DELETE FROM clients")
        elif table == "agents":
            c.execute("DELETE FROM appointments"); c.execute("DELETE FROM agents")
        else:
            c.execute(f"DELETE FROM {table}")
        c.executemany(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({marks})",
                      [tuple(r.get(k) for k in cols) for r in rows])
    return len(rows)
