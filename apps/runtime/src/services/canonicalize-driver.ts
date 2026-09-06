import { notifyOfapiGlobalIncident, resolveOfapiGlobalIncident } from "./notification-incidents.ts";
import { listHistoricalOfapiBindings } from "@agency_hub_core/db";
// Canonicalization driver (Stage 8). The minutely sweep IS the replay
// executor: it walks observations whose parse_version is below their
// family's current version, runs the pure canonicalizer, appends events
// (per-account gapless protocol, cross-producer dedup by key), and stamps
// parse_version forward-only. Bumping a family's version makes the sweep
// revisit its kinds — replay is the steady-state mechanism, not a special
// case. The events:replay CLI runs the same engine with narrowing filters.

import {
  appendDomainEvents,
  appendMixedDomainEvents,
  appendProjectionOnlyDomainEvents,
  assertDomainEventTargetMonthsAttached,
  type DomainEventPartitionCoverage,
  DomainEventTargetMonthsUnattachedError,
  listObservationsForReplay,
  listDetachedPartitionsHoldingAccount,
  listObservedPostRefsForCapture,
  listPageNativeAccountRefs,
  loadDomainEventPartitionCoverage,
  markObservationParsed,
  type ReplayObservationRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { isCapturePayloadUnavailable, resolveCapturePayloadRow } from "./payload-reader.ts";
import {
  CANONICALIZER_FAMILIES,
  type CanonicalizerFamily,
} from "./canonicalize/index.ts";
import type { CanonicalEventDraft } from "./canonicalize/types.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const CANONICALIZE_SWEEP_QUEUE = "canonicalize.sweep";

/**
 * The reconcile half of what used to be ONE minutely handler (defect
 * 2026-08-22). `runOfapiDmReadthroughReconcile`, `runOfapiCaptureMaterialization`
 * and `runDmCorrectionsReconcile` ran inside the canonicalize sweep's handler,
 * AFTER every family — so once the sweep started outrunning pg-boss's 900s
 * handler expiration (WP-F0's ~30 drafts per dm_messages observation, plus the
 * five WP-F1..F6 projection-only families) the job was killed mid-run and the
 * three reconciles NEVER RAN AT ALL: `messages.received` and
 * `ofapi.interactive_response` backlogs grew while the sweep restarted and was
 * killed again. They share a cadence with the sweep and nothing else, so they
 * get their own minutely queue. The name lives here, beside the sweep it was
 * split from, and the two are created and scheduled together below.
 */
export const DM_RECONCILE_SWEEP_QUEUE = "projections.dm-reconcile.sweep";

const SWEEP_PAGE_SIZE = 200;
const SWEEP_MAX_PAGES_PER_FAMILY = 20;

/**
 * Wall-clock budget the minutely sweep hands `runCanonicalization`
 * (`maxDurationMs`). Ten minutes sits well under pg-boss's 900s default
 * handler expiration for this queue — the queue keeps that default on purpose,
 * so the budget is the thing that ends a long run and the expiration stays the
 * backstop it was meant to be. The gap leaves room for the page in flight when
 * the budget expires (the check is BETWEEN pages, never mid-row).
 */
export const CANONICALIZE_SWEEP_BUDGET_MS = 600_000;

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
  await ensureQueueCreated(boss, DM_RECONCILE_SWEEP_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureCanonicalizeSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(CANONICALIZE_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" });
  // Same minute, its own job: the reconciles must be reachable on a tick the
  // sweep spent entirely inside one family's pages.
  await boss.schedule(DM_RECONCILE_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" });
}

export interface CanonicalizationRunResult {
  /** Conflicting refs are held unmapped; dry-run reports without incident mutations. */
  bindingConflicts: string[];
  scanned: number;
  appended: number;
  deduped: number;
  stamped: number;
  /** Observations with events but no mapped account — retried next sweep. */
  skippedUnmapped: number;
  /**
   * Rows the family's shape gate refused: the payload matches no shape the
   * family knows, so it stays UNSTAMPED and replayable for a future parser.
   * Distinct from a legitimately EMPTY snapshot, which is consumed normally.
   */
  skippedUnparseable: number;
  /** Bounded, content-free reasons for shape-gate refusals. These make an
   * `events:replay` result actionable without exposing the captured payload or
   * emitting one repetitive log line per poison row on every sweep. */
  unparseableSamples: Array<{
    observationId: number;
    family: string;
    kind: string;
    reasonCode: string;
    itemIndex?: number;
  }>;
  /**
   * Rows whose captured body could not be READ at all (#223) — a pointer-only
   * envelope whose single catalog copy was momentarily out of reach. Left
   * UNSTAMPED and retried, exactly like an unparseable row, but counted apart
   * from one because the two mean opposite things about the future:
   * unparseable is PERMANENT until a parser learns the shape, unavailable is
   * TRANSIENT and needs no code change at all. Folding them together would let
   * a degraded catalog masquerade as a corpus of unknown payloads — and the
   * number that would grow is the one an operator reads as "we need a new
   * parser".
   */
  skippedUnavailable: number;
  /** Highest observation id examined this run — the exact continuation cursor
   * for a bounded run (feed it back as `afterId`). Null when nothing matched. */
  lastObservationId: number | null;
  /**
   * Rows whose canonicalize/append/stamp threw — logged, left UNSTAMPED
   * (retried next sweep), never allowed to wedge the run. Parsers are total
   * by design, so anything here is a transient DB error or a genuine bug
   * worth the error-log line it produces every sweep.
   */
  errored: number;
  /**
   * §3.2c(ii): rows REFUSED before any write because a draft's target month
   * has no attached domain_events partition. Deliberately distinct from
   * `errored`: nothing failed, the engine declined — the observation stays
   * unstamped, its parse debt survives the recovery, and a run reporting
   * partitionBlocked > 0 is a SKIPPED step, not a passed one.
   */
  partitionBlocked: number;
  /** ONE entry per (family, target month) per run, naming detached vs absent
   *  and the recovery each needs — not one line per refused row. */
  partitionAnomalies: Array<{
    family: string;
    month: string;
    shape: "detached" | "absent";
    detachedRelations: string[];
    recovery: string;
  }>;
  /** Seconds from received_at to processing for the oldest row this run. */
  maxLagSeconds: number;
  /**
   * The run stopped early because `maxDurationMs` ran out. NOT a failure and
   * not an error: every row it did process is settled, and the families it did
   * not reach are named in `skippedFamilies` and take the head of the next run
   * (see the rotation below). It IS starvation pressure, so the sweep logs it
   * at warn level — a tick that keeps truncating means the minute no longer
   * holds the corpus.
   */
  truncatedByBudget: boolean;
  /**
   * `source:lane` of every family that did not run AT ALL this tick because
   * the budget was already gone when its turn came. The family that was
   * mid-run when the budget expired is absent from this list — it ran, kept
   * its sweep cursor, and resumes exactly where it stopped.
   */
  skippedFamilies: string[];
}

export interface CanonicalizationRunOptions {
  /** Narrow to specific kinds (CLI); default = every declared family kind. */
  kinds?: readonly string[];
  accountId?: number | null;
  /** Restrict the scan to an explicit account set. Mandatory for a family
   * whose kinds are shared across platforms — the stamp lands even on rows
   * that produced zero events, so an unscoped run consumes the other
   * platform's observations for good (see listObservationsForReplay). */
  accountIds?: readonly number[];
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
  /** Start the keyset scan after this observation id. The continuation cursor
   * for a bounded run: a run that hit `maxPagesPerFamily` reports
   * `lastObservationId`, and passing it back here resumes EXACTLY where it
   * stopped — which is what makes a dry run (which stamps nothing, so it
   * cannot advance by itself) able to cover a large corpus. Ignored when
   * `useSweepCursor` is set. */
  afterId?: number | null;
  /** Counts-only parser diagnostics sink, handed to every canonicalizer. */
  diagnostics?: { record: (code: string) => void };
  /**
   * Wall-clock budget for the WHOLE run (defect 2026-08-22). Default: none —
   * the CLI drains and the replay paths are bounded by their page counts and
   * must not stop halfway through a narrowed replay. The minutely sweep passes
   * one, because pg-boss kills a handler that outruns the queue's expiration
   * and a killed run is strictly worse than a truncated one: it settles
   * nothing extra and takes everything scheduled after it down with it.
   *
   * The budget is checked BETWEEN PAGES and BETWEEN FAMILIES, never mid-row: a
   * row is the unit of work that appends and stamps in one commit, and abandoning
   * one halfway is exactly the append-without-stamp shape the engine already
   * treats as a retry.
   */
  maxDurationMs?: number;
}

/** Where each family's NEXT sweep resumes (see useSweepCursor). Module-level
 * on purpose, mirroring the corrections reconciler (#123): a wrap resets to
 * the head, so skipped rows are retried once per full cycle, not once per
 * minute. In-memory is enough — a worker restart costs one head pass. */
const sweepCursors = new Map<string, number | null>();

function sweepCursorKey(family: CanonicalizerFamily): string {
  // Multiple independently-versioned families may share one observation
  // source (pull/posts is projection-only while the general pull family is
  // deliverable). Include the declared kind lane so their sweep cursors can
  // never alias when their version numbers happen to match.
  return `${family.source}:${family.kinds?.join(",") ?? "*"}:v${family.version}`;
}

/**
 * Where the NEXT budgeted sweep starts its family rotation — the `source:lane`
 * of a family, or null for "the registry head" (defect 2026-08-22).
 *
 * Why rotate at all: with a wall-clock budget the registry order becomes a
 * priority order, and the families at the end of it (fansly-stats,
 * -engagement, -catalog, -comments — the WP-F1..F6 additions) are exactly the
 * ones that never got a turn while the sweep was being killed at 900s. Each
 * budgeted run therefore resumes at the family AFTER the one that ran the
 * budget out, so every family reaches the head within a few ticks.
 *
 * Module-level and in-memory, deliberately mirroring `sweepCursors` above: a
 * worker restart costs one pass that starts at the head, and the per-family
 * cursors (which ARE the durable "where was I" state within a family) are
 * untouched by rotation — a family resumes its own scan exactly where it
 * stopped whenever its turn comes round.
 *
 * Rotation is safe ONLY because families of the same `source` claim DISJOINT
 * kinds (the one family with `kinds: null` is command_result, the only family
 * of its source). Two families claiming one kind would make run order decide
 * which of them stamps parse_version first — order would then be semantics,
 * not scheduling, and this rotation would break it.
 */
let sweepFamilyRotationKey: string | null = null;

/** `source:lane` — stable, version-independent, unique across the registry
 *  (the lane's contract), and the same label the partition anomalies carry. */
function familyLabel(family: CanonicalizerFamily): string {
  return `${family.source}:${family.lane}`;
}

function rotateFamilies(
  families: readonly CanonicalizerFamily[],
): readonly CanonicalizerFamily[] {
  if (sweepFamilyRotationKey === null) {
    return families;
  }
  const start = families.findIndex((family) => familyLabel(family) === sweepFamilyRotationKey);
  // A key that no longer resolves (registry edited, or a `families` override)
  // means "start at the head" — never "skip the run".
  return start <= 0 ? families : [...families.slice(start), ...families.slice(0, start)];
}

/** Test hook: start every family's next sweep from the signal head. */
export function resetCanonicalizeSweepCursors() {
  sweepCursors.clear();
  sweepFamilyRotationKey = null;
}

/**
 * §3.2c(ii) in the ENGINE, not in a command — this one object backs both the
 * ordinary minutely sweep and the `events:replay` CLI drain, because both call
 * `runCanonicalization`. A CLI-only gate would leave the steady-state sweep
 * that re-reads history after a version bump completely unguarded.
 *
 * The census is read ONCE per run and only on first use: a run whose families
 * emit nothing (or only out-of-regime drafts) issues no catalog query at all.
 */
interface PartitionGate {
  assertTargetsAttached(family: CanonicalizerFamily, targets: readonly Date[]): Promise<void>;
  recordAnomaly(
    family: CanonicalizerFamily,
    error: DomainEventTargetMonthsUnattachedError,
  ): void;
}

function createPartitionGate(
  app: Pick<AppContext, "db" | "logger">,
  totals: CanonicalizationRunResult,
): PartitionGate {
  let coverage: Promise<DomainEventPartitionCoverage> | null = null;
  const raised = new Set<string>();
  return {
    async assertTargetsAttached(_family, targets) {
      if (targets.length === 0) {
        return;
      }
      coverage ??= loadDomainEventPartitionCoverage(app.db);
      await assertDomainEventTargetMonthsAttached(app.db, targets, {
        coverage: await coverage,
      });
    },
    recordAnomaly(family, error) {
      for (const blocked of error.blocked) {
        // ONE anomaly per (family, target month) per run — a blocked drain can
        // be thousands of rows, and thousands of identical log lines are how
        // an operator stops reading them.
        const key = `${family.source}:${family.lane}:${blocked.month}`;
        if (raised.has(key)) {
          continue;
        }
        raised.add(key);
        const anomaly = {
          family: `${family.source}:${family.lane}`,
          month: blocked.month,
          shape: blocked.shape,
          detachedRelations: blocked.detachedRelations,
          recovery: blocked.recovery,
        };
        totals.partitionAnomalies.push(anomaly);
        app.logger.error(
          anomaly,
          "Canonicalization REFUSED an append: no attached domain_events partition for the "
            + "target month; the observation stays unstamped until the recovery runs",
        );
      }
    },
  };
}

async function runFamily(
  app: Pick<AppContext, "db" | "logger">,
  family: CanonicalizerFamily,
  options: CanonicalizationRunOptions,
  totals: CanonicalizationRunResult,
  runContext: {
    nativeAccountRefByAccountId: ReadonlyMap<number, string | null>;
    accountIdByNativeRef: ReadonlyMap<string, number>;
    diagnostics?: { record: (code: string) => void };
  },
  partitionGate: PartitionGate,
  /** Epoch ms after which this family must take no NEW page; null = no budget. */
  deadlineAt: number | null,
): Promise<boolean> {
  const kinds = options.kinds !== undefined
    ? (family.kinds === null
      ? options.kinds
      : options.kinds.filter((kind) => family.kinds!.includes(kind)))
    : family.kinds ?? undefined;
  if (options.kinds !== undefined && kinds !== undefined && kinds.length === 0) {
    return false;
  }
  const belowParseVersion = options.belowParseVersion ?? family.version;
  const now = options.now ?? new Date();

  const useCursor = options.useSweepCursor === true;
  const pageSize = options.pageSize ?? SWEEP_PAGE_SIZE;
  const maxPages = options.maxPagesPerFamily ?? SWEEP_MAX_PAGES_PER_FAMILY;
  let afterId: number | null = useCursor
    ? sweepCursors.get(sweepCursorKey(family)) ?? null
    : options.afterId ?? null;
  let reachedEnd = false;
  let budgetExhausted = false;
  const checkedAcceptedLedgers = new Set<number>();
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    // The budget, checked between PAGES only (never mid-row). `pageIndex > 0`
    // on purpose: the caller already proved the budget was alive when this
    // family's turn came, so every family that starts gets at least one page —
    // a family that could be entered and immediately abandoned would be
    // "scheduled" without ever making progress.
    if (deadlineAt !== null && pageIndex > 0 && Date.now() >= deadlineAt) {
      budgetExhausted = true;
      break;
    }
    const rows: ReplayObservationRow[] = await listObservationsForReplay(app.db, {
      belowParseVersion,
      ...(family.minimumParseVersion === undefined ? {} : { atLeastParseVersion: family.minimumParseVersion }),
      source: family.source,
      ...(kinds !== undefined ? { kinds } : {}),
      accountId: options.accountId ?? null,
      ...(options.accountIds !== undefined ? { accountIds: options.accountIds } : {}),
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
      totals.lastObservationId = totals.lastObservationId === null
        ? row.id
        : Math.max(totals.lastObservationId, row.id);
      totals.maxLagSeconds = Math.max(
        totals.maxLagSeconds,
        Math.round((now.getTime() - row.receivedAt.getTime()) / 1000),
      );
      // Fault isolation: one poison row (or a transient DB error mid-row)
      // must cost exactly that row's stamp, not the sweep. It stays below
      // the version floor and is retried next run; everything after it in
      // this run still processes (afterId already advanced past the page).
      try {
        // G5 slice 2: resolve the body through the read seam BEFORE the shape
        // gate, so the family sees exactly the bytes the mode says are
        // canonical. `inline` returns the same row object untouched.
        const observation = await resolveCapturePayloadRow(app, "observation", row.id, row);
        // Shape gate BEFORE anything else: a payload the family cannot read
        // must not be stamped consumed. Stamping it would delete it from
        // every future replay just as surely as a DROP would — the exact
        // failure the parse_version contract exists to prevent.
        if (family.canParse !== undefined && !family.canParse(observation)) {
          totals.skippedUnparseable += 1;
          const rejection = family.parseRejection?.(observation) ?? null;
          const reasonCode = rejection?.code ?? "unclassified";
          // The worker logs the whole run result. Bound this list so a broad
          // version bump over a poison corpus cannot turn diagnostics into its
          // own log-volume incident.
          if (totals.unparseableSamples.length < 20) {
            totals.unparseableSamples.push({
              observationId: row.id,
              family: familyLabel(family),
              kind: row.kind,
              reasonCode,
              ...(rejection?.itemIndex === undefined
                ? {}
                : { itemIndex: rejection.itemIndex }),
            });
          }
          runContext.diagnostics?.record(`canonicalize_rejected:${family.lane}:${reasonCode}`);
          continue;
        }
        let acceptedPostRefs: ReadonlySet<string> | undefined;
        if (family.replayContext === "accepted_posts") {
          if (row.accountId === null) throw new Error("OF post capture has no mapped page");
          if (!checkedAcceptedLedgers.has(row.accountId)) {
            if ((await listDetachedPartitionsHoldingAccount(app.db, row.accountId)).length > 0) {
              throw new Error("OF post replay requires the complete attached acceptance ledger");
            }
            checkedAcceptedLedgers.add(row.accountId);
          }
          acceptedPostRefs = new Set(await listObservedPostRefsForCapture(app.db, row.accountId, row.id));
        }
        const drafts = family.canonicalize(observation, {
          ...runContext, ...(acceptedPostRefs === undefined ? {} : { acceptedPostRefs }),
        })
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
          const inputs = drafts.map((draft) => ({ ...draft, observationId: row.id }));
          // §3.2c(ii), BEFORE any write: refuse the whole observation when a
          // draft aims at a month with no attached partition. Receipt-time
          // drafts are in the current month by construction and never block;
          // the provider-dated lanes (message.material_observed, post.observed)
          // are the ones a historical drain aims at cold months.
          await partitionGate.assertTargetsAttached(
            family,
            inputs.map((input) => input.occurredAt),
          );
          // A projection-only family's material never reaches a client, so its
          // hidden seq range needs the atomic checkpoint the SSE replay
          // validator looks for. The key carries the family version: a version
          // bump that mints EXTRA events for an already-checkpointed
          // observation must claim a fresh checkpoint, not collide with the
          // old one.
          const checkpoint = {
            occurredAt: row.receivedAt,
            observationId: row.id,
            dedupKey: `${family.source}:v${family.version}:checkpoint:${row.id}`,
          };
          // Three shapes, one checkpoint identity. `mixed` (§3.2a) is the
          // third: a deliverable family that also emits projection-only
          // material for the same observation. It reuses the SAME checkpoint
          // key the projection-only branch builds — the family version in the
          // key is what lets a version bump mint EXTRA events for an
          // already-checkpointed observation without colliding.
          const result = family.projectionOnly === true
            ? await appendProjectionOnlyDomainEvents(app.db, accountId!, inputs, checkpoint)
            : family.mixed === true
            ? await appendMixedDomainEvents(app.db, accountId!, inputs, checkpoint)
            : await appendDomainEvents(app.db, accountId!, inputs);
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
        // §3.2c(ii): a refusal is not a failure. The observation keeps its
        // parse debt (unstamped, retried after the recovery) and is counted
        // apart from `errored` so a blocked drain cannot read as a clean run.
        if (error instanceof DomainEventTargetMonthsUnattachedError) {
          totals.partitionBlocked += 1;
          partitionGate.recordAnomaly(family, error);
          continue;
        }
        // #223: an unreadable body is NOT a canonicalization failure and must
        // not be counted as one — a parse error is a bug or a poison row, this
        // is a body that will be there again in a minute. It shares the
        // outcome (unstamped, retried next sweep) and nothing else. Before
        // #223 the seam answered `null` here, four of the six families have no
        // `canParse` shape gate, and a null payload canonicalizes to zero
        // events — so the row fell straight through to markObservationParsed
        // and was consumed for good.
        if (isCapturePayloadUnavailable(error)) {
          totals.skippedUnavailable += 1;
          app.logger.warn(
            { observationId: row.id, source: family.source, kind: row.kind },
            "Observation body is unavailable; left UNSTAMPED for the next sweep",
          );
          continue;
        }
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
    // A budget-truncated family is mid-signal by construction, so its cursor
    // holds the exact continuation point until its next turn.
    sweepCursors.set(sweepCursorKey(family), reachedEnd ? null : afterId);
  }
  return budgetExhausted;
}

/** One global latch; CLI/test stubs without config only log. Never called in dry-run. */
async function reportOfapiBindingConflicts(
  app: Pick<AppContext, "db" | "logger"> & Partial<Pick<AppContext, "config">>, refs: string[],
) {
  if (!app.config) return;
  const incidentApp = { db: app.db, logger: app.logger, config: app.config };
  if (refs.length > 0) {
    await notifyOfapiGlobalIncident(incidentApp, {
      kind: "ofapi_binding_conflict",
      errorSummary: `OFAPI account(s) claimed by two pages: ${refs.join(", ")} — facts for these refs are held back until custody is settled`,
      occurredAt: new Date(),
    });
  } else {
    await resolveOfapiGlobalIncident(incidentApp, { kind: "ofapi_binding_conflict", recoveredAt: new Date() });
  }
}

export async function runCanonicalization(
  app: Pick<AppContext, "db" | "logger"> & Partial<Pick<AppContext, "config">>,
  options: CanonicalizationRunOptions = {},
): Promise<CanonicalizationRunResult> {
  const totals: CanonicalizationRunResult = {
    bindingConflicts: [],
    scanned: 0,
    appended: 0,
    deduped: 0,
    stamped: 0,
    skippedUnmapped: 0,
    skippedUnparseable: 0,
    unparseableSamples: [],
    skippedUnavailable: 0,
    lastObservationId: null,
    errored: 0,
    partitionBlocked: 0,
    partitionAnomalies: [],
    maxLagSeconds: 0,
    truncatedByBudget: false,
    skippedFamilies: [],
  };
  const deadlineAt = options.maxDurationMs !== undefined && options.maxDurationMs > 0
    ? Date.now() + options.maxDurationMs
    : null;
  const partitionGate = createPartitionGate(app, totals);
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
  for (const binding of await listHistoricalOfapiBindings(app.db)) {
    const key = `onlyfans:${binding.account_id}`;
    const current = accountIdByNativeRef.get(key);
    if (current !== undefined && current !== binding.page_id) {
      // Two pages claim one provider account. Neither may receive its facts until an operator
      // settles custody: the ref is quarantined (its rows stay skippedUnmapped and self-heal once
      // the map is unambiguous), every other ref and family runs normally.
      accountIdByNativeRef.delete(key);
      totals.bindingConflicts.push(binding.account_id);
      continue;
    }
    accountIdByNativeRef.set(key, binding.page_id);
  }
  if (totals.bindingConflicts.length > 0) {
    app.logger.error({ bindingConflicts: totals.bindingConflicts, dryRun: options.dryRun === true },
      "OFAPI binding custody conflict: refs quarantined from canonicalization");
  }
  // Stage 8 contract: a dry run writes NOTHING — no incident open, no incident resolve, no Telegram.
  if (options.dryRun !== true) await reportOfapiBindingConflicts(app, totals.bindingConflicts);
  const runContext = {
    nativeAccountRefByAccountId: new Map(
      pages.map((page) => [page.id, page.nativeAccountRef] as const),
    ),
    accountIdByNativeRef,
    ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
  };
  const families = options.families ?? CANONICALIZER_FAMILIES;
  // Only the cursor-driven minutely sweep rotates. CLI and replay runs keep
  // the registry order so a narrowed replay stays deterministic — and they
  // pass no budget, so there is nothing for a rotation to be fair about.
  const rotates = options.useSweepCursor === true;
  const ordered = rotates ? rotateFamilies(families) : families;
  /** Index in `ordered` the NEXT run should start at; null = a full pass. */
  let nextStartIndex: number | null = null;
  for (const [index, family] of ordered.entries()) {
    if (deadlineAt !== null && Date.now() >= deadlineAt) {
      // The budget died in the PREVIOUS family: this one and everything after
      // it did not run at all, and this one heads the next run.
      totals.truncatedByBudget = true;
      totals.skippedFamilies = ordered.slice(index).map(familyLabel);
      nextStartIndex = index;
      break;
    }
    // Family isolation: a structural failure in one family (e.g. its list
    // query dying on a transient error) must not stall the other sources.
    try {
      const budgetExhausted = await runFamily(
        app,
        family,
        options,
        totals,
        runContext,
        partitionGate,
        deadlineAt,
      );
      if (budgetExhausted) {
        // This family ran and kept its cursor; the next run starts AFTER it so
        // the tail of the registry cannot be starved by the head.
        totals.truncatedByBudget = true;
        totals.skippedFamilies = ordered.slice(index + 1).map(familyLabel);
        nextStartIndex = (index + 1) % ordered.length;
        break;
      }
    } catch (error) {
      totals.errored += 1;
      app.logger.error(
        { error, source: family.source },
        "Canonicalizer family run failed; other families continue",
      );
    }
  }
  if (rotates) {
    // A completed pass clears the offset: the next run starts at the head,
    // exactly as every run did before the budget existed.
    sweepFamilyRotationKey = nextStartIndex === null
      ? null
      : familyLabel(ordered[nextStartIndex]!);
  }
  return totals;
}
