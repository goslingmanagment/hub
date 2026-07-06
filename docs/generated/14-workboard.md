> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Workboard — the chatter task board (v2 engine, LIVE)

The Workboard is the per-page chatter task board that ranks a page's fans into
tabs by how much attention they need. It lives entirely in
`apps/runtime/src/modules/workboard/` (12 files). The v2 priority engine is the
live path — v1 routes were retired at Stage 23. This document maps the module
route surface, the pure priority engine, the recompute paths (real-time
event-driven + nightly reconciler), the two-tier closing classifier, and the
six `scripts/workboard-v2-*.ts` helpers (whose import paths are broken against
the Stage 19 relocation). All money the engine reads is BIGINT mills.

## Module route surface (`workboard/index.ts`)

`index.ts` re-exports the engine/recompute/classify internals through the
module wall (`index.ts:25-35`) and registers the v2 routes (`index.ts:41`). v1
routes were retired at Stage 23 (`index.ts:45`).

| Route | Anchor | Notes |
|---|---|---|
| `GET /pages/:label/workboard/v2` | `index.ts:48` | board read |
| `GET /pages/:label/workboard/v2/lists` | `index.ts:56` | "lists" mode (spender-bucket bands) |
| `POST /pages/:label/workboard/v2/contact` | `index.ts:64` | mark contacted |
| `POST /pages/:label/workboard/v2/recompute` | `index.ts:72` | on-demand recompute |
| `POST …/v2/snooze` / `…/v2/unsnooze` | `index.ts:80,88` | snooze / unsnooze a fan |
| `POST …/v2/undo-contact` | `index.ts:96` | reverse a contact mark |
| `POST …/v2/claim` / `…/v2/unclaim` | `index.ts:106,114` | Stage 23 claim leases, any-session |
| `GET/PUT/POST …/v2/ai`, `…/v2/ai/settings`, `…/v2/ai/classify` | `index.ts:122-152` | AI admin (owner-only) |
| `GET …/workboard/ai/runs` | `index.ts:122-152` | classifier run history (owner-only) |

## Pure priority engine (`engine.ts`, 822 lines)

`engine.ts` holds the side-effect-free scoring logic. Its tunable coefficients
are the `WB` constant (`engine.ts:28`). The scoring pipeline:

- `computeValue` (`engine.ts:172`) — the fan's spend/value component.
- `combineUrgency` (`engine.ts:388`) — how time-sensitive the fan is.
- `computeQuality` (`engine.ts:442`) — engagement/quality component.
- `computeFreeloader` (`engine.ts:503`) — the freeloader penalty component.
- `deriveTab` (`engine.ts:579`) — maps a fan to one of the tabs.
- `computeRankScore` (`engine.ts:606`) — the final rank score used to order a
  tab.
- `evaluateFan` (`engine.ts:707`) — the top-level entry that runs the pipeline
  for a single fan and returns its tab + score.

The tabs are `subscribers` / `spenders` / `fresh_mass` / `old_mass` / `service`
(`types.ts:6-11`). The "lists" mode (route `…/v2/lists`) uses the shared
`SPENDER_AUTO_LIST_BUCKETS` mills bands from `@agency_hub_core/shared` (the same
source that drives the Fansly `[FB] $X-$Y Spenders` spender auto-lists).

## Recompute paths (`recompute.ts`, 351 lines)

`recompute.ts` persists computed state into the `workboard_state` table.

- `recomputeWorkboardPage` (`recompute.ts:227`) — recompute a whole page.
- `recomputeWorkboardFan` (`recompute.ts:272`) — recompute a single fan. When
  the fan's tab changes it appends a `workboard.state_changed` domain event
  (`recompute.ts:314`). The event carries `pageId`/`fanId`/`fromTab`/`toTab`,
  is module-emitted with the `observationId: 0` sentinel (no source
  observation exists), and its dedup key is time-based
  (`wbstate:${fanId}:${toTab}:${now}`) because identical transitions can
  legitimately recur (`recompute.ts:310-325`). This is the real-time path.
- `recomputeAllWorkboardPages` (`recompute.ts:337`) — the nightly RECONCILER.
  Since Stage 23 the event-driven per-fan path does the real-time work; the
  `changed` count returned here is a drift counter with target 0 (anything
  above zero means the event path missed something) (`recompute.ts:331-336`).

The real-time wiring lives in `services/workboard-event-recompute.ts`
(`startWorkboardEventRecompute`): it subscribes to the domain-event hub and
schedules debounced pg-boss jobs that call the per-fan recompute.

## The closing classifier (two tiers, flag-gated)

The workboard classifies whether a fan's conversation is at a "closing" (buy)
moment, in two tiers:

- **L1 — `closing.ts`** — a free, multilingual exact-match detector. No model
  call.
- **L2 — `closing-classifier.ts`** — a Haiku (Anthropic) classifier reached
  through `ai-gateway-internal` (never a direct vendor SDK; every generation
  goes through the Stage 29 gateway).
- **Orchestration — `classify-closing.ts`** — `runClosingClassificationForPage`
  ties the tiers together with a per-run cap, a cache, and cost accounting.
- **Per-page overrides — `ai-settings.ts`** — a per-page DB override layered
  over the env defaults.
- **Analytics — `ai-analytics.ts`** — the report/runs/settings handlers behind
  the `…/v2/ai/*` and `…/workboard/ai/runs` routes.
- Supporting: `spender-diagnostics.ts`, `page-access.ts` (both OnlyFans and
  Fansly pages are served).

## Workboard tables

State is persisted in `workboard_state` (written by `recompute.ts`).
Tab-change history flows onto the `domain_events` stream as
`workboard.state_changed` events (the Stage 23 board-event feed for the future
workboard app, riding stream v2). Classifier runs/settings are persisted via
the AI-settings and AI-analytics services.

## The six `scripts/workboard-v2-*.ts` helpers (broken import paths)

Six operator scripts exist under `scripts/`:

- `workboard-v2-classify` — verify + run the L2 classifier for one page.
- `workboard-v2-eval-classifier` — offline Haiku eval that gates buy_signal
  precision (non-zero exit on false positives).
- `workboard-v2-inspect-dialogs` — read-only dump of classified dialogs +
  verdicts (no writes).
- `workboard-v2-reclassify-page` — one-off clear-cache → classify → recompute,
  mirroring the dashboard "reclassify all" button.
- `workboard-v2-recompute` — cron-friendly page/all recompute.
- `workboard-v2-show-verdicts` — show the recent L2 tail → decision verdicts.

**Actual state: the import paths are broken.** All six scripts import from
`../apps/runtime/src/services/workboard-v2/…`, a directory that does not exist
anywhere in the repo. The real code was relocated to
`apps/runtime/src/modules/workboard/` in the Stage 19 move, so these scripts are
stale against that relocation and would not run as written.
