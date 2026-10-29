import { createHash } from "node:crypto";

import {
  CLIENT_ACTIVITY_LOST_MINUTES,
  FAN_QUEUE_LEASE_MINUTES,
  IN_CONVERSATION_MINUTES,
  type AgentFanQueue,
  type AgentFanQueueAppendBody,
  type AgentFanQueueAppendResponse,
  type AgentFanQueueCreateBody,
  type AgentFanQueueDetail,
  type AgentFanQueueGetQuery,
  type AgentFanQueueListQuery,
  type AgentFanQueuePreviewBody,
  type AgentFanQueuePreviewResponse,
  type AgentFanQueueUpdateBody,
  type ClientFanQueueItem,
  type ClientFanQueueItemDoneBody,
  type ClientFanQueueItemDoneResponse,
  type ClientFanQueueReleaseResponse,
  type ClientFanQueuesResponse,
  type ClientFanQueueTakeBody,
  type ClientFanQueueTakeResponse,
  type FanQueueExcluded,
  type FanQueueRule,
  type FanQueueScenario,
  type FanQueueStop,
} from "@agency_hub_core/contracts";
import {
  completeFanQueueItem,
  countFanQueueAvailable,
  countFanQueueDay,
  countFanQueueItems,
  countFanQueueMassMessages,
  deferFanQueueItems,
  dropFanQueueItems,
  dropPendingFanQueueItems,
  expireFanQueueLeases,
  findFanQueueByIdempotencyKey,
  findFanQueuePerson,
  findLeasedFanQueueItem,
  findPageSummaryByLabel,
  getFanQueue,
  insertFanQueue,
  insertFanQueueItems,
  insertObservation,
  insertOnlineAttempt,
  leaseFanQueueItems,
  listFanQueueAnswered,
  listFanQueueResults,
  listFanQueues,
  listFanQueueSiblingPageIds,
  listOnlineCandidates,
  listRecentPageAuthors,
  moveFanQueueItems,
  pickPendingFanQueueItems,
  releaseFanQueueLeases,
  renewFanQueueLeases,
  resolveFanQueueRefs,
  selectFanQueueFans,
  updateFanQueue,
  type Database,
  type FanQueueItemRow,
  type FanQueueRow,
  type FanQueueSelection,
  type OnlineCandidateRow,
} from "@agency_hub_core/db";
import { startOfBusinessDay, toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { decideOnline, greetingNameOf, ONLINE_TEMPLATES, type OthersTalking } from "./client-online-rules.ts";
import { inConversationOf } from "./client-in-conversation.ts";
import { requireClientGrantedPage } from "./client-switches.ts";
import { clientTokenIngestProducer } from "./client-token-profile.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import {
  describeFanQueueList,
  describeFanQueueRule,
  FAN_QUEUE_LATER_DAYS,
  fanQueueFilterOf,
  fanQueueItemAct,
  fanQueueListFilter,
  fanQueueWhy,
  judgeFanQueueItem,
} from "./fan-queue-rules.ts";
import { ingestProducerForClientVersion } from "./ingest-observations.ts";

/**
 * Fan queues (docs/plans/2026-10-29-fan-queues/spec.md): an agent previews,
 * creates, changes and reads a page's queues on the word of the person who
 * asked; the extension lists a person's queues, takes a portion and reports
 * each fan. The rules and words are fan-queue-rules.ts, the SQL
 * packages/db/src/repositories/fan-queues.ts. Database only: nothing here asks
 * a platform or sends anything.
 */

export const FAN_QUEUES_FEATURE = "fanQueues";
export const FAN_QUEUE_ITEM_OBSERVATION_KIND = "client.fan_queue_item.v1";
/** A rule over a whole page reads its chats: longer than the plane's usual ceiling. */
export const FAN_QUEUE_AGENT_TIMEOUT_MS = 45_000;
/** How far back a fan who answered the caller's queue message stays on top. */
const ANSWERED_HOURS = 72;
const MASS_DAYS = 90;
const PREVIEW_SAMPLES = 5;
const DAY = 24 * 60 * 60 * 1000;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

export interface FanQueuePage {
  id: number;
  label: string;
  platform: string;
}

// ── people ─────────────────────────────────────────────────────────────────

async function person(db: Database, username: string, pageId: number, reason: "requester_not_granted" | "person_not_granted") {
  const found = await findFanQueuePerson(db, { username, pageId });
  if (found === null || !found.granted) {
    throw new ConflictError(`${username} is not a person of the page`, { reason });
  }
  return found;
}

