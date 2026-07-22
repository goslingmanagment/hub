# OFAPI Link Stats Sync — Implementation Plan

> **SUPERSEDED BY REVIEW — read the code, not the Task blocks.** The plan was
> executed, then hardened through seven dual-review rounds; the shipped
> implementation diverges from the Task-4 code below in load-bearing ways:
> free `/stored/*` endpoints instead of the paid live lists (limit 1000);
> dedicated `link_stats` credit lane (migration 0113) instead of the backfill
> sub-cap; NULL-able unknown money + `revenue_is_loading`; run statuses
> complete/partial/truncated with vanished-inventory and never-nonempty
> absence guards; cron `45 4,16 * * *` UTC; Stage-26 auth-dead pause +
> tombstone re-check; page-erasure hot targets; counters capped to
> PG INTEGER. The Post-review revision sections record per-round deltas;
> `apps/runtime/src/services/ofapi-link-stats-sync.ts` is truth.

**Goal:** persist OnlyFans trial-link and tracking-link statistics (clicks, claims, subscribers, revenue, spenders) into core's Postgres on a twice-daily schedule, as append-only snapshots grouped by completed reconcile runs.

**Architecture:** a standalone pg-boss reconcile job modeled 1:1 on the existing chargebacks reconcile (`apps/runtime/src/services/ofapi-chargebacks-sync.ts`): scheduler fires a queue twice a day, the worker walks `GET /{account}/tracking-links` and `GET /{account}/trial-links` per OFAPI-mapped OnlyFans page via the existing `OfapiClient` methods, normalizes items, and appends one *run* row per (page, link kind) plus one *snapshot* row per link. Deltas/reports are computed later from snapshot differences; this feature only stores facts.

**Tech stack:** TypeScript ESM, Fastify runtime monorepo (`apps/runtime`), drizzle-orm + hand-written SQL migrations (`packages/db`), pg-boss 12, Vitest (+ Testcontainers for integration).

## Global Constraints

- Money is BIGINT **mills** (1 mill = $0.001). Parse vendor dollars ONLY with `dollarsToMills` from `@agency_hub_core/shared` (the chargebacks file shows the exact local wrapper to copy). Never store floats or `NUMERIC(…,2)`.
- Migrations are **forward-only**, hand-written SQL in `packages/db/migrations/`, name pattern `^[0-9]{4}_[a-z0-9][a-z0-9_-]*\.sql$`. The next free number is **0111** (last applied: `0110_voice_notes_audio_bytes_constraint.sql`). Never edit an applied migration.
- `packages/db/src/schema.ts` is kept in sync with SQL **by hand** (`pnpm db:generate` is disabled).
- Tests live in root `tests/`; **no `drizzle-orm` imports inside tests**; integration tests use Testcontainers (Docker Desktop required) and must not run two vitest suites in parallel.
- The literal `platform ===` outside `packages/onlyfans`/`packages/fansly` is ratcheted by `scripts/check-platform-branches.mjs` against `scripts/platform-branch-budget.json` (budget currently 52). This feature adds exactly one such branch → Task 4 bumps the budget to 53 WITH a written justification appended to the `note` field. Do not add the literal anywhere else (including tests).
- New config flags: add to `packages/shared/src/config-registry.ts` AND `packages/shared/src/config.ts` (zod schema + type field + env→config mapping). Do NOT touch `.env.example` / `.env.production.example` — the chargebacks flag precedent omits them.
- Do not call per-link OFAPI endpoints (`/subscribers`, `/spenders`, `/stats`, `/cohort-arps`) — list endpoints only. Cost must stay O(pages), not O(links).
- Commit per task with the repo convention `type(scope): summary`.
- Final gate for the whole plan: `pnpm check` green.

## Executor pre-flight

Read this plan end-to-end before Task 1. If any referenced symbol/file diverges from the actual tree, stop and report all mismatches at once instead of improvising mid-task. You work in an existing worktree on branch `ai/260721a-of-links-sync`; do not switch branches; do not push or open PRs (the operator does that).

## Vendor data shapes (verified live 2026-07-22)

`GET /{account}/tracking-links` → `data.list[]` items (already unwrapped into `OfapiListPage.items` by the client):

```json
{
  "id": 2117449,
  "campaignCode": 7,
  "campaignName": "waptap",
  "campaignUrl": "https://onlyfans.com/loravie/c7",
  "subscribersCount": 19,
  "clicksCount": 82,
  "createdAt": "2025-09-15T10:17:11+00:00",
  "endDate": null,
  "tags": [],
  "revenue": {
    "total": 0,
    "revenuePerSubscriber": 0,
    "revenuePerClick": 0,
    "spendersCount": 0,
    "calculatedAt": "2026-07-21T00:18:23.000000Z",
    "isLoading": false
  }
}
```

`GET /{account}/trial-links` → `data.list[]` items:

```json
{
  "id": 11365057,
  "trialLinkName": "blog 18.06.26",
  "url": "https://onlyfans.com/loravievip/trial/xxxxxxxx",
  "subscribeDays": 360,
  "subscribeCounts": 0,
  "claimCounts": 323,
  "clicksCounts": 611,
  "expiredAt": null,
  "createdAt": "2026-06-17T00:00:00+00:00",
  "isFinished": false,
  "revenue": {
    "total": 144.8,
    "revenuePerSubscriber": 0.4482972136222911,
    "spendersCount": 7,
    "calculatedAt": "2026-07-21T21:05:40.000000Z",
    "isLoading": false
  }
}
```

Notes: counters are cumulative since link creation; `revenue.total` is USD dollars; trial items also carry a large `user` object — ignore it. Field-name asymmetry is real: tracking `clicksCount`/`subscribersCount` vs trial `clicksCounts`/`subscribeCounts`. Vendor ratio fields (`revenuePerSubscriber`, `revenuePerClick`) are derivable and NOT stored.

---

### Task 1: Migration 0111 + drizzle schema

**Files:**
- Create: `packages/db/migrations/0111_ofapi_link_stats.sql`
- Modify: `packages/db/src/schema.ts` (append after the `pageFanIdentities` table block, around line 1580)

**Interfaces:**
- Produces: tables `page_link_stat_runs`, `page_link_stat_snapshots`; drizzle exports `pageLinkStatRuns`, `pageLinkStatSnapshots` consumed by Task 2.

- [ ] Step: create `packages/db/migrations/0111_ofapi_link_stats.sql`:

```sql
-- OFAPI trial/tracking link statistics (2026-07-22 plan).
-- One run row per completed (page, link_kind) list walk; append-only
-- snapshot rows per link per run. Cumulative vendor counters are stored
-- as observed — deltas are a query-time concern. Money in mills.

CREATE TABLE IF NOT EXISTS page_link_stat_runs (
  id BIGSERIAL PRIMARY KEY,
  platform_account_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('tracking', 'trial')),
  status TEXT NOT NULL CHECK (status IN ('complete', 'truncated')),
  pulled_at TIMESTAMPTZ NOT NULL,
  api_pages INTEGER NOT NULL DEFAULT 0,
  raw_items INTEGER NOT NULL DEFAULT 0,
  written_rows INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_link_stat_runs_page_kind_pulled_idx
  ON page_link_stat_runs (platform_account_id, link_kind, pulled_at DESC);

CREATE TABLE IF NOT EXISTS page_link_stat_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES page_link_stat_runs(id) ON DELETE RESTRICT,
  platform_account_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('tracking', 'trial')),
  platform_link_id TEXT NOT NULL,
  name TEXT,
  url TEXT,
  link_created_at TIMESTAMPTZ,
  link_ends_at TIMESTAMPTZ,
  is_finished BOOLEAN,
  clicks_count INTEGER NOT NULL,
  claims_count INTEGER,
  subscribers_count INTEGER NOT NULL,
  spenders_count INTEGER NOT NULL DEFAULT 0,
  revenue_gross_mills BIGINT NOT NULL DEFAULT 0,
  revenue_calculated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT page_link_stat_snapshots_run_link_uniq UNIQUE (run_id, platform_link_id)
);

CREATE INDEX IF NOT EXISTS page_link_stat_snapshots_page_link_idx
  ON page_link_stat_snapshots (platform_account_id, link_kind, platform_link_id, id DESC);
```

