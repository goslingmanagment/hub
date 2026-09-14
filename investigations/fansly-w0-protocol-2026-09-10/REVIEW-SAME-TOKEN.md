# Independent review: existing-session W0 probe

14 September 2026, Moscow. Reviewer: `review_w0_runner`.

**No unresolved code finding in the reviewed probe. The subsequent live receipt
is audited separately below.**
This review covers the bounded observer, stored
credential/egress resolution, decoder refactor, bundler, isolated launcher and
associated test cases. The reviewer performed static inspection only, with no
test execution or production access.

The reported findings are fixed:

- The runner uses the existing trusted runtime DATABASE_URL, sets connection
  defaults to read-only and verifies READ ONLY and REPEATABLE READ inside each
  credential snapshot before lookup. It has no role switch, grant or fallback.
- Exit zero requires the observation deadline, a received type-1 frame and
  equal before/after credential-route generations. This is not a W0 gate pass.
- Configuration disables ambient dotenv loading, preserving JSON-only stdout.
- The launcher uses an immutable image, 256 MiB memory including swap,
  0.25 CPU, 64 PIDs and a read-only filesystem. Its independent 150-second
  timeout terminates Docker attach and attempts removal of its UUID-named
  container. SIGTERM enters cleanup; attach stop failure cannot skip removal.
  Unconfirmed cleanup is recorded and cannot yield a successful launcher exit.

The token is loaded in the isolated process, sent only in native socket auth,
and omitted from reports, errors and command arguments. Transport remains
page-proxied and TLS-verified. No REST request, pacing call, business write,
credential change or retry is introduced. Before/after generation equality
does not prove that no transient change occurred between snapshots.

The earlier reviewer interpretation requiring the exact `read_only` username
for this executable was too broad. The owner's explicit database-role rule
applies to production psql diagnostics; token reuse was separately approved.
The final probe uses the existing trusted runtime credential path with verified
read-only transactions. It does not obtain new privileges. The retained
[permission receipt](evidence/same-token-20260913T220004Z/production-permission-read.json)
showed that the discarded strict-username implementation could not read
credentials or proxies at 2026-09-13 22:08:30 UTC. That historical result does not
establish a blocker for the final runtime-configuration path or prove a live
connection. Integration cases exercise the existing runtime identity, reject an
actual UPDATE with SQLSTATE 25006, and retain the missing-privilege refusal.

Mocked launcher cases cover cancellation, timeout, attach wait failure,
resource flags and private inputs. The earlier [bundled invalid-argument receipt](evidence/same-token-20260913T220004Z/bundle-invalid-args-final.json)
contains empty stdout and the fixed sanitized error. The implementing agent's
`pnpm check`, serial Docker-Postgres and launcher results are recorded
separately in [validation.json](evidence/same-token-20260913T220004Z/validation.json);
they were not executed by this reviewer.

Binding, fan-out, presence, six-hour continuity, gap recovery, savings and
reader latency remain outside the evidence provided by this short probe.

Reviewed source SHA-256:

```text
c5f9b788636fbb3244dde991461bd2e00fce4b60c381039d58f508c196a1eaed  scripts/fansly-ws/probe.ts
f7115581fe60e2ece82b923208af2894859631186430b5c66892d02d6ce19f85  scripts/fansly-ws/probe-cli.ts
b347dcca1399a0d708802a32fbbe1730ab6680187126cb5c812962ff95154b23  scripts/fansly-ws/probe-observer.ts
d501ad836641bc14eda0a73d3094475926cea3aa0022ce88072ebda51890b56a  scripts/fansly-ws/build-probe.mjs
13c592d9b5b7e34e4761e4ab80af37ff1d70d44d31502727e7d8b7666f2da6e8  scripts/fansly-ws/run-probe.py
6a2bbb36a4f169ed971c11fb38b05a109f1e1bc006d610f97acb871dd8a92e25  apps/runtime/src/services/egress/fansly-probe-context.ts
46a17c9c049c6ffb64b84b5a5aa67729195aeba54425c876f1a3c452ae08d021  apps/runtime/src/services/egress/fansly-probe-socket.ts
21a10225941f594cfc4cb703911b3dc7ea47f427297928c7c97562b630dddfdb  apps/runtime/src/services/egress/resolver.ts
b436ce47e6574337540895f4d4619e208a2e3c654b11fc3a3f1897d3549807ab  apps/runtime/src/services/page-context.ts
```

## Live receipt audit — 14 September 2026, Moscow

The reviewer inspected the retained [live receipt](evidence/same-token-20260913T220004Z/live-receipt.json)
and [invocation](evidence/same-token-20260913T220004Z/live-invocation.json) locally;
no additional production command, socket or test was executed by the reviewer.

The `lilly-1` observation ran from 2026-09-13 22:28:13.308 to 22:30:13.373 UTC
(120.065 seconds). One connection received and retained nine frames: one type-1
session response, five pongs and three service frames with serviceId 4/eventType 2.
None was rejected or truncated. The service-frame payloads were not retained,
so they must not be described as confirmed DM delivery. The receipt reports
zero REST requests, deadline completion and equal before/after generations.
This supports short-lived transport/auth compatibility with the existing REST
session; it does not establish account binding or business-event completeness.

The launcher exited zero with no timeout and confirmed attach/container cleanup.
The returned evidence also reports removal of the temporary environment file and
absence of the owned container; stderr is empty. The exported fields contain
receipt times, counters, fixed diagnostic labels, bounded numeric codes and a
generation fingerprint. No token, encryption key, DSN, proxy credentials, raw
frame body, message content or unapproved payload field name appears in them.

Account binding, fan-out/browser coexistence, presence, six-hour continuity,
gap recovery, polling savings and event-to-reader latency remain unverified.
Post-run production health is a separate observation, not inferred here.

```text
f00f853b0e7b08ca253d13f274d748ce17d8d3f4c6901de308532e6915ee3c69  live-receipt.json
3a3b2ade2a1a7c1b396b21e1c0a05aa60ef98e0706a8aed29e1ba78fce330ecc  live-invocation.json
```

Publication-only cleanup removed an extra blank line at the context module EOF;
no executable statement changed after validation or the live probe.
