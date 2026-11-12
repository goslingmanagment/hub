import { createHash } from "node:crypto";

import {
  buyerLinkOf,
  customOrderCode,
  PEOPLE_MESSAGE_KIND_SPECS,
  peopleMessageCapWords,
  peopleMessageKindSpec,
  peopleMessageQuietWords,
  type PeopleMessageKindSpec,
  type PeopleMessagePressBody,
  type PeopleMessagePressResponse,
  type PeopleMessageRow as PeopleMessageWire,
  type PeopleMessagesResponse,
  type PeopleMessageSwitchBody,
  type PeopleMessageSwitchResponse,
} from "@agency_hub_core/contracts";
import {
  ConfigOverrideVersionConflictError,
  countPeopleMessagesByKind,
  countPeopleMessagesForCap,
  findCustomOrder,
  findHandinShift,
  findMatterByKey,
  findNewestCurrentHandinVersion,
  findNewestCustomOrderId,
  findNewestMatterKeyOfKind,
  findNewestPeopleMessage,
  findPeopleMessagePersonByCode,
  getConfigOverride,
  insertPeopleMessage,
  listConfigAudit,
  listCurrentHandinVersionsSubmitted,
  listCustomOrdersMovedToModel,
  listExistingPeopleMessageKeys,
  listHeldPeopleMessages,
  listOpenMattersOfKinds,
  listPeopleMessageModels,
  listPeopleMessageObjectIds,
  listPeopleMessagePersons,
  listVisiblePages,
  markStalePeopleMessagesUnknown,
  settlePeopleMessage,
  type MatterRow,
  type PeopleMessageRow,
} from "@agency_hub_core/db";
import {
  peopleMessageChatsOf,
  peopleMessageKindsOf,
  withPeopleMessageKind,
  type PeopleMessageChats,
  type PeopleMessageKind,
  type PeopleMessageKindsOn,
} from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { auditCtx } from "../../api/request-auth.ts";
import { recordAudit, type HumanAuthPrincipal } from "../auth.ts";
import { cardTextOf } from "../custom-orders/index.ts";
import { loadEffectiveConfigField } from "../effective-config.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";
import { applyLiveConfigPatches } from "../live-config.ts";
import { shiftWords } from "../shift-handin-rules.ts";
import { readHandinVersionPosts, SHIFT_REPORT_MISSING_KIND } from "../shift-handins.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";
import {
  assertSendable,
  decideMessage,
  destinationOf,
  HELD_WORDS,
  inQuietHours,
  moscowDayOf,
  STATE_WORDS,
  withoutJoinSecret,
  type HeldReason,
  type MessageCandidate,
  type MessageLocks,
} from "./rules.ts";
import type { PeopleTransport } from "./transport.ts";

/**
 * Сообщения людям (ecosystem plan 2026-11-12, package S): the server's own
 * voice for the facts the server owns. Every minute the pass reads what fires
 * each kind — a handed-in report's newest version, an order moved to «У модели»
 * without its card, the matters «Сдайте смену» and «Кастом снят, отдайте фану» —
 * and writes each message once (its key: the object's version or the matter's
 * reason key), as `held` unless both locks are open: the bot token
 * (env PEOPLE_TELEGRAM_BOT_TOKEN) and the kind turned on (live setting
 * peopleMessageKinds), for an event after it was turned on. A message that may
 * leave is written `sending` before its one attempt, then settled; an attempt
 * that never settled is `unknown` and is never repeated. A held message never
 * sends later. The owner's two kinds sent by a press (the payout text, the
 * invitation) go through the same door. Nothing here touches Gengar.
 */

export const PEOPLE_MESSAGES_QUEUE = "people-messages.sweep";

type MessagesApp = Pick<AppContext, "db" | "config" | "logger">;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A report is copied when its newest version has stood this long (a correction right after replaces it). */
const REPORT_SETTLE_MS = 5 * MINUTE_MS;
/** How far back the events are read: older ones make no message (a worker down for a night sends nothing stale). */
const EVENT_LOOKBACK_MS = 6 * HOUR_MS;
/** A reminder's matter opened longer ago makes no message. */
const MATTER_LOOKBACK_MS = 48 * HOUR_MS;
/** An attempt still `sending` after this is `unknown`. */
const SENDING_STALE_MS = 15 * MINUTE_MS;
const HELD_SHOWN = 5;
const SHOT_NOT_GIVEN_KIND = "custom.shot_not_given";

