<div align="center">
  <img src="docs/cover.png" alt="Opsdeck" width="100%">
  <h3>A local operations console with inspectable data, access, and analytics.</h3>
  <p>
    <img alt="Status: local reference" src="https://img.shields.io/badge/status-local_reference-6d28d9">
    <img alt="Python 3.11 or newer" src="https://img.shields.io/badge/Python-3.11%2B-3776ab?logo=python&logoColor=white">
    <img alt="Node.js 20 or newer for checks" src="https://img.shields.io/badge/checks-Node.js_20%2B-339933?logo=nodedotjs&logoColor=white">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0f766e">
  </p>
  <p>
    <a href="#overview">Overview</a> ·
    <a href="#system-map">System map</a> ·
    <a href="#quick-start">Quick start</a> ·
    <a href="#verification">Verification</a> ·
    <a href="#deployment-boundary">Boundary</a>
  </p>
</div>

## Overview

Opsdeck is a local operations console for a booked-appointment programme. It brings client activity, appointments, leads, callers, reporting, service requests, feedback, workforce views, payroll, profit and loss, access, and audit data into one repository that can be read from the browser surface down to the SQL query.

Opsdeck is an engineering reference, not a hosted service. Its Python server uses only the standard library, its data layer is SQLite, and its browser application is plain HTML, CSS, and ES modules. There is no application framework, package install, or frontend build step between the source and the running system.

That constraint keeps the important behavior visible. Account scope is applied in SQL instead of hidden in the interface. CSV imports report rejected and coerced values. Analytics are implemented as deterministic functions with known-answer tests. The HTTP contract is described beside the server and checked against a live isolated process. Runtime files stay outside the source dataset.

The bundled records are synthetic. They provide enough relationships and volume to exercise the console without including customer information, but no number in the repository should be represented as a real business result.

## System map

| Layer | Responsibility |
| --- | --- |
| Browser shell | Navigation, filters, tables, charts, import/export controls, account-aware views, and error handling. |
| Analytics modules | Statistical summaries, forecasting, anomaly and trend analysis, funnels, cohorts, experiments, segmentation, and capacity calculations. |
| HTTP server | Static delivery, authentication, signed sessions, CSRF checks, API routing, access decisions, health, and operational endpoints. |
| Authorization | PBKDF2 password records, lockout, roles, client assignments, internal/external boundaries, and security audit events. |
| SQLite | Schema migrations, referential integrity, indexed reads, import provenance, and client scope enforced in queries. |
| Local runtime | Database, account store, structured logs, and audit records under the configurable runtime directory. |

The normal request path is browser → authenticated HTTP route → role and client scope → parameterized SQLite query → CSV or JSON response. A manager or client request cannot retrieve rows outside its assigned client IDs because the database predicate is added before the rows leave SQLite. An empty scope means no rows; it is not treated as unrestricted access.

## Implemented capabilities

### Operational console

The browser application includes overview, insights, reporting, patterns, appointments, engagement, leads, clients, service requests, feedback, callers, team, onboarding, payroll, P&L, audit, access, and settings surfaces. Views share one in-memory state and can load the server's scoped client, caller, appointment, and lead datasets.

CSV support covers quoted fields, escaped quotes, byte-order marks, currency symbols, thousands separators, accounting negatives, percentages, Excel serial dates, case-variant enums, duplicates, and orphaned references. Ambiguous values are rejected instead of guessed, and every coercion is included in the import report.

### Analytics

The analytics layer includes descriptive statistics, Pearson and Spearman relationships, linear and Theil–Sen trends, Mann–Kendall tests, autocorrelation and seasonal decomposition, robust MAD anomalies, bootstrapped changepoints, Holt–Winters forecasts, logistic scoring, ROC AUC, k-means segmentation, Erlang-B/Erlang-C capacity calculations, two-proportion tests, power estimates, Wilson intervals, and cohort matrices.

These are local deterministic calculations, not external services. The repository's synthetic case study uses a fixed seed so the same source state produces the same results. The interface exposes operational summaries and selected analyses while the pure functions remain independently testable in Node and the browser.

### Accounts and data boundaries

Accounts use PBKDF2-HMAC-SHA256 with a per-user salt. Repeated failed sign-ins trigger account lockout, login requests are rate-limited by client address, session cookies are HttpOnly and SameSite=Strict, and authenticated writes require a CSRF token. Sessions are HMAC-signed with a per-process key and intentionally end when the process restarts.

| Role | Data boundary |
| --- | --- |
| `admin` | Unrestricted client data plus administrative surfaces. |
| `manager` | Assigned client IDs and internal operational surfaces. |
| `client` | Assigned client data without internal-only collections. |
| `prospect` | No client data, even if client IDs are accidentally assigned. |

Security-relevant events append to a JSONL audit trail. Structured application logs and in-process metrics are available to administrators, with health, readiness, OpenAPI, and Prometheus-format endpoints provided by the server.

## Quick start

Opsdeck requires Python 3.11 or newer. Node.js 20 or newer is only needed for the JavaScript and browser checks.

```bash
git clone https://github.com/Retroplaya135/opsdeck.git
cd opsdeck

python3 tools/load_csv.py --verify
python3 server.py
```

Open `http://127.0.0.1:8420`. On the first run, the server creates an `admin` account and prints a generated password once. Change it from another terminal with `python3 server.py passwd admin`.

