W0 lacked a REST identity receipt tied to the exact credential and route generation used by the receiver. The ordinary page verification endpoint also writes application state. Add a separate operator preflight that performs one fixed `/account/me` GET through the existing page dispatcher, checks the stored account ID, and emits bounded, sanitized evidence.

The continuity launcher requires that private receipt; the existing short invocation can optionally consume it. Both check the current generation before connecting. Continuity preserves the original receipt across all three phases. Known refusals retain distinct safe reasons and zero socket attempts. D336 and the two runbooks describe the workflow and its limits. Overall socket scope, fan-out, presence, recovery and W0 acceptance remain unverified.

Validation on the final source:

- `pnpm check`: PASS — typecheck ratchet and lint, **3,821 tests passed / 9 skipped in 333 files**, dashboard build. Existing strictness debt remains 1,897; no new debt.
- `pnpm exec vitest run --no-file-parallelism tests/fansly-probe-context.integration.test.ts`: PASS — **16 Docker-PostgreSQL tests**, including consistent account/session/route snapshots, read-only enforcement and unchanged captured facts/credentials/pacing.
- `tests/fansly-binding-transport.test.ts`: **15 loopback transport tests passed**, also included in the final full unit run. HTTP CONNECT and SOCKS routes, exact GET and headers, wrong/missing identity, HTTP errors, redirect refusal, 15-second deadline, body cap, cancellation, proxy/TLS failure, zero direct fallback and redaction.
- Serial Python launcher suites: **4 + 10 + 8 tests passed** (`fansly-binding-launcher.py`, `fansly-probe-launcher.py`, `fansly-continuity-launcher.py`). They cover admission, immutable private handoff, cancellation and owned cleanup.
- All three operator bundles build; invalid-argument executions return the expected fixed error without configuration or provider access.
- Independent source and readability review: initial P3 concerning lost refusal evidence fixed; repeat review found no remaining P1/P2/P3.

No live provider experiment, production change or new measurement was performed for this PR. The change adds no API, database migration or production flag. Live use still requires the accepted W0 experiment prerequisites; savings and event-to-reader latency are not claimed.