/** A message the service makes: what the rules judge, and the text sent when it differs from the one kept. */
interface Outgoing extends MessageCandidate {
  /** Sent instead of `text` (an invitation's link is not kept): only in memory. */
  sendText?: string;
}

// ── The locks ────────────────────────────────────────────────────────────────

interface Switches {
  locks: MessageLocks;
  token: string | null;
  chats: PeopleMessageChats;
}

function tokenOf(app: Pick<AppContext, "config">): string | null {
  const token = app.config.peopleTelegramBotToken;
  return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
}

async function switchesOf(app: MessagesApp): Promise<Switches> {
  const [kinds, chats] = await Promise.all([
    loadEffectiveConfigField(app.db, app.config, "peopleMessageKinds"),
    loadEffectiveConfigField(app.db, app.config, "peopleMessageChats"),
  ]);
  const token = tokenOf(app);
  return { locks: { tokenSet: token !== null, kindsOn: peopleMessageKindsOf(kinds) }, token, chats: peopleMessageChatsOf(chats) };
}

async function pagesByLabel(app: MessagesApp): Promise<Map<string, { modelSlug: string; modelName: string }>> {
  const pages = await listVisiblePages(app.db);
  return new Map(pages.map((page) => [page.label, { modelSlug: page.modelSlug ?? page.label, modelName: page.modelName ?? page.label }]));
}

const teamLink = (app: Pick<AppContext, "config">, path: string) => `${(app.config.webTeamOrigin ?? "https://chatgoose.gosling-agency.ru").replace(/\/+$/u, "")}${path}`;

// ── What fires each kind ─────────────────────────────────────────────────────

async function reportCopies(app: MessagesApp, chats: PeopleMessageChats, versions: ReadonlyArray<{ versionId: number; shiftId: number; version: number; userId: number; submittedAt: Date }>): Promise<Outgoing[]> {
  const out: Outgoing[] = [];
  const names = await listPeopleMessagePersons(app.db, [...new Set(versions.map((one) => one.userId))]);
  for (const one of versions) {
    const read = await readHandinVersionPosts(app, { shiftId: one.shiftId, version: one.version });
    if (read === null) continue;
    const about = `отчёт ${names.get(one.userId)?.name ?? "чаттера"}, смена ${shiftWords(read.startedAt, read.endedAt)}${one.version > 1 ? `, версия ${one.version}` : ""}`;
    for (const post of read.posts) {
      out.push({
        kind: "shift.report.copy",
        key: `shift.report.copy:v${one.versionId}:${post.modelSlug}`,
        recipient: { kind: "chat", chat: chats[post.modelSlug]?.reports ?? null, words: `${post.modelName} · Отчётность` },
        objectType: "shift_handin_version",
        objectId: String(one.versionId),
        about,
        text: post.text,
        eventAt: one.submittedAt,
      });
    }
  }
  return out;
}

async function cardOf(app: MessagesApp, chats: PeopleMessageChats, pages: Map<string, { modelSlug: string; modelName: string }>, orderId: number, eventAt: Date): Promise<Outgoing | null> {
  const order = await findCustomOrder(app.db, orderId);
  if (order === null) return null;
  const page = order.pageLabel === null ? undefined : pages.get(order.pageLabel);
  const modelName = order.modelName ?? page?.modelName ?? "модель не подтверждена";
  return {
    kind: "custom.card.to_model",
    key: `custom.card.to_model:${order.id}`,
    recipient: { kind: "chat", chat: page === undefined ? null : chats[page.modelSlug]?.customs ?? null, words: `${modelName} · кастомы` },
    objectType: "custom_order",
    objectId: String(order.id),
    about: `заказ ${customOrderCode(order.id)}`,
    text: cardTextOf(order),
    eventAt,
  };
}

