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
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const CANONICALIZE_SWEEP_QUEUE = "canonicalize.sweep";

const SWEEP_PAGE_SIZE = 200;
const SWEEP_MAX_PAGES_PER_FAMILY = 20;

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

  let afterId: number | null = null;
  for (let pageIndex = 0; pageIndex < SWEEP_MAX_PAGES_PER_FAMILY; pageIndex += 1) {
    const rows: ReplayObservationRow[] = await listObservationsForReplay(app.db, {
      belowParseVersion,
      source: family.source,
      ...(kinds !== undefined ? { kinds } : {}),
      accountId: options.accountId ?? null,
      from: options.from ?? null,
      to: options.to ?? null,
      afterId,
      limit: SWEEP_PAGE_SIZE,
    });
    if (rows.length === 0) {
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
        const drafts = family.canonicalize(row, runContext);
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

    if (rows.length < SWEEP_PAGE_SIZE) {
      break;
    }
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