function scenarioWire(scenario: Record<string, unknown>): AgentFanQueue["scenario"] {
  const texts = Array.isArray(scenario.texts) ? scenario.texts.map(String) : null;
  return {
    action: typeof scenario.action === "string" ? scenario.action : "auto",
    sendMode: typeof scenario.sendMode === "string" ? scenario.sendMode : "one",
    templates: typeof scenario.templates === "string" ? scenario.templates : null,
    texts,
    hint: typeof scenario.hint === "string" ? scenario.hint : null,
  };
}

// ── selection: a rule or a list against the page ───────────────────────────

async function select(
  db: Database,
  input: { page: FanQueuePage; rule: FanQueueRule | undefined; fans: AgentFanQueuePreviewBody["fans"]; now: Date; exceptQueueId: number | null },
): Promise<{ selection: FanQueueSelection; ruleText: string[]; notFound: number }> {
  const { page, now } = input;
  if (input.fans !== undefined) {
    const found = await resolveFanQueueRefs(db, { pageId: page.id, platform: page.platform, refs: input.fans.map((one) => one.ref) });
    const seen = new Set<number>();
    const list: Array<{ fanId: number; why: string | null }> = [];
    let notFound = 0;
    for (const one of input.fans) {
      const fanId = found.get(one.ref);
      if (fanId === undefined) { notFound += 1; continue; }
      if (seen.has(fanId)) continue;
      seen.add(fanId);
      list.push({ fanId, why: one.why ?? null });
    }
    const selection = await selectFanQueueFans(db, {
      pageId: page.id, platform: page.platform, now, filter: fanQueueListFilter(), siblingPageIds: [], list, exceptQueueId: input.exceptQueueId,
    });
    return { selection, ruleText: describeFanQueueList(list.length), notFound };
  }
  const rule = input.rule ?? {};
  const siblingPageIds = rule.otherPagesSpend === undefined ? [] : await listFanQueueSiblingPageIds(db, { pageId: page.id });
  const selection = await selectFanQueueFans(db, {
    pageId: page.id, platform: page.platform, now, filter: fanQueueFilterOf(rule, now), siblingPageIds, list: null, exceptQueueId: input.exceptQueueId,
  });
  return { selection, ruleText: describeFanQueueRule(rule, page.platform), notFound: 0 };
}

function excludedOf(selection: FanQueueSelection, notFound: number): FanQueueExcluded {
  return { ...selection.excluded, notFound };
}

export async function previewFanQueue(
  db: Database,
  input: { page: FanQueuePage; body: AgentFanQueuePreviewBody; now: Date },
): Promise<AgentFanQueuePreviewResponse> {
  const { selection, ruleText, notFound } = await select(db, { page: input.page, rule: input.body.rule, fans: input.body.fans, now: input.now, exceptQueueId: null });
  const count = selection.fans.length;
  return {
    pageLabel: input.page.label,
    ruleText,
    count,
    excluded: excludedOf(selection, notFound),
    samples: selection.fans.slice(0, PREVIEW_SAMPLES).map((fan) => ({
      fanRef: fan.fanRef, username: fan.username, displayName: fan.displayName, why: fanQueueWhy(fan, input.now, input.page.platform),
    })),
    historyIncomplete: selection.fans.filter((fan) => !fan.historyComplete).length,
    daysAtLimit: input.body.dailyLimit === undefined ? null : Math.ceil(count / input.body.dailyLimit),
  };
}

/** Each fan's person in a people queue: in turn, or in blocks of `split`. */
function assignees(count: number, people: number[], split: Array<{ userId: number; count: number }> | null): Array<number | null> {
  if (split !== null) {
    const out: Array<number | null> = [];
    for (const share of split) for (let i = 0; i < share.count && out.length < count; i++) out.push(share.userId);
    return out;
  }
  return Array.from({ length: count }, (_, i) => people[i % people.length]!);
}