/** A reminder from its matter: «Сдайте смену» or «Кастом снят, отдайте фану», to the matter's person. */
async function reminderOf(app: MessagesApp, matter: MatterRow): Promise<Outgoing | null> {
  if (!("userId" in matter.owner)) return null;
  const person = (await listPeopleMessagePersons(app.db, [matter.owner.userId])).get(matter.owner.userId);
  if (person === undefined) return null;
  const recipient = { kind: "person" as const, userId: person.userId, telegramUserId: person.telegramUserId, name: person.name };
  if (matter.kind === SHIFT_REPORT_MISSING_KIND) {
    const shiftId = Number(matter.object?.id ?? Number.NaN);
    const shift = Number.isSafeInteger(shiftId) ? await findHandinShift(app.db, shiftId) : null;
    if (shift === null) return null;
    const when = shiftWords(shift.startedAt, shift.endedAt);
    return {
      kind: "shift.report.missing",
      key: `shift.report.missing:${matter.key}`,
      recipient,
      objectType: "matter",
      objectId: matter.key,
      about: `смена ${when}`,
      text: `Смена ${when} не сдана. Сдайте её, пожалуйста: ${teamLink(app, matter.link ?? `/workboard/my/shifts/${shiftId}`)}`,
      eventAt: matter.openedAt,
    };
  }
  if (matter.kind === SHOT_NOT_GIVEN_KIND) {
    const orderId = Number(matter.object?.id ?? Number.NaN);
    const order = Number.isSafeInteger(orderId) ? await findCustomOrder(app.db, orderId) : null;
    if (order === null) return null;
    const code = customOrderCode(order.id);
    const fan = order.fanErasedAt === null && order.platform !== null && order.fanRef !== null
      ? buyerLinkOf({ platform: order.platform, fanRef: order.fanRef, username: order.fanUsername })
      : order.buyer ?? "-";
    return {
      kind: "custom.shot.give",
      key: `custom.shot.give:${matter.key}`,
      recipient,
      objectType: "matter",
      objectId: matter.key,
      about: `заказ ${code}`,
      text: [
        `Кастом ${code} снят, отдайте его фану.`,
        `Фан: ${fan}`,
        `Страница: ${order.pageLabel ?? "не подтверждена"}`,
        `Заказ: ${teamLink(app, matter.link ?? `/workboard/customs/${code}`)}`,
      ].join("\n"),
      eventAt: matter.openedAt,
    };
  }
  return null;
}

async function candidatesOf(app: MessagesApp, chats: PeopleMessageChats, now: Date): Promise<Outgoing[]> {
  const out: Outgoing[] = [];
  const guarded = async (what: string, run: () => Promise<Outgoing[]>) => {
    try {
      out.push(...await run());
    } catch (error) {
      app.logger.error({ err: error, what }, "people messages: a kind's facts could not be read; it waits for the next pass");
    }
  };
  await guarded("shift.report.copy", async () => {
    const versions = await listCurrentHandinVersionsSubmitted(app.db, { from: new Date(now.getTime() - EVENT_LOOKBACK_MS), to: new Date(now.getTime() - REPORT_SETTLE_MS), limit: 200 });
    // A version whose posts are written already is not read again.
    const done = await listPeopleMessageObjectIds(app.db, { kind: "shift.report.copy", objectType: "shift_handin_version", objectIds: versions.map((one) => String(one.versionId)) });
    return reportCopies(app, chats, versions.filter((one) => !done.has(String(one.versionId))));
  });
  await guarded("custom.card.to_model", async () => {
    const moved = await listCustomOrdersMovedToModel(app.db, { from: new Date(now.getTime() - EVENT_LOOKBACK_MS), to: now, limit: 200 });
    const done = await listExistingPeopleMessageKeys(app.db, moved.map((one) => `custom.card.to_model:${one.orderId}`));
    const pages = await pagesByLabel(app);
    const cards: Outgoing[] = [];
    for (const one of moved) {
      if (done.has(`custom.card.to_model:${one.orderId}`)) continue;
      const order = await findCustomOrder(app.db, one.orderId);
      // The card is in a group already (attached to the order): nothing to put there.
      if (order === null || order.telegramRefs.length > 0) continue;
      const card = await cardOf(app, chats, pages, one.orderId, one.at);
      if (card !== null) cards.push(card);
    }
    return cards;
  });
  await guarded("reminders", async () => {
    // The people's night: no reminder is made; in the morning the matter, if still open, makes it.
    if (inQuietHours(now)) return [];
    const matters = (await listOpenMattersOfKinds(app.db, [SHIFT_REPORT_MISSING_KIND, SHOT_NOT_GIVEN_KIND]))
      .filter((matter) => now.getTime() - matter.openedAt.getTime() <= MATTER_LOOKBACK_MS && "userId" in matter.owner);
    const kindOf = (matter: MatterRow) => (matter.kind === SHIFT_REPORT_MISSING_KIND ? "shift.report.missing" : "custom.shot.give");
    const done = await listExistingPeopleMessageKeys(app.db, matters.map((matter) => `${kindOf(matter)}:${matter.key}`));
    const reminders: Outgoing[] = [];
    for (const matter of matters) {
      if (done.has(`${kindOf(matter)}:${matter.key}`)) continue;
      const one = await reminderOf(app, matter);
      if (one !== null) reminders.push(one);
    }
    return reminders;
  });
  return out;
}

