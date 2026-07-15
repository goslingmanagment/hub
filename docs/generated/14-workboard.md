> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Workboard v2

The workboard ranks fans within a page for chatter follow-up. Runtime code is
under `apps/runtime/src/modules/workboard/`; persistence is in
`packages/db/src/repositories/workboard-v2.ts`; scheduled and event-driven
execution is wired through `apps/runtime/src/worker-services.ts` and
`apps/runtime/src/services/workboard-event-recompute.ts`.

## HTTP surface

`apps/runtime/src/modules/workboard/index.ts` registers page-scoped routes for:

- the v2 report and per-tab lists;
- recording and undoing contact actions;
- recomputing a page;
- snoozing and unsnoozing a fan;
- claiming and unclaiming a fan lease;
- AI classifier analytics and settings;
- manually triggering classification; and
- owner-level classifier run history.

`resolveAccessibleWorkboardPage` in `page-access.ts` resolves the label and
checks principal page access. Read and mutation routes use contract schemas from
`packages/contracts/src/routes.ts`; the page boundary is reapplied in the
service layer.

## Signal model and priority engine

`types.ts` defines the five tabs (`subscribers`, `spenders`, `fresh_mass`,
`old_mass`, `service`), mass substates, secondary statuses, value/urgency
vocabularies, conversation quality, and the `FanSignals` input.

`engine.ts` is pure calculation. It derives:

- value tier and confidence from spend/subscription facts;
- reply, purchase, expiry, silence, and operational urgency drivers;
- conversation quality, response latency, role ratio, and meaningful-chat
  state;
- freeloader/cooling/ceiling classification;
- destination tab and secondary status; and
- a numeric rank score and explanation payload.

The coefficients and thresholds are collected in the exported `WB` constant.
The engine consumes mills and timestamps supplied by repository queries; it
does not perform I/O.

## Recompute and persistence

`recompute.ts` maps repository signal rows to `FanSignals`, calls
`evaluateFan`, and upserts `workboard_state`. It supports one fan, one page, or
all pages. Page recompute removes state rows whose fan is no longer present in
the current signal set.

`report.ts` reads ranked rows, summary counts, active snoozes, claims, contact
history, and available actions. Contact writes append
`workboard_contact_log`; undo marks the most recent active contact retracted.
Snoozes share `workboard_snoozes`. Claims use `workboard_claim_leases` with an
expiry and one page/fan lease row.

The main v2 tables in `packages/db/src/schema.ts` are `workboard_state`,
`workboard_contact_log`, `workboard_snoozes`, and `workboard_claim_leases`.
Classifier support uses `wb_closing_settings`, `wb_closing_cache`, and
`wb_classifier_runs` through `packages/db/src/repositories/workboard-v2.ts`.

## Event and scheduled execution

Domain events that affect workboard signals enqueue a deduplicated
`workboard.fan-recompute` job through
`apps/runtime/src/services/workboard-event-recompute.ts`. Workers process fan
jobs in batches. The scheduler also registers `workboard.recompute` at 03:00 UTC
and `workboard.classify-closing` at 01:00 UTC in
`apps/runtime/src/services/sync-queue.ts`.

`recomputeAllWorkboardPages` performs the nightly deterministic refresh.
Classification runs before the recompute path updates final state, so cached
closing semantics participate in the engine evaluation.

## Closing classifier

`closing.ts` contains the deterministic message-text heuristic.
`closing-classifier.ts` defines the classifier interface and builds the AI
implementation. `classify-closing.ts` selects candidate conversations, applies
daily caps and cache reuse, invokes the classifier, and records per-page runs.

The AI implementation calls the internal gateway lane as feature
`workboard-closing`; its provider spend and prompt/completion enter the same
usage ledger and restricted capture class as client generations. Effective
settings combine config defaults with per-page overrides in `ai-settings.ts`.
`ai-analytics.ts` serves settings, runs, cost estimates, and manual execution.

## Dashboard and scripts

`apps/dashboard/src/pages/WorkboardV2Page.tsx` consumes the report/list/action
contracts. Components under `apps/dashboard/src/components/page/workboard/v2/`
render focus, cap, quadrant, tone, and row state. The dashboard route is
`/pages/:pageLabel/workboard`; legacy `/workboard/v2` and `/crm` paths redirect
to it.

Six `scripts/workboard-v2-*.ts` utilities inspect, evaluate, classify,
reclassify, recompute, and show verdicts. Several of those scripts still import
the pre-module path `apps/runtime/src/services/workboard-v2/...`, which is absent
at this commit; the live runtime imports the current module path.

Workboard behavior is covered by engine, page, AI-settings, and integration
tests named `tests/workboard-*.test.ts`; route/action persistence and Stage-23
semantics run against Testcontainers Postgres.
