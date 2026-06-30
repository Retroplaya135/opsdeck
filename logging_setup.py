"""
Structured logging, persistent sink, and in-process metrics.

Three separate concerns kept separate on purpose:

  * LOGS answer "what did the process do". Structured JSON, one object per
    line, correlated by request id. Written to stderr AND a rotating file so
    a restart does not erase the evidence for the incident that caused it.
  * METRICS answer "how is it behaving in aggregate". Counters and histograms
    exposed in Prometheus text format. Cheap enough to update on every
    request, which a log line is not when you want a p95.
  * The AUDIT log (auth_store) answers "who did what". Different retention,
    different audience, deliberately not mixed in here.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from bisect import insort
from collections import defaultdict, deque
from pathlib import Path

VAR = Path(os.environ.get("OPSDECK_VAR_DIR", Path(__file__).resolve().parent / "var"))
LOG_FILE = VAR / "app.log"
MAX_BYTES = 5 * 1024 * 1024
KEEP = 3

_local = threading.local()
LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
MIN_LEVEL = LEVELS.get(os.environ.get("OPSDECK_LOG_LEVEL", "info").lower(), 20)
_lock = threading.Lock()

# Recent lines kept in memory so an operator can read the log through the UI
# without shell access to the host.
RING = deque(maxlen=500)


# ───────────────────────────── correlation ─────────────────────────────

def new_request_id() -> str:
    rid = uuid.uuid4().hex[:12]
    _local.request_id = rid
    return rid


def request_id() -> str | None:
    return getattr(_local, "request_id", None)


def clear_request() -> None:
    _local.request_id = None


# ───────────────────────────── rotation ─────────────────────────────

def _rotate_if_needed() -> None:
    try:
        if not LOG_FILE.exists() or LOG_FILE.stat().st_size < MAX_BYTES:
            return
        # Shift .2 -> .3, .1 -> .2, current -> .1. Oldest falls off the end.
        for i in range(KEEP - 1, 0, -1):
            src, dst = LOG_FILE.with_suffix(f".log.{i}"), LOG_FILE.with_suffix(f".log.{i+1}")
            if src.exists():
                os.replace(src, dst)
        os.replace(LOG_FILE, LOG_FILE.with_suffix(".log.1"))
    except OSError:
        pass


def log(level: str, event: str, **fields) -> None:
    if LEVELS.get(level, 0) < MIN_LEVEL:
        return
    rec = {"ts": round(time.time(), 3), "level": level, "event": event}
    rid = request_id()
    if rid:
        rec["rid"] = rid
    rec.update(fields)
    line = json.dumps(rec, separators=(",", ":"), default=str)
    # Single write under one lock: interleaved partial lines from concurrent
    # threads would make the stream unparseable, which defeats the format.
    with _lock:
        RING.append(rec)
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
        try:
            VAR.mkdir(exist_ok=True)
            _rotate_if_needed()
            with open(LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            pass          # never let a full disk take down the request


def debug(event, **f): log("debug", event, **f)
def info(event, **f):  log("info", event, **f)
def warn(event, **f):  log("warn", event, **f)
def error(event, **f): log("error", event, **f)


def recent(limit: int = 200, level: str | None = None, event: str | None = None) -> list[dict]:
    with _lock:
        items = list(RING)
    if level:
        floor = LEVELS.get(level, 0)
        items = [r for r in items if LEVELS.get(r.get("level", ""), 0) >= floor]
    if event:
        items = [r for r in items if event in str(r.get("event", ""))]
    return list(reversed(items))[:limit]


# ───────────────────────────── metrics ─────────────────────────────

class Metrics:
    """
    Counters plus latency quantiles. Keeps a bounded sample per key rather
    than every observation, so memory does not grow with traffic; quantiles
    are computed off the reservoir at scrape time.
    """

    def __init__(self, reservoir: int = 512):
        self._counters: dict[tuple, int] = defaultdict(int)
        self._samples: dict[str, list[float]] = defaultdict(list)
        self._reservoir = reservoir
        self._lock = threading.Lock()
        self.started = time.time()

    def inc(self, name: str, labels: tuple = (), n: int = 1) -> None:
        with self._lock:
            self._counters[(name, labels)] += n

    def observe(self, name: str, value: float) -> None:
        with self._lock:
            arr = self._samples[name]
            if len(arr) < self._reservoir:
                insort(arr, value)
            else:
                # Drop the median rather than a tail value: keeping both tails
                # is what makes p50/p95 meaningful once the reservoir is full.
                del arr[len(arr) // 2]
                insort(arr, value)

    def quantile(self, name: str, q: float) -> float:
        with self._lock:
            arr = self._samples.get(name) or []
            if not arr:
                return 0.0
            idx = min(len(arr) - 1, max(0, int(round(q * (len(arr) - 1)))))
            return arr[idx]

    def snapshot(self) -> dict:
        with self._lock:
            counters = {f"{n}{list(l)}" if l else n: v for (n, l), v in self._counters.items()}
            samples = {k: len(v) for k, v in self._samples.items()}
        return {"uptime": time.time() - self.started, "counters": counters, "samples": samples}

    def prometheus(self, extra: dict | None = None) -> str:
        """Prometheus text exposition format (version 0.0.4)."""
        out: list[str] = []
        with self._lock:
            counters = dict(self._counters)
            names = list(self._samples.keys())

        out.append("# HELP opsdeck_uptime_seconds Process uptime.")
        out.append("# TYPE opsdeck_uptime_seconds gauge")
        out.append(f"opsdeck_uptime_seconds {time.time() - self.started:.1f}")

        grouped: dict[str, list] = defaultdict(list)
        for (name, labels), value in counters.items():
            grouped[name].append((labels, value))
        for name, entries in sorted(grouped.items()):
            out.append(f"# TYPE {name} counter")
            for labels, value in sorted(entries, key=lambda e: str(e[0])):
                if labels:
                    lbl = ",".join(f'{k}="{v}"' for k, v in labels)
                    out.append(f"{name}{{{lbl}}} {value}")
                else:
                    out.append(f"{name} {value}")

        for name in sorted(names):
            out.append(f"# TYPE {name} summary")
            for q in (0.5, 0.95, 0.99):
                out.append(f'{name}{{quantile="{q}"}} {self.quantile(name, q):.3f}')

        for key, value in sorted((extra or {}).items()):
            if isinstance(value, bool):
                value = int(value)
            if isinstance(value, (int, float)):
                out.append(f"# TYPE {key} gauge")
                out.append(f"{key} {value}")
        return "\n".join(out) + "\n"


METRICS = Metrics()
