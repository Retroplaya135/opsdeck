#!/usr/bin/env python3
"""
Load data/*.csv into the SQLite database.

    python3 tools/load_csv.py            # load from data/
    python3 tools/load_csv.py --verify   # load, then assert integrity

Validation happens here, at the boundary, so bad rows never reach a table.
Rows that fail are reported with their line number and reason rather than
being silently skipped — a loader that quietly drops 4% of a file is how a
dashboard ends up confidently wrong.
"""
from __future__ import annotations

import csv
import sys
import time
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402

DATA = Path(__file__).resolve().parent.parent / "data"


def day_epoch(s: str) -> int | None:
    """Local-midnight epoch ms, built from components so no timezone shift."""
    try:
        y, m, d = (int(x) for x in str(s).strip()[:10].split("-"))
        return int(datetime(y, m, d).timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def hm_minutes(s: str, default: int = 540) -> int:
    try:
        h, m = str(s).strip().split(":")
        v = int(h) * 60 + int(m)
        return v if 0 <= v <= 1439 else default
    except (ValueError, AttributeError):
        return default


def num(s, default=0.0):
    try:
        return float(str(s).replace(",", "").replace("$", "").strip() or default)
    except ValueError:
        return default


def read(name: str) -> list[dict]:
    p = DATA / name
    if not p.exists():
        return []
    with open(p, encoding="utf-8-sig", newline="") as fh:
        return [{k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
                for row in csv.DictReader(fh)]


def load() -> dict:
    report = {}
    db.migrate()

    # clients ─────────────────────────────────────────────
    rows, bad = [], []
    for i, r in enumerate(read("clients.csv"), start=2):
        if not r.get("id") or not r.get("name"):
            bad.append((i, "id and name required")); continue
        since = r.get("since", "")
        if not day_epoch(since):
            bad.append((i, f"since '{since}' is not YYYY-MM-DD")); continue
        status = r.get("status", "active").lower()
        flag = (r.get("flag") or "").lower() or None
        rows.append(dict(
            id=r["id"], name=r["name"], vertical=r.get("vertical") or "General",
            status=status if status in ("active", "churned") else "active",
            flag=flag if flag in ("expansion", "watch") else None,
            mrr=num(r.get("mrr")), per_appt=num(r.get("perappt")),
            since=since[:10], seats=int(num(r.get("seats"))),
            csm=r.get("csm") or "Unassigned",
            churned_on=(r.get("churnedon") or None), churn_reason=(r.get("churnreason") or None)))
    db.replace_entity("clients", rows)
    report["clients"] = {"accepted": len(rows), "rejected": len(bad), "errors": bad[:10]}
    known_clients = {r["id"] for r in rows}

    # agents ──────────────────────────────────────────────
    rows, bad = [], []
    for i, r in enumerate(read("agents.csv"), start=2):
        if not r.get("id") or r.get("clientid") not in known_clients:
            bad.append((i, f"unknown clientid '{r.get('clientid')}'")); continue
        st = day_epoch(r.get("startedat", ""))
        if st is None:
            bad.append((i, "startedat is not a date")); continue
        en = day_epoch(r.get("endedat", "")) if r.get("endedat") else None
        kind = (r.get("kind") or "human").lower()
        rows.append(dict(
            id=r["id"], name=r.get("name") or r["id"],
            kind=kind if kind in ("ai", "human") else "human",
            client_id=r["clientid"], started_at=st, ended_at=en,
            base=num(r.get("base")), seat_cost=num(r.get("seatcost")),
            aht_sec=int(num(r.get("ahtsec"), 180)) or 180,
            active=0 if (r.get("active", "").lower() in ("false", "0", "no") or en) else 1))
    db.replace_entity("agents", rows)
    report["agents"] = {"accepted": len(rows), "rejected": len(bad), "errors": bad[:10]}
    known_agents = {r["id"] for r in rows}

    # appointments ────────────────────────────────────────
    rows, bad = [], []
    valid = {"upcoming", "showed", "closed", "noshow", "cancelled"}
    for i, r in enumerate(read("appointments.csv"), start=2):
        d = day_epoch(r.get("date", ""))
        if d is None:
            bad.append((i, "date is not YYYY-MM-DD")); continue
        if r.get("clientid") not in known_clients or r.get("agentid") not in known_agents:
            bad.append((i, "unknown client or agent")); continue
        oc = (r.get("outcome") or "").lower()
        if oc not in valid:
            bad.append((i, f"outcome '{oc}' not recognised")); continue
        rows.append(dict(day=d, hm=hm_minutes(r.get("time")), client_id=r["clientid"],
                         agent_id=r["agentid"], outcome=oc, value=num(r.get("value")), lead_days=0))
    db.replace_entity("appts", rows)
    report["appts"] = {"accepted": len(rows), "rejected": len(bad), "errors": bad[:10]}

    # leads ───────────────────────────────────────────────
    rows, bad = [], []
    for i, r in enumerate(read("leads.csv"), start=2):
        if not r.get("id") or r.get("clientid") not in known_clients:
            bad.append((i, f"unknown clientid '{r.get('clientid')}'")); continue
        created = day_epoch(r.get("date", "")) or int(time.time() * 1000)
        score = int(num(r.get("score"), 50))
        rows.append(dict(id=r["id"], name=r.get("name") or r["id"], client_id=r["clientid"],
                         stage=(r.get("stage") or "new").lower(), source=r.get("source") or "Unknown",
                         value=num(r.get("value")), score=max(0, min(100, score)), created=created))
    db.replace_entity("leads", rows)
    report["leads"] = {"accepted": len(rows), "rejected": len(bad), "errors": bad[:10]}

    for entity, res in report.items():
        db.record_import("cli", entity, f"data/{entity}.csv",
                         res["accepted"], res["rejected"], 0, "tools/load_csv.py")
    return report


def verify() -> list[str]:
    """Assertions that must hold after any load. Cheap, and they catch real damage."""
    c = db.connect()
    problems = []
    q = lambda s: c.execute(s).fetchone()[0]

    if q("SELECT COUNT(*) FROM agents a LEFT JOIN clients c ON a.client_id=c.id WHERE c.id IS NULL"):
        problems.append("orphaned agents (agent.client_id with no client)")
    if q("SELECT COUNT(*) FROM appointments a LEFT JOIN clients c ON a.client_id=c.id WHERE c.id IS NULL"):
        problems.append("orphaned appointments by client")
    if q("SELECT COUNT(*) FROM appointments a LEFT JOIN agents g ON a.agent_id=g.id WHERE g.id IS NULL"):
        problems.append("orphaned appointments by agent")
    if q("SELECT COUNT(*) FROM leads l LEFT JOIN clients c ON l.client_id=c.id WHERE c.id IS NULL"):
        problems.append("orphaned leads")
    if q("SELECT COUNT(*) FROM appointments WHERE value < 0 OR hm < 0 OR hm > 1439"):
        problems.append("appointments with impossible value or time")
    if q("SELECT COUNT(*) FROM agents WHERE ended_at IS NOT NULL AND ended_at < started_at"):
        problems.append("agents that ended before they started")
    if q("SELECT COUNT(*) FROM clients") == 0:
        problems.append("no clients loaded")
    return problems


if __name__ == "__main__":
    t0 = time.time()
    rep = load()
    print(f"loaded in {time.time()-t0:.2f}s\n")
    for entity, res in rep.items():
        flag = "" if not res["rejected"] else f"  ({res['rejected']} rejected)"
        print(f"  {entity:<10} {res['accepted']:>6} rows{flag}")
        for line, why in res["errors"]:
            print(f"      line {line}: {why}")
    print()
    s = db.stats()
    print(f"  schema v{s['schemaVersion']}  ·  {s['sizeBytes']/1024:.0f} KB  ·  "
          f"{s['journalMode']}  ·  foreign_keys={s['foreignKeys']}")
    if "--verify" in sys.argv:
        problems = verify()
        print("\n  integrity:", "PASS — no violations" if not problems else "FAIL")
        for p in problems:
            print("    ✗", p)
        sys.exit(1 if problems else 0)