// ── One message ──────────────────────────────────────────────────────────────

export interface DeliveryOutcome {
  id: number | null;
  state: PeopleMessagePressResponse["state"];
  reason: HeldReason | null;
}

/**
 * Writes the message once and, only with both locks open and a reachable recipient, makes its one attempt. The row is
 * written before the attempt: held, or `sending` with the attempt's time.
 */
async function deliver(app: MessagesApp, message: Outgoing, switches: Switches, transport: PeopleTransport, now: Date): Promise<DeliveryOutcome> {
  const spec = peopleMessageKindSpec(message.kind);
  if ((await listExistingPeopleMessageKeys(app.db, [message.key])).size > 0) return { id: null, state: "duplicate", reason: null };
  const destination = destinationOf(message.recipient);
  const used = destination === null ? 0 : await countPeopleMessagesForCap(app.db, {
    kind: message.kind,
    recipient: message.recipient.kind === "person" ? { userId: message.recipient.userId } : { chatId: destination.chatId, topicId: destination.topicId },
    ...moscowDayOf(now),
  });
  const decision = decideMessage(message, switches.locks, { used, max: spec.cap });
  const row = await insertPeopleMessage(app.db, {
    kind: message.kind,
    idempotencyKey: message.key,
    recipient: message.recipient.kind,
    recipientUserId: message.recipient.kind === "person" ? message.recipient.userId : null,
    telegramChatId: destination?.chatId ?? null,
    telegramTopicId: destination?.topicId ?? null,
    toWords: message.recipient.kind === "person" ? message.recipient.name : message.recipient.words,
    objectType: message.objectType,
    objectId: message.objectId,
    about: message.about,
    text: message.text,
    eventAt: message.eventAt,
    state: decision.send ? "sending" : "held",
    heldReason: decision.send ? null : decision.reason,
    createdAt: now,
    attemptedAt: decision.send ? now : null,
  });
  if (row === null) return { id: null, state: "duplicate", reason: null };
  if (!decision.send) return { id: row.id, state: "held", reason: decision.reason };

  assertSendable(message, switches.locks, switches.token, decision.chatId);
  let result: Awaited<ReturnType<PeopleTransport>>;
  try {
    result = await transport({ token: switches.token, chatId: decision.chatId, topicId: decision.topicId, text: message.sendText ?? message.text, idempotencyKey: message.key });
  } catch (error) {
    result = { status: "unknown", error: error instanceof Error ? error.message.slice(0, 300) : "the attempt threw" };
  }
  await settlePeopleMessage(app.db, {
    id: row.id,
    state: result.status,
    telegramMessageId: result.status === "sent" ? result.messageId : null,
    error: result.status === "sent" ? null : result.error.slice(0, 500),
    at: new Date(),
  });
  return { id: row.id, state: result.status, reason: null };
}

export interface PeopleMessagesTally {
  made: number;
  held: number;
  sent: number;
  failed: number;
  unknown: number;
  staleUnknown: number;
}

/** One pass: every kind's new events, each message written once; the attempts that never settled become `unknown`. */
export async function runPeopleMessages(app: MessagesApp, options: { now?: Date; transport: PeopleTransport }): Promise<PeopleMessagesTally> {
  const now = options.now ?? new Date();
  const switches = await switchesOf(app);
  const tally: PeopleMessagesTally = { made: 0, held: 0, sent: 0, failed: 0, unknown: 0, staleUnknown: 0 };
  for (const message of await candidatesOf(app, switches.chats, now)) {
    try {
      const outcome = await deliver(app, message, switches, options.transport, now);
      if (outcome.state === "duplicate") continue;
      tally.made += 1;
      if (outcome.state === "held" || outcome.state === "sent" || outcome.state === "failed" || outcome.state === "unknown") tally[outcome.state] += 1;
    } catch (error) {
      app.logger.error({ err: error, kind: message.kind, key: message.key }, "people messages: a message could not be written");
    }
  }
  tally.staleUnknown = await markStalePeopleMessagesUnknown(app.db, { attemptedBefore: new Date(now.getTime() - SENDING_STALE_MS), at: now });
  return tally;
}

