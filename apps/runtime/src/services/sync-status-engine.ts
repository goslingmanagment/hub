import {
  countActiveLiveWorkByResource,
  getWorkForStatus,
  lastLiveAppliedAtByResource,
  lastLiveAppliedAtOverSubjects,
  listSyncPages,
  type Database,
  type SyncPageRow,
  type SyncStream,
  type SyncWorkResourceCounts,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import type { SyncUxSummary } from "@agency_hub_core/contracts";
import { activeFanslyPageHold, isIndefinite } from "@agency_hub_core/shared";

import {
  estimateSlotOpensAt,
  explainWork,
  ownerRunning,
  type StatusPage,
  type StatusWork,
  type WaitingReason,
} from "../sync/engine/status.ts";
import {
  FANSLY_RESOURCE_SPECS,
  fanslyKeysForStreams,
  fanslyLeverStreams,
  fanslyStreamPollSeconds,
} from "../sync/fansly/registry.ts";
import type {
  SyncDomainBlockKey,
  SyncDomainBlockStatus,
  SyncStatusReason,
  SyncStreamRole,
} from "./sync-status.ts";

// The status blocks of a Fansly page (design step 3 §3.2 items 2 and 7): the
// Fansly Sync Engine reads it, so every block reads `state: "engine"` with the
// page's engine mode, and each stream of the block (the registry's lever map,
// `FANSLY_LEVER_STREAMS`) is described by the live work of the registry keys
// that answer to it: when one was last applied, when the next is due, why the
// earliest waits, and what is quarantined or blocked by the vendor. Reads are
// bounded (the page's active rows by the open-row index, each key's newest
// attempts along `sync_attempts_work`, a few rows a key): the Settings
// overview polls it every 10 s.

export type EngineMode = "handover" | "live";

/** What the engine blocks of a set of pages are built from. */
export interface EngineStatusFacts {
  page: SyncPageRow & { mode: EngineMode };
  /** Active live work per key (any subject). */
  counts: ReadonlyMap<string, SyncWorkResourceCounts>;
  /** The page-level (subject '') rows that are open, running or quarantined. */
  pageRows: readonly SyncWorkRow[];
  /** When each key was last applied live: a page-level key, and a lever key
   *  that works per subject (a chat, a fan) over all its subjects. */
  appliedAt: ReadonlyMap<string, Date>;
  /** S, for when the page's next slot opens. */
  settingMs: number;
}

export function isEngineOwnedMode(mode: SyncPageRow["mode"]): mode is EngineMode {
  return mode === "handover" || mode === "live";
}

/** The Settings blocks of a Fansly page: the lever streams each block shows
 *  and its buttons move, with the role each plays in the block. A stream in no
 *  block (`fan_earnings`, `posts`, the statistics and catalogue reads, …) has
 *  no Settings button: the insights coverage lists every one. */
export const ENGINE_BLOCK_STREAMS: Readonly<Record<
  SyncDomainBlockKey,
  ReadonlyArray<{ stream: SyncStream; role: SyncStreamRole }>
>> = {
  connection: [{ stream: "light", role: "primary" }],
  financials: [
    { stream: "transactions", role: "primary" },
    { stream: "top_spenders", role: "supporting" },
  ],
  audience: [
    { stream: "subscribers", role: "primary" },
    { stream: "followers", role: "primary" },
    { stream: "followers_reconcile", role: "supporting" },
  ],
  messages_live: [{ stream: "dm_conversations", role: "primary" }],
  messages_history: [{ stream: "dm_messages", role: "primary" }],
};

/** The lever streams of a Settings block on a Fansly page. */
export function engineBlockStreams(block: SyncDomainBlockKey): SyncStream[] {
  return ENGINE_BLOCK_STREAMS[block].map(({ stream }) => stream);
}

const PAGE_LEVEL_KEYS = FANSLY_RESOURCE_SPECS.filter((spec) => spec.subject === "page").map((spec) => spec.key);

/** The lever keys that work per subject (`dm-messages.head` per chat,
 *  `purchases.targets` per target, …): a stream of such keys alone
 *  (`dm_messages`, `purchase_history`) was last read when any subject was. */
export const SUBJECT_LEVEL_LEVER_KEYS: readonly string[] = (() => {
  const lever = new Set(fanslyKeysForStreams(fanslyLeverStreams()));
  return FANSLY_RESOURCE_SPECS.filter((spec) => spec.subject !== "page" && lever.has(spec.key)).map((spec) => spec.key);
})();

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
    const pageLevel = await lastLiveAppliedAtByResource(db, { pageId: page.pageId, resources: PAGE_LEVEL_KEYS });
    const perSubject = await lastLiveAppliedAtOverSubjects(db, { pageId: page.pageId, resources: SUBJECT_LEVEL_LEVER_KEYS });
    const appliedAt = new Map([...pageLevel, ...perSubject]);
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
    holdSince: page.holdSince,
    holdDetail: page.holdDetail,
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

/** One lever stream of an engine page, as the live work of the registry keys
 *  that answer to it says: the read model of every surface that describes the
 *  page stream by stream (the Settings blocks, the insights coverage, the
 *  top-spenders source). */
export interface EngineStreamState {
  stream: SyncStream;
  /** The registry keys that answer to the stream, in registry order. */
  keys: string[];
  /** When one of them was last applied live (a key that works per subject:
   *  over all its subjects). */
  succeededAt: Date | null;
  /** The earliest due time of their open work. */
  nextDueAt: Date | null;
  /** Their live rows that are open, running or quarantined (any subject). */
  activeWork: number;
  /** The owner paused the whole page or every one of the keys. */
  paused: boolean;
  /** Some of their work is quarantined or blocked by the vendor. */
  needsAttention: boolean;
  /** What needs attention (and the command that lists it), or why the
   *  earliest-due page-level row waits, as one line. */
  statusReason: SyncStatusReason | null;
  /** Why that earliest-due page-level row waits, as data: its key, the
   *  engine's reason and until when. Null when the stream needs attention, or
   *  none of its page-level work is open. */
  waiting: EngineStreamWaiting | null;
  /** The largest subject-breaker failure count among their active rows. */
  consecutiveFailures: number;
}

/** Why a stream's earliest-due page-level work waits ("почему ждёт", plan §10). */
export interface EngineStreamWaiting {
  resource: string;
  reason: WaitingReason;
  until: Date | null;
}

/** A host runs the page's loop: a fresh heartbeat of its owner, in a mode an
 *  actor runs in. False: nothing of the page is read, whatever its work says
 *  (every row waits `ownership_unconfirmed`). */
export function engineOwnerRunning(facts: Pick<EngineStatusFacts, "page">, now: Date = facts.page.dbNow): boolean {
  return ownerRunning(facts.page, now);
}

/** The commands that list the work a stream needs the owner for: quarantined
 *  rows are a state of their own; rows Fansly refuses stay `open` (they wait
 *  `blocked_by_vendor`), so those are listed by their key. */
function attentionCommands(page: string | number, quarantined: readonly string[], blocked: readonly string[]): string[] {
  const list = `pnpm cli sync work list --page ${page}`;
  return [
    ...(quarantined.length > 0 ? [`${list} --state quarantined`] : []),
    ...blocked.map((resource) => `${list} --state open --resource ${resource}`),
  ];
}

export function engineStreamState(
  stream: SyncStream,
  facts: EngineStatusFacts,
  now: Date = facts.page.dbNow,
): EngineStreamState {
  const keys = fanslyKeysForStreams([stream]);
  const counts = keys.map((key) => facts.counts.get(key)).filter((row): row is SyncWorkResourceCounts => row !== undefined);
  const quarantined = counts.reduce((sum, row) => sum + row.quarantined, 0);
  const blocked = counts.reduce((sum, row) => sum + row.blockedByVendor, 0);
  const consecutiveFailures = counts.reduce((max, row) => Math.max(max, row.maxFailureCount), 0);
  const succeededAt = latest(keys.map((key) => facts.appliedAt.get(key)));
  const nextDueAt = earliest(counts.map((row) => row.nextDueAt));
  const activeWork = counts.reduce((sum, row) => sum + row.active, 0);
  const paused = facts.page.pausedAll
    || (keys.length > 0 && keys.every((key) => facts.page.pausedResources.includes(key)));
  const needsAttention = quarantined > 0 || blocked > 0;
  let statusReason: SyncStatusReason | null = null;
  let waiting: EngineStreamWaiting | null = null;
  if (needsAttention) {
    const quarantinedKeys = counts.filter((row) => row.quarantined > 0).map((row) => row.resource);
    const blockedKeys = counts.filter((row) => row.blockedByVendor > 0).map((row) => row.resource);
    const summary = [
      quarantined > 0 ? `${quarantined} quarantined (${quarantinedKeys.join(", ")})` : null,
      blocked > 0 ? `${blocked} blocked by Fansly (${blockedKeys.join(", ")})` : null,
    ].filter(Boolean).join(", ");
    const commands = attentionCommands(facts.page.pageLabel ?? facts.page.pageId, quarantinedKeys, blockedKeys);
    statusReason = {
      code: quarantined > 0 ? "engine_quarantined" : "engine_blocked_by_vendor",
      summary: `${summary}; ${commands.join("; ")}`,
      waitingFor: null,
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
      // A hold with no end (refused credentials) has no "until" to show.
      const until = explanation.until !== null && !isIndefinite(explanation.until) ? explanation.until : null;
      waiting = { resource: row.resource, reason: explanation.reason, until };
      statusReason = {
        code: explanation.reason,
        summary: `${row.resource}: ${explanation.reason}${until === null ? "" : ` until ${until.toISOString()}`}`,
        waitingFor: null,
      };
    }
  }
  return {
    stream, keys, succeededAt, nextDueAt, activeWork, paused, needsAttention, statusReason, waiting, consecutiveFailures,
  };
}

/** One lever stream of an engine page as a Settings block substream. */
function engineSubstream(
  stream: SyncStream,
  role: SyncStreamRole,
  facts: EngineStatusFacts,
  now: Date,
): EngineSubstream {
  const state = engineStreamState(stream, facts, now);
  return {
    stream,
    role,
    state: "engine",
    succeededAt: iso(state.succeededAt),
    nextDueAt: iso(state.nextDueAt),
    nextRetryAt: null,
    cadenceSeconds: fanslyStreamPollSeconds(stream),
    isFresh: !state.needsAttention,
    needsAttention: state.needsAttention,
    statusReason: state.statusReason,
    error: state.needsAttention && state.statusReason !== null
      ? {
        stream,
        code: state.statusReason.code,
        summary: state.statusReason.summary,
        failedAt: null,
        consecutiveFailures: state.consecutiveFailures,
      }
      : null,
  };
}

/** A Settings block of an engine-owned page (`ENGINE_BLOCK_STREAMS`). */
export function buildEngineDomainBlock(
  block: SyncDomainBlockKey,
  facts: EngineStatusFacts,
  now: Date = facts.page.dbNow,
): SyncDomainBlockStatus {
  const substreams = ENGINE_BLOCK_STREAMS[block].map(({ stream, role }) => engineSubstream(stream, role, facts, now));
  const blockKeys = fanslyKeysForStreams(engineBlockStreams(block));
  const attention = substreams.find((substream) => substream.needsAttention) ?? null;
  const refusal = engineCredentialsRefusal(facts.page, now);
  const credentialsRefused = refusal !== null;
  const mode = facts.page.mode;
  const engineReason: SyncStatusReason = {
    code: "fansly_sync_engine",
    summary: engineModeSummary(mode),
    waitingFor: null,
  };
  // The connection block carries a refused credential, so the page's
  // diagnosis asks for new credentials.
  const statusReason: SyncStatusReason = block === "connection" && refusal !== null
    ? { code: "credentials_invalid", summary: refusal.summary, waitingFor: null }
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

function engineModeSummary(mode: EngineMode): string {
  return mode === "handover"
    ? "Switching to the Fansly Sync Engine (handover): neither engine sends until the switch completes"
    : "Managed by the Fansly Sync Engine";
}

/** The page's refused credentials (an `auth` / `identity_mismatch` hold in
 *  force) in the words of the status surfaces; null when the engine holds
 *  nothing against them. */
export function engineCredentialsRefusal(
  page: SyncPageRow,
  now: Date = page.dbNow,
): { kind: "auth" | "identity_mismatch"; summary: string } | null {
  const hold = activeFanslyPageHold(page, now)?.credentials ?? null;
  if (hold === null) return null;
  return {
    kind: hold.kind,
    summary: hold.kind === "auth"
      ? "Fansly refused the page's credentials: the engine holds the page until new ones are saved"
      : "The credentials belong to another Fansly account: the engine holds the page until new ones are saved",
  };
}

// ── the page summary ─────────────────────────────────────────────────────────
//
// The one-line sync state of a Fansly page on the surfaces that list pages
// (the sidebar's connections, the overview, the credentials tab): the same
// verdict the page's Settings blocks give together (`buildPageSyncUx` over the
// engine blocks), read from the page's row and the counts of its active work
// alone — two bounded queries for all pages, where the blocks read every
// page-level key of every page.

/** What the summary of an engine page is built from. */
export interface EngineSummaryFacts {
  page: SyncPageRow & { mode: EngineMode };
  /** Active live work per key (any subject). */
  counts: readonly SyncWorkResourceCounts[];
}

/** The summary facts of every engine-owned page among `pageIds`, by page id.
 *  A page in `off`/`shadow`, or with no engine row, is absent. */
export async function readEngineSummaryFacts(
  db: Database,
  input: { pageIds: readonly number[] },
): Promise<Map<number, EngineSummaryFacts>> {
  const facts = new Map<number, EngineSummaryFacts>();
  if (input.pageIds.length === 0) return facts;
  const wanted = new Set(input.pageIds);
  const pages = (await listSyncPages(db, { modes: ["handover", "live"] }))
    .filter((page): page is SyncPageRow & { mode: EngineMode } => isEngineOwnedMode(page.mode) && wanted.has(page.pageId));
  if (pages.length === 0) return facts;
  const counts = await countActiveLiveWorkByResource(db, { pageIds: pages.map((page) => page.pageId) });
  for (const page of pages) {
    facts.set(page.pageId, { page, counts: counts.filter((row) => row.pageId === page.pageId) });
  }
  return facts;
}

/** Every registry key some Settings block shows. */
const BLOCK_KEYS: ReadonlySet<string> = new Set(
  fanslyKeysForStreams(Object.values(ENGINE_BLOCK_STREAMS).flatMap((streams) => streams.map(({ stream }) => stream))),
);

/** The sync summary of an engine page: new credentials needed, work of a
 *  Settings block quarantined or refused by Fansly, a switch in progress, or
 *  managed by the engine. */
export function buildEnginePageSyncUx(facts: EngineSummaryFacts, now: Date = facts.page.dbNow): SyncUxSummary {
  const updatedAt = iso(facts.page.lastCompletedAt);
  const base = { progressLabel: null, nextRetryAt: null, updatedAt };
  const refusal = engineCredentialsRefusal(facts.page, now);
  if (refusal !== null) {
    return {
      ...base,
      state: "attention",
      label: "Reconnect",
      headline: "Reconnect to resume sync",
      detail: refusal.summary,
      requiresAction: true,
    };
  }
  const blockCounts = facts.counts.filter((row) => BLOCK_KEYS.has(row.resource));
  const quarantined = blockCounts.reduce((sum, row) => sum + row.quarantined, 0);
  const blocked = blockCounts.reduce((sum, row) => sum + row.blockedByVendor, 0);
  if (quarantined > 0 || blocked > 0) {
    return {
      ...base,
      state: "attention",
      label: "Needs attention",
      headline: "The Fansly Sync Engine needs attention",
      detail: [
        quarantined > 0 ? `${quarantined} quarantined` : null,
        blocked > 0 ? `${blocked} blocked by Fansly` : null,
      ].filter(Boolean).join(", "),
      requiresAction: false,
    };
  }
  const handover = facts.page.mode === "handover";
  return {
    ...base,
    state: handover ? "catching_up" : "healthy",
    label: handover ? "Switching" : "Fansly Sync Engine",
    headline: handover ? "Switching to the Fansly Sync Engine" : "Managed by the Fansly Sync Engine",
    detail: engineModeSummary(facts.page.mode),
    requiresAction: false,
  };
}
