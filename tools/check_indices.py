#!/usr/bin/env python3
"""Assert the hot queries use an index. A missing index does not fail a test
suite — it just makes the console slowly get worse as data grows, which is
exactly the kind of regression nobody notices until it is painful."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db

HOT = [
    ("scoped appointments", "SELECT * FROM appointments WHERE client_id IN (?,?) ORDER BY day", ("c1", "c2")),
    ("appointments by day", "SELECT * FROM appointments WHERE day >= ?", (0,)),
    ("scoped leads",        "SELECT * FROM leads WHERE client_id IN (?)", ("c1",)),
    ("agents by client",    "SELECT * FROM agents WHERE client_id = ?", ("c1",)),
]

db.connect()
bad = []
for label, sql, args in HOT:
    detail = " | ".join(r["detail"] for r in db.connect().execute("EXPLAIN QUERY PLAN " + sql, args))
    if "USING INDEX" not in detail and "USING COVERING INDEX" not in detail:
        bad.append(f"{label}: {detail}")

if bad:
    print("queries falling back to a full scan:")
    for b in bad:
        print("  -", b)
    sys.exit(1)
print(f"all {len(HOT)} hot queries use an index")