export async function ensurePeopleMessagesQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, PEOPLE_MESSAGES_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensurePeopleMessagesSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(PEOPLE_MESSAGES_QUEUE, "* * * * *", null, { tz: "UTC" });
}

// ── The owner's press ───────────────────────────────────────────────────────

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function outcomeWords(outcome: DeliveryOutcome): string {
  if (outcome.state === "duplicate") return "Это сообщение уже было: второй раз не отправляется";
  if (outcome.state === "held") return `Не отправлено, ${HELD_WORDS[outcome.reason ?? "kind_off"]}`;
  if (outcome.state === "sending") return "Отправляется";
  const words = STATE_WORDS[outcome.state];
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `peopleMessagePress`: the payout text or the invitation, by the owner's press, through the same door as every kind. */
export async function pressPeopleMessage(
  app: MessagesApp,
  principal: HumanAuthPrincipal,
  body: PeopleMessagePressBody,
  options: { now?: Date; transport: PeopleTransport },
): Promise<PeopleMessagePressResponse> {
  const now = options.now ?? new Date();
  if ((body.person === undefined) === (body.userId === undefined)) throw new BadRequestError("Name the person by code or by login, one of them");
  const person = body.person !== undefined
    ? await findPeopleMessagePersonByCode(app.db, body.person)
    : (await listPeopleMessagePersons(app.db, [body.userId!])).get(body.userId!) ?? null;
  if (person === null) throw new NotFoundError("No such person");
  const invite = body.kind === "newcomer.invite";
  const kept = invite ? withoutJoinSecret(body.text) : body.text;
  const switches = await switchesOf(app);
  const outcome = await deliver(app, {
    kind: body.kind,
    key: invite
      ? `newcomer.invite:${person.userId}:${digest(body.text)}`
      : `payout.text:${person.userId}:${moscowDayOf(now).from.toISOString().slice(0, 10)}:${digest(body.text)}`,
    recipient: { kind: "person", userId: person.userId, telegramUserId: person.telegramUserId, name: person.name },
    objectType: invite ? "user" : "person",
    objectId: invite ? String(person.userId) : person.personCode,
    about: invite ? `приглашение ${person.name}` : `выплата ${person.name}`,
    text: kept,
    ...(invite ? { sendText: body.text } : {}),
    eventAt: now,
  }, switches, options.transport, now);
  await recordAudit(app, {
    ...auditCtx(principal),
    eventType: "people_message.press",
    targetUserId: person.userId,
    metadata: { kind: body.kind, state: outcome.state, reason: outcome.reason, messageId: outcome.id },
  });
  return { id: outcome.id, state: outcome.state, reason: outcome.reason, words: outcomeWords(outcome) };
}

// ── The owner's switch ──────────────────────────────────────────────────────

/** `peopleMessageSwitch`: one kind on or off, through the audited path of every live setting. */
export async function switchPeopleMessageKind(
  app: Pick<AppContext, "db" | "config">,
  principal: HumanAuthPrincipal,
  kind: PeopleMessageKind,
  body: PeopleMessageSwitchBody,
  now: Date = new Date(),
): Promise<PeopleMessageSwitchResponse> {
  const current = await loadEffectiveConfigField(app.db, app.config, "peopleMessageKinds");
  const next = withPeopleMessageKind(current, kind, body.on, now);
  const spec = peopleMessageKindSpec(kind);
  let results: Awaited<ReturnType<typeof applyLiveConfigPatches>>;
  try {
    results = await applyLiveConfigPatches(app, {
      patches: [{ key: "peopleMessageKinds", value: next, expectedVersion: body.expectedVersion }],
      note: `Сообщения людям: ${body.on ? "включён" : "выключен"} вид ${kind}`,
      actor: { userId: principal.user.id, audit: auditCtx(principal) },
    });
  } catch (error) {
    if (error instanceof ConfigOverrideVersionConflictError) {
      throw new ConflictError("The kinds changed since the screen read them: read the screen again", { reason: "kinds_changed" });
    }
    throw error;
  }
  const onSince = peopleMessageKindsOf(next)[kind] ?? null;
  const tokenSet = tokenOf(app) !== null;
  const sentence = body.on
    ? `${spec.onSentence}${tokenSet ? "" : " Пока нет токена бота: сообщения этого вида задерживаются и не уходят."}`
    : "Выключено: новые сообщения этого вида задерживаются и не уходят. Задержанные раньше не уйдут и после включения.";
  return {
    kind,
    on: body.on,
    onSince: onSince?.toISOString() ?? null,
    sentence,
    kindsVersion: results[0]!.version,
    audit: { at: now.toISOString(), by: principal.user.username },
  };
}

// ── The owner's screen ──────────────────────────────────────────────────────

function rowWire(row: PeopleMessageRow): PeopleMessageWire {
  const words = row.state === "held" ? HELD_WORDS[row.heldReason ?? "kind_off"] : STATE_WORDS[row.state];
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    to: row.toWords,
    about: row.about,
    text: row.text,
    state: row.state,
    reason: row.heldReason,
    words: words.charAt(0).toUpperCase() + words.slice(1),
  };
}

