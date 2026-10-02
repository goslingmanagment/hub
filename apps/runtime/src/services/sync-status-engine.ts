import {
  countActiveLiveWorkByResource,
  getWorkForStatus,
  lastLiveAppliedAtByResource,
  listSyncPages,
  type Database,
  type SyncPageRow,
  type SyncStream,
  type SyncWorkResourceCounts,
  type SyncWorkRow,
} from "@agency_hub_core/db";

import { activePageHold } from "../sync/engine/errors.ts";
import { estimateSlotOpensAt, explainWork, type StatusPage, type StatusWork } from "../sync/engine/status.ts";
import { fanslyKeysForStreams, fanslyStreamPollSeconds } from "../sync/fansly/legacy-streams.ts";
import { FANSLY_RESOURCE_SPECS } from "../sync/fansly/registry.ts";
import type {
  SyncDomainBlockKey,
  SyncDomainBlockStatus,
  SyncStatusReason,
  SyncStreamRole,
} from "./sync-status.ts";

// The legacy status blocks of a page the Fansly Sync Engine owns (design step
// 3 §3.2 items 2 and 7): its legacy cursors are frozen at the switch, so a
// block derived from them would read "delayed" for good. Every block reads
// `state: "engine"` with the page's engine mode instead, and each legacy
// stream of the block is described by the live work of the registry keys
// that took it over: when one was last applied, when the next is due, why the
// earliest waits, and what is quarantined or blocked by the vendor. Reads are
// bounded (the page's active rows by the open-row index, page-level keys'
// newest attempts along `sync_attempts_work`): the Settings overview polls it
// every 10 s.

export type EngineMode = "handover" | "live";

/** What the engine blocks of a set of pages are built from. */
export interface EngineStatusFacts {
  page: SyncPageRow & { mode: EngineMode };
  /** Active live work per key (any subject). */
  counts: ReadonlyMap<string, SyncWorkResourceCounts>;
  /** The page-level (subject '') rows that are open, running or quarantined. */
  pageRows: readonly SyncWorkRow[];
  /** When each page-level key was last applied live. */
  appliedAt: ReadonlyMap<string, Date>;
  /** S, for when the page's next slot opens. */
  settingMs: number;
}

export function isEngineOwnedMode(mode: SyncPageRow["mode"]): mode is EngineMode {
  return mode === "handover" || mode === "live";
}

const PAGE_LEVEL_KEYS = FANSLY_RESOURCE_SPECS.filter((spec) => spec.subject === "page").map((spec) => spec.key);

/** The engine facts of every engine-owned page among `pageIds` (all pages
 *  when omitted), keyed by page id. Pages in `off`/`shadow` are absent. */
export async function readEngineStatusFacts(
  db: Database,
  input: { pageIds?: readonly number[]; settingMs: number },
): Promise<Map<number, EngineStatusFacts>> {
  const wanted = input.pageIds === undefined ? null : new Set(input.pageIds);
  const pages = (await listSyncPages(db, { modes: ["handover", "live"] }))
    .filter((page): page is SyncPageRow & { mode: EngineMode } =>
      isEngineOwnedMode(page.mode) && (wanted === null || wanted.has(page.pageId)));
  const facts = new Map<number, EngineStatusFacts>();
  if (pages.length === 0) return facts;
  const counts = await countActiveLiveWorkByResource(db, { pageIds: pages.map((page) => page.pageId) });
  for (const page of pages) {
    const pageRows = await getWorkForStatus(db, {
      pageId: page.pageId,
      shadow: false,
      subject: "",
      states: ["open", "running", "quarantined"],
      limit: 200,
    });
    const appliedAt = await lastLiveAppliedAtByResource(db, { pageId: page.pageId, resources: PAGE_LEVEL_KEYS });
    facts.set(page.pageId, {
      page,
      counts: new Map(counts.filter((row) => row.pageId === page.pageId).map((row) => [row.resource, row])),
      pageRows,
      appliedAt,
      settingMs: input.settingMs,
    });
  }
  return facts;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function latest(values: ReadonlyArray<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (value && (best === null || value.getTime() > best.getTime())) best = value;
  }
  return best;
}

function earliest(values: ReadonlyArray<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (value && (best === null || value.getTime() < best.getTime())) best = value;
  }
  return best;
}

function statusPageOf(page: SyncPageRow): StatusPage {
  return {
    mode: page.mode,
    pausedAll: page.pausedAll,
    pausedRequests: page.pausedRequests,
    pausedResources: page.pausedResources,
    holdKind: page.holdKind,
    holdUntil: page.holdUntil,
    holdDetail: page.holdDetail,
    credentialsGeneration: page.credentialsGeneration,
    resourceHolds: page.resourceHolds,
    owner: page.owner,
  };
}

function statusWorkOf(work: SyncWorkRow): StatusWork {
  return {
    id: work.id,
    resource: work.resource,
    subject: work.subject,
    class: work.class,
    state: work.state,
    dueAt: work.dueAt,
    breakerUntil: work.breakerUntil,
    blockedByVendorAt: work.blockedByVendorAt,
    waitingReason: work.waitingReason,
    waitingUntil: work.waitingUntil,
  };
}

type EngineSubstream = SyncDomainBlockStatus["substreams"][number];

