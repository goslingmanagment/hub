// Canonicalization driver (Stage 8). The minutely sweep IS the replay
// executor: it walks observations whose parse_version is below their
// family's current version, runs the pure canonicalizer, appends events
// (per-account gapless protocol, cross-producer dedup by key), and stamps
// parse_version forward-only. Bumping a family's version makes the sweep
// revisit its kinds — replay is the steady-state mechanism, not a special
// case. The events:replay CLI runs the same engine with narrowing filters.

import {
  appendDomainEvents,
  listObservationsForReplay,
  listPageNativeAccountRefs,
  markObservationParsed,
  type ReplayObservationRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  CANONICALIZER_FAMILIES,
  type CanonicalizerFamily,
} from "./canonicalize/index.ts";
import type { CanonicalEventDraft } from "./canonicalize/types.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const CANONICALIZE_SWEEP_QUEUE = "canonicalize.sweep";

const SWEEP_PAGE_SIZE = 200;
const SWEEP_MAX_PAGES_PER_FAMILY = 20;

/** W8.2 (A13 remainder, decision #133): the plausibility window for
 * occurred_at at canonicalize time. Provider timestamps are untrusted input —
 * a garbage year (1970 epoch-zero, 20326 fat-finger) used to aim the insert
 * at a partition that may not exist (ExecFindPartition 23514 → the
 * observation retries every sweep, forever). Real platform facts start 2024;
 * the future edge allows provider clock skew, nothing more. */
export const OCCURRED_AT_CLAMP_MIN = new Date("2024-01-01T00:00:00Z");
export const OCCURRED_AT_CLAMP_FUTURE_MONTHS = 2;

export function occurredAtClampMax(now: Date): Date {
  const max = new Date(now.getTime());
  max.setUTCMonth(max.getUTCMonth() + OCCURRED_AT_CLAMP_FUTURE_MONTHS);
  return max;
}

/** Out-of-window occurred_at falls back to the observation's receipt time —
 * NEVER a guessed boundary date — and the raw provider value is preserved
 * verbatim in event data (occurredAtRaw) so a later repair campaign (the
 * 1970-repair precedent) can re-date honestly. Dedup keys are built by the
 * canonicalizers BEFORE this clamp, so replays stay key-stable. */
export function clampDraftOccurredAt(
  draft: CanonicalEventDraft,
  receivedAt: Date,
  now: Date,
): CanonicalEventDraft {
  const time = draft.occurredAt.getTime();
  if (
    !Number.isNaN(time)
    && time >= OCCURRED_AT_CLAMP_MIN.getTime()
    && time <= occurredAtClampMax(now).getTime()
  ) {
    return draft;
  }
  return {
    ...draft,
    occurredAt: receivedAt,
    data: {
      ...draft.data,
      occurredAtClamped: true,
      occurredAtRaw: Number.isNaN(time) ? null : draft.occurredAt.toISOString(),
    },
  };
}