export async function createFanQueue(
  app: AppContext,
  db: Database,
  input: { page: FanQueuePage; body: AgentFanQueueCreateBody; agentKeyId: number; now: Date },
): Promise<{ queue: AgentFanQueue; replayed: boolean; added: number }> {
  const { page, body, now } = input;
  const existing = await findFanQueueByIdempotencyKey(db, body.idempotencyKey);
  if (existing !== null) {
    if (existing.pageId !== page.id) throw new ConflictError("The idempotency key belongs to another queue", { reason: "idempotency_key_reused" });
    return { queue: (await queuesWire(app, db, [existing], now))[0]!, replayed: true, added: 0 };
  }
  const requester = await person(db, body.requestedBy, page.id, "requester_not_granted");
  const people: number[] = [];
  for (const name of body.people ?? []) people.push((await person(db, name, page.id, "person_not_granted")).userId);
  let split: Array<{ userId: number; count: number }> | null = null;
  if (body.split !== undefined) {
    split = [];
    for (const share of body.split) {
      const found = await person(db, share.username, page.id, "person_not_granted");
      split.push({ userId: found.userId, count: share.count });
      if (!people.includes(found.userId)) people.push(found.userId);
    }
  }
  const { selection, ruleText } = await select(db, { page, rule: body.rule, fans: body.fans, now, exceptQueueId: null });
  const fans = split === null ? selection.fans : selection.fans.slice(0, split.reduce((sum, share) => sum + share.count, 0));
  const scenario: FanQueueScenario = body.scenario;
  const queueId = await insertFanQueue(db, {
    pageId: page.id,
    name: body.name,
    goal: body.goal ?? null,
    kind: body.kind,
    rule: body.rule === undefined ? null : (body.rule as Record<string, unknown>),
    ruleText,
    scenario: scenario as unknown as Record<string, unknown>,
    distribution: body.distribution,
    people,
    perPerson: body.perPerson ?? null,
    dailyLimit: body.dailyLimit ?? null,
    endsAt: body.endsAt === undefined ? null : new Date(body.endsAt),
    refilledOn: body.kind === "standing" ? toBusinessDate(now) : null,
    requestedByUserId: requester.userId,
    createdByAgentKeyId: input.agentKeyId,
    createdByUserId: null,
    idempotencyKey: body.idempotencyKey,
  });
  const who = body.distribution === "people" ? assignees(fans.length, people, split) : fans.map(() => null);
  const added = await insertFanQueueItems(db, {
    queueId, pageId: page.id, now,
    items: fans.map((fan, i) => ({ fanId: fan.fanId, fanRef: fan.fanRef, why: fanQueueWhy(fan, now, page.platform), assigneeUserId: who[i] ?? null })),
  });
  const queue = await getFanQueue(db, queueId);
  return { queue: (await queuesWire(app, db, [queue!], now))[0]!, replayed: false, added };
}

// ── the queues as the agent reads them ─────────────────────────────────────

async function queuesWire(app: AppContext, db: Database, queues: readonly FanQueueRow[], now: Date): Promise<AgentFanQueue[]> {
  void app;
  const ids = queues.map((queue) => queue.id);
  const [counts, day] = await Promise.all([
    countFanQueueItems(db, ids),
    countFanQueueDay(db, { queueIds: ids, dayStart: startOfBusinessDay(now) }),
  ]);
  return queues.map((queue) => {
    const c = counts.get(queue.id) ?? { pending: 0, leased: 0, sent: 0, skipped: 0, dropped: 0 };
    const mine = day.filter((row) => row.queueId === queue.id);
    return {
      queueId: queue.id,
      pageLabel: queue.pageLabel,
      name: queue.name,
      goal: queue.goal,
      kind: queue.kind,
      status: queue.status,
      rule: queue.rule,
      ruleText: queue.ruleText,
      scenario: scenarioWire(queue.scenario),
      distribution: queue.distribution,
      people: queue.peopleNames,
      perPerson: queue.perPerson,
      dailyLimit: queue.dailyLimit,
      endsAt: iso(queue.endsAt),
      requestedBy: queue.requestedBy,
      createdAt: queue.createdAt.toISOString(),
      pausedAt: iso(queue.pausedAt),
      pausedBy: queue.pausedBy,
      finishedAt: iso(queue.finishedAt),
      counts: c,
      today: {
        sent: mine.reduce((sum, row) => sum + row.sent, 0),
        byPerson: mine.map((row) => ({ username: row.username, sent: row.sent, skipped: row.skipped })),
      },
      daysLeft: queue.dailyLimit === null ? null : Math.ceil((c.pending + c.leased) / queue.dailyLimit),
    };
  });
}

function grantedQueue(queue: FanQueueRow | null, pageIds: readonly number[]): FanQueueRow {
  // A queue of a page out of the grant is the plane's one static 404.
  if (queue === null || !pageIds.includes(queue.pageId)) throw new NotFoundError("Not found");
  return queue;
}

export async function listFanQueuesForAgent(
  app: AppContext,
  db: Database,
  input: { pages: readonly FanQueuePage[]; query: AgentFanQueueListQuery; now: Date },
): Promise<AgentFanQueue[]> {
  const pages = input.query.pageLabel === undefined ? input.pages : input.pages.filter((page) => page.label === input.query.pageLabel);
  const statuses: Array<FanQueueRow["status"]> = input.query.status === "open" ? ["active", "paused"]
    : input.query.status === "all" ? ["active", "paused", "done"] : [input.query.status];
  return queuesWire(app, db, await listFanQueues(db, { pageIds: pages.map((page) => page.id), statuses }), input.now);
}