- [ ] Step: append to `packages/db/src/schema.ts` (style mirrors `pageFanIdentities`/`dailyFollowers`; `pgTable`, `bigserial`, `bigint`, `integer`, `boolean`, `text`, `timestamp`, `index`, `uniqueIndex` are already imported in that file — verify and reuse; the CHECK constraints live only in SQL, matching the repo's newer TEXT+CHECK style):

```ts
// OFAPI trial/tracking link statistics (2026-07-22): one run row per
// completed (page, link_kind) list walk; append-only per-link snapshots.
// Cumulative vendor counters stored as observed; deltas are query-time.
export const pageLinkStatRuns = pgTable(
  "page_link_stat_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    linkKind: text("link_kind").notNull(),
    status: text("status").notNull(),
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull(),
    apiPages: integer("api_pages").default(0).notNull(),
    rawItems: integer("raw_items").default(0).notNull(),
    writtenRows: integer("written_rows").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pageKindPulledIdx: index("page_link_stat_runs_page_kind_pulled_idx").on(
      table.platformAccountId,
      table.linkKind,
      table.pulledAt,
    ),
  }),
);

export const pageLinkStatSnapshots = pgTable(
  "page_link_stat_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .references(() => pageLinkStatRuns.id, { onDelete: "restrict" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    linkKind: text("link_kind").notNull(),
    platformLinkId: text("platform_link_id").notNull(),
    name: text("name"),
    url: text("url"),
    linkCreatedAt: timestamp("link_created_at", { withTimezone: true }),
    linkEndsAt: timestamp("link_ends_at", { withTimezone: true }),
    isFinished: boolean("is_finished"),
    clicksCount: integer("clicks_count").notNull(),
    claimsCount: integer("claims_count"),
    subscribersCount: integer("subscribers_count").notNull(),
    spendersCount: integer("spenders_count").default(0).notNull(),
    revenueGrossMills: bigint("revenue_gross_mills", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    revenueCalculatedAt: timestamp("revenue_calculated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    runLinkUniq: uniqueIndex("page_link_stat_snapshots_run_link_uniq").on(
      table.runId,
      table.platformLinkId,
    ),
    pageLinkIdx: index("page_link_stat_snapshots_page_link_idx").on(
      table.platformAccountId,
      table.linkKind,
      table.platformLinkId,
      table.id,
    ),
  }),
);
```

  Caveat for the SQL↔drizzle unique: the migration declares a table CONSTRAINT while drizzle models it as `uniqueIndex`. That asymmetry exists elsewhere in this schema; keep the SQL as written (constraint) and the drizzle side as `uniqueIndex` — do NOT regenerate SQL from drizzle.

- [ ] Verify: `pnpm db:migrate` against the local dev database (or `pnpm check` typecheck pass if no local DB); migration applies cleanly and is numbered contiguously after 0110.
- [ ] Commit: `feat(db): add page_link_stat_runs/_snapshots for OFAPI link stats`

### Task 2: DB repository helpers

**Files:**
- Modify: `packages/db/src/repositories/ofapi.ts` (append at end)

**Interfaces:**
- Consumes: `pageLinkStatRuns`, `pageLinkStatSnapshots` from Task 1 (import from `../schema.ts` alongside the file's existing schema imports).
- Produces (used by Task 4 service and Task 5 tests; all exported through the existing `export * from "./repositories/ofapi.ts"` in `packages/db/src/index.ts` — no index edit needed):

```ts
export type LinkStatKind = "tracking" | "trial";

export interface InsertLinkStatRunInput {
  platformAccountId: number;
  linkKind: LinkStatKind;
  status: "complete" | "truncated";
  pulledAt: Date;
  apiPages: number;
  rawItems: number;
  writtenRows: number;
}

export interface InsertLinkStatSnapshotInput {
  platformAccountId: number;
  linkKind: LinkStatKind;
  platformLinkId: string;
  name: string | null;
  url: string | null;
  linkCreatedAt: Date | null;
  linkEndsAt: Date | null;
  isFinished: boolean | null;
  clicksCount: number;
  claimsCount: number | null;
  subscribersCount: number;
  spendersCount: number;
  revenueGrossMills: bigint;
  revenueCalculatedAt: Date | null;
}

export async function insertLinkStatRun(
  db: Database,
  input: InsertLinkStatRunInput,
): Promise<{ id: number }>;

export async function insertLinkStatSnapshots(
  db: Database,
  runId: number,
  rows: InsertLinkStatSnapshotInput[],
): Promise<number>;

export async function listLinkStatRuns(
  db: Database,
  input: { platformAccountId: number; linkKind?: LinkStatKind },
): Promise<Array<typeof pageLinkStatRuns.$inferSelect>>;

export async function listLinkStatSnapshots(
  db: Database,
  input: { runId: number },
): Promise<Array<typeof pageLinkStatSnapshots.$inferSelect>>;
```

- [ ] Step: implement in `packages/db/src/repositories/ofapi.ts`, following that file's existing style (drizzle query builder, `Database` type already imported there):

```ts
export async function insertLinkStatRun(
  db: Database,
  input: InsertLinkStatRunInput,
): Promise<{ id: number }> {
  const [row] = await db
    .insert(pageLinkStatRuns)
    .values({
      platformAccountId: input.platformAccountId,
      linkKind: input.linkKind,
      status: input.status,
      pulledAt: input.pulledAt,
      apiPages: input.apiPages,
      rawItems: input.rawItems,
      writtenRows: input.writtenRows,
    })
    .returning({ id: pageLinkStatRuns.id });
  if (!row) {
    throw new Error("insertLinkStatRun returned no row");
  }
  return row;
}

export async function insertLinkStatSnapshots(
  db: Database,
  runId: number,
  rows: InsertLinkStatSnapshotInput[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const inserted = await db
    .insert(pageLinkStatSnapshots)
    .values(rows.map((row) => ({
      runId,
      platformAccountId: row.platformAccountId,
      linkKind: row.linkKind,
      platformLinkId: row.platformLinkId,
      name: row.name,
      url: row.url,
      linkCreatedAt: row.linkCreatedAt,
      linkEndsAt: row.linkEndsAt,
      isFinished: row.isFinished,
      clicksCount: row.clicksCount,
      claimsCount: row.claimsCount,
      subscribersCount: row.subscribersCount,
      spendersCount: row.spendersCount,
      revenueGrossMills: row.revenueGrossMills,
      revenueCalculatedAt: row.revenueCalculatedAt,
    })))
    .returning({ id: pageLinkStatSnapshots.id });
  return inserted.length;
}

export async function listLinkStatRuns(
  db: Database,
  input: { platformAccountId: number; linkKind?: LinkStatKind },
) {
  const conditions = [eq(pageLinkStatRuns.platformAccountId, input.platformAccountId)];
  if (input.linkKind !== undefined) {
    conditions.push(eq(pageLinkStatRuns.linkKind, input.linkKind));
  }
  return db
    .select()
    .from(pageLinkStatRuns)
    .where(and(...conditions))
    .orderBy(desc(pageLinkStatRuns.pulledAt), desc(pageLinkStatRuns.id));
}

export async function listLinkStatSnapshots(db: Database, input: { runId: number }) {
  return db
    .select()
    .from(pageLinkStatSnapshots)
    .where(eq(pageLinkStatSnapshots.runId, input.runId))
    .orderBy(pageLinkStatSnapshots.platformLinkId);
}
```

  Add `pageLinkStatRuns`, `pageLinkStatSnapshots` to the file's schema import block, and reuse its existing `eq`/`and`/`desc` drizzle imports (extend the import list if any of them is missing).
- [ ] Verify: `pnpm check` typecheck passes (unit scope; DB not required).
- [ ] Commit: `feat(db): link-stat run/snapshot repository helpers`

### Task 3: Config flag

**Files:**
- Modify: `packages/shared/src/config-registry.ts` (after the `ofapiChargebacksReconcileEnabled` entry, line ~190)
- Modify: `packages/shared/src/config.ts` (three spots: zod env schema near `OFAPI_CHARGEBACKS_RECONCILE_ENABLED` ~line 155; the config type field near `ofapiChargebacksReconcileEnabled?: boolean;` ~line 337; the env→config mapping near line 539)

**Interfaces:**
- Produces: `config.ofapiLinkStatsReconcileEnabled: boolean | undefined` (env `OFAPI_LINK_STATS_RECONCILE_ENABLED`, default false) consumed by Task 4.

- [ ] Step: config-registry entry (one line, matching neighbors verbatim in shape):

```ts
  { key: "ofapiLinkStatsReconcileEnabled", envName: "OFAPI_LINK_STATS_RECONCILE_ENABLED", configField: "ofapiLinkStatsReconcileEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI link stats reconcile", default: "false", editability: EDITABLE, runtimeApply: "boot", comparable: true, costWarning: "Twice-daily tracking/trial link list walks spend OFAPI credits (backfill budget lane)." },
```

- [ ] Step: `config.ts` zod schema line:

```ts
  OFAPI_LINK_STATS_RECONCILE_ENABLED: booleanSchema.default(false),
```

- [ ] Step: `config.ts` type field:

```ts
  ofapiLinkStatsReconcileEnabled?: boolean;
```

- [ ] Step: `config.ts` mapping line:

```ts
    ofapiLinkStatsReconcileEnabled: parsed.OFAPI_LINK_STATS_RECONCILE_ENABLED,
```

- [ ] Step: `tests/config-registry.test.ts` — the boot-apply allowlist is pinned: append `"ofapiLinkStatsReconcileEnabled"` to the `BOOT_KEYS` array (~line 106, next to `"ofapiChargebacksReconcileEnabled"` if present there — otherwise at the list end) and update any asserted count in that test if one exists.
- [ ] Verify: `pnpm check` — the config-registry pin tests (they assert registry↔config consistency and the BOOT_KEYS pin) pass.
- [ ] Commit: `feat(config): OFAPI_LINK_STATS_RECONCILE_ENABLED flag`

### Task 4: Sync service + scheduler/worker registration + branch budget

**Files:**
- Create: `apps/runtime/src/services/ofapi-link-stats-sync.ts`
- Create: `packages/db/migrations/0112_ofapi_link_stats_incident.sql` — mirror `0107_ofapi_chargebacks_reconcile_incident.sql` verbatim:

```sql
-- 0112: make a failed OFAPI link-stats reconcile visible as one durable,
-- process-global notification incident until a later clean run recovers.
ALTER TYPE "notification_incident_kind"
  ADD VALUE IF NOT EXISTS 'ofapi_link_stats_reconcile_failed';
```

- Modify: `packages/db/src/schema.ts` — append `"ofapi_link_stats_reconcile_failed"` to the `notificationIncidentKindEnum` pgEnum value list (~line 164)
- Modify: `packages/db/src/repositories/notifications.ts` — append the same literal to the `NotificationIncidentKind` union (~line 11)
- Modify: `packages/contracts/src/routes.ts` — append the same literal to the `notificationIncidentKindEnum` z.enum (~line 2947), then run `pnpm contracts:generate` (regenerates the OpenAPI/SDK surface; commit the regenerated artifacts in this task's commit; client repos are NOT re-vendored — they don't consume the new literal)
- Modify: `apps/runtime/src/services/schedules.ts` (add import; add `ensureOfapiLinkStatsQueue(boss, createdQueues)` after the chargebacks queue call; add `ensureOfapiLinkStatsSchedule(boss)` inside the `Promise.all`)
- Modify: `apps/runtime/src/worker-services.ts` — TWO edits: (a) workers create/reconcile every queue they consume before registering handlers — add `await ensureOfapiLinkStatsQueue(boss, createdQueues);` directly after the `await ensureOfapiChargebacksQueue(boss, createdQueues);` line in the queue block (~line 179); (b) add `startOfapiLinkStatsWorker` to the import block near line 59 and `await startOfapiLinkStatsWorker(app, boss);` next to the chargebacks start call near line 354
- Modify: `tests/worker-startup.test.ts` — the worker-startup mocks pin the set of queues a worker touches (~line 128); extend the mock/expectation list with `OFAPI_LINK_STATS_RECONCILE_QUEUE` exactly the way `OFAPI_CHARGEBACKS_RECONCILE_QUEUE` appears there
- Modify: `scripts/platform-branch-budget.json` (budget 52 → 53; append to `note`: `" 2026-07-22: +1 for the link-stats reconcile page filter (ofapi-link-stats-sync.ts) — mirrors the chargebacks reconcile's onlyfans-only fleet selection by design."`)
- Modify: `NotificationIncidentKind` union — grep for the literal `"ofapi_chargebacks_reconcile_failed"` across `packages/db/src/repositories/notifications.ts` and `apps/runtime/src/services/notification-incidents.ts` and add `"ofapi_link_stats_reconcile_failed"` at EVERY union-type site, plus the two exhaustive switch cases in `notification-incidents.ts`:

```ts
    case "ofapi_link_stats_reconcile_failed":
      return "🚨 OFAPI link-stats reconcile failed";
```

  (in `openTitleForIncident`, after the chargebacks case at ~line 88), and

```ts
    case "ofapi_link_stats_reconcile_failed":
      return "OFAPI link-stats reconcile recovered";
```

  (in the recovery-title switch, after the chargebacks case at ~line 147). The switches are exhaustive — a missing case is a compile error, which is your checklist.

**Interfaces:**
- Consumes: Task 2 repo helpers; Task 3 `config.ofapiLinkStatsReconcileEnabled`; existing `OfapiClient.listTrackingLinks/listTrialLinks(context, accountId, { limit, offset }): Promise<OfapiListPage>` (both OPTIONAL on the interface — guard for `undefined`); `listOfapiMappedPages` from `@agency_hub_core/db`; `createOfapiRestGuard` from `./sync/ofapi-dm-sync.ts`; `persistRawPayload` from `./sync/shared.ts` (Stage-7 raw-payload + observation dual-write; works outside the page-executor context via UUID idempotency keys); `dollarsToMills` from `@agency_hub_core/shared`; `asRecord`, `idToString` from `./ofapi-payloads.ts`; `notifyOfapiGlobalIncident`/`resolveOfapiGlobalIncident` from `./notification-incidents.ts`; `ensureQueueCreated` + types from `./sync-queue.ts`.
- Produces: `OFAPI_LINK_STATS_RECONCILE_QUEUE`, `isOfapiLinkStatsReconcileEnabled(config)`, `runOfapiLinkStatsReconcile(app)`, `ensureOfapiLinkStatsQueue(boss, createdQueues?)`, `ensureOfapiLinkStatsSchedule(boss)`, `startOfapiLinkStatsWorker(app, boss)`, `OfapiLinkStatsPageResult` — consumed by Task 5 tests.

- [ ] Step: create `apps/runtime/src/services/ofapi-link-stats-sync.ts`:

```ts
// OFAPI trial/tracking link statistics reconcile (2026-07-22 plan). Twice a
// day, for every OFAPI-mapped OnlyFans page, walk the two link-list endpoints
// and append run + per-link snapshot rows. Counters are cumulative vendor
// values stored as observed; regressions are NOT clamped (chargebacks and
// deletions legitimately lower them) — the reporting layer owns delta
// semantics. List endpoints only: cost stays O(pages).

import {
  insertLinkStatRun,
  insertLinkStatSnapshots,
  listOfapiMappedPages,
  type Database,
  type InsertLinkStatSnapshotInput,
  type LinkStatKind,
} from "@agency_hub_core/db";
import { dollarsToMills } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import type { OfapiListPage, OfapiRequestContext } from "./ofapi.ts";
import { persistRawPayload, retentionDate } from "./sync/shared.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import {
  ensureQueueCreated,
  type QueueCreationClient,
  type SyncQueueLifecycleClient,
} from "./sync-queue.ts";
import { createOfapiRestGuard } from "./sync/ofapi-dm-sync.ts";

export const OFAPI_LINK_STATS_RECONCILE_QUEUE = "ofapi.link-stats.reconcile";

// A failed fleet pass is durable and operator-visible through the global
// incident; retrying the pg-boss job would repeat every healthy page's walk.
const OFAPI_LINK_STATS_QUEUE_OPTIONS = {
  policy: "exclusive",
  retryLimit: 0,
} as const;

const LINK_STATS_PAGE_LIMIT = 100;
// Offset-walk backstop per (page, kind) per run: 20 pages = 2000 links.
const LINK_STATS_MAX_PAGES_PER_RUN = 20;
// Backfill-lane default; ofapiBackfillDailyCreditBudget governs real spend.
const DEFAULT_BACKFILL_DAILY_CREDIT_BUDGET = 200;

export function isOfapiLinkStatsReconcileEnabled(
  config?: Pick<AppContext["config"], "ofapiLinkStatsReconcileEnabled">,
) {
  return config?.ofapiLinkStatsReconcileEnabled === true;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCounter(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return value;
}

function parseDollarMills(value: unknown): bigint | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const normalized = typeof value === "string"
    ? value.trim().replace(/^\$/, "").replace(/,/g, "")
    : value;
  try {
    return dollarsToMills(normalized);
  } catch {
    return null;
  }
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLinkItem(
  kind: LinkStatKind,
  pageId: number,
  item: Record<string, unknown>,
):
  | { status: "ok"; row: InsertLinkStatSnapshotInput }
  | { status: "skipped"; reason: string }
{
  const platformLinkId = idToString(item.id);
  if (!platformLinkId) {
    return { status: "skipped", reason: "missing_link_id" };
  }
  const clicksCount = parseCounter(kind === "tracking" ? item.clicksCount : item.clicksCounts);
  if (clicksCount === null) {
    return { status: "skipped", reason: "invalid_clicks_count" };
  }
  const subscribersCount = parseCounter(
    kind === "tracking" ? item.subscribersCount : item.subscribeCounts,
  );
  if (subscribersCount === null) {
    return { status: "skipped", reason: "invalid_subscribers_count" };
  }
  let claimsCount: number | null = null;
  if (kind === "trial") {
    claimsCount = parseCounter(item.claimCounts);
    if (claimsCount === null) {
      return { status: "skipped", reason: "invalid_claims_count" };
    }
  }
  const revenue = asRecord(item.revenue);
  return {
    status: "ok",
    row: {
      platformAccountId: pageId,
      linkKind: kind,
      platformLinkId,
      name: parseOptionalString(kind === "tracking" ? item.campaignName : item.trialLinkName),
      url: parseOptionalString(kind === "tracking" ? item.campaignUrl : item.url),
      linkCreatedAt: parseDate(item.createdAt),
      linkEndsAt: parseDate(kind === "tracking" ? item.endDate : item.expiredAt),
      isFinished: kind === "trial" && typeof item.isFinished === "boolean"
        ? item.isFinished
        : null,
      clicksCount,
      claimsCount,
      subscribersCount,
      spendersCount: parseCounter(revenue?.spendersCount) ?? 0,
      revenueGrossMills: parseDollarMills(revenue?.total) ?? 0n,
      revenueCalculatedAt: parseDate(revenue?.calculatedAt),
    },
  };
}

export interface OfapiLinkStatsKindResult {
  linkKind: LinkStatKind;
  status: "written" | "truncated" | "skipped";
  reason: string | null;
  apiPages: number;
  rawItems: number;
  writtenRows: number;
  skippedReasons: Record<string, number>;
}

export interface OfapiLinkStatsPageResult {
  pageLabel: string;
  status: "written" | "partial" | "skipped" | "failed";
  reason: string | null;
  kinds: OfapiLinkStatsKindResult[];
}

type LinkLister = (
  context: OfapiRequestContext,
  accountId: string,
  params: { limit?: number; offset?: number },
) => Promise<OfapiListPage>;

async function reconcileKind(
  input: {
    db: Database;
    kind: LinkStatKind;
    list: LinkLister;
    requestContext: OfapiRequestContext;
    pageId: number;
    ofapiAccountId: string;
    pulledAt: Date;
    guard: ReturnType<typeof createOfapiRestGuard>;
  },
): Promise<OfapiLinkStatsKindResult> {
  const normalized: InsertLinkStatSnapshotInput[] = [];
  const skippedReasons: Record<string, number> = {};
  let apiPages = 0;
  let rawItems = 0;
  let blockedReason: string | null = null;
  let walkComplete = false;

  for (let offset = 0; apiPages < LINK_STATS_MAX_PAGES_PER_RUN;) {
    const block = await input.guard.resolveBlock();
    if (block !== null) {
      blockedReason = block;
      break;
    }
    const page = await input.list(input.requestContext, input.ofapiAccountId, {
      limit: LINK_STATS_PAGE_LIMIT,
      offset,
    });
    await input.guard.recordResponse(page);
    // Stage 7 producer discipline: every fetched page is journaled untrimmed
    // (raw payload + observation dual-write) before projection. Loud on
    // failure — a page we cannot journal fails the page's reconcile.
    await persistRawPayload(input.db, {
      platformAccountId: input.pageId,
      endpoint: input.kind === "tracking"
        ? "/:accountId/tracking-links"
        : "/:accountId/trial-links",
      requestParams: { limit: LINK_STATS_PAGE_LIMIT, offset },
      responsePayload: page.items,
      mapperVersion: "link-stats-v1",
      payloadKind: "mapping_critical",
      // Stage 1 retention stand-down: captured facts are stamped far-future
      // (the cleanup job is a deliberate no-op) — never a real deletion date.
      retainUntil: retentionDate(input.pulledAt),
    }, { action: "journal link-stats page", platform: "onlyfans" });
    apiPages += 1;
    rawItems += page.items.length;
    for (const item of page.items) {
      const result = normalizeLinkItem(input.kind, input.pageId, item);
      if (result.status === "ok") {
        normalized.push(result.row);
      } else {
        skippedReasons[result.reason] = (skippedReasons[result.reason] ?? 0) + 1;
      }
    }
    if (page.items.length < LINK_STATS_PAGE_LIMIT) {
      walkComplete = true;
      break;
    }
    offset += page.items.length;
  }

  // A truncated walk still records its run row (status 'truncated') so the
  // attempt is visible, but writes NO snapshots: link absence is only
  // meaningful against a complete walk, and a partial snapshot set would
  // read as deletions downstream.
  const status: OfapiLinkStatsKindResult["status"] = walkComplete ? "written" : "truncated";
  const run = await insertLinkStatRun(input.db, {
    platformAccountId: input.pageId,
    linkKind: input.kind,
    status: walkComplete ? "complete" : "truncated",
    pulledAt: input.pulledAt,
    apiPages,
    rawItems,
    writtenRows: walkComplete ? normalized.length : 0,
  });
  let writtenRows = 0;
  if (walkComplete) {
    writtenRows = await insertLinkStatSnapshots(input.db, run.id, normalized);
  }

  return {
    linkKind: input.kind,
    status,
    reason: walkComplete ? null : blockedReason ?? "walk_truncated",
    apiPages,
    rawItems,
    writtenRows,
    skippedReasons,
  };
}

async function reconcilePage(
  app: AppContext,
  input: {
    pageId: number;
    pageLabel: string;
    ofapiAccountId: string;
    pulledAt: Date;
    guard: ReturnType<typeof createOfapiRestGuard>;
  },
): Promise<OfapiLinkStatsPageResult> {
  const listTrackingLinks = app.ofapi?.listTrackingLinks?.bind(app.ofapi);
  const listTrialLinks = app.ofapi?.listTrialLinks?.bind(app.ofapi);
  if (!listTrackingLinks || !listTrialLinks) {
    return {
      pageLabel: input.pageLabel,
      status: "skipped",
      reason: "ofapi_client_not_configured",
      kinds: [],
    };
  }

  // No proxy/dispatcher resolution here on purpose: the OFAPI list transport
  // (`observedListRequest`) performs a plain fetch and never consumes
  // `context.dispatcher` — OFAPI fronts each connected account with its own
  // vendor-side egress. The governed egress seam (`resolveOfapiEgressContext`)
  // belongs to the capture-jobs/read-gateway paths, not to list reconciles.
  // If `OfapiRequestContext` requires more fields than these, mirror the
  // minimal shape the other list-sync callers pass — do not add proxy code.
  const requestContext: OfapiRequestContext = {
    pageId: input.pageId,
    dispatcher: null,
    egressKey: null,
    creditBudgetScope: "backfill",
  };

  const kinds: OfapiLinkStatsKindResult[] = [];
  // Tracking first, then trial — a mid-page budget block still yields a
  // complete tracking run; kind isolation keeps one endpoint's failure from
  // discarding the other's completed walk.
  for (const [kind, list] of [
    ["tracking", listTrackingLinks],
    ["trial", listTrialLinks],
  ] as const satisfies ReadonlyArray<readonly [LinkStatKind, LinkLister]>) {
    kinds.push(await reconcileKind({
      db: app.db,
      kind,
      list,
      requestContext,
      pageId: input.pageId,
      ofapiAccountId: input.ofapiAccountId,
      pulledAt: input.pulledAt,
      guard: input.guard,
    }));
  }

  const written = kinds.filter((kind) => kind.status === "written").length;
  const status: OfapiLinkStatsPageResult["status"] = written === kinds.length
    ? "written"
    : written > 0
      ? "partial"
      : "skipped";
  const firstBlocked = kinds.find((kind) => kind.status !== "written");
  return {
    pageLabel: input.pageLabel,
    status,
    reason: firstBlocked?.reason ?? null,
    kinds,
  };
}

export async function runOfapiLinkStatsReconcile(app: AppContext) {
  if (!isOfapiLinkStatsReconcileEnabled(app.config)) {
    return { pages: [] as OfapiLinkStatsPageResult[] };
  }

  const mapped = (await listOfapiMappedPages(app.db))
    .filter((page) => page.platform === "onlyfans");
  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun: LINK_STATS_MAX_PAGES_PER_RUN * 2 * Math.max(1, mapped.length),
    dailyCreditBudget:
      app.config.ofapiBackfillDailyCreditBudget ?? DEFAULT_BACKFILL_DAILY_CREDIT_BUDGET,
    budgetScope: "backfill",
  });
  const pulledAt = new Date();

  const pages: OfapiLinkStatsPageResult[] = [];
  for (const page of mapped) {
    try {
      pages.push(await reconcilePage(app, {
        pageId: page.id,
        pageLabel: page.label,
        ofapiAccountId: page.ofapiAccountId,
        pulledAt,
        guard,
      }));
    } catch (error) {
      guard.abandonPendingReservation();
      const reason = error instanceof Error ? error.message : String(error);
      pages.push({
        pageLabel: page.label,
        status: "failed",
        reason,
        kinds: [],
      });
      app.logger.error({
        err: error,
        pageId: page.id,
        pageLabel: page.label,
      }, "OFAPI link-stats reconcile failed for page; continuing with remaining pages");
    }
  }

  const failed = pages.filter((page) => page.status === "failed");
  if (failed.length > 0) {
    const shown = failed.slice(0, 5)
      .map((page) => `${page.pageLabel}: ${page.reason ?? "unknown error"}`)
      .join("; ");
    const remainder = failed.length > 5 ? `; +${failed.length - 5} more` : "";
    await notifyOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
      errorSummary: `${failed.length} page(s) failed: ${shown}${remainder}`,
    });
  } else if (pages.length > 0 && pages.every((page) => page.status === "written")) {
    await resolveOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
    });
  }

  const degraded = pages.filter((page) => page.status === "partial" || page.status === "skipped");
  if (degraded.length > 0) {
    app.logger.warn({
      degraded: degraded.map((page) => ({ label: page.pageLabel, reason: page.reason })),
    }, "OFAPI link-stats reconcile incomplete for some pages");
  }
  app.logger.info({
    pages: pages.map((page) => ({
      label: page.pageLabel,
      status: page.status,
      reason: page.reason,
      kinds: page.kinds.map((kind) => ({
        kind: kind.linkKind,
        status: kind.status,
        apiPages: kind.apiPages,
        rawItems: kind.rawItems,
        writtenRows: kind.writtenRows,
      })),
    })),
  }, "OFAPI link-stats reconcile complete");

  return { pages };
}

export async function ensureOfapiLinkStatsQueue(
  boss: SyncQueueLifecycleClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(
    boss,
    OFAPI_LINK_STATS_RECONCILE_QUEUE,
    OFAPI_LINK_STATS_QUEUE_OPTIONS,
    createdQueues,
  );

  await boss.updateQueue(OFAPI_LINK_STATS_RECONCILE_QUEUE, {
    retryLimit: OFAPI_LINK_STATS_QUEUE_OPTIONS.retryLimit,
  });

  const queue = await boss.getQueue(OFAPI_LINK_STATS_RECONCILE_QUEUE);
  if (
    !queue ||
    queue.policy !== OFAPI_LINK_STATS_QUEUE_OPTIONS.policy ||
    queue.retryLimit !== OFAPI_LINK_STATS_QUEUE_OPTIONS.retryLimit
  ) {
    throw new Error(
      `Queue ${OFAPI_LINK_STATS_RECONCILE_QUEUE} configuration drift: expected ` +
      `policy=${OFAPI_LINK_STATS_QUEUE_OPTIONS.policy}, ` +
      `retryLimit=${OFAPI_LINK_STATS_QUEUE_OPTIONS.retryLimit}`,
    );
  }
}

export async function ensureOfapiLinkStatsSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Twice daily at 00:15/12:15 UTC — two observations per day; one failed
  // window still leaves a daily point for delta reports.
  await boss.schedule(OFAPI_LINK_STATS_RECONCILE_QUEUE, "45 4,16 * * *", null, { tz: "UTC" });
  // (revised post-review: 04:45/16:45 UTC, after the chargebacks 03:10 window)
}

export async function startOfapiLinkStatsWorker(
  app: AppContext,
  boss: {
    work: (
      queue: string,
      options: { batchSize: number },
      handler: () => Promise<void>,
    ) => Promise<unknown>;
  },
) {
  await boss.work(OFAPI_LINK_STATS_RECONCILE_QUEUE, { batchSize: 1 }, async () => {
    const result = await runOfapiLinkStatsReconcile(app);
    const failed = result.pages.filter((page) => page.status === "failed");
    if (failed.length > 0) {
      throw new Error(`OFAPI link-stats reconcile failed for ${failed.length} page(s)`);
    }
  });
}
```

- [ ] Step: register in `apps/runtime/src/services/schedules.ts` — add the import alongside the chargebacks one, then `await ensureOfapiLinkStatsQueue(boss, createdQueues);` directly after `await ensureOfapiChargebacksQueue(boss, createdQueues);`, and `ensureOfapiLinkStatsSchedule(boss),` directly after `ensureOfapiChargebacksSchedule(boss),` inside the `Promise.all`:

```ts
import { ensureOfapiLinkStatsQueue, ensureOfapiLinkStatsSchedule } from "./ofapi-link-stats-sync.ts";
```

- [ ] Step: register the worker in `apps/runtime/src/worker-services.ts` — extend the import block (near line 59) with `startOfapiLinkStatsWorker` from `./services/ofapi-link-stats-sync.ts` (match the file's existing import style), and add after line ~354's `await startOfapiChargebacksWorker(app, boss);`:

```ts
  await startOfapiLinkStatsWorker(app, boss);
```

- [ ] Step: `scripts/platform-branch-budget.json` — set `"budget": 53` and append the justification sentence quoted in **Files** above to the `note` string.
- [ ] Verify: `pnpm check` green (includes the platform-branch ratchet and config pins).
- [ ] Commit: `feat(sync): OFAPI link-stats reconcile job (runs + snapshots, 2x daily)`

### Task 5: Tests

**Files:**
- Create: `tests/ofapi-link-stats-queue.test.ts`
- Create: `tests/ofapi-link-stats-sync.integration.test.ts`
- Modify: `tests/helpers/runtime.ts` — add `ofapiLinkStatsReconcileEnabled?: boolean;` to the options type (next to `ofapiChargebacksReconcileEnabled?: boolean;` at ~line 49) and the mapping `ofapiLinkStatsReconcileEnabled: overrides?.ofapiLinkStatsReconcileEnabled ?? false,` next to the chargebacks mapping at ~line 153

**Interfaces:**
- Consumes: Task 4 exports; Task 2 `listLinkStatRuns`/`listLinkStatSnapshots`; helpers `createModel`, `createOnlyFansPage`, `setPageOfapiAccountId` from `@agency_hub_core/db`; `resetIntegrationDatabase`, `startIntegrationTestDatabase` from `./helpers/db.ts`; `createTestAppContext` from `./helpers/runtime.ts` (it accepts an `ofapi` override and the new flag via its options object — extend its options type with `ofapiLinkStatsReconcileEnabled?: boolean` if the flag passthrough is not already generic).

- [ ] Step: `tests/ofapi-link-stats-queue.test.ts` — mirror the chargebacks queue lifecycle test exactly (create/updateQueue/getQueue fakes; drift rejection):

```ts
import { describe, expect, it, vi } from "vitest";

import {
  ensureOfapiLinkStatsQueue,
  OFAPI_LINK_STATS_RECONCILE_QUEUE,
} from "../apps/runtime/src/services/ofapi-link-stats-sync.ts";

describe("OFAPI link-stats queue lifecycle", () => {
  it("creates a single-attempt queue and reconciles an existing retrying queue", async () => {
    let queue = {
      name: OFAPI_LINK_STATS_RECONCILE_QUEUE,
      policy: "exclusive",
      retryLimit: 2,
    };
    const createQueue = vi.fn(async () => undefined);
    const updateQueue = vi.fn(async (_name: string, options: { retryLimit?: number }) => {
      queue = { ...queue, ...options };
    });
    const getQueue = vi.fn(async () => queue);

    await ensureOfapiLinkStatsQueue({ createQueue, updateQueue, getQueue } as never);

    expect(createQueue).toHaveBeenCalledWith(
      OFAPI_LINK_STATS_RECONCILE_QUEUE,
      { policy: "exclusive", retryLimit: 0 },
    );
    expect(updateQueue).toHaveBeenCalledWith(
      OFAPI_LINK_STATS_RECONCILE_QUEUE,
      { retryLimit: 0 },
    );
    expect(queue.retryLimit).toBe(0);
  });

  it("fails startup when the mutable retry policy did not reconcile", async () => {
    const createQueue = vi.fn(async () => undefined);
    const updateQueue = vi.fn(async () => undefined);
    const getQueue = vi.fn(async () => ({
      name: OFAPI_LINK_STATS_RECONCILE_QUEUE,
      policy: "exclusive",
      retryLimit: 2,
    }));

    await expect(ensureOfapiLinkStatsQueue({
      createQueue,
      updateQueue,
      getQueue,
    } as never)).rejects.toThrow("configuration drift");
  });
});
```

- [ ] Step: `tests/ofapi-link-stats-sync.integration.test.ts` — follow the chargebacks integration test skeleton (`beforeAll` Testcontainers with 120s timeout, `beforeEach` reset + `createTestAppContext(testDb, { ofapiLinkStatsReconcileEnabled: true, ofapiCreditLedgerEnabled: true })`, `seedOfapiPage` helper copied from that file). Fake client (NO `platform ===` literal anywhere in the test):

```ts
function linksClient(input: {
  trackingByAccount: Map<string, Record<string, unknown>[]>;
  trialByAccount: Map<string, Record<string, unknown>[]>;
  failTrialFor?: string;
}): OfapiClient {
  const empty: Record<string, unknown>[] = [];
  const page = (items: Record<string, unknown>[]): OfapiListPage => ({
    items,
    hasNextPage: false,
    nextMarker: null,
    nextPageUrl: null,
    meta: null,
  });
  return {
    async listTrackingLinks(_context: unknown, accountId: string): Promise<OfapiListPage> {
      return page(input.trackingByAccount.get(accountId) ?? empty);
    },
    async listTrialLinks(_context: unknown, accountId: string): Promise<OfapiListPage> {
      if (input.failTrialFor === accountId) {
        throw new Error("trial endpoint down");
      }
      return page(input.trialByAccount.get(accountId) ?? empty);
    },
  } as unknown as OfapiClient;
}
```

  Fixtures: one tracking item and one trial item copied verbatim from the **Vendor data shapes** section above (adjust ids/names freely). Test cases, each a separate `it`:
  1. **writes runs and snapshots with mills conversion** — seed one page, run `runOfapiLinkStatsReconcile(appContext)`, assert: page result `status === "written"`; `listLinkStatRuns` returns 2 rows (`tracking` + `trial`, both `status === "complete"`); tracking snapshot has `clicksCount: 82`, `subscribersCount: 19`, `claimsCount: null`; trial snapshot has `claimsCount: 323`, `revenueGrossMills: 144800n`, `revenueCalculatedAt` an instance of `Date`; both snapshots carry the run's `platformAccountId` and `platformLinkId` as strings (`"2117449"`, `"11365057"`).
  2. **second run appends, never overwrites** — run the reconcile twice; assert 4 run rows total and that snapshot rows for the same `platformLinkId` exist under two distinct `runId`s with identical values (append-only history).
  3. **kind isolation on endpoint failure** — `failTrialFor` the seeded account: page result `status === "partial"`; tracking run `complete` with its snapshot written; NO trial run row with status `complete` (the thrown error aborts before the trial run row — assert `listLinkStatRuns` with `linkKind: "trial"` is empty) — and the overall reconcile reports the page under `failed`? No: the throw happens inside `reconcilePage`'s kind loop and propagates to the per-page catch in `runOfapiLinkStatsReconcile`, so the page result is `status === "failed"` and the tracking run row (already committed) survives. Assert exactly that: page `failed`, tracking run row present with `writtenRows === 1`, no trial run rows.
  4. **invalid items are skipped with reasons** — tracking item without `id` and trial item with `clicksCounts: -5` alongside one valid item each; assert `writtenRows === 1` per kind and run rows record `rawItems === 2`.
  5. **flag off → no calls, no rows** — `createTestAppContext(testDb, { ofapiLinkStatsReconcileEnabled: false, ... })`, client spies assert zero invocations, `pages` result empty.

  Case 3's expectation about the aborted trial run row is the plan's intended semantics (fail the page loudly, keep completed kind runs); if during implementation the committed-tracking-then-throw ordering proves different in code, fix the CODE to match this test, not the test.
- [ ] Verify: `pnpm vitest run tests/ofapi-link-stats-queue.test.ts` green; `pnpm vitest run tests/ofapi-link-stats-sync.integration.test.ts` green (Docker Desktop running; do not run other vitest suites in parallel).
- [ ] Commit: `test(sync): OFAPI link-stats queue + reconcile coverage`

### Task 6: Backlog note (follow-up, no code)

**Files:**
- Create (or append if it exists): `.agentic/backlog.md` — the workspace-toolkit location for deferred improvements. Do NOT touch root `backlog.md`: its header scopes it to reproducible defects and release-safety debt only, and this is neither.

- [ ] Step: create `.agentic/backlog.md` with:

```markdown
# .agentic/backlog.md — отложенные улучшения (agentic workflow)

Формат: `### <ID> — <title>`, поля «Суть / Код / Закрыть». Не для дефектов —
для них корневой `backlog.md`.

### LINK-001 — fan_identities повторно покупает link-list обходы

- **Суть:** Phase-1 link discovery в fan_identities дёргает те же
  `/tracking-links` + `/trial-links`, которые теперь персистит link-stats
  reconcile (см. `docs/plans/2026-07-22-ofapi-link-stats-sync.md`), — двойная
  трата кредитов на одни и те же списки.
- **Код:** `apps/runtime/src/services/sync/ofapi-fan-identities.ts` (Phase 1,
  walkLinkPages) vs `apps/runtime/src/services/ofapi-link-stats-sync.ts`.
- **Закрыть:** читать link ids из последнего complete `page_link_stat_runs`
  вместо свежего discovery-обхода; перед этим зафиксировать freshness-контракт
  (bound на staleness каталога). Добавлено 2026-07-22.
```

- [ ] Verify: `pnpm check` still green (docs-only change; the full gate is the plan's exit criterion).
- [ ] Commit: `docs(backlog): note fan_identities/link-stats duplicate list spend`

---

## Self-review notes (author)

- Coverage: hub storage (T1–T2), flag (T3), job + schedule 2×/day + registration + ratchet (T4), tests (T5), follow-up record (T6). Naming-convention ops doc lives in /OS, deliberately out of repo scope.
- Placeholder scan: none — every step carries code or exact text.
- Type consistency: `LinkStatKind`/`InsertLinkStatSnapshotInput` defined in T2, consumed by T4/T5 under the same names; queue constant name matches between T4 and T5; flag field name matches T3↔T4↔T5.
- Known asymmetry documented: SQL CHECK constraints vs drizzle `text()` columns; SQL UNIQUE constraint vs drizzle `uniqueIndex` (T1 caveat).

---

## Post-review revision (2026-07-22, after dual review of PR #23 @ 243639dd)

All 8 confirmed findings addressed:

1. Run + snapshots now commit atomically (`insertLinkStatRunWithSnapshots`,
   one `db.transaction`) with a written-count assertion.
2. Unknown vendor revenue is NULL, never a fake zero: `revenue_gross_mills`
   and `spenders_count` are nullable, `revenue_is_loading` persisted;
   `isLoading===true`, missing revenue block, or unparseable total → NULL.
3. Run status gains `'partial'` (full walk, normalization drops): `'complete'`
   is the only absence-proving status.
4. Walk terminality now comes from `hasNextPage` (page size is only a guard);
   empty page + `hasNextPage=true` → `pagination_contradiction`, truncated.
5. Own credit quota `OFAPI_LINK_STATS_DAILY_CREDIT_BUDGET` (default 50) and
   cron moved to `45 4,16 * * *` UTC — after the chargebacks 03:10 window.
6. Snapshot rows dedupe by `platform_link_id` (last write wins) before the
   unique-constrained insert.
7. Incident open/refresh/resolve, worker throw path, and the recovery text
   are integration-tested; `notification-incident-messages` extended.
8. Per-run page cap raised to 200 (20k links) and page status distinguishes
   `'truncated'` from `'skipped'`.