export async function ensureCanonicalizeQueues(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, CANONICALIZE_SWEEP_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureCanonicalizeSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(CANONICALIZE_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" });
}

export interface CanonicalizationRunResult {
  scanned: number;
  appended: number;
  deduped: number;
  stamped: number;
  /** Observations with events but no mapped account — retried next sweep. */
  skippedUnmapped: number;
  /**
   * Rows whose canonicalize/append/stamp threw — logged, left UNSTAMPED
   * (retried next sweep), never allowed to wedge the run. Parsers are total
   * by design, so anything here is a transient DB error or a genuine bug
   * worth the error-log line it produces every sweep.
   */
  errored: number;
  /** Seconds from received_at to processing for the oldest row this run. */
  maxLagSeconds: number;
}

export interface CanonicalizationRunOptions {
  /** Narrow to specific kinds (CLI); default = every declared family kind. */
  kinds?: readonly string[];
  accountId?: number | null;
  from?: Date | null;
  to?: Date | null;
  /** Override the version floor (CLI --parse-version); default per family. */
  belowParseVersion?: number;
  dryRun?: boolean;
  now?: Date;
  /** Family registry override (fault-isolation tests); default = all. */
  families?: readonly CanonicalizerFamily[];
  /** W5.3 (B3, decision #123 semantics): resume each family from where the
   * last sweep stopped instead of restarting at the head every minute.
   * Permanently-unstampable rows (poison, skippedUnmapped) used to occupy
   * the scan head forever — ≥4000 stuck rows starved the whole family. Only
   * the minutely sweep worker sets this; CLI/replay paths (kinds/account/
   * from/to filters) stay cursor-free so narrowed replays are deterministic. */
  useSweepCursor?: boolean;
  /** Paging-bound overrides (tests; mirrors the corrections reconciler). */
  pageSize?: number;
  maxPagesPerFamily?: number;
}

/** Where each family's NEXT sweep resumes (see useSweepCursor). Module-level
 * on purpose, mirroring the corrections reconciler (#123): a wrap resets to
 * the head, so skipped rows are retried once per full cycle, not once per
 * minute. In-memory is enough — a worker restart costs one head pass. */
const sweepCursors = new Map<string, number | null>();

function sweepCursorKey(family: CanonicalizerFamily): string {
  return `${family.source}:v${family.version}`;
}

/** Test hook: start every family's next sweep from the signal head. */
export function resetCanonicalizeSweepCursors() {
  sweepCursors.clear();
}

async function runFamily(
  app: Pick<AppContext, "db" | "logger">,
  family: CanonicalizerFamily,
  options: CanonicalizationRunOptions,
  totals: CanonicalizationRunResult,
  runContext: {
    nativeAccountRefByAccountId: ReadonlyMap<number, string | null>;
    accountIdByNativeRef: ReadonlyMap<string, number>;
  },
) {
  const kinds = options.kinds !== undefined
    ? (family.kinds === null
      ? options.kinds
      : options.kinds.filter((kind) => family.kinds!.includes(kind)))
    : family.kinds ?? undefined;
  if (options.kinds !== undefined && kinds !== undefined && kinds.length === 0) {
    return;
  }
  const belowParseVersion = options.belowParseVersion ?? family.version;
  const now = options.now ?? new Date();

  const useCursor = options.useSweepCursor === true;
  const pageSize = options.pageSize ?? SWEEP_PAGE_SIZE;
  const maxPages = options.maxPagesPerFamily ?? SWEEP_MAX_PAGES_PER_FAMILY;
  let afterId: number | null = useCursor
    ? sweepCursors.get(sweepCursorKey(family)) ?? null
    : null;
  let reachedEnd = false;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const rows: ReplayObservationRow[] = await listObservationsForReplay(app.db, {
      belowParseVersion,
      source: family.source,
      ...(kinds !== undefined ? { kinds } : {}),
      accountId: options.accountId ?? null,
      from: options.from ?? null,
      to: options.to ?? null,
      afterId,
      limit: pageSize,
    });
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }
    afterId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      totals.scanned += 1;
      totals.maxLagSeconds = Math.max(
        totals.maxLagSeconds,
        Math.round((now.getTime() - row.receivedAt.getTime()) / 1000),
      );
      // Fault isolation: one poison row (or a transient DB error mid-row)
      // must cost exactly that row's stamp, not the sweep. It stays below
      // the version floor and is retried next run; everything after it in
      // this run still processes (afterId already advanced past the page).
      try {
        const drafts = family.canonicalize(row, runContext)
          .map((draft) => clampDraftOccurredAt(draft, row.receivedAt, now));
        // Capture-first rows (webhook) carry only the vendor account ref;
        // resolve it against the page map before the unmapped check.
        const accountId = row.accountId
          ?? (row.nativeAccountRef
            ? runContext.accountIdByNativeRef.get(`${row.platform}:${row.nativeAccountRef}`) ?? null
            : null);

        if (options.dryRun) {
          totals.appended += drafts.length;
          continue;
        }

        if (drafts.length > 0 && accountId == null) {
          // Events require an account; an unmapped observation stays below the
          // version floor and self-heals once the account mapping lands.
          totals.skippedUnmapped += 1;
          continue;
        }

        if (drafts.length > 0) {
          const result = await appendDomainEvents(
            app.db,
            accountId!,
            drafts.map((draft) => ({ ...draft, observationId: row.id })),
          );
          totals.appended += result.appended;
          totals.deduped += result.deduped;
        }
        await markObservationParsed(app.db, {
          observationId: row.id,
          receivedAt: row.receivedAt,
          parseVersion: belowParseVersion,
        });
        totals.stamped += 1;
      } catch (error) {
        totals.errored += 1;
        app.logger.error(
          { error, observationId: row.id, source: family.source, kind: row.kind },
          "Canonicalization failed for observation; left pending for the next sweep",
        );
      }
    }

    if (rows.length < pageSize) {
      reachedEnd = true;
      break;
    }
  }
  if (useCursor) {
    // End of signal → wrap to the head next run (skipped rows get their
    // once-per-cycle retry); mid-signal → resume where this run stopped.
    sweepCursors.set(sweepCursorKey(family), reachedEnd ? null : afterId);
  }
}

export async function runCanonicalization(
  app: Pick<AppContext, "db" | "logger">,
  options: CanonicalizationRunOptions = {},
): Promise<CanonicalizationRunResult> {
  const totals: CanonicalizationRunResult = {
    scanned: 0,
    appended: 0,
    deduped: 0,
    stamped: 0,
    skippedUnmapped: 0,
    errored: 0,
    maxLagSeconds: 0,
  };
  // Per-run context: Fansly DM direction resolves against the page's own
  // native account ref (Stage 17); built once, shared by all families.
  const pages = await listPageNativeAccountRefs(app.db);
  // Inverse resolution for capture-first producers: webhook observations
  // journal the VENDOR account ref (acct_… for OFAPI) and no page id — the
  // page id resolves here at canonicalize time, keyed platform-scoped over
  // both identity columns (platform_account_id and ofapi_account_id).
  const accountIdByNativeRef = new Map<string, number>();
  for (const page of pages) {
    if (page.nativeAccountRef) {
      accountIdByNativeRef.set(`${page.platform}:${page.nativeAccountRef}`, page.id);
    }
    if (page.ofapiAccountId) {
      accountIdByNativeRef.set(`${page.platform}:${page.ofapiAccountId}`, page.id);
    }
  }
  const runContext = {
    nativeAccountRefByAccountId: new Map(
      pages.map((page) => [page.id, page.nativeAccountRef] as const),
    ),
    accountIdByNativeRef,
  };
  for (const family of options.families ?? CANONICALIZER_FAMILIES) {
    // Family isolation: a structural failure in one family (e.g. its list
    // query dying on a transient error) must not stall the other sources.
    try {
      await runFamily(app, family, options, totals, runContext);
    } catch (error) {
      totals.errored += 1;
      app.logger.error(
        { error, source: family.source },
        "Canonicalizer family run failed; other families continue",
      );
    }
  }
  return totals;
}