export async function getFanQueueForAgent(
  app: AppContext,
  db: Database,
  input: { queueId: number; pageIds: readonly number[]; query: AgentFanQueueGetQuery; now: Date },
): Promise<AgentFanQueueDetail> {
  const queue = grantedQueue(await getFanQueue(db, input.queueId), input.pageIds);
  const from = input.query.from === undefined ? queue.createdAt : new Date(input.query.from);
  const to = input.query.to === undefined ? input.now : new Date(input.query.to);
  const [wire] = await queuesWire(app, db, [queue], input.now);
  const results = await listFanQueueResults(db, { queueId: queue.id, from, to, now: input.now });
  return {
    ...wire!,
    results: {
      from: from.toISOString(),
      to: to.toISOString(),
      ...results.total,
      byPerson: results.byPerson,
      skipped: results.skipped,
      dropped: results.dropped,
    },
  };
}

/** The asker of a queue, the owner and a team lead may change it. */
async function changer(db: Database, queue: FanQueueRow, username: string) {
  const who = await person(db, username, queue.pageId, "requester_not_granted");
  if (who.userId !== queue.requestedByUserId && who.role !== "owner" && who.role !== "team_lead") {
    throw new ForbiddenError("Only the queue's asker, the owner or a team lead changes it");
  }
  return who;
}

export async function updateFanQueueForAgent(
  app: AppContext,
  db: Database,
  input: { queueId: number; pageIds: readonly number[]; body: AgentFanQueueUpdateBody; now: Date },
): Promise<AgentFanQueue> {
  const { body, now } = input;
  const queue = grantedQueue(await getFanQueue(db, input.queueId, { forUpdate: true }), input.pageIds);
  const who = await changer(db, queue, body.requestedBy);
  if (queue.status === "done" && body.status !== "active") {
    throw new ConflictError("The queue is finished", { reason: "fan_queue_not_editable" });
  }
  let people: number[] | undefined;
  if (body.addPeople !== undefined || body.removePeople !== undefined) {
    const next = new Set(queue.people);
    for (const name of body.addPeople ?? []) next.add((await person(db, name, queue.pageId, "person_not_granted")).userId);
    for (const name of body.removePeople ?? []) {
      const found = await findFanQueuePerson(db, { username: name, pageId: queue.pageId });
      if (found !== null) next.delete(found.userId);
    }
    people = [...next];
  }
  if (body.move !== undefined) {
    if (queue.distribution !== "people") throw new ConflictError("Only a people queue moves fans between people", { reason: "fan_queue_not_people" });
    const from = await findFanQueuePerson(db, { username: body.move.from, pageId: queue.pageId });
    if (from === null) throw new ConflictError(`${body.move.from} is not a person of the page`, { reason: "person_not_granted" });
    const to = body.move.to === null ? null : (await person(db, body.move.to, queue.pageId, "person_not_granted")).userId;
    await moveFanQueueItems(db, { queueId: queue.id, fromUserId: from.userId, toUserId: to, count: body.move.count ?? null, now });
    if (to !== null && !(people ?? queue.people).includes(to)) people = [...(people ?? queue.people), to];
  }
  await updateFanQueue(db, {
    queueId: queue.id,
    now,
    ...(body.status === undefined ? {} : { status: body.status, pausedByUserId: who.userId }),
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.goal === undefined ? {} : { goal: body.goal }),
    ...(body.scenario === undefined ? {} : { scenario: body.scenario as unknown as Record<string, unknown> }),
    ...(body.perPerson === undefined ? {} : { perPerson: body.perPerson }),
    ...(body.dailyLimit === undefined ? {} : { dailyLimit: body.dailyLimit }),
    ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt === null ? null : new Date(body.endsAt) }),
    ...(people === undefined ? {} : { people }),
  });
  // A finished queue lets its fans go: other queues may take them.
  if (body.status === "done") await dropPendingFanQueueItems(db, { queueId: queue.id, keepFanIds: null, reason: "queue_done", now });
  return (await queuesWire(app, db, [(await getFanQueue(db, queue.id))!], now))[0]!;
}