/** One legacy stream of an engine page, from the live work of its keys. */
function engineSubstream(
  stream: SyncStream,
  role: SyncStreamRole,
  facts: EngineStatusFacts,
  now: Date,
): EngineSubstream {
  const keys = fanslyKeysForStreams([stream]);
  const counts = keys.map((key) => facts.counts.get(key)).filter((row): row is SyncWorkResourceCounts => row !== undefined);
  const quarantined = counts.reduce((sum, row) => sum + row.quarantined, 0);
  const blocked = counts.reduce((sum, row) => sum + row.blockedByVendor, 0);
  const maxFailures = counts.reduce((max, row) => Math.max(max, row.maxFailureCount), 0);
  const succeededAt = latest(keys.map((key) => facts.appliedAt.get(key)));
  const nextDueAt = earliest(counts.map((row) => row.nextDueAt));
  const needsAttention = quarantined > 0 || blocked > 0;
  let statusReason: SyncStatusReason | null = null;
  let error: EngineSubstream["error"] = null;
  if (needsAttention) {
    const resources = counts.filter((row) => row.quarantined > 0 || row.blockedByVendor > 0).map((row) => row.resource);
    const summary = [
      quarantined > 0 ? `${quarantined} quarantined` : null,
      blocked > 0 ? `${blocked} blocked by Fansly` : null,
    ].filter(Boolean).join(", ");
    statusReason = {
      code: quarantined > 0 ? "engine_quarantined" : "engine_blocked_by_vendor",
      summary: `${summary} (${resources.join(", ")}); pnpm cli sync work list --page ${facts.page.pageLabel ?? facts.page.pageId} --state quarantined`,
      waitingFor: null,
    };
    error = {
      stream,
      code: statusReason.code,
      summary: statusReason.summary,
      failedAt: null,
      consecutiveFailures: maxFailures,
    };
  } else {
    // Why the earliest-due page-level row of the stream waits.
    const row = [...facts.pageRows]
      .filter((work) => keys.includes(work.resource))
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
    const explanation = row === undefined
      ? null
      : explainWork(statusWorkOf(row), statusPageOf(facts.page), {
        slotOpensAt: estimateSlotOpensAt({
          lastSendAt: facts.page.lastSendAt,
          lastCompletedAt: facts.page.lastCompletedAt,
          settingMs: facts.settingMs,
        }),
      }, now);
    if (explanation !== null && row !== undefined) {
      statusReason = {
        code: explanation.reason,
        summary: `${row.resource}: ${explanation.reason}${explanation.until === null ? "" : ` until ${explanation.until.toISOString()}`}`,
        waitingFor: null,
      };
    }
  }
  return {
    stream,
    role,
    state: "engine",
    succeededAt: iso(succeededAt),
    nextDueAt: iso(nextDueAt),
    nextRetryAt: null,
    cadenceSeconds: fanslyStreamPollSeconds(stream),
    isFresh: !needsAttention,
    needsAttention,
    statusReason,
    error,
  };
}

/** A legacy block of an engine-owned page. `streams` are the block's legacy
 *  streams the page's platform supports, with their roles. */
export function buildEngineDomainBlock(
  block: SyncDomainBlockKey,
  streams: ReadonlyArray<{ stream: SyncStream; role: SyncStreamRole }>,
  facts: EngineStatusFacts,
  now: Date = facts.page.dbNow,
): SyncDomainBlockStatus {
  const substreams = streams.map(({ stream, role }) => engineSubstream(stream, role, facts, now));
  const blockKeys = fanslyKeysForStreams(streams.map(({ stream }) => stream));
  const attention = substreams.find((substream) => substream.needsAttention) ?? null;
  const hold = activePageHold(facts.page, now);
  const credentialsRefused = hold !== null && (hold.kind === "auth" || hold.kind === "identity_mismatch");
  const mode = facts.page.mode;
  const engineReason: SyncStatusReason = {
    code: "fansly_sync_engine",
    summary: mode === "handover"
      ? "Switching to the Fansly Sync Engine (handover): neither engine sends until the switch completes"
      : "Managed by the Fansly Sync Engine",
    waitingFor: null,
  };
  // The connection block carries a refused credential the way the legacy
  // block did, so the page's diagnosis asks for new credentials.
  const statusReason: SyncStatusReason = block === "connection" && credentialsRefused
    ? {
      code: "credentials_invalid",
      summary: hold!.kind === "auth"
        ? "Fansly refused the page's credentials: the engine holds the page until new ones are saved"
        : "The credentials belong to another Fansly account: the engine holds the page until new ones are saved",
      waitingFor: null,
    }
    : attention?.statusReason ?? engineReason;
  const needsAttention = attention !== null || (block === "connection" && credentialsRefused);
  return {
    block,
    state: "engine",
    engineMode: mode,
    succeededAt: iso(latest(substreams.map((substream) => (substream.succeededAt ? new Date(substream.succeededAt) : null)))),
    progress: null,
    progressStream: null,
    progressRole: null,
    error: attention?.error ?? null,
    statusReason,
    primaryFresh: !needsAttention,
    needsAttention,
    nextDueAt: iso(earliest(substreams.map((substream) => (substream.nextDueAt ? new Date(substream.nextDueAt) : null)))),
    nextRetryAt: null,
    intervals: substreams
      .filter((substream) => substream.cadenceSeconds > 0)
      .map((substream) => ({ stream: substream.stream, cadenceSeconds: substream.cadenceSeconds })),
    // The block's own keys and which of them the owner paused: what its
    // Pause / Resume buttons act on.
    metrics: {
      engineMode: mode,
      engineKeys: blockKeys,
      pausedResources: blockKeys.filter((key) => facts.page.pausedResources.includes(key)),
      pausedAll: facts.page.pausedAll,
    },
    connectionStatus: block === "connection" ? (credentialsRefused ? "error" : "connected") : null,
    substreams,
    tasks: [],
  };
}
