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
}

async function runFamily(
  app: Pick<AppContext, "db" | "logger">,
  family: CanonicalizerFamily,
  options: CanonicalizationRunOptions,
  totals: CanonicalizationRunResult,
  runContext: { nativeAccountRefByAccountId: ReadonlyMap<number, string | null> },
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
      const drafts = family.canonicalize(row, runContext);

      if (options.dryRun) {
        totals.appended += drafts.length;
        continue;
      }

      if (drafts.length > 0 && row.accountId == null) {
        // Events require an account; an unmapped observation stays below the
        // version floor and self-heals once the account mapping lands.
        totals.skippedUnmapped += 1;
        continue;
      }

      if (drafts.length > 0) {
        const result = await appendDomainEvents(
          app.db,
          row.accountId!,
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
    maxLagSeconds: 0,
  };
  // Per-run context: Fansly DM direction resolves against the page's own
  // native account ref (Stage 17); built once, shared by all families.
  const pages = await listPageNativeAccountRefs(app.db);
  const runContext = {
    nativeAccountRefByAccountId: new Map(
      pages.map((page) => [page.id, page.nativeAccountRef] as const),
    ),
  };
  for (const family of CANONICALIZER_FAMILIES) {
    await runFamily(app, family, options, totals, runContext);
  }
  return totals;
}