export async function appendFanQueueForAgent(
  app: AppContext,
  db: Database,
  input: { queueId: number; pages: readonly FanQueuePage[]; body: AgentFanQueueAppendBody; now: Date },
): Promise<AgentFanQueueAppendResponse> {
  const { body, now } = input;
  const queue = grantedQueue(await getFanQueue(db, input.queueId, { forUpdate: true }), input.pages.map((page) => page.id));
  await changer(db, queue, body.requestedBy);
  if (queue.status === "done") throw new ConflictError("The queue is finished", { reason: "fan_queue_not_editable" });
  const page = input.pages.find((one) => one.id === queue.pageId)!;
  const { selection, notFound } = await select(db, { page, rule: body.rule, fans: body.fans, now, exceptQueueId: queue.id });
  const people = queue.people;
  const who = queue.distribution === "people" ? assignees(selection.fans.length, people, null) : selection.fans.map(() => null);
  const added = await insertFanQueueItems(db, {
    queueId: queue.id, pageId: queue.pageId, now,
    items: selection.fans.map((fan, i) => ({ fanId: fan.fanId, fanRef: fan.fanRef, why: fanQueueWhy(fan, now, page.platform), assigneeUserId: who[i] ?? null })),
  });
  const [wire] = await queuesWire(app, db, [(await getFanQueue(db, queue.id))!], now);
  return { added, excluded: excludedOf(selection, notFound), queue: wire! };
}

// ── upkeep: a standing queue refills once a Moscow day; a campaign ends ────

/**
 * Brings a queue up to date before it is read or taken from: a campaign past
 * its end, or with nothing left to hand out, is finished (its pending fans go
 * free); a standing queue not refilled today reads its rule again: new fans at
 * the end, pending ones it no longer takes out.
 */
async function upkeep(db: Database, queue: FanQueueRow, now: Date): Promise<FanQueueRow> {
  if (queue.status === "done") return queue;
  if (queue.endsAt !== null && queue.endsAt <= now) {
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await updateFanQueue(tx, { queueId: queue.id, status: "done", now });
      await dropPendingFanQueueItems(tx, { queueId: queue.id, keepFanIds: null, reason: "queue_done", now });
    });
    return (await getFanQueue(db, queue.id))!;
  }
  const today = toBusinessDate(now);
  if (queue.kind === "standing" && queue.status === "active" && queue.rule !== null && queue.refilledOn !== today) {
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      // The row lock makes one taker refill; the others find it refilled.
      const locked = await getFanQueue(tx, queue.id, { forUpdate: true });
      if (locked === null || locked.refilledOn === today) return;
      const page = { id: locked.pageId, label: locked.pageLabel, platform: locked.platform };
      const { selection } = await select(tx, { page, rule: locked.rule as FanQueueRule, fans: undefined, now, exceptQueueId: locked.id });
      const keep = selection.fans.map((fan) => fan.fanId);
      await dropPendingFanQueueItems(tx, { queueId: locked.id, keepFanIds: keep, reason: "no_longer_fits", now });
      await insertFanQueueItems(tx, {
        queueId: locked.id, pageId: locked.pageId, now,
        items: selection.fans.map((fan) => ({ fanId: fan.fanId, fanRef: fan.fanRef, why: fanQueueWhy(fan, now, page.platform), assigneeUserId: null })),
      });
      await updateFanQueue(tx, { queueId: locked.id, refilledOn: today, now });
    });
    return (await getFanQueue(db, queue.id))!;
  }
  return queue;
}

// ── the extension ──────────────────────────────────────────────────────────

function producerOf(request: { headers: Record<string, string | string[] | undefined> }, principal: HumanAuthPrincipal) {
  const header = request.headers["x-client-version"];
  const clientVersion = typeof header === "string" ? header : null;
  return principal.clientProfile === undefined
    ? ingestProducerForClientVersion(clientVersion ?? "unknown")
    : clientTokenIngestProducer(principal.clientProfile, clientVersion);
}

async function clientPage(app: AppContext, principal: HumanAuthPrincipal, pageLabel: string): Promise<FanQueuePage> {
  // A cookie session → 403: the queues are a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, pageLabel), FAN_QUEUES_FEATURE);
  // `page.id` is Hub's page; the row's `platformAccountId` is the platform's own account id.
  return { id: page.id, label: page.label, platform: page.platform };
}

/** A person may work a pool queue open to all (no people) or naming them, and a people queue naming them. */
const mayWork = (queue: FanQueueRow, userId: number) => queue.people.length === 0 ? queue.distribution === "pool" : queue.people.includes(userId);

function templatesOf(queues: readonly FanQueueRow[]) {
  const own = queues.flatMap((queue) => {
    const texts = Array.isArray(queue.scenario.texts) ? queue.scenario.texts.map(String) : [];
    return texts.map((text, i) => ({ id: `Q${i + 1}`, group: `q${queue.id}`, text }));
  });
  return [...ONLINE_TEMPLATES.map((one) => ({ ...one })), ...own];
}