const MISSING: Readonly<Record<PeopleMessageKind, string>> = {
  "shift.report.copy": "Сданных в системе отчётов пока нет: пример появится с первым.",
  "custom.card.to_model": "Заказов в системе пока нет: пример появится с первым.",
  "shift.report.missing": "Дел «Сдайте смену» пока не было: смену в системе ещё никто не сдаёт.",
  "custom.shot.give": "Дел «Кастом снят, отдайте фану» пока не было.",
  "claim.confirm": "Заявок «моё / делим» в системе пока нет.",
  "payout.text": "Пример появится после первого нажатия: текст даёт расчёт выплаты ledger, сейчас он в «Выплате» человека под «Скопировать».",
  "newcomer.invite": "Пример появится после первого нажатия: сейчас текст в окне приглашения под «Скопировать сообщение».",
};

/** An example of a kind from the newest real object; null — none yet. */
async function exampleOf(app: MessagesApp, kind: PeopleMessageKind, chats: PeopleMessageChats): Promise<{ text: string; about: string } | null> {
  switch (kind) {
    case "shift.report.copy": {
      const newest = await findNewestCurrentHandinVersion(app.db);
      if (newest === null) return null;
      const read = await readHandinVersionPosts(app, { shiftId: newest.shiftId, version: newest.version });
      const post = read?.posts[0];
      return post === undefined || read === null ? null : { text: post.text, about: `последний сданный отчёт: смена ${shiftWords(read.startedAt, read.endedAt)}, ${post.modelName}` };
    }
    case "custom.card.to_model": {
      const id = await findNewestCustomOrderId(app.db);
      const card = id === null ? null : await cardOf(app, chats, await pagesByLabel(app), id, new Date());
      return card === null ? null : { text: card.text, about: `последний заказ: ${card.about.replace(/^заказ /u, "")}` };
    }
    case "shift.report.missing":
    case "custom.shot.give": {
      const key = await findNewestMatterKeyOfKind(app.db, kind === "shift.report.missing" ? SHIFT_REPORT_MISSING_KIND : SHOT_NOT_GIVEN_KIND);
      const matter = key === null ? null : await findMatterByKey(app.db, key);
      const one = matter === null ? null : await reminderOf(app, matter);
      return one === null ? null : { text: one.text, about: `последнее дело: ${one.about}, ${one.recipient.kind === "person" ? one.recipient.name : ""}`.replace(/, $/u, "") };
    }
    case "claim.confirm":
      return null;
    case "payout.text":
    case "newcomer.invite": {
      const newest = await findNewestPeopleMessage(app.db, kind);
      return newest === null ? null : { text: newest.text, about: `последнее нажатие: ${newest.about}` };
    }
    default:
      return null;
  }
}

