"""
OpenAPI 3.1 description of the HTTP surface.

Kept as a Python literal rather than a static file so it cannot drift from the
server that serves it: both live in the same repository, and the contract test
in run-tests.sh asserts every documented path is actually routed.
"""
from __future__ import annotations

SPEC = {
    "openapi": "3.1.0",
    "info": {
        "title": "Opsdeck API",
        "version": "1.0.0",
        "description": (
            "Operations console for a booked-appointment programme.\n\n"
            "**Authentication** is a session cookie obtained from `POST /api/login`. "
            "The cookie is HttpOnly and SameSite=Strict, and gains `Secure` when the "
            "server runs with TLS.\n\n"
            "**CSRF**: every authenticated `POST` must echo the token from `GET /api/me` "
            "in an `X-CSRF-Token` header. Requests without it are rejected with 403.\n\n"
            "**Tenant scope** is applied in SQL when data is read. A `manager` or "
            "`client` account cannot retrieve rows outside its assigned accounts "
            "through any endpoint, including exports."
        ),
    },
    "servers": [{"url": "http://127.0.0.1:8420", "description": "Local"}],
    "tags": [
        {"name": "auth", "description": "Sign-in and identity"},
        {"name": "data", "description": "Scoped entity reads"},
        {"name": "admin", "description": "Administrator-only surfaces"},
        {"name": "ops", "description": "Health, metrics, telemetry"},
    ],
    "components": {
        "securitySchemes": {
            "sessionCookie": {"type": "apiKey", "in": "cookie", "name": "opsdeck_session"},
            "csrfHeader": {"type": "apiKey", "in": "header", "name": "X-CSRF-Token"},
        },
        "schemas": {
            "Error": {
                "type": "object",
                "properties": {"error": {"type": "string"}, "retryAfter": {"type": "integer"}},
                "required": ["error"],
            },
            "Identity": {
                "type": "object",
                "properties": {
                    "username": {"type": "string"},
                    "role": {"type": "string", "enum": ["admin", "manager", "client", "prospect"]},
                    "clients": {"type": ["array", "null"], "items": {"type": "string"},
                                "description": "Client ids in scope; null means unrestricted."},
                    "unrestricted": {"type": "boolean"},
                    "clientDataEntitled": {"type": "boolean",
                        "description": "False for roles served no client data at all."},
                    "internal": {"type": "boolean",
                        "description": "False for an outside party; gates internal-only collections."},
                    "roleHelp": {"type": "string"},
                    "csrfToken": {"type": "string"},
                    "schemaVersion": {"type": "integer"},
                },
            },
        },
        "responses": {
            "Unauthenticated": {"description": "No valid session",
                                "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}},
            "Forbidden": {"description": "Authenticated but not permitted, or CSRF token missing",
                          "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}},
        },
    },
    "security": [{"sessionCookie": []}],
    "paths": {
        "/api/login": {
            "post": {
                "tags": ["auth"], "summary": "Exchange credentials for a session",
                "security": [],
                "requestBody": {"required": True, "content": {"application/json": {"schema": {
                    "type": "object", "required": ["username", "password"],
                    "properties": {"username": {"type": "string"}, "password": {"type": "string"}}}}}},
                "responses": {
                    "200": {"description": "Session and CSRF cookies issued"},
                    "401": {"$ref": "#/components/responses/Unauthenticated"},
                    "423": {"description": "Account locked after repeated failures"},
                    "429": {"description": "Rate limited by client IP"},
                },
            }
        },
        "/logout": {"get": {"tags": ["auth"], "summary": "Clear the session cookie",
                            "responses": {"303": {"description": "Redirect to /login"}}}},
        "/api/me": {"get": {"tags": ["auth"], "summary": "Identity, scope and CSRF token",
                            "responses": {"200": {"description": "Current identity", "content": {
                                "application/json": {"schema": {"$ref": "#/components/schemas/Identity"}}}},
                                "401": {"$ref": "#/components/responses/Unauthenticated"}}}},
        "/api/data/{kind}": {
            "get": {
                "tags": ["data"],
                "summary": "Scoped entity export as CSV",
                "description": "Rows outside the caller's scope are excluded by the query, not filtered afterwards.",
                "parameters": [
                    {"name": "kind", "in": "path", "required": True,
                     "schema": {"type": "string", "enum": ["clients", "agents", "appts", "leads"]}},
                    {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 50000, "maximum": 100000}},
                    {"name": "offset", "in": "query", "schema": {"type": "integer", "default": 0}},
                ],
                "responses": {
                    "200": {"description": "CSV rows",
                            "headers": {
                                "ETag": {"schema": {"type": "string"}},
                                "X-Total-Count": {"schema": {"type": "integer"},
                                                  "description": "Rows in scope before pagination"},
                                "X-Returned-Count": {"schema": {"type": "integer"}}},
                            "content": {"text/csv": {"schema": {"type": "string"}}}},
                    "304": {"description": "Unchanged since the supplied If-None-Match"},
                    "401": {"$ref": "#/components/responses/Unauthenticated"},
                    "404": {"description": "Unknown dataset, or no rows in scope"},
                },
            }
        },
        "/api/event": {
            "post": {"tags": ["ops"], "summary": "Record a UI event in the audit trail",
                     "security": [{"sessionCookie": [], "csrfHeader": []}],
                     "responses": {"200": {"description": "Recorded"},
                                   "400": {"description": "Unknown action"},
                                   "403": {"$ref": "#/components/responses/Forbidden"}}}
        },
        "/api/client-error": {
            "post": {"tags": ["ops"], "summary": "Report a browser-side error to the server log",
                     "security": [{"sessionCookie": [], "csrfHeader": []}],
                     "responses": {"200": {"description": "Logged"},
                                   "403": {"$ref": "#/components/responses/Forbidden"}}}
        },
        "/api/audit": {"get": {"tags": ["admin"], "summary": "Audit trail and aggregate counts",
                               "responses": {"200": {"description": "Entries, newest first"},
                                             "403": {"$ref": "#/components/responses/Forbidden"}}}},
        "/api/users": {"get": {"tags": ["admin"], "summary": "Accounts, roles and scope",
                               "responses": {"200": {"description": "Account list"},
                                             "403": {"$ref": "#/components/responses/Forbidden"}}}},
        "/api/db": {"get": {"tags": ["admin"], "summary": "Database statistics and import history",
                            "responses": {"200": {"description": "Stats"},
                                          "403": {"$ref": "#/components/responses/Forbidden"}}}},
        "/api/logs": {"get": {"tags": ["admin"], "summary": "Recent structured log lines",
                              "parameters": [
                                  {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 200}},
                                  {"name": "level", "in": "query",
                                   "schema": {"type": "string", "enum": ["debug", "info", "warn", "error"]}},
                                  {"name": "event", "in": "query", "schema": {"type": "string"}}],
                              "responses": {"200": {"description": "Log entries and metric counters"},
                                            "403": {"$ref": "#/components/responses/Forbidden"}}}},
        "/metrics": {"get": {"tags": ["admin"], "summary": "Prometheus exposition",
                             "responses": {"200": {"description": "text/plain; version=0.0.4"},
                                           "403": {"$ref": "#/components/responses/Forbidden"}}}},
        "/healthz": {"get": {"tags": ["ops"], "summary": "Liveness — never touches the database",
                             "security": [], "responses": {"200": {"description": "Process is up"}}}},
        "/readyz": {"get": {"tags": ["ops"], "summary": "Readiness — verifies schema version",
                            "security": [],
                            "responses": {"200": {"description": "Ready to serve"},
                                          "503": {"description": "Migrating or unavailable"}}}},
        "/openapi.json": {"get": {"tags": ["ops"], "summary": "This document",
                                  "security": [], "responses": {"200": {"description": "OpenAPI 3.1"}}}},
    },
}