async function todayOf(db: Database, queueIds: readonly number[], userId: number, now: Date) {
  const day = await countFanQueueDay(db, { queueIds, dayStart: startOfBusinessDay(now) });
  const out = new Map<number, { mine: number; page: number }>();
  for (const id of queueIds) out.set(id, { mine: 0, page: 0 });
  for (const row of day) {
    const t = out.get(row.queueId)!;
    t.page += row.sent;
    if (row.userId === userId) t.mine += row.sent;
  }
  return out;
}

export async function readClientFanQueues(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string },
): Promise<ClientFanQueuesResponse> {
  const page = await clientPage(app, principal, input.pageLabel);
  const now = new Date();
  const me = principal.user.id;
  const listed = (await listFanQueues(app.db, { pageIds: [page.id], statuses: ["active", "paused"] })).filter((queue) => mayWork(queue, me));
  const queues: FanQueueRow[] = [];
  for (const queue of listed) {
    const fresh = await upkeep(app.db, queue, now);
    if (fresh.status !== "done") queues.push(fresh);
  }
  const ids = queues.map((queue) => queue.id);
  const [today, available, answered] = await Promise.all([
    todayOf(app.db, ids, me, now),
    countFanQueueAvailable(app.db, { queueIds: ids, userId: me, now }),
    listFanQueueAnswered(app.db, { pageId: page.id, userId: me, now, hours: ANSWERED_HOURS }),
  ]);
  return {
    pageLabel: page.label,
    queues: queues.map((queue) => ({
      queueId: queue.id,
      name: queue.name,
      goal: queue.goal,
      kind: queue.kind,
      status: queue.status,
      distribution: queue.distribution,
      mineOnly: queue.distribution === "people" && queue.people.length === 1 && queue.people[0] === me,
      scenario: scenarioWire(queue.scenario),
      ruleText: queue.ruleText,
      requestedBy: queue.requestedBy,
      pausedAt: iso(queue.pausedAt),
      pausedBy: queue.pausedBy,
      perPerson: queue.perPerson,
      dailyLimit: queue.dailyLimit,
      today: today.get(queue.id) ?? { mine: 0, page: 0 },
      pending: available.get(queue.id)?.pending ?? 0,
      leasedToMe: available.get(queue.id)?.leasedToMe ?? 0,
    })),
    answered: answered.map((one) => ({
      itemId: one.itemId,
      queueId: one.queueId,
      fanRef: one.fanRef,
      conversationRef: one.conversationRef,
      username: one.username,
      displayName: one.displayName,
      alias: one.alias,
      sentAt: one.sentAt.toISOString(),
      act: one.act,
      templateId: one.templateId,
      answeredAt: one.answeredAt.toISOString(),
      answerText: one.answerText,
    })),
    templates: templatesOf(queues),
    serverNow: now.toISOString(),
  };
}

function itemWire(
  item: FanQueueItemRow,
  row: OnlineCandidateRow,
  context: { queue: FanQueueRow; now: Date; until: Date; mass: { count: number; lastAt: Date | null } | undefined },
): ClientFanQueueItem {
  const decision = decideOnline(row, { now: context.now, others: null });
  const { act, templateId } = fanQueueItemAct(context.queue.scenario as unknown as FanQueueScenario, row, { now: context.now, rank: item.rank, others: null });
  return {
    itemId: item.id,
    queueId: item.queueId,
    why: item.why,
    leaseUntil: context.until.toISOString(),
    templateId,
    followedAt: iso(row.followerSince),
    massLast90d: { count: context.mass?.count ?? 0, lastAt: iso(context.mass?.lastAt ?? null) },
    fanRef: row.fanRef,
    conversationRef: row.conversationRef,
    username: row.username,
    displayName: row.displayName,
    alias: row.alias,
    greetingName: greetingNameOf(row.displayName, row.username),
    lifetimeGrossMills: row.lifetimeGrossMills,
    last30dGrossMills: row.last30GrossMills,
    seenAt: iso(row.seenAt),
    onlineSince: null,
    seenSource: row.seenSource,
    reason: decision.reason,
    reasonAt: iso(decision.reasonAt),
    act,
    aside: null,
    asideAt: null,
    asideBy: null,
    messageCount: row.messageCount,
    lastFanMessageAt: iso(row.lastFanMessageAt),
    lastPageMessageAt: iso(row.answeredAt),
    subscription: {
      isSubscriber: row.isSubscriber,
      startedAt: iso(row.subscribedAt),
      endsAt: iso(row.subscriptionEndsAt),
      autoRenew: row.autoRenew,
    },
  };
}