function lastSwitchOf(
  kind: PeopleMessageKind,
  audit: ReadonlyArray<{ changedAt: Date; userId: number | null; oldValue: unknown; newValue: unknown }>,
  names: Map<number, string>,
): PeopleMessagesResponse["kinds"][number]["lastSwitch"] {
  const onIn = (value: unknown) => peopleMessageKindsOf(typeof value === "string" ? value : undefined)[kind] !== undefined;
  for (const row of audit) {
    const before = onIn(row.oldValue);
    const after = onIn(row.newValue);
    if (before === after) continue;
    return { at: row.changedAt.toISOString(), by: row.userId === null ? "командная строка" : names.get(row.userId) ?? "владелец", on: after };
  }
  return null;
}

/** `peopleMessages`: the owner's screen. Database only; reads, writes nothing. */
export async function readPeopleMessages(app: MessagesApp, now: Date = new Date()): Promise<PeopleMessagesResponse> {
  const switches = await switchesOf(app);
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const [override, models, counts, audit] = await Promise.all([
    getConfigOverride(app.db, "peopleMessageKinds"),
    listPeopleMessageModels(app.db),
    countPeopleMessagesByKind(app.db, since),
    listConfigAudit(app.db, { key: "peopleMessageKinds", limit: 200 }),
  ]);
  const names = new Map([...(await listPeopleMessagePersons(app.db, audit.flatMap((row) => (row.userId === null ? [] : [row.userId])))).values()].map((one) => [one.userId, one.name]));
  const kindsOn: PeopleMessageKindsOn = switches.locks.kindsOn;
  const kinds: PeopleMessagesResponse["kinds"] = [];
  for (const spec of PEOPLE_MESSAGE_KIND_SPECS) {
    let example: { text: string; about: string } | null = null;
    try {
      example = await exampleOf(app, spec.kind, switches.chats);
    } catch (error) {
      app.logger.warn({ err: error, kind: spec.kind }, "people messages: the example could not be read");
    }
    const states = counts.get(spec.kind);
    kinds.push({
      kind: spec.kind,
      title: spec.title,
      audience: spec.audience,
      toWhom: spec.toWhom,
      when: spec.when,
      template: spec.template,
      example,
      exampleMissing: example === null ? MISSING[spec.kind] : null,
      on: kindsOn[spec.kind] !== undefined,
      onSince: kindsOn[spec.kind]?.toISOString() ?? null,
      lastSwitch: lastSwitchOf(spec.kind, audit, names),
      trigger: spec.connected ? "ready" : "not_connected",
      triggerNote: spec.triggerNote,
      cap: spec.cap,
      capWords: peopleMessageCapWords(spec),
      quietWords: peopleMessageQuietWords(spec),
      needs: [...spec.needs],
      onSentence: spec.onSentence,
      blockedFor: blockedFor(spec, models, switches.chats),
      counts: {
        held: states?.get("held") ?? 0,
        sent: states?.get("sent") ?? 0,
        failed: states?.get("failed") ?? 0,
        unknown: (states?.get("unknown") ?? 0) + (states?.get("sending") ?? 0),
      },
      held: (await listHeldPeopleMessages(app.db, { kind: spec.kind, since, limit: HELD_SHOWN })).map(rowWire),
    });
  }
  return {
    tokenSet: switches.locks.tokenSet,
    sentence: switches.locks.tokenSet
      ? "Токен бота задан: включённые виды отправляются, выключенные задерживаются."
      : "Отправка невозможна: нет токена. Все сообщения задерживаются на сервере и никуда не уходят.",
    kindsVersion: override?.version ?? null,
    chats: models.map((model) => ({
      modelSlug: model.slug,
      modelName: model.name,
      reports: switches.chats[model.slug]?.reports !== undefined,
      customs: switches.chats[model.slug]?.customs !== undefined,
    })),
    kinds,
    serverNow: now.toISOString(),
  };
}

/** The models a group kind cannot reach: no chat for its topic. */
function blockedFor(spec: PeopleMessageKindSpec, models: ReadonlyArray<{ slug: string; name: string }>, chats: PeopleMessageChats): string[] {
  if (spec.audience !== "group") return [];
  const missing = models.filter((model) => (spec.kind === "shift.report.copy" ? chats[model.slug]?.reports : chats[model.slug]?.customs) === undefined);
  return missing.length === 0 ? [] : [`Нет чата: ${missing.map((model) => model.name).join(", ")}`];
}
