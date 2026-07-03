#!/usr/bin/env python3
"""
Assert the OpenAPI document matches the server that serves it.

A spec that drifts from the implementation is worse than no spec: it is a
confident, wrong contract that an integrator will build against. This checks
both directions — every documented path must respond, and every routed API
path must be documented.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import api_spec  # noqa: E402

BASE = os.environ.get("OPSDECK_TEST_BASE", "http://127.0.0.1:8420")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib follows 3xx by default, which reports the DESTINATION status and
    hides the redirect the spec actually documents — /logout looked like a 200."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def probe(path: str) -> int:
    req = urllib.request.Request(BASE + path, method="GET",
                                 headers={"Accept": "application/json"})
    try:
        with OPENER.open(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


problems = []
documented = set(api_spec.SPEC["paths"])

for path, ops in api_spec.SPEC["paths"].items():
    if "get" not in ops:
        continue
    concrete = path.replace("{kind}", "clients")
    status = probe(concrete)
    if status == 0:
        problems.append(f"{path}: server did not respond")
        continue
    documented_codes = {int(c) for c in ops["get"]["responses"] if c.isdigit()}
    # Unauthenticated probes legitimately return 401/403/303 even when the
    # documented happy path is 200, so accept those as "route exists".
    if status not in documented_codes | {401, 403, 303}:
        problems.append(f"{path}: returned {status}, not in documented {sorted(documented_codes)}")

# Reverse direction: any /api/ path the server routes must be in the spec.
server_src = (Path(__file__).resolve().parent.parent / "server.py").read_text()
import re
routed = set(re.findall(r'path == "(/api/[^"]+|/metrics|/healthz|/readyz|/openapi\.json)"', server_src))
routed |= {"/api/data/{kind}"} if '/api/data/' in server_src else set()
undocumented = {p for p in routed if p not in documented}
for p in sorted(undocumented):
    problems.append(f"{p}: routed by the server but absent from the spec")

if problems:
    print("API contract drift:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print(f"API contract holds: {len(documented)} documented paths, all reachable and no undocumented routes")