async function othersTalking(app: AppContext, pageId: number, me: number, now: Date): Promise<Map<string, OthersTalking>> {
  const authors = await listRecentPageAuthors(app.db, { pageId, now, minutes: IN_CONVERSATION_MINUTES, lostMinutes: CLIENT_ACTIVITY_LOST_MINUTES });
  const others = new Map<string, OthersTalking>();
  for (const fan of inConversationOf(authors, me)) {
    const chatters = fan.chatters.filter((chatter) => !chatter.isMe);
    if (chatters.length > 0) others.set(fan.fanRef, { names: chatters.map((chatter) => chatter.name), lastSentAt: new Date(chatters[0]!.lastSentAt) });
  }
  return others;
}

async function workable(app: AppContext, page: FanQueuePage, queueId: number, me: number, now: Date): Promise<FanQueueRow> {
  const found = await getFanQueue(app.db, queueId);
  if (found === null || found.pageId !== page.id || !mayWork(found, me)) throw new NotFoundError("Not found");
  return upkeep(app.db, found, now);
}

export async function takeClientFanQueue(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; queueId: number; body: ClientFanQueueTakeBody },
): Promise<ClientFanQueueTakeResponse> {
  const page = await clientPage(app, principal, input.pageLabel);
  const me = principal.user.id;
  const now = new Date();
  const until = new Date(now.getTime() + FAN_QUEUE_LEASE_MINUTES * 60_000);
  const queue = await workable(app, page, input.queueId, me, now);
  const others = await othersTalking(app, page.id, me, now);
  const result = await app.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    await expireFanQueueLeases(tx, { queueId: queue.id, now });
    const mine = await renewFanQueueLeases(tx, { queueId: queue.id, userId: me, until, now });
    const today = (await todayOf(tx, [queue.id], me, now)).get(queue.id)!;
    const leasedNow = (await countFanQueueItems(tx, [queue.id])).get(queue.id)!.leased;
    let stopped: FanQueueStop | null = null;
    let need = Math.max(0, input.body.count - mine.length);
    if (queue.status === "paused") { stopped = "paused"; need = 0; }
    if (queue.status === "done") { stopped = "done"; need = 0; }
    // The person's own portion first (it is what they read), then the page's limit for the day.
    if (need > 0 && queue.perPerson !== null && !input.body.more) {
      const room = queue.perPerson - today.mine - mine.length;
      if (room <= 0) { stopped = "portion_done"; need = 0; } else need = Math.min(need, room);
    }
    if (need > 0 && queue.dailyLimit !== null) {
      const room = queue.dailyLimit - today.page - leasedNow;
      if (room <= 0) { stopped = "limit_reached"; need = 0; } else need = Math.min(need, room);
    }
    const taken: FanQueueItemRow[] = [];
    const looked: number[] = [];
    let dropped = 0;
    // A few rounds: a picked fan may leave or wait, and the next ones fill his place.
    for (let round = 0; round < 4 && need > 0; round++) {
      const picked = await pickPendingFanQueueItems(tx, {
        queueId: queue.id, userId: me, people: queue.distribution === "people", now, limit: need * 2 + 4, skipIds: looked,
      });
      if (picked.length === 0) break;
      const facts = await listOnlineCandidates(tx, {
        pageId: page.id, platform: page.platform, now, minutes: 0, onlineRefs: [], limit: picked.length, fanIds: picked.map((item) => item.fanId),
      });
      const byFan = new Map(facts.map((row) => [row.fanId, row]));
      const drops: Array<{ id: number; reason: string }> = [];
      const waits: Array<{ id: number; until: Date }> = [];
      const go: FanQueueItemRow[] = [];
      for (const item of picked) {
        looked.push(item.id);
        const judged = judgeFanQueueItem(item, byFan.get(item.fanId), { now, others: others.get(item.fanRef) ?? null });
        if (judged.kind === "drop") drops.push({ id: item.id, reason: judged.reason });
        else if (judged.kind === "wait") waits.push({ id: item.id, until: judged.until });
        else go.push(item);
      }
      await dropFanQueueItems(tx, { items: drops, now });
      await deferFanQueueItems(tx, { items: waits, now });
      dropped += drops.length;
      const lease = go.slice(0, need);
      await leaseFanQueueItems(tx, { itemIds: lease.map((item) => item.id), userId: me, until, now });
      taken.push(...lease);
      need -= lease.length;
    }
    const portion = [...mine, ...taken].sort((a, b) => a.rank - b.rank);
    const pending = (await countFanQueueAvailable(tx, { queueIds: [queue.id], userId: me, now })).get(queue.id)?.pending ?? 0;
    if (stopped === null && portion.length < input.body.count && pending === 0) stopped = "empty";
    return { portion, today, pending, dropped, stopped };
  });
  const fanIds = result.portion.map((item) => item.fanId);
  const [facts, mass] = await Promise.all([
    fanIds.length === 0 ? Promise.resolve([]) : listOnlineCandidates(app.db, {
      pageId: page.id, platform: page.platform, now, minutes: 0, onlineRefs: [], limit: fanIds.length, fanIds,
    }),
    countFanQueueMassMessages(app.db, { pageId: page.id, fanIds, now, days: MASS_DAYS }),
  ]);
  const byFan = new Map(facts.map((row) => [row.fanId, row]));
  const items = result.portion.flatMap((item) => {
    const row = byFan.get(item.fanId);
    return row === undefined ? [] : [itemWire(item, row, { queue, now, until, mass: mass.get(item.fanId) })];
  });
  return {
    queueId: queue.id,
    items,
    stopped: result.stopped,
    today: result.today,
    pending: result.pending,
    dropped: result.dropped,
    serverNow: now.toISOString(),
  };
}

