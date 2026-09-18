A failed Lilly-1 W0 attempt produced only `transport_error` and omitted the
observed open timestamp. Undici also discarded the structured request cause,
so that receipt could not distinguish failure before or after socket opening.

Retain `openedAt`, a fixed failure phase, an allowlisted transport error code and
an exposed outer HTTP status in short and continuity receipts. A small interceptor
uses the existing per-attempt page dispatcher and forwards its original callbacks.
The observer freezes evidence before cleanup; error text, headers, bodies and
credentials never enter these fields. Unknown causes and internal CONNECT status
remain unknown. Existing routing, authentication, deadlines and retry behavior
are unchanged. D338 and the runbook document the evidence limits.

Validation before opening this PR:

```text
pnpm check                                      PASS
  strictness-ratchet: 1897 existing errors, no new debt
  Test Files: 334 passed
  Tests:      3835 passed | 9 skipped
  lint and dashboard build: PASS
pnpm exec vitest run --no-file-parallelism tests/fansly-probe-context.integration.test.ts
  Test Files: 1 passed
  Tests:      16 passed (Docker Postgres)
short / continuity / binding operator bundles   PASS
git diff --check                                PASS
```

Source hashes were unchanged through both serial runs. Unit coverage includes
real local HTTP CONNECT and SOCKS5 transports, TLS rejection and outer HTTP 403,
pre/post-open and send failures, first-failure preservation, callback delegation
and secret/getter redaction. Two independent reviews (transport and readability)
found no unresolved issues; a getter allowlist bypass was fixed before the runs.
Their reports are included in the investigation directory.

This is operator diagnostic code; no API/worker/scheduler deployment or new flag
is needed. No live request was made for this PR. The earlier 158 ms attempt still
has an unknown cause and provides no W0, savings or reader-latency acceptance.
