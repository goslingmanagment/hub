# Pass 3 stage specifications — index

Written by Pass 3b (core-side stages, 2026-07-04) per `prompts/prompt-3b-stage-specs-core.md`
and Pass 3c (client-repo stages + re-documentation, 2026-07-04) per
`prompts/prompt-3c-stage-specs-clients.md`; per-repo migration overviews live in each client
repo's `docs/project-kernel/pass3-migration.md`. The master is
[`../roadmap.md`](../roadmap.md); each spec follows its §6 template exactly. Statuses:
`specified` (spec on disk, ready to hand to an execution session) · `deferred-to-3c`
(client-repo-owned; core-side interface notes live in the named related spec) ·
`placeholder` (deliberately unspecified pending an owner design pass).

Cross-cutting facts re-verified against production over SSH on 2026-07-04 during spec-writing:
all staged flags running-on (both roles, `skippedOverrides = 0`); zero OnlyMonster-sourced
transaction rows; OnlyFans pages 100 % OFAPI-fed with history to 2025-09; Fansly pages write
`transactions` with bare numeric `raw_type` codes (platform-aware provenance backfill in
Stage 13); disk 32 GB free of 79 GB.

| # | Stage | File | Status |
|---|---|---|---|
| 1 | Kernel retention & redaction stand-down | [stage-01-kernel-retention-redaction-standdown.md](stage-01-kernel-retention-redaction-standdown.md) | specified |
| 2 | Kernel destruction-door guards + chatter-read-scope fix | [stage-02-destruction-door-guards-chatter-read-scope.md](stage-02-destruction-door-guards-chatter-read-scope.md) | specified |
| 3 | OFAPI staged-capture enablement completed | [stage-03-ofapi-staged-capture-enablement.md](stage-03-ofapi-staged-capture-enablement.md) | specified (collapsed to verification checklist per Q1) |
| 4 | Desktop stop-loss release | [stage-04-desktop-stop-loss-release.md](stage-04-desktop-stop-loss-release.md) | specified (3c; Proposal 4.1 accepted 2026-07-04 — `x-client-version` header) |
| 5 | OnlyMonster full historical export | [stage-05-onlymonster-full-historical-export.md](stage-05-onlymonster-full-historical-export.md) | specified (collapsed per Q1 — nothing to export) |
| 6 | Fansly server-replay gate | [stage-06-fansly-server-replay-gate.md](stage-06-fansly-server-replay-gate.md) | specified + probe BUILT & RUN — day-1 verdict 2026-07-04: all 3 families replayable, single check (decisions.md #62); ≥5-day longevity re-probe still open |
| 7 | Observation journal + server-side producers | [stage-07-observation-journal-producers.md](stage-07-observation-journal-producers.md) | specified |
| 8 | Domain events, canonicalization, replay | [stage-08-domain-events-canonicalization-replay.md](stage-08-domain-events-canonicalization-replay.md) | specified |
| 9 | Read-gateway capture-through + read attribution | [stage-09-read-gateway-capture-attribution.md](stage-09-read-gateway-capture-attribution.md) | specified |
| 10 | Platform-neutral message archive | [stage-10-platform-neutral-message-archive.md](stage-10-platform-neutral-message-archive.md) | specified |
| 11 | Client-capture lane (core side) + desktop hoard upload | [stage-11-client-capture-lane.md](stage-11-client-capture-lane.md) | specified (desktop half in 3c; wire contract fixed in this spec) |
| 12 | Desktop local-DB harvest (one-time) | [stage-12-desktop-local-db-harvest.md](stage-12-desktop-local-db-harvest.md) | specified (3c; inventory via diagnostics export — no hub telemetry exists) |
| 13 | Transactions provenance, currency, single-writer gate | [stage-13-transactions-provenance-single-writer.md](stage-13-transactions-provenance-single-writer.md) | specified |
| 14 | OFAPI transactions truth + historical backfills | [stage-14-ofapi-transactions-truth-backfills.md](stage-14-ofapi-transactions-truth-backfills.md) | specified (shrunk per Q1 — verify depth, close feed gaps) |
| 15 | OnlyMonster parity gate + retirement | [stage-15-onlymonster-retirement.md](stage-15-onlymonster-retirement.md) | specified (collapsed per Q1 — verify-zero + offboard) |
| 16 | Fansly earnings & PPV order-history streams | [stage-16-fansly-earnings-ppv-streams.md](stage-16-fansly-earnings-ppv-streams.md) | specified (conditional on Stage 6 verdicts) |
| 17 | Fansly message backscroll backfill | [stage-17-fansly-backscroll-backfill.md](stage-17-fansly-backscroll-backfill.md) | specified (reuses existing deep-backfill machinery) |
| 18 | Platform adapter seam | [stage-18-platform-adapter-seam.md](stage-18-platform-adapter-seam.md) | specified |
| 19 | API decomposition + declarative authorization | [stage-19-api-decomposition-declarative-auth.md](stage-19-api-decomposition-declarative-auth.md) | specified |
| 20 | Generated SDK + dashboard adoption + cross-repo gates | [stage-20-generated-sdk-dashboard-adoption.md](stage-20-generated-sdk-dashboard-adoption.md) | specified (distribution = git-tag installs, owner-confirmed 2026-07-04) |
| 21 | Event stream v2 | [stage-21-event-stream-v2.md](stage-21-event-stream-v2.md) | specified |
| 22 | Identity: all-roles sessions, device tokens, grants, attribution | [stage-22-identity-sessions-device-tokens-grants.md](stage-22-identity-sessions-device-tokens-grants.md) | specified |
| 23 | Workboard kernel module | [stage-23-workboard-kernel-module.md](stage-23-workboard-kernel-module.md) | specified |
| 24 | Desktop migration: SDK, stream v2, direct-read removal | [stage-24-desktop-migration-sdk-stream-v2-direct-read-removal.md](stage-24-desktop-migration-sdk-stream-v2-direct-read-removal.md) | specified (3c) |
| 25 | Worker scale-out; global-ordering retirement | [stage-25-worker-scaleout-global-ordering-retirement.md](stage-25-worker-scaleout-global-ordering-retirement.md) | specified |
| 26 | Egress & pacing unification; auth-dead pause | [stage-26-egress-pacing-unification.md](stage-26-egress-pacing-unification.md) | specified |
| 27 | Money-unit consolidation | [stage-27-money-unit-consolidation.md](stage-27-money-unit-consolidation.md) | specified (Proposal 1 accepted per Q6 — no data migration) |
| 28 | Retention tiering, lake, metrics, erasure procedure | [stage-28-retention-tiering-lake-metrics-erasure.md](stage-28-retention-tiering-lake-metrics-erasure.md) | specified (on-box per Q3; backup risk re-accepted, no mirror — owner 2026-07-04) |
| 29 | AI gateway hardening + restricted capture class | [stage-29-ai-gateway-hardening-restricted-capture.md](stage-29-ai-gateway-hardening-restricted-capture.md) | specified |
| 30 | AI feature services + prompt migration | [stage-30-ai-feature-services-prompt-migration.md](stage-30-ai-feature-services-prompt-migration.md) | specified |
| 31 | Desktop AI cutover | [stage-31-desktop-ai-cutover.md](stage-31-desktop-ai-cutover.md) | specified (3c; cutover = feature services, not a transport flip — hub-AI mode is a proxy lane) |
| 32 | Extension cutover | [stage-32-extension-cutover.md](stage-32-extension-cutover.md) | specified (3c; Proposal 32.1 ruled (a) 2026-07-04 — kernel `compare` feature, one model × N prompt variants) |
| 33 | Dashboard modernization | [stage-33-dashboard-modernization.md](stage-33-dashboard-modernization.md) | specified |
| 34 | Workboard application | [stage-34-workboard-application.md](stage-34-workboard-application.md) | placeholder-specified (3c; pending DP 4 design pass, Q4 — states what's ready and what the pass must decide) |
| 35 | Re-documentation & family standard | [stage-35-redocumentation-family-standard.md](stage-35-redocumentation-family-standard.md) | specified (3c; NB both client repos' Pass 1 maps are currently uncommitted — task 1 commits them) |