export async function completeClientFanQueueItem(
  app: AppContext,
  request: { headers: Record<string, string | string[] | undefined> },
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; itemId: number; body: ClientFanQueueItemDoneBody },
): Promise<ClientFanQueueItemDoneResponse> {
  const page = await clientPage(app, principal, input.pageLabel);
  const me = principal.user.id;
  const now = new Date();
  const body = input.body;
  const producer = producerOf(request, principal);
  const { state, queueId } = await app.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const item = await findLeasedFanQueueItem(tx, { itemId: input.itemId, pageId: page.id, userId: me });
    if (item === null) throw new ConflictError("The fan is not in your portion", { reason: "fan_queue_item_not_leased" });
    const payload = {
      pageLabel: page.label, queueId: item.queueId, itemId: item.id, fanRef: item.fanRef, outcome: body.outcome,
      act: body.act ?? null, templateId: body.templateId ?? null, skipReason: body.skipReason ?? null, uncertain: body.uncertain ?? false,
      at: now.toISOString(),
    };
    const journaled = await insertObservation(tx, {
      source: "client_capture",
      producer,
      platform: page.platform,
      accountId: page.id,
      kind: FAN_QUEUE_ITEM_OBSERVATION_KIND,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `${me}:fan_queue_item:${item.id}:${body.outcome}:${now.toISOString()}`,
      observedAt: now,
      actorPrincipalId: me,
    });
    if (body.outcome === "sent") {
      // A send whose outcome is not known counts as went and is never sent again.
      const state = await completeFanQueueItem(tx, {
        itemId: item.id, userId: me, now, observationId: journaled.observationId, outcome: "sent",
        act: body.act ?? null, templateId: body.templateId ?? null, reason: body.uncertain ? "uncertain" : null, notBefore: null,
      });
      return { state, queueId: item.queueId };
    }
    if (body.skipReason === "dismiss") {
      // «Не предлагать» is the team's mark, the one «Онлайн» reads.
      await insertOnlineAttempt(tx, {
        pageId: page.id, fanId: item.fanId, fanRef: item.fanRef, conversationRef: null, userId: me, action: "dismissed",
        act: null, templateId: null, reason: "fan_queue", attemptedAt: now, observationId: journaled.observationId,
      });
    }
    const later = body.skipReason === "later";
    const state = await completeFanQueueItem(tx, {
      itemId: item.id, userId: me, now, observationId: journaled.observationId,
      outcome: later ? "later" : "skipped", act: null, templateId: null, reason: body.skipReason ?? null,
      notBefore: later ? new Date(now.getTime() + FAN_QUEUE_LATER_DAYS * DAY) : null,
    });
    return { state, queueId: item.queueId };
  });
  const today = (await todayOf(app.db, [queueId], me, now)).get(queueId)!;
  return { itemId: input.itemId, state, today, serverNow: now.toISOString() };
}

export async function releaseClientFanQueue(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; queueId: number },
): Promise<ClientFanQueueReleaseResponse> {
  const page = await clientPage(app, principal, input.pageLabel);
  const me = principal.user.id;
  const queue = await getFanQueue(app.db, input.queueId);
  if (queue === null || queue.pageId !== page.id) throw new NotFoundError("Not found");
  return { released: await releaseFanQueueLeases(app.db, { queueId: queue.id, userId: me, now: new Date() }) };
}