The loader validates the bundled synthetic CSV files, applies migrations, replaces the corresponding tables, and records import counts. Re-running it is the supported way to restore the sample dataset.

## Practical usage

Use `python3 server.py adduser <username> <role> [client-ids]` to create an account, `python3 server.py users` to inspect accounts, and `python3 server.py deluser <username>` to remove one. Password prompts are interactive when a terminal is attached. A non-admin account without client IDs sees no client rows.

Runtime state defaults to `var/` and is excluded from version control. Keep account files, the database, audit entries, imported business data, certificates, and private keys out of the repository.

| Environment variable | Purpose |
| --- | --- |
| `OPSDECK_VAR_DIR` | Move the database, account store, logs, and audit files to another directory. |
| `OPSDECK_PORT` | Change the HTTP port from `8420`. |
| `OPSDECK_HOST` | Change the bind address from `127.0.0.1`; wider binding changes the security boundary. |
| `OPSDECK_ADMIN_PASSWORD` | Supply the first administrator password instead of generating one. |
| `OPSDECK_LOG_LEVEL` | Select the minimum structured-log level. |
| `OPSDECK_TLS_CERT` / `OPSDECK_TLS_KEY` | Enable TLS 1.2+ using a certificate and private key. Both are required. |

The live API description is served at `/openapi.json`. Data endpoints return scoped CSV and include total/returned counts plus an ETag. Administrator endpoints expose account summaries, database/import status, recent logs, audit aggregates, and metrics. `/healthz` checks process liveness without touching the database; `/readyz` verifies that the expected schema is available.

## Verification

```bash
bash run-tests.sh
A11Y=1 bash run-tests.sh
```

The default script checks Python and JavaScript syntax, 79 headless JavaScript assertions, the ES-module graph, CSV fixture ingestion, migrations, index use, referential integrity, an isolated live server, the OpenAPI route contract, password policy, SQL scope, TLS cookie behavior, and a source secret scan.

Setting `A11Y=1` also starts an isolated static fixture server and runs the browser suites plus contrast and DOM accessibility checks. Those browser checks require a compatible Chrome installation. A fresh local audit passed all 44 script-level checks with the browser and accessibility path enabled.

The browser smoke suite confirms that each route renders, avoids obvious invalid values, and preserves expected structure. It does not prove that every displayed metric is correct. Metric changes should add a known-answer assertion at the pure analytics or aggregate layer rather than relying only on a rendered-page check.

## Repository map

| Path | Responsibility |
| --- | --- |
| `server.py` | HTTP service, session handling, CSRF, access gates, routes, TLS, and account CLI. |
| `auth_store.py` | Password records, roles, client scope, lockout, and audit events. |
| `db.py` | SQLite connection policy, migrations, indexes, imports, and scoped queries. |
| `api_spec.py` | OpenAPI 3.1 contract served by the running application. |
| `logging_setup.py` | Structured local logs, rotation, request context, and in-process metrics. |
| `index.html` | Application shell, visual tokens, navigation, and view containers. |
| `js/analytics.js` | Pure statistical and capacity calculations. |
| `js/aggregates.js` | Operational windows, client/caller summaries, funnels, and P&L aggregates. |
| `js/ingest.js` / `js/csvio.js` | CSV parsing, coercion, validation, replacement, and export. |
| `js/app.js` / `js/views.analytics.js` | Routing, state integration, interaction, and rendered operational views. |
| `tools/` | Data loading and checks for modules, parsing, indexes, API contracts, browsers, and accessibility. |
| `data/` / `fixtures/` | Synthetic source records and deliberately messy import cases. |

## Deployment boundary

Opsdeck is complete as a local reference and intentionally incomplete as an internet-facing service. The default loopback bind is part of that design. Binding to another interface requires an explicit transport, identity, session, monitoring, backup, and incident-response design rather than a single environment-variable change.

Sessions are held in process memory and end on restart. TLS is optional rather than mandatory. The account store is a local JSON file. The audit trail is append-only through the application API but is not hash-chained or protected from a hostile machine administrator. SQLite is appropriate for this local, read-heavy shape; the repository does not provide multi-node coordination, failover, or online backup automation.

The sample data is modelled, not customer data. There is no claim that its distributions, forecasts, staffing recommendations, or financial outputs describe an operating company. Before using real data, define retention, access review, backup/restore, deletion, and disclosure rules, then re-run the import and display checks against representative sanitized fixtures.

The browser application still contains a large shared-state module. That trade-off keeps deployment dependency-free, but it limits parallel development and makes view-level regression coverage important. The current suite is strongest at pure calculations, ingest, contracts, and structural rendering; it is not a substitute for an independent security review.

## Documentation

- [OpenAPI source](api_spec.py), also served at `/openapi.json`
- [Browser unit-suite runner](tests.html)
- [Route smoke runner](smoke.html)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Contributing, security, and license

Keep analytics deterministic, enforce client scope in database queries, and report rejected or coerced import values. Add a focused known-answer test for metric, schema, authorization, or ingestion changes. Use synthetic fixtures only, and run the browser path for interface work. See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository rules.

Report authentication, authorization, session, SQL-scope, import, or path-handling vulnerabilities through the private channel described in [SECURITY.md](SECURITY.md). Do not include operational records, customer exports, credentials, recordings, or financial data in a report.

Opsdeck is available under the [MIT License](LICENSE).
