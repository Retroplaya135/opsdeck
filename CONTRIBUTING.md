# Contributing

Keep analytics deterministic, enforce client scopes in database queries, and report rejected or coerced import values. Add a focused test for metric, schema, authorization, or ingestion changes.

```bash
bash run-tests.sh
```

With Chrome installed, run `A11Y=1 bash run-tests.sh` for UI changes. Use synthetic data; keep customer exports, credentials, call recordings, financial records, and runtime files from `var/` out of the repository.
