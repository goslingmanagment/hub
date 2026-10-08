import {
  countActiveLiveWorkByResource,
  countUnavailableChats,
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
import { isIndefinite } from "@agency_hub_core/shared";

import {
  heldByScope,
  holdSetOf,
  pageHoldsInForce,
  type HoldSet,
  type RouteAdmissionView,
} from "../sync/engine/admission.ts";
import { routeAdmissionView, RouteClocks } from "../sync/engine/route-policy.ts";
import {
  estimateSlotOpensAt,
  explainWork,
  ownerRunning,
  routePutOffUntil,
  type StatusPage,
  type StatusWork,
  type WaitingReason,
} from "../sync/engine/status.ts";
import {
  FANSLY_RESOURCE_SPECS,
  fanslyKeysForStreams,
  fanslyLeverStreams,
  fanslyResourceSpec,
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
// earliest waits, what is quarantined or blocked by the vendor — and what
// stops its keys from sending now (`engineStops`: the owner's pauses and the
// hold evaluator's answer, key by key). Reads are bounded (the page's active
// rows by the open-row index, each key's newest attempts along
// `sync_attempts_work`, a few rows a key): the Settings overview polls it
// every 10 s.
//
// A chat Fansly does not serve to the page (an established chat-unavailability
// episode, arena "vanished chat" plan §4) is no work that needs the owner:
// its `dm-messages.*` rows are out of the vendor's block count
// (`countActiveLiveWorkByResource`), and the chat is counted instead — the
// messages block's `chatsUnavailable` and a line of the page summary.

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
  /** Chats Fansly does not serve to the page (established unavailability
   *  episodes); absent: none. */
  chatsUnavailable?: number;
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

/** The registry keys a Settings block shows and its buttons move, in registry
 *  order. No key is another block's too (tests/sync-lever-map.test.ts). */
export function engineBlockKeys(block: SyncDomainBlockKey): string[] {
  return fanslyKeysForStreams(engineBlockStreams(block));
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
  const chats = await countUnavailableChats(db, { pageIds: pages.map((page) => page.pageId) });
  for (const page of pages) {
    const pageRows = await getWorkForStatus(db, {
      pageId: page.pageId,
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
      chatsUnavailable: chats.get(page.pageId) ?? 0,
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

function statusPageOf(page: SyncPageRow, holds: HoldSet): StatusPage {
  return {
    mode: page.mode,
    pausedAll: page.pausedAll,
    pausedRequests: page.pausedRequests,
    pausedResources: page.pausedResources,
    holds,
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
    http: fanslyResourceSpec(work.resource)?.http !== false,
  };
}

// ── what stops a key ─────────────────────────────────────────────────────────
//
// "Is it sending?" has one answer per registry key, and the surfaces that
// describe a page stream by stream give it for the keys of each stream: the
// owner's pause (the page, the requests class, the key), and what the hold
// evaluator says of a request of the key (`engine/admission.ts` `heldByScope`,
// the rule the actor admits by) — the page's own hold, the breaker of the
// key's resource file, a 429's hold of its routes. Every cause is listed, not
// the first: a key the owner paused on a page Fansly refuses is stopped by
// both, and ending one leaves the other.
//
// A 429's hold stops a key in the two ways the actor meets it. Every route the
// key reads is held: the pick leaves the key out until one opens. Or one of
// them is, and the request the key's work planned took it: the final check
// before the admission put the work off until the route opens (`deferForRoute`)
// — a key that reads several routes (`posts.refresh`: the timeline and the
// tips; `followers.reconcile`; the catalogue and statistics reads) is picked
// while one of them is open, so such a hold shows only on its row. That row is
// read for the keys that work per page (`putOff`: one row a key); a key that
// works per subject is judged by its routes alone. A route's own pace is not a
// stop: work it puts off is queued. The route holds are read from the page's
// hold set alone (no send is counted): this is about holds, and it costs no
// read of the attempt journal.

export const ENGINE_STOP_REASONS = ["paused", "page_hold", "resource_hold", "route_hold"] as const;
export type EngineStopReason = (typeof ENGINE_STOP_REASONS)[number];

/** One thing that stops keys of a page from sending now, with the keys. */
export interface EngineStop {
  reason: EngineStopReason;
  /** What stops them. `paused`: `page` (the owner paused the whole page),
   *  `requests` (the history requests class) or `keys` (the keys themselves).
   *  `page_hold`: the hold's kind (`auth`, `identity_mismatch`, `network`, or
   *  `unreadable` — rows of the hold set this build cannot read).
   *  `resource_hold`: the resource file on its breaker. `route_hold`: the
   *  routes a 429 holds. */
  by: string[];
  /** The registry keys it stops, in registry order. */
  resources: string[];
  /** When it ends (for work a hold of one of its routes put off: when the
   *  work is due again, or the hold ends if that is sooner). Null: no instant
   *  ends it — a pause, refused credentials, rows nobody can read. */
  until: Date | null;
}

/** How much of a set of keys is stopped: none of them, some, or every one. */
export type EngineStopped = "none" | "some" | "all";

/** What stops a set of keys, and how much of the set that is. */
export interface EngineStops {
  /** One entry per cause, in the order of `ENGINE_STOP_REASONS`. */
  stops: EngineStop[];
  stopped: EngineStopped;
  /** The owner's pause stops every one of the keys, whatever else does. */
  paused: boolean;
}

/** What the stops of a set of keys are judged from: the page's pauses, its
 *  hold set and the holds of its routes, read once, and the page-level work a
 *  route put off. */
interface StopFacts {
  page: Pick<SyncPageRow, "pausedAll" | "pausedRequests" | "pausedResources">;
  holds: HoldSet;
  /** The route admission over the route holds alone; null: the route state
   *  does not read (the page is then held as a whole, `unreadable`). */
  routes: RouteAdmissionView | null;
  /** The keys whose page-level row the route of its planned request put off,
   *  with when the row is due again (`routePutOffUntil`). */
  putOff: ReadonlyMap<string, Date>;
}

/** The page and its page-level rows: what the stops of its keys are read from. */
type StopSource = Pick<EngineStatusFacts, "page" | "pageRows">;

function stopFactsOf(source: StopSource, holds: HoldSet, now: Date): StopFacts {
  const putOff = new Map<string, Date>();
  for (const row of source.pageRows) {
    const until = routePutOffUntil(statusWorkOf(row), now);
    if (until !== null) putOff.set(row.resource, until);
  }
  return {
    page: source.page,
    holds,
    routes: holds.routes.ok
      ? routeAdmissionView(new RouteClocks({ sends: [], state: holds.routes.state }), FANSLY_RESOURCE_SPECS, now)
      : null,
    putOff,
  };
}

/** A hold's end as a stop shows it: an indefinite one has none. */
function stopEnd(until: Date | null): Date | null {
  return until === null || isIndefinite(until) ? null : until;
}

type StopCause = Omit<EngineStop, "resources">;

/** The owner's pause of one key, by its widest scope; null: not paused. */
function keyPause(key: string, page: StopFacts["page"]): StopCause | null {
  if (page.pausedAll) return { reason: "paused", by: ["page"], until: null };
  if (page.pausedRequests && fanslyResourceSpec(key)?.class === "requests") {
    return { reason: "paused", by: ["requests"], until: null };
  }
  return page.pausedResources.includes(key) ? { reason: "paused", by: ["keys"], until: null } : null;
}

/** Everything that stops one key now, in the order the engine judges a row
 *  (`explainWork`): the pause, the page, the file, the routes. Empty: a
 *  request of it would be admitted as far as pauses and holds go. */
function keyStops(key: string, facts: StopFacts, now: Date): StopCause[] {
  const causes: StopCause[] = [];
  const pause = keyPause(key, facts.page);
  if (pause !== null) causes.push(pause);
  // A key without requests never waits on the page's hold or on a route.
  const sends = fanslyResourceSpec(key)?.http !== false;
  const routes = sends ? facts.routes : null;
  const held = heldByScope(facts.holds, routes, { work: { resource: key } }, now);
  if (held.page !== null && sends) causes.push({ reason: "page_hold", by: [held.page.kind], until: stopEnd(held.page.until) });
  if (held.resource !== null) causes.push({ reason: "resource_hold", by: [held.resource.file], until: held.resource.until });
  if (held.route?.scope === "route_hold") {
    // Every route of the key is held: until the first of them opens.
    causes.push({ reason: "route_hold", by: [...held.route.held], until: held.route.until });
    return causes;
  }
  // One of its routes is open. The evaluator is then asked as it is of the
  // row itself (`explainWork`): work its route put off waits on a hold while
  // one keeps a route of the key closed.
  const putOffUntil = facts.putOff.get(key) ?? null;
  if (putOffUntil === null) return causes;
  const putOff = heldByScope(facts.holds, routes, { work: { resource: key, putOffUntil } }, now).route;
  if (putOff?.scope === "route_hold") {
    // The stop stands while the work is put off and a hold keeps a route
    // closed: it ends with the first of the two (a route's own interval may
    // put the work off past its hold — from the hold's end it is queued).
    const holdsEnd = latest(putOff.held.map((route) => routes?.routeOpensAt(route)?.at));
    causes.push({ reason: "route_hold", by: [...putOff.held], until: earliest([putOff.until, holdsEnd]) });
  }
  return causes;
}

function stopsOfKeys(keys: readonly string[], facts: StopFacts, now: Date): EngineStops {
  const byCause = new Map<string, EngineStop>();
  let stoppedKeys = 0;
  let pausedKeys = 0;
  for (const key of keys) {
    const causes = keyStops(key, facts, now);
    if (causes.length > 0) stoppedKeys += 1;
    if (causes.some((cause) => cause.reason === "paused")) pausedKeys += 1;
    for (const cause of causes) {
      const id = `${cause.reason}\u0000${cause.by.join(",")}\u0000${cause.until?.getTime() ?? ""}`;
      const known = byCause.get(id);
      if (known === undefined) byCause.set(id, { ...cause, resources: [key] });
      else known.resources.push(key);
    }
  }
  const stops = [...byCause.values()]
    .sort((a, b) => ENGINE_STOP_REASONS.indexOf(a.reason) - ENGINE_STOP_REASONS.indexOf(b.reason));
  return {
    stops,
    stopped: stoppedKeys === 0 ? "none" : stoppedKeys === keys.length ? "all" : "some",
    paused: keys.length > 0 && pausedKeys === keys.length,
  };
}

/** What stops the registry keys `keys` of a page from sending now, and how
 *  much of them that is: by the page's row and its page-level work. */
export function engineStops(keys: readonly string[], source: StopSource, now: Date = source.page.dbNow): EngineStops {
  return stopsOfKeys(keys, stopFactsOf(source, holdSetOf(source.page.holds), now), now);
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
  /** The earliest due time of their open work that nothing stops: a paused
   *  or held key has no next read while its stop stands. */
  nextDueAt: Date | null;
  /** Their live rows that are open, running or quarantined (any subject). */
  activeWork: number;
  /** The owner's pause stops every one of the keys: the whole page, or each
   *  key (a key of the requests class also by the requests pause). */
  paused: boolean;
  /** How many of the keys can send nothing now: none, some, every one. */
  stopped: EngineStopped;
  /** What stops those keys, cause by cause (`engineStops`). */
  stops: EngineStop[];
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
  const activeWork = counts.reduce((sum, row) => sum + row.active, 0);
  const holds = holdSetOf(facts.page.holds);
  const stopFacts = stopFactsOf(facts, holds, now);
  const { stops, stopped, paused } = stopsOfKeys(keys, stopFacts, now);
  const stoppedKeys = new Set(stops.flatMap((stop) => stop.resources));
  const nextDueAt = earliest(counts.filter((row) => !stoppedKeys.has(row.resource)).map((row) => row.nextDueAt));
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
      : explainWork(statusWorkOf(row), statusPageOf(facts.page, holds), {
        slotOpensAt: estimateSlotOpensAt({
          lastSendAt: facts.page.lastSendAt,
          lastCompletedAt: facts.page.lastCompletedAt,
          settingMs: facts.settingMs,
        }),
        // A 429's hold of the row's routes reads `route_hold`; a route's own
        // pace stays what the row stores (`pacer`: queued).
        routes: stopFacts.routes,
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
    stream, keys, succeededAt, nextDueAt, activeWork, paused, stopped, stops, needsAttention, statusReason, waiting,
    consecutiveFailures,
  };
}

/** A stop on the wire: its end as an ISO instant. */
export interface EngineStopWire extends Omit<EngineStop, "until"> {
  until: string | null;
}

export function engineStopToWire(stop: EngineStop): EngineStopWire {
  return { reason: stop.reason, by: [...stop.by], resources: [...stop.resources], until: iso(stop.until) };
}

/** Work of some keys — quarantined, refused by the vendor: how many rows, of
 *  which keys. */
export interface EngineWorkCount {
  count: number;
  resources: string[];
}

/** What a Settings block of an engine page says beyond its streams: who runs
 *  the page, the keys its buttons move and which of them the owner paused,
 *  what stops them now, and the work that needs the owner. */
export interface EngineBlockInfo {
  mode: EngineMode;
  /** A host runs the page's loop. False: nothing of the block is read. */
  ownerRunning: boolean;
  /** The registry keys the block's buttons move, in registry order. */
  keys: string[];
  /** Those of them that are polls: what "sync now" makes due. */
  pollKeys: string[];
  /** Those of them the owner paused one by one. */
  pausedKeys: string[];
  /** The owner paused the whole page (`sync page pause --all`). */
  pausedAll: boolean;
  /** How many of the keys can send nothing now, and what stops them. */
  stopped: EngineStopped;
  stops: EngineStopWire[];
  /** The owner's pause stops every one of the keys, whatever else does. */
  paused: boolean;
  /** The keys' live rows that are open, running or quarantined. */
  activeWork: number;
  /** The keys' quarantined rows: what the block's requeue takes. */
  quarantined: EngineWorkCount;
  /** The keys' rows Fansly refuses — the rows of a chat Fansly does not serve
   *  to the page left out (they are `chatsUnavailable`). */
  blockedByVendor: EngineWorkCount;
  /** The block that reads the chats' messages (`messages_history`) only:
   *  how many chats Fansly does not serve to the page. Informational — no
   *  attention, no lever (`pnpm cli sync chats unavailable` lists them). */
  chatsUnavailable?: number;
}

/** A stream of a block: how many of its keys are stopped and by what, and
 *  its live rows that are open, running or quarantined. */
export interface EngineSubstreamInfo {
  stopped: EngineStopped;
  stops: EngineStopWire[];
  /** The owner's pause stops every one of its keys, whatever else does. */
  paused: boolean;
  activeWork: number;
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
    engine: {
      stopped: state.stopped,
      stops: state.stops.map(engineStopToWire),
      paused: state.paused,
      activeWork: state.activeWork,
    },
  };
}

/** The rows `rows` counts among the live work of `keys`, with their keys. */
function countWork(
  keys: readonly string[],
  facts: EngineStatusFacts,
  rows: (counts: SyncWorkResourceCounts) => number,
): EngineWorkCount {
  const found = keys
    .map((key) => facts.counts.get(key))
    .filter((counts): counts is SyncWorkResourceCounts => counts !== undefined && rows(counts) > 0);
  return { count: found.reduce((sum, counts) => sum + rows(counts), 0), resources: found.map((counts) => counts.resource) };
}

/** The Settings block whose keys read the chats' messages (`dm-messages.*`):
 *  the one that counts the chats Fansly does not serve to the page. */
const CHATS_BLOCK: SyncDomainBlockKey = "messages_history";

/** A Settings block of an engine-owned page (`ENGINE_BLOCK_STREAMS`). */
export function buildEngineDomainBlock(
  block: SyncDomainBlockKey,
  facts: EngineStatusFacts,
  now: Date = facts.page.dbNow,
): SyncDomainBlockStatus {
  const substreams = ENGINE_BLOCK_STREAMS[block].map(({ stream, role }) => engineSubstream(stream, role, facts, now));
  const blockKeys = engineBlockKeys(block);
  const { stops, stopped, paused } = engineStops(blockKeys, facts, now);
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
    metrics: {},
    // The block's own keys, which of them the owner paused and what stops
    // them: what its card says and its buttons act on.
    engine: {
      mode,
      ownerRunning: engineOwnerRunning(facts, now),
      keys: blockKeys,
      pollKeys: blockKeys.filter((key) => fanslyResourceSpec(key)?.kind === "poll"),
      pausedKeys: blockKeys.filter((key) => facts.page.pausedResources.includes(key)),
      pausedAll: facts.page.pausedAll,
      stopped,
      stops: stops.map(engineStopToWire),
      paused,
      activeWork: countWork(blockKeys, facts, (counts) => counts.active).count,
      quarantined: countWork(blockKeys, facts, (counts) => counts.quarantined),
      blockedByVendor: countWork(blockKeys, facts, (counts) => counts.blockedByVendor),
      ...(block === CHATS_BLOCK ? { chatsUnavailable: facts.chatsUnavailable ?? 0 } : {}),
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
  const hold = pageHoldsInForce(holdSetOf(page.holds), now)?.credentials ?? null;
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
  /** Chats Fansly does not serve to the page; absent: none. */
  chatsUnavailable?: number;
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
  const chats = await countUnavailableChats(db, { pageIds: pages.map((page) => page.pageId) });
  for (const page of pages) {
    facts.set(page.pageId, {
      page,
      counts: counts.filter((row) => row.pageId === page.pageId),
      chatsUnavailable: chats.get(page.pageId) ?? 0,
    });
  }
  return facts;
}

/** Every registry key some Settings block shows. */
const BLOCK_KEYS: ReadonlySet<string> = new Set(
  fanslyKeysForStreams(Object.values(ENGINE_BLOCK_STREAMS).flatMap((streams) => streams.map(({ stream }) => stream))),
);

/** The summary's informational line of the chats Fansly does not serve to
 *  the page; null: none. Never a reason for attention. */
export function engineChatsUnavailableText(chats: number | undefined): string | null {
  return chats === undefined || chats <= 0 ? null : `Chats Fansly does not serve: ${chats}`;
}

/** The sync summary of an engine page: new credentials needed, work of a
 *  Settings block quarantined or refused by Fansly, a switch in progress, or
 *  managed by the engine — with, beside any of the last three, how many chats
 *  Fansly does not serve to the page (a counter, never "Needs attention"). */
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
  // A chat Fansly does not serve is not among them (`countActiveLiveWorkByResource`).
  const blocked = blockCounts.reduce((sum, row) => sum + row.blockedByVendor, 0);
  const chats = engineChatsUnavailableText(facts.chatsUnavailable);
  const withChats = (detail: string) => (chats === null ? detail : `${detail} · ${chats}`);
  if (quarantined > 0 || blocked > 0) {
    return {
      ...base,
      state: "attention",
      label: "Needs attention",
      headline: "The Fansly Sync Engine needs attention",
      detail: withChats([
        quarantined > 0 ? `${quarantined} quarantined` : null,
        blocked > 0 ? `${blocked} blocked by Fansly` : null,
      ].filter(Boolean).join(", ")),
      requiresAction: false,
    };
  }
  const handover = facts.page.mode === "handover";
  return {
    ...base,
    state: handover ? "catching_up" : "healthy",
    label: handover ? "Switching" : "Fansly Sync Engine",
    headline: handover ? "Switching to the Fansly Sync Engine" : "Managed by the Fansly Sync Engine",
    detail: withChats(engineModeSummary(facts.page.mode)),
    requiresAction: false,
  };
}
