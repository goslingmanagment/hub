import {
  CUSTOM_STATE_WORDS,
  CUSTOMS_ROUTINES,
  customOrderBurnsOf,
  customOrderCode,
  customOrderUrgencyOf,
  customsReaderStale,
  parseCustomOrderCode,
  parseTelegramRef,
  type CustomBurn,
  type CustomOrder,
  type CustomOrderAction,
  type CustomOrderActionBody,
  type CustomOrderCard,
  type CustomOrderCardPatch,
  type CustomOrderCreateBody,
  type CustomOrderMessage,
  type CustomOrderDetailResponse,
  type CustomOrderFacts,
  type CustomOrderPayment,
  type CustomOrdersBoardResponse,
  type CustomPaidWordKind,
  type CustomUrgency,
  type CustomUrgencyInput,
} from "@agency_hub_core/contracts";
import {
  addCustomOrderCard,
  addCustomOrderMessage,
  addCustomOrderPayment,
  addCustomOrderRejection,
  answerCustomOrderRevisions,
  bumpCustomOrder,
  closeCustomOrderRevisions,
  dismissCustomSale,
  findCustomOrder,
  findCustomOrderLastHandMove,
  findCustomOrderLinkDoor,
  findCustomSale,
  findPageFanByInput,
  findPageSummaryByLabel,
  hasCustomOrderRejection,
  hasCustomOrderStepByRef,
  insertCustomOrder,
  insertCustomOrderEvent,
  isCustomOrderEvent,
  listCustomDeliverySuggestions,
  listCustomLookalikeSales,
  listCustomOrderActorNames,
  listCustomOrderPayments,
  listCustomOrdersInStates,
  listCustomPaymentCandidates,
  listObjectEvents,
  listOnShiftUsersByPage,
  listPersonFans,
  listSystemRoutines,
  listUsersWithPersonRight,
  listCustomOrderMessages,
  listCustomOrderRoundMessages,
  lockCustomOrder,
  markCustomOrderRevisionDone,
  moveCustomOrder,
  removeCustomOrderPayment,
  removeCustomOrderRejection,
  reopenCustomOrderRevisions,
  retractCustomOrderDeliveries,
  setCustomOrderStateNote,
  updateCustomOrderFields,
  type CustomLookalikeRow,
  type CustomOrderMessageResult,
  type CustomOrderMessageRow,
  type CustomOrderRoundRow,
  type CustomOrderRow,
  type CustomOrderSaleRow,
  type CustomOrderStateRow,
  type Database,
  listTestPageIds,
  type TeamFacts,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { requireSessionUser, type AuthPrincipal, type HumanAuthPrincipal } from "../auth.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import {
  cardOf,
  customOrderFactsOf,
  dueLeftDaysOf,
  fanInputOf,
  isBoardAction,
  issueOf,
  mayTakeStep,
  overdueDaysOf,
  paidWordOf,
  partsAbout,
  renderCardText,
  roundOf,
  seesOrder,
  stateByMessages,
  STEP_FROM,
  STEP_TO,
  stepsFor,
  wantedParts,
  whatOf,
  worksOnPage,
  type CustomPart,
  type CustomViewer,
} from "./rules.ts";
import { waitingCustomSaleIds } from "./readers.ts";
import { customMoveOf, customStepLeader, ledPhasesOf, type CustomLeader } from "./leaders.ts";
import { personOfLogin, teamFactsFor, teamPagesFor } from "../teams.ts";

/**
 * Заказ кастома (ecosystem plan 2026-11-12, package I): the core every door
 * goes through — the board's reads, one step of an order with its history
 * event in the same transaction, a record. Who may take a step is rules.ts's;
 * which sale may pay an order and which message carried it are a sale and a
 * message Hub holds — its suggestion a person picks, or what an agent names and
 * Hub verifies (evidence.ts) — never a free number. An undo of what the system
 * or an agent applied is remembered (`custom_order_rejections`). Database only:
 * nothing here sends a message or asks a platform.
 */

type CustomApp = Pick<AppContext, "db">;

/** How long a sale is offered as a payment, and how many. */
export const CUSTOM_PAYMENT_DAYS = 30;
const DAY_MS = 86_400_000;

/** Who did a step and through which door (object_events). */
export interface CustomActor {
  door: "extension" | "workboard" | "telegram" | "api" | "system" | "contentops";
  userId?: number | null;
  agentKeyId?: number | null;
  onBehalfOfUserId?: number | null;
}

export function notAllowed(message = "This step is not yours, or not from the order's state"): ConflictError {
  return new ConflictError(message, { reason: "not_allowed" });
}
const notSuggested = (message: string) => new ConflictError(message, { reason: "not_suggested" });
const notFound = () => new NotFoundError("The custom order was not found");

// ── Who looks ───────────────────────────────────────────────────────────────

export async function customLeads(db: Database): Promise<Array<{ userId: number; username: string; displayName: string }>> {
  return listUsersWithPersonRight(db, "customs_lead");
}

/**
 * The viewer of a human principal: their role and pages, and whether their person «ведёт кастомы». A narrow session
 * (opened from the extension, no password) reads as a chatter whatever the role, as everywhere it is let in; so does the
 * extension's own narrow token (`clientProfile`: the fan panel's «Отдан» and the frame's «Записать кастом», package R5).
 */
export async function customViewerOf(app: CustomApp, principal: HumanAuthPrincipal): Promise<CustomViewer> {
  const leads = await customLeads(app.db);
  const narrow = principal.narrowDeviceTokenId !== undefined || principal.clientProfile !== undefined;
  const role = !narrow && (principal.user.role === "owner" || principal.user.role === "team_lead")
    ? principal.user.role
    : "chatter";
  const test = principal.sandbox?.test === true;
  const facts = await teamFactsFor(app, principal);
  // The team's cut (services/teams.ts): the pages of the viewer's teams plus the pages their login was granted.
  const team = role === "owner" ? undefined : await teamPagesFor(app, principal);
  return {
    userId: principal.user.id, role, pageIds: team ?? principal.assignedPageIds, lead: leads.some((lead) => lead.userId === principal.user.id),
    // What the login works: the writes of the chat's side go by it, never by the team's read cut.
    workPageIds: principal.assignedPageIds,
    // Who leads which step, by the one rule (leaders.ts): a narrow session from the extension leads nothing.
    leads: narrow ? { check: [], shoot: [] } : ledPhasesOf(facts, principal.user.id, test),
    // The test realm (sandbox/realm.ts): the lead and the owner see every order of THEIR realm only.
    realm: { test, testPageIds: await listTestPageIds(app.db) },
  };
}

/** The one rule's inputs (leaders.ts): the team facts, and the person right's holder for an order of no known page. */
export interface CustomLeaderContext {
  facts: TeamFacts;
  fallback: CustomLeader | null;
}

export async function customLeaderContext(app: CustomApp, principal?: object): Promise<CustomLeaderContext> {
  const [facts, leads] = await Promise.all([teamFactsFor(app, principal), customLeads(app.db)]);
  const first = leads[0];
  const personId = first === undefined ? null : personOfLogin(facts, first.userId);
  const name = personId === null ? first?.displayName ?? "" : facts.people.find((person) => person.personId === personId)?.name ?? first?.displayName ?? "";
  return { facts, fallback: first === undefined ? null : { kind: "person", personId, userId: first.userId, name } };
}

/** «У кого сейчас» of an order on the wire. */
export function leaderWire(context: CustomLeaderContext | null, row: CustomOrderRow): CustomOrder["leader"] {
  if (context === null) return null;
  const step = customStepLeader(context.facts, row, context.fallback);
  if (step === null) return null;
  return { name: step.leader.kind === "owner" ? null : step.leader.name || null, phase: step.phase, product: step.product };
}

/** Who is on shift now, by page label (`listOnShiftUsersByPage`): whose move a shot order is. */
export type CustomOnShift = ReadonlyMap<string, readonly number[]>;

/** Whose move on the wire (`customMoveOf`, the one rule); null — nobody's, or the rule's inputs are not at hand. */
function moveWire(context: CustomLeaderContext | null, row: CustomOrderRow, facts: CustomOrderFacts, onShift: CustomOnShift): CustomOrder["move"] {
  if (context === null) return null;
  const onPage = row.pageLabel === null ? [] : onShift.get(row.pageLabel) ?? [];
  const move = customMoveOf(context.facts, row, { paid: facts.paid.value, given: facts.given.value }, onPage, context.fallback);
  if (move === null) return null;
  const { who, what } = move;
  switch (who.kind) {
    case "owner": return { who: null, whoKind: "owner", what };
    case "person": return { who: who.name || null, whoKind: "person", what };
    case "shift": return { who: who.name || null, whoKind: "shift", what };
    case "model": return { who: row.modelName, whoKind: "model", what };
    case "fan": return { who: row.fanUsername ?? row.fanDisplayName ?? row.buyer, whoKind: "fan", what };
  }
}

/** What the urgency of a row is read from (`customOrderUrgencyOf`, `customOrderBurnsOf`). */
function urgencyInputOf(row: CustomOrderRow, facts: CustomOrderFacts): CustomUrgencyInput {
  const paidWord = paidWordOf(row.paidWord);
  return {
    state: row.state, deadlineOn: row.deadlineOn, deadlineDefault: row.deadlineDefault, stateAt: row.stateAt, stateNote: row.stateNote,
    createdAt: row.createdAt, firstPaidAt: row.firstPaidAt, payments: row.payments, paidWord: paidWord === null ? null : { at: paidWord.at },
    holdReason: row.holdReason, issue: issueOf(row.issue), fanAskedAt: row.fanAskedAt, sentAt: row.sentAt, facts,
  };
}

/** Whether the order burns, why, and its forwarding timer (`customOrderUrgencyOf`): the board's and the checks' one reading. */
export function urgencyOfRow(row: CustomOrderRow, facts: CustomOrderFacts, now: Date): CustomUrgency {
  return customOrderUrgencyOf(urgencyInputOf(row, facts), now);
}

/** Everything the order burns by (`customOrderBurnsOf`): the checks' matters say what the board's «Горит» says. */
export function burnsOfRow(row: CustomOrderRow, facts: CustomOrderFacts, now: Date): CustomBurn[] {
  return customOrderBurnsOf(urgencyInputOf(row, facts), now);
}

/** The four facts of a row (`customOrderFactsOf`). */
export function factsOfRow(row: CustomOrderRow): CustomOrderFacts {
  return customOrderFactsOf({
    state: row.state, priceMills: row.priceMills, payments: row.payments, paidGrossMills: row.paidGrossMills,
    paymentReversed: row.paymentReversed, paidWord: paidWordOf(row.paidWord), sentAt: row.sentAt,
  });
}

// ── The wire ────────────────────────────────────────────────────────────────

export function orderWire(row: CustomOrderRow, now: Date = new Date(), leaders: CustomLeaderContext | null = null, onShift: CustomOnShift = new Map()): CustomOrder {
  const card = cardOf(row.card);
  const paidWord = paidWordOf(row.paidWord);
  const facts = factsOfRow(row);
  return {
    id: row.id,
    code: customOrderCode(row.id),
    pageLabel: row.pageLabel,
    platform: row.platform,
    model: row.modelName,
    modelSlug: row.modelSlug,
    fan: row.fanId === null || row.fanRef === null || row.platform === null
      ? null
      : { platform: row.platform, fanRef: row.fanRef, username: row.fanUsername, displayName: row.fanDisplayName },
    buyer: row.fanId === null ? row.buyer : null,
    fanErased: row.fanErasedAt !== null,
    card,
    what: whatOf(card),
    deadlineOn: row.deadlineOn,
    state: row.state,
    stateWord: CUSTOM_STATE_WORDS[row.state],
    leader: leaderWire(leaders, row),
    stateAt: row.stateAt.toISOString(),
    stateNote: row.stateNote,
    stateRef: row.stateRef,
    paidGrossMills: row.paidGrossMills,
    paidNetMills: row.paidNetMills,
    payments: row.payments,
    givenAt: row.givenAt?.toISOString() ?? null,
    givenMessageRef: row.givenMessageRef,
    acceptedBy: row.acceptedBy,
    acceptedByName: row.acceptedByName,
    telegramRefs: row.telegramRefs,
    contentopsRef: row.contentopsRef,
    origin: row.origin,
    overdueDays: overdueDaysOf(row, now),
    dueLeftDays: dueLeftDaysOf(row, now),
    deadlineDefault: row.deadlineDefault,
    facts,
    priceMills: row.priceMills,
    paidWord,
    holdReason: row.holdReason,
    issue: issueOf(row.issue),
    fanAskedAt: row.fanAskedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    move: moveWire(leaders, row, facts, onShift),
    ...urgencyOfRow(row, facts, now),
    partsDone: row.partsDone,
    openRevisions: row.openRevisions,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The order on the agent's wire and ContentOps' («Съёмка» reads the agent's shape): the session wire without money.
 * The facts and what they are read from only with `money` — an agent key holding `read:money` (`facts.paid` is about
 * the fan's money); ContentOps and every other key read it as before (customs facts spec §11). Whose move and whether it
 * burns with `reading` — the live list to a key holding `read:messages`: the reader's reminders follow the board's one
 * rule (`customMoveOf`), never a copy of it; who is on shift comes in `onShift`.
 */
export function agentOrderBase(
  row: CustomOrderRow,
  now: Date,
  leaders: CustomLeaderContext | null,
  options: { money?: boolean; reading?: boolean; onShift?: CustomOnShift } = {},
) {
  const {
    paidGrossMills: _gross, paidNetMills: _net, dueLeftDays, deadlineDefault, facts, priceMills, paidWord, holdReason, issue, fanAskedAt, sentAt,
    // The board's reading of the order (whose move, what burns, the timer) is the board's, but for the reader's two.
    move, burning, reason: _reason, timer: _timer, ...wire
  } = orderWire(row, now, leaders, options.onShift);
  const read = options.reading === true ? { move, burning } : {};
  if (options.money !== true) return { ...wire, ...read };
  return { ...wire, dueLeftDays, deadlineDefault, facts, priceMills, paidWord, holdReason, issue, fanAskedAt, sentAt, ...read };
}

export function messageWire(message: CustomOrderMessageRow): CustomOrderMessage {
  return {
    telegramRef: message.telegramRef,
    eventRef: message.eventRef,
    ordinal: message.ordinal,
    kind: message.kind,
    part: message.part,
    complete: message.complete,
    at: message.postedAt?.toISOString() ?? null,
    author: message.author,
    excerpt: message.excerpt,
    doneAt: message.doneAt?.toISOString() ?? null,
    retractedAt: message.retractedAt?.toISOString() ?? null,
  };
}

export async function orderMessagesOf(db: Database, orderId: number): Promise<CustomOrderMessage[]> {
  return (await listCustomOrderMessages(db, orderId)).map(messageWire);
}

export function cardTextOf(row: CustomOrderRow): string {
  return renderCardText({
    id: row.id,
    card: cardOf(row.card),
    deadlineOn: row.deadlineOn,
    createdAt: row.createdAt,
    buyer: row.buyer,
    fan: row.fanId === null || row.fanRef === null || row.platform === null ? null : { platform: row.platform, fanRef: row.fanRef, username: row.fanUsername },
  });
}

const paymentWire = (sale: CustomOrderSaleRow): CustomOrderPayment => ({
  transactionRef: String(sale.transactionId),
  kind: sale.kind,
  grossMills: sale.grossMills,
  netMills: sale.netMills,
  at: sale.at.toISOString(),
  note: sale.note,
});

// ── The board ───────────────────────────────────────────────────────────────

/** The sales that look like a custom with no order that `viewer` should see: the lead and the owner every page's, a team lead their pages', a chatter the chats they led. */
export function lookalikesFor(viewer: CustomViewer, given: readonly CustomLookalikeRow[]): CustomLookalikeRow[] {
  const rows = given.filter((row) => seesOrder({ ...viewer, lead: true }, row));
  if (viewer.lead || viewer.role === "owner") return [...rows];
  if (viewer.role === "team_lead") return rows.filter((row) => viewer.pageIds.includes(row.pageId));
  return rows.filter((row) => row.ledByUserIds.includes(viewer.userId) && viewer.pageIds.includes(row.pageId));
}

/**
 * «Сверено N минут назад» (customs facts spec §9): the last success of the reader's two routines in «Система →
 * Состояние» (`CUSTOMS_ROUTINES`, as the reader reports them), and whether the reader is stale. No table of its own.
 */
export async function customsVerifiedOf(app: CustomApp, now: Date): Promise<CustomOrdersBoardResponse["verified"]> {
  const routines = await listSystemRoutines(app.db);
  const success = (key: string) => routines.find((routine) => routine.key === key)?.lastSuccessAt ?? null;
  const readerAt = success(CUSTOMS_ROUTINES.reader.key);
  const nightlyAt = success(CUSTOMS_ROUTINES.nightly.key);
  return { readerAt: readerAt?.toISOString() ?? null, nightlyAt: nightlyAt?.toISOString() ?? null, readerStale: customsReaderStale(readerAt, now) };
}

/** The person's accounts (the fan and the accounts joined to it): the payments and hints are theirs. */
async function personFanIds(db: Database, fanId: number | null): Promise<number[]> {
  if (fanId === null) return [];
  return (await listPersonFans(db, fanId)).map((fan) => fan.id);
}

/** «Это оплата?» of an order: the fan's tips and subscriptions on the page no order took. */
export async function paymentCandidatesOf(db: Database, order: Pick<CustomOrderRow, "pageId" | "fanId">, kinds: readonly string[], now: Date, limit: number) {
  if (order.pageId === null || order.fanId === null) return [];
  return listCustomPaymentCandidates(db, { pageId: order.pageId, fanIds: await personFanIds(db, order.fanId), kinds, now, days: CUSTOM_PAYMENT_DAYS, limit });
}

/** The kinds of sale that can pay a custom: what an agent may name, and what it is offered. */
export const CUSTOM_PAYING_KINDS = ["tip", "subscription", "message_purchase"] as const;

/**
 * The agent's «это оплата?» (customs facts spec §5): the fan's sales (any account of the person) on `pageIds` — the
 * key's pages of the order's model — of the last 30 days, that pay no order and that no person took off this one, the
 * newest first. Not only since the order was recorded: a fan mostly pays first and the card is written after. The reader
 * reads the chat around each and names one back, or leaves it; Hub never decides by the amount.
 */
export async function unlinkedSalesOf(
  db: Database,
  order: Pick<CustomOrderRow, "id" | "fanId">,
  pageIds: readonly number[],
  now: Date,
  limit: number,
) {
  if (order.fanId === null || pageIds.length === 0) return [];
  return listCustomPaymentCandidates(db, {
    pageIds, fanIds: await personFanIds(db, order.fanId), kinds: CUSTOM_PAYING_KINDS, now, days: CUSTOM_PAYMENT_DAYS,
    notRejectedFor: order.id, limit,
  });
}

/** «Отдали: это он?»: media the page sent in the fan's chat since the payment, or since the record. */
export async function deliveryCandidatesOf(db: Database, order: CustomOrderRow, limit: number) {
  if (order.pageId === null || order.conversationRef === null) return [];
  return listCustomDeliverySuggestions(db, { pageId: order.pageId, conversationRef: order.conversationRef, since: order.firstPaidAt ?? order.createdAt, limit });
}

async function historyOf(db: Database, orderId: number): Promise<CustomOrderDetailResponse["history"]> {
  const events = await listObjectEvents(db, { objectType: "custom_order", objectId: String(orderId), limit: 300 });
  const userIds = [...new Set(events.flatMap((event) => [event.actorUserId, event.onBehalfOfUserId]).filter((id): id is number => id !== null))];
  const agentKeyIds = [...new Set(events.map((event) => event.actorAgentKeyId).filter((id): id is number => id !== null))];
  const names = await listCustomOrderActorNames(db, { userIds, agentKeyIds });
  return events.map((event) => ({
    id: event.id,
    at: event.createdAt.toISOString(),
    event: event.event,
    actor: event.actorUserId !== null ? names.users.get(event.actorUserId) ?? null
      : event.actorAgentKeyId !== null ? names.agentKeys.get(event.actorAgentKeyId) ?? null : null,
    onBehalfOf: event.onBehalfOfUserId === null ? null : names.users.get(event.onBehalfOfUserId) ?? null,
    door: event.door,
    changes: event.changes,
  }));
}

const IN_WORK: readonly CustomOrderStateRow[] = ["recorded", "paid", "checked", "at_model", "partly", "shot", "revision"];

async function detailOf(app: CustomApp, viewer: CustomViewer, order: CustomOrderRow, now: Date): Promise<CustomOrderDetailResponse> {
  const working = IN_WORK.includes(order.state);
  const [payments, offered, deliveries, history, messages, leaders, onShift] = await Promise.all([
    listCustomOrderPayments(app.db, order.id),
    order.state === "cancelled" ? Promise.resolve([]) : paymentCandidatesOf(app.db, order, ["tip", "subscription"], now, 10),
    working ? deliveryCandidatesOf(app.db, order, 10) : Promise.resolve([]),
    historyOf(app.db, order.id),
    orderMessagesOf(app.db, order.id),
    customLeaderContext(app),
    listOnShiftUsersByPage(app.db, now),
  ]);
  return {
    order: orderWire(order, now, leaders, onShift),
    cardText: cardTextOf(order),
    sourceText: order.sourceText,
    messages,
    payments: payments.map(paymentWire),
    paymentSuggestions: offered.map(paymentWire),
    deliverySuggestions: deliveries.map((message) => ({
      messageRef: message.messageRef, at: message.at.toISOString(), mediaCount: message.mediaCount, priceMills: message.priceMills,
    })),
    history,
    actions: stepsFor(viewer, order),
    serverNow: now.toISOString(),
  };
}

async function visibleOrder(app: CustomApp, viewer: CustomViewer, code: string): Promise<CustomOrderRow> {
  const id = parseCustomOrderCode(code);
  const order = id === null ? null : await findCustomOrder(app.db, id);
  // An order the viewer does not see reads like one that does not exist.
  if (order === null || !seesOrder(viewer, order)) throw notFound();
  return order;
}

export async function readCustomOrder(app: CustomApp, principal: AuthPrincipal, code: string, now: Date = new Date()): Promise<CustomOrderDetailResponse> {
  requireSessionUser(principal);
  const viewer = await customViewerOf(app, principal);
  return detailOf(app, viewer, await visibleOrder(app, viewer, code), now);
}

// ── One step ────────────────────────────────────────────────────────────────

/**
 * A message of the order, as a door gives it: a Telegram message known by its link, or an event known by the
 * sender's own `eventRef` (ContentOps' delivery), the link then only its evidence (null — none).
 */
export interface CustomMessageInput {
  telegramRef: string | null;
  eventRef?: string | null;
  at: Date | null;
  author: string | null;
  excerpt: string | null;
}

/** The event a message step names and what became of it: kept now, or the order had this very one. */
export interface CustomEventResult {
  ref: string;
  result: "stored" | "already";
}

/** A step as every door gives it: the board's body, the extension's and the agent's translated to it. */
export type CustomStep =
  | {
    action: "edit";
    /** The whole card (the board, Gengar's «держи обновлённую»), or only the changed fields (the reader). */
    card?: CustomOrderCard;
    patch?: CustomOrderCardPatch;
    deadlineOn?: string | null;
    sourceText?: string;
    /** The agreed total, gross (null — not named any more); a hold's reason (null — the order waits no more). */
    priceMills?: number | null;
    holdReason?: string | null;
    /** A person's edit marks its fields as theirs; an agent's never overwrites such a field. */
    by: "person" | "agent";
    ifVersion?: number;
  }
  /**
   * The deadline: a person's is theirs (it enters `person_fields`, an agent never moves it again); an agent's — a move
   * the chatter agreed with the fan, with its `reason` — and the system's never enter it, and never move a person's.
   * The system's alone is «примерно» (`deadline_default`); any other clears that mark.
   */
  | { action: "deadline"; deadlineOn: string | null; by: "person" | "agent" | "system"; reason?: string | undefined; undoOf?: number | undefined }
  /** `by: "agent"` — only while the order has no fan and its fan was not erased. */
  | { action: "fan"; pageId: number; fanId: number; conversationRef: string | null; by?: "person" | "agent" }
  | { action: "card"; telegramRef: string; postedAt?: Date | null; author?: string | null }
  | { action: "payment"; transactionId: number }
  | { action: "unpay"; transactionId: number; undoOf?: number | undefined }
  | { action: "checked" }
  | { action: "at_model"; telegramRef?: string | undefined }
  | { action: "partly"; note?: string | undefined; ref?: string | undefined }
  /** A revision request: about `part`, or — none named — about the whole order. No `message`: a person's «Правка» on the board. */
  | { action: "revision"; note?: string | undefined; ref?: string | undefined; message?: CustomMessageInput; ordinal?: number; part?: CustomPart | undefined }
  | { action: "shot"; ref?: string | undefined }
  | { action: "refused"; reason: string; ref?: string | undefined }
  /**
   * `messageRef` null — given by a person's word, no message named; `note` — whose word and where, as the one-off
   * backfill carries it (kept in the history only).
   */
  | { action: "given"; messageRef: string | null; at: Date; note?: string | undefined }
  /** «Отдан» taken back: «снят» again; a delivering message the system or an agent named stays off the order. */
  | { action: "ungive"; undoOf?: number | undefined }
  | { action: "close" }
  | { action: "cancel"; reason?: string | undefined }
  | { action: "delivery"; message: CustomMessageInput; part: "video" | "photos" | undefined; complete: boolean }
  | { action: "revision_done"; telegramRef: string | null; eventRef?: string | null; ordinal: number }
  | { action: "message"; kind: "repost" | "confirmation" | "note"; message: CustomMessageInput }
  /** A delivery taken back, by its eventRef or its message's link; the retraction is its own event (a note). */
  | {
    action: "retract"; retracts: { eventRef: string } | { telegramRef: string }; reason: string; message: CustomMessageInput & { eventRef: string };
    undoOf?: number | undefined;
  }
  /** The server's own: the order put where its kept messages say (`settleCustomOrders`). */
  | { action: "settle" }
  /** A wait on purpose, and its end. */
  | { action: "hold"; reason: string }
  | { action: "unhold" }
  /** The sources disagree about the order: the agent's one sentence; and its end. */
  | { action: "issue"; text: string }
  | { action: "issue_clear" }
  /** The owner's word on the payment; null — taken back. */
  | { action: "paid_word"; word: { kind: CustomPaidWordKind; note: string | null } | null }
  /** The fan asked where the order is: his message (checked by the door) and its time. */
  | { action: "fan_asked"; messageRef: string; at: Date }
  /** His ask answered: by a person's word, or the page's message to him after it (the checks pass), with its time. */
  | { action: "fan_asked_clear"; messageRef?: string; at?: Date };

function patched(card: CustomOrderCard, patch: CustomOrderCardPatch): CustomOrderCard {
  const next: Record<string, unknown> = { ...card };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return cardOf(next);
}

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** What «правка» is about: the newest request still open, its words and its message; null — none is open. */
function aboutOf(rows: readonly CustomOrderRoundRow[], open: readonly number[]): { note: string | null; ref: string | null } | null {
  const newest = rows.find((row) => row.id === open.at(-1));
  return newest === undefined ? null : { note: newest.excerpt, ref: newest.telegramRef };
}

/** The steps that put the order in a state by a message of the model's group (`ref`). */
const STATE_STEPS_BY_MESSAGE: ReadonlySet<string> = new Set(["partly", "shot", "refused"]);

/**
 * What an order's kept messages say against what it holds, read-only: the state they put it in (`stateByMessages`),
 * the parts ready by them, whether that differs — and whether a person moved the order by their own hand after its
 * newest message (they decided with it in sight: such an order is never settled).
 */
async function settledOf(db: Database, order: CustomOrderRow): Promise<{ to: CustomOrderStateRow; partsDone: CustomPart[]; differs: boolean; byHand: boolean }> {
  const wanted = wantedParts(cardOf(order.card));
  const rows = await listCustomOrderRoundMessages(db, order.id);
  const round = roundOf({ wanted, partsDone: order.partsDone, messages: rows, saidWholeAt: order.shotByHandAt });
  const to = stateByMessages(order.state, round);
  const differs = rows.length > 0 && (to !== order.state || round.answered.length > 0 || round.reopened.length > 0
    || !sameValue(round.partsDone, wanted.filter((part) => order.partsDone.includes(part))));
  const newest = rows.reduce((latest, row) => Math.max(latest, row.at.getTime()), 0);
  const hand = differs ? await findCustomOrderLastHandMove(db, order.id) : null;
  return { to, partsDone: round.partsDone, differs, byHand: hand !== null && hand.getTime() > newest };
}

export interface CustomSettleRow {
  code: string;
  state: CustomOrderStateRow;
  /** Where the order's kept messages put it. */
  byMessages: CustomOrderStateRow;
  partsDone: CustomPart[];
  partsByMessages: CustomPart[];
  /** differs — not applied (a dry run); settled — put there now; by_hand — left: a person moved it after its newest message. */
  outcome: "differs" | "settled" | "by_hand";
}

/**
 * The orders whose kept messages disagree with what they hold — an import stored their messages without a step, and
 * a repeat of a kept message changes nothing, so no door can apply them any more. Without `apply` nothing is
 * written: the list says each order's state now and by its messages. With it each is settled by the step every
 * message goes through (`settle`), with its line in the order's history; a second run finds nothing. `orderIds`
 * limits it to those orders.
 */
export async function settleCustomOrders(
  app: CustomApp,
  input: { apply: boolean; orderIds?: readonly number[] | undefined; now?: Date },
): Promise<CustomSettleRow[]> {
  const out: CustomSettleRow[] = [];
  const orders = (await listCustomOrdersInStates(app.db, STEP_FROM.settle))
    .filter((order) => input.orderIds === undefined || input.orderIds.includes(order.id));
  for (const order of orders) {
    const settled = await settledOf(app.db, order);
    if (!settled.differs) continue;
    const row = { code: customOrderCode(order.id), state: order.state, byMessages: settled.to, partsDone: order.partsDone, partsByMessages: settled.partsDone };
    if (settled.byHand) {
      out.push({ ...row, outcome: "by_hand" });
    } else if (!input.apply) {
      out.push({ ...row, outcome: "differs" });
    } else {
      const changed = await applyCustomStep(app, {
        orderId: order.id, step: { action: "settle" }, actor: { door: "system" }, viewer: null, ...(input.now === undefined ? {} : { now: input.now }),
      });
      // Moved on between the read and the lock (a step of a door): nothing left to settle, nothing to list.
      if (changed) out.push({ ...row, outcome: "settled" });
    }
  }
  return out;
}

/**
 * One step of an order in one transaction, with its history event and a new version: the state checked under
 * the order's lock (two people at once — the second gets `changed: false` or 409, never a double step). `viewer`
 * null — a door whose rights were checked before (an agent key, the system). Answers whether anything changed.
 */
export async function applyCustomStep(
  app: CustomApp,
  input: {
    orderId: number; step: CustomStep; actor: CustomActor; viewer: CustomViewer | null; now?: Date;
    /** A person's step carried by another product's key (ContentOps «Съёмка»): «снят» is then their own word. */
    byPerson?: boolean;
    /** Filled for a message step: the event it names and whether it is kept now or was before; null — not kept. */
    report?: { event: CustomEventResult | null };
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const step = input.step;
  if (input.report !== undefined) input.report.event = null;
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockCustomOrder(db, input.orderId))) throw notFound();
    const order = (await findCustomOrder(db, input.orderId))!;
    if (input.viewer !== null) {
      if (!seesOrder(input.viewer, order)) throw notFound();
      if (!isBoardAction(step.action) || !mayTakeStep(input.viewer, order, step.action)) throw notAllowed();
    }
    // One rule for every step that names a message or an event: one the order already keeps changes nothing, whatever
    // the order's state is now — the daily routine repeats every message it sees. A message step (delivery, revision,
    // message, retract) is known by the message's own identity (`addMessage` below); a state step by a message
    // (partly, shot, refused) by that step and message in the order's history.
    if (STATE_STEPS_BY_MESSAGE.has(step.action) && "ref" in step && typeof step.ref === "string"
      && (await hasCustomOrderStepByRef(db, { orderId: order.id, event: `custom_order.${step.action}`, ref: step.ref }))) return false;
    if (!STEP_FROM[step.action].includes(order.state)) throw notAllowed(`An order «${order.state}» takes no step «${step.action}»`);
    const event = (name: string, changes: Record<string, unknown>) => insertCustomOrderEvent(db, {
      orderId: order.id, event: `custom_order.${name}`, door: input.actor.door, userId: input.actor.userId ?? null,
      agentKeyId: input.actor.agentKeyId ?? null, onBehalfOfUserId: input.actor.onBehalfOfUserId ?? null, changes, at: now,
    });
    const move = (to: CustomOrderStateRow, extra: { note?: string | null; ref?: string | null; clear?: { given?: boolean; sent?: boolean; fanAsked?: boolean } } = {}) =>
      moveCustomOrder(db, { orderId: order.id, from: [order.state], to, ...extra, at: now });
    /** A person's own hand: the board, the extension, ContentOps «Съёмка» as the person — never an agent key or the system. */
    const byPerson = (input.actor.userId !== undefined && input.actor.userId !== null) || input.byPerson === true;
    // A person's undo names the step it takes back (customs facts spec §10): one of this order's history, recorded with it.
    const undoOf = "undoOf" in step && step.undoOf !== undefined ? step.undoOf : null;
    if (undoOf !== null && !(await isCustomOrderEvent(db, { orderId: order.id, eventId: undoOf }))) {
      throw new ConflictError("The step it undoes is not one of the order's history", { reason: "unknown_event" });
    }
    const undo = undoOf === null ? {} : { undoOf };
    /** Who says a word kept on the order (an issue, the owner's word): a person's registry name, an agent key's name. */
    const actorName = async (): Promise<string | null> => {
      const userId = input.actor.userId ?? null;
      const agentKeyId = input.actor.agentKeyId ?? null;
      const names = await listCustomOrderActorNames(db, { userIds: userId === null ? [] : [userId], agentKeyIds: agentKeyId === null ? [] : [agentKeyId] });
      return (userId === null ? null : names.users.get(userId)) ?? (agentKeyId === null ? null : names.agentKeys.get(agentKeyId)) ?? null;
    };
    /**
     * Undo remembered (spec §10): evidence the system or an agent applied and a person took off the order is never applied
     * to it again by them; a person who applies it by hand takes the memory away.
     */
    const evidence = async (kind: "payment" | "given", ref: string) => {
      if (byPerson) await removeCustomOrderRejection(db, { orderId: order.id, kind, ref });
      else if (await hasCustomOrderRejection(db, { orderId: order.id, kind, ref })) {
        throw new ConflictError(kind === "payment" ? "A person took this sale off the order" : "A person took this message off the order", { reason: "rejected" });
      }
    };
    /** Taking evidence off: remembered when the step that applied it came through the system's or an agent's door. */
    const rememberUndo = async (kind: "payment" | "given", ref: string): Promise<boolean> => {
      const door = await findCustomOrderLinkDoor(db, { orderId: order.id, kind, ref });
      if (door !== "system" && door !== "api") return false;
      await addCustomOrderRejection(db, { orderId: order.id, kind, ref, userId: input.actor.userId ?? null, at: now });
      return true;
    };
    const addMessage = async (
      message: CustomMessageInput,
      kind: "repost" | "delivery" | "revision" | "confirmation" | "note",
      extra: { part?: "video" | "photos" | null; ordinal?: number; complete?: boolean } = {},
    ): Promise<CustomOrderMessageResult> => {
      const result = await addCustomOrderMessage(db, {
        orderId: order.id, telegramRef: message.telegramRef, eventRef: message.eventRef ?? null, ordinal: extra.ordinal ?? 0, kind,
        part: extra.part ?? null, complete: extra.complete ?? null, postedAt: message.at, author: message.author, excerpt: message.excerpt, at: now,
      });
      // `taken`: the identity holds another kind of message — this event is not kept, and the answer says so.
      if (input.report !== undefined && result !== "taken") input.report.event = { ref: message.eventRef ?? message.telegramRef!, result };
      return result;
    };
    const refsOf = (message: CustomMessageInput) => ({
      ...(message.telegramRef === null ? {} : { telegramRef: message.telegramRef }),
      ...(message.eventRef ? { eventRef: message.eventRef } : {}),
    });
    /**
     * The order's round after this step's message (rules.ts, `roundOf`), written: the parts ready now and the requests
     * the round fixes or opens again. `questioned` — the parts this step takes a word's readiness from. Every message
     * step of every door settles here, so the readiness is computed in one place.
     */
    const settleRound = async (wanted: readonly CustomPart[], questioned: readonly CustomPart[] = []) => {
      const rows = await listCustomOrderRoundMessages(db, order.id);
      const round = roundOf({ wanted, partsDone: order.partsDone, messages: rows, questioned, saidWholeAt: order.shotByHandAt });
      if (!sameValue(round.partsDone, order.partsDone)) await updateCustomOrderFields(db, order.id, { partsDone: round.partsDone }, now);
      await answerCustomOrderRevisions(db, { orderId: order.id, ids: round.answered, at: now });
      await reopenCustomOrderRevisions(db, { orderId: order.id, ids: round.reopened });
      return { ...round, about: aboutOf(rows, round.open) };
    };
    /** «Правка» about a request still open: the order moves there; in it already, only what it is about follows. */
    const toRevision = async (about: { note: string | null; ref: string | null }) => {
      if (order.state !== "revision") await move("revision", about);
      else if (order.stateNote !== about.note || order.stateRef !== about.ref) await setCustomOrderStateNote(db, order.id, about, now);
    };

    const changed = await (async (): Promise<boolean> => {
      switch (step.action) {
        case "edit": {
          if (step.ifVersion !== undefined && step.ifVersion !== order.version) {
            throw new ConflictError(`The order changed since version ${step.ifVersion} (now ${order.version})`, { reason: "version_changed" });
          }
          const before = cardOf(order.card);
          const next = step.card ?? patched(before, step.patch ?? {});
          const keys = [...new Set([...Object.keys(before), ...Object.keys(next)])]
            .filter((key) => !sameValue(before[key as keyof CustomOrderCard], next[key as keyof CustomOrderCard]));
          const deadlineChanged = step.deadlineOn !== undefined && step.deadlineOn !== order.deadlineOn;
          const sourceChanged = step.sourceText !== undefined && step.sourceText !== order.sourceText;
          const priceChanged = step.priceMills !== undefined && step.priceMills !== order.priceMills;
          const holdChanged = step.holdReason !== undefined && step.holdReason !== order.holdReason;
          const touched = [...keys, ...(deadlineChanged ? ["deadlineOn"] : []), ...(priceChanged ? ["priceMills"] : []), ...(holdChanged ? ["holdReason"] : [])];
          if (step.by === "agent") {
            const theirs = touched.filter((key) => order.personFields.includes(key));
            if (theirs.length > 0) {
              throw new ConflictError(`A person edited these fields; they are not overwritten: ${theirs.join(", ")}`, { reason: "edited_by_person" });
            }
          }
          if (touched.length === 0 && !sourceChanged) return false;
          await updateCustomOrderFields(db, order.id, {
            card: next,
            // A deadline edited is no system's «примерно» any more.
            ...(deadlineChanged ? { deadlineOn: step.deadlineOn ?? null, deadlineDefault: false } : {}),
            ...(sourceChanged ? { sourceText: step.sourceText } : {}),
            ...(priceChanged ? { priceMills: step.priceMills ?? null } : {}),
            ...(holdChanged ? { holdReason: step.holdReason ?? null } : {}),
            ...(step.by === "person" ? { personFields: [...new Set([...order.personFields, ...touched])] } : {}),
          }, now);
          await event("edited", {
            fields: touched, ...(deadlineChanged ? { deadlineOn: step.deadlineOn ?? null } : {}), ...(sourceChanged ? { sourceText: true } : {}),
            ...(priceChanged ? { priceMills: step.priceMills ?? null } : {}), ...(holdChanged ? { reason: step.holdReason ?? null } : {}),
          });
          return true;
        }
        case "deadline": {
          // A person's deadline is theirs: neither an agent nor the system moves it again (as an agent's edit of it).
          if (step.by !== "person" && order.personFields.includes("deadlineOn")) {
            throw new ConflictError("A person set this deadline; it is not overwritten: deadlineOn", { reason: "edited_by_person" });
          }
          const approximate = step.by === "system" && step.deadlineOn !== null;
          // The same day again changes nothing, unless it turns «примерно» into a day someone set (or back).
          if (step.deadlineOn === order.deadlineOn && approximate === order.deadlineDefault) return false;
          await updateCustomOrderFields(db, order.id, {
            deadlineOn: step.deadlineOn, deadlineDefault: approximate,
            ...(step.by === "person" ? { personFields: [...new Set([...order.personFields, "deadlineOn"])] } : {}),
          }, now);
          await event("deadline", {
            from: order.deadlineOn, to: step.deadlineOn, ...(step.reason ? { reason: step.reason } : {}), ...(approximate ? { approximate: true } : {}), ...undo,
          });
          return true;
        }
        case "fan": {
          if (step.by === "agent" && (order.fanId !== null || order.fanErasedAt !== null)) {
            throw new ConflictError("The order has its fan already, or its fan was erased", { reason: "fan_known" });
          }
          if (step.pageId === order.pageId && step.fanId === order.fanId) return false;
          await updateCustomOrderFields(db, order.id, { pageId: step.pageId, fanId: step.fanId, buyer: null, conversationRef: step.conversationRef }, now);
          // The buyer's string goes: the fan is known now. Its text stays out of the history (a fan's name).
          await event("fan_confirmed", { pageId: step.pageId, fanId: step.fanId, hadBuyer: order.buyer !== null });
          return true;
        }
        case "card": {
          const added = await addCustomOrderCard(db, { orderId: order.id, telegramRef: step.telegramRef, at: now, postedAt: step.postedAt ?? null, author: step.author ?? null });
          if (!added) {
            if (order.telegramRefs.includes(step.telegramRef)) return false;
            throw new ConflictError("The Telegram card belongs to another order", { reason: "taken" });
          }
          await event("card", { telegramRef: step.telegramRef });
          return true;
        }
        case "payment": {
          await evidence("payment", String(step.transactionId));
          const added = await addCustomOrderPayment(db, { orderId: order.id, transactionId: step.transactionId, userId: input.actor.userId ?? null, at: now });
          if (!added) {
            const own = await listCustomOrderPayments(db, order.id);
            if (own.some((sale) => sale.transactionId === step.transactionId)) return false;
            throw new ConflictError("The payment is taken by another custom", { reason: "not_suggested" });
          }
          if (order.state === "recorded") await move("paid");
          await event("payment", { transactionId: step.transactionId, ...(order.state === "recorded" ? { state: "paid" } : {}) });
          return true;
        }
        case "unpay": {
          if (!(await removeCustomOrderPayment(db, { orderId: order.id, transactionId: step.transactionId }))) return false;
          const remembered = await rememberUndo("payment", String(step.transactionId));
          const back = order.state === "paid" && (await listCustomOrderPayments(db, order.id)).length === 0;
          if (back) await move("recorded");
          await event("payment_removed", {
            transactionId: step.transactionId, ...(back ? { state: "recorded" } : {}), ...(remembered ? { remembered: true } : {}), ...undo,
          });
          return true;
        }
        case "checked": {
          await move("checked");
          await event("checked", { from: order.state });
          return true;
        }
        case "at_model": {
          if (step.telegramRef !== undefined) {
            const added = await addCustomOrderCard(db, { orderId: order.id, telegramRef: step.telegramRef, at: now });
            if (!added && !order.telegramRefs.includes(step.telegramRef)) throw new ConflictError("The Telegram card belongs to another order", { reason: "taken" });
          }
          await move("at_model");
          await event("at_model", { from: order.state, ...(step.telegramRef === undefined ? {} : { telegramRef: step.telegramRef }) });
          return true;
        }
        case "delivery": {
          const wanted = wantedParts(cardOf(order.card));
          const part = step.part ?? wanted[0]!;
          // The same delivery again (or its link holding another message) is nothing new: an old message never moves the order.
          if ((await addMessage(step.message, "delivery", { part, complete: step.complete })) !== "stored") return false;
          // The round decides: a whole delivery makes its own part ready when it is newer than the last request about
          // that part, and fixes only the requests whose every part is ready now — never the other part's request.
          const round = await settleRound(wanted);
          // Kept in every state; it moves the order only from the states before «снят» and from a revision: «снят» when
          // every wanted part is ready and no request is open, «правка» while one is (or while a revision still waits
          // for its part), else «сдан частично».
          const to = stateByMessages(order.state, round);
          if (to === "revision" && round.about !== null) await toRevision(round.about);
          else if (to !== order.state) await move(to, { ref: step.message.telegramRef });
          await event("delivery", {
            from: order.state, to, part, complete: step.complete, ...refsOf(step.message),
            ...(step.message.excerpt ? { excerpt: step.message.excerpt } : {}),
            ...(round.answered.length > 0 ? { revisionsDone: round.answered.length } : {}),
          });
          return true;
        }
        case "partly":
        case "shot":
        case "refused": {
          const note = step.action === "refused" ? step.reason : step.action === "shot" ? null : step.note ?? null;
          const ref = step.ref ?? null;
          // «Снят»: every part whole, and the open revision requests fixed by it (an order with one open is never shot).
          // Set by a person's own hand, it is their word: it stands until a newer revision request, and a delivery
          // taken back afterwards does not undo it (`shot_by_hand_at`; the reader's «снят» is no such word).
          let answered = 0;
          if (step.action === "shot") {
            // A person's own hand: on the board, or carried by another product's key (ContentOps «Съёмка»).
            const byHand = (input.actor.userId !== undefined && input.actor.userId !== null) || input.byPerson === true;
            await updateCustomOrderFields(db, order.id, { partsDone: wantedParts(cardOf(order.card)), ...(byHand ? { shotByHandAt: now } : {}) }, now);
            answered = await closeCustomOrderRevisions(db, { orderId: order.id, at: now });
          }
          await move(STEP_TO[step.action]!, { note, ref });
          await event(step.action, {
            from: order.state, ...(note === null ? {} : { note }), ...(ref === null ? {} : { ref }), ...(answered > 0 ? { revisionsDone: answered } : {}),
          });
          return true;
        }
        case "revision": {
          const wanted = wantedParts(cardOf(order.card));
          const note = step.note ?? step.message?.excerpt ?? null;
          // Every request is a message of the order with its own time, so the round can tell what came after it. A
          // person's «Правка» on the board has no message of the model's group: the hub names it itself.
          const message: CustomMessageInput = step.message
            ?? { telegramRef: null, eventRef: `${input.actor.door}:revision:${order.version + 1}`, at: null, author: null, excerpt: null };
          if ((await addMessage({ ...message, excerpt: note }, "revision", { ordinal: step.ordinal ?? 0, part: step.part ?? null })) !== "stored") return false;
          // It sends back the parts it is about: each is ready again only by a whole delivery newer than the request.
          const round = await settleRound(wanted, partsAbout(wanted, step.part));
          const ref = step.ref ?? step.message?.telegramRef ?? null;
          // A request reported late, whose parts came whole after it, is fixed already and moves nothing. A revision of a
          // given order takes «отдан» off it, and any revision the «sent, not opened» (customs facts spec §6): the files the
          // fan has or was sent are not the order's last word any more.
          if (round.about !== null && (order.state !== "revision" || order.stateNote !== round.about.note || order.stateRef !== round.about.ref)) {
            // The message that gave it is the version sent back: never this order's delivery again by the system or an
            // agent (a person may still name it by hand, which takes the memory away).
            if (order.state === "given" && order.givenMessageRef !== null) {
              await addCustomOrderRejection(db, { orderId: order.id, kind: "given", ref: order.givenMessageRef, userId: input.actor.userId ?? null, at: now });
            }
            await move("revision", { ...round.about, clear: { given: order.state === "given", sent: true } });
          } else if (round.about !== null && order.sentAt !== null) {
            await updateCustomOrderFields(db, order.id, { sentCleared: true }, now);
          }
          await event("revision", {
            from: order.state, ...(note === null ? {} : { note }), ...(ref === null ? {} : { ref }), ...(step.ordinal ? { ordinal: step.ordinal } : {}),
            ...(step.part === undefined ? {} : { part: step.part }),
            ...(step.message?.eventRef ? { eventRef: step.message.eventRef } : {}),
          });
          return true;
        }
        case "revision_done": {
          // The request is fixed by a word (it stays fixed); the order stays «правка» until the parts it sent back come
          // whole again, or «снят».
          const done = await markCustomOrderRevisionDone(db, { orderId: order.id, telegramRef: step.telegramRef, eventRef: step.eventRef ?? null, ordinal: step.ordinal, at: now });
          if (!done) return false;
          if (order.state === "revision") {
            const round = await settleRound(wantedParts(cardOf(order.card)));
            if (round.about !== null) await toRevision(round.about);
          }
          await event("revision_done", {
            ...(step.telegramRef === null ? {} : { telegramRef: step.telegramRef }), ...(step.eventRef ? { eventRef: step.eventRef } : {}), ordinal: step.ordinal,
          });
          return true;
        }
        case "message": {
          const kept = await addMessage(step.message, step.kind);
          let card = false;
          const cardRef = step.message.telegramRef;
          if (step.kind === "repost" && cardRef !== null) {
            card = await addCustomOrderCard(db, { orderId: order.id, telegramRef: cardRef, at: now, postedAt: step.message.at, author: step.message.author });
            if (!card && !order.telegramRefs.includes(cardRef)) throw new ConflictError("The Telegram card belongs to another order", { reason: "taken" });
          }
          if (kept !== "stored" && !card) return false;
          await event("message", { kind: step.kind, ...refsOf(step.message) });
          return true;
        }
        case "retract": {
          // The retraction is an event of its own (a note with its reason), so a repeat of it changes nothing.
          const kept = await addMessage({ ...step.message, excerpt: step.message.excerpt ?? step.reason }, "note");
          if (kept === "taken") throw new ConflictError("This eventRef names another message of the order", { reason: "event_taken" });
          if (kept === "already") return false;
          const { matched, retracted } = await retractCustomOrderDeliveries(db, { orderId: order.id, ...step.retracts }, now);
          if (matched === 0) throw new ConflictError("The order has no delivery of that ref", { reason: "unknown_event" });
          // The part of a whole delivery taken back stands only on a whole delivery that stays and is newer than the last
          // request about that part: the one that was sent back for revision does not count. The requests the taken
          // delivery had answered are open again, and the state follows: «правка» while one is open, else what the
          // parts that stay say.
          const wanted = wantedParts(cardOf(order.card));
          const questioned = [...new Set(retracted.filter((one) => one.complete !== false && one.part !== null).map((one) => one.part!))];
          const round = await settleRound(wanted, questioned);
          const lost = wanted.filter((part) => order.partsDone.includes(part) && !round.partsDone.includes(part));
          const follows = retracted.length > 0 && (order.state === "shot" || order.state === "partly" || order.state === "revision");
          const to: CustomOrderStateRow = !follows ? order.state
            : round.about !== null || order.state === "revision" ? "revision"
            : round.whole ? "shot" : round.partsDone.length > 0 || round.liveDeliveries > 0 ? "partly" : "at_model";
          if (to === "revision" && round.about !== null) await toRevision(round.about);
          else if (to !== order.state) await move(to);
          await event("retracted", {
            from: order.state, to, retracts: "eventRef" in step.retracts ? step.retracts.eventRef : step.retracts.telegramRef,
            eventRef: step.message.eventRef, parts: lost, reason: step.reason,
            ...(round.reopened.length > 0 ? { revisionsReopened: round.reopened.length } : {}), ...undo,
          });
          return true;
        }
        case "settle": {
          // The order where its kept messages say: for the ones stored without a step (an import), which no repeat of
          // the message can apply any more. Never an order a person moved by their own hand after its newest message.
          const settled = await settledOf(db, order);
          if (settled.byHand || !settled.differs) return false;
          const round = await settleRound(wantedParts(cardOf(order.card)));
          const to = stateByMessages(order.state, round);
          if (to === "revision" && round.about !== null) await toRevision(round.about);
          else if (to !== order.state) await move(to);
          await event("settled", { from: order.state, to, parts: round.partsDone });
          return true;
        }
        case "given": {
          if (step.messageRef !== null) await evidence("given", step.messageRef);
          // The fan has it: «sent, not opened» and his «where is it» are over.
          await moveCustomOrder(db, {
            orderId: order.id, from: [order.state], to: "given", given: { messageRef: step.messageRef, at: step.at }, clear: { sent: true, fanAsked: true }, at: now,
          });
          await event("given", step.messageRef === null
            ? { from: order.state, byWord: true, ...(step.note === undefined ? {} : { note: step.note, at: step.at.toISOString() }) }
            : { from: order.state, messageRef: step.messageRef, sentAt: step.at.toISOString() });
          return true;
        }
        case "ungive": {
          // «Снят» again, the mark and its message gone; a message the system or an agent named stays off the order.
          const ref = order.givenMessageRef;
          const remembered = ref !== null && (await rememberUndo("given", ref));
          await move("shot", { clear: { given: true, sent: true } });
          await event("ungiven", { from: order.state, ...(ref === null ? { byWord: true } : { messageRef: ref }), ...(remembered ? { remembered: true } : {}), ...undo });
          return true;
        }
        case "hold": {
          if (order.holdReason === step.reason) return false;
          // A person's hold is theirs, as a field they edited: an agent's edit never takes it off or rewrites it.
          await updateCustomOrderFields(db, order.id, {
            holdReason: step.reason, ...(byPerson ? { personFields: [...new Set([...order.personFields, "holdReason"])] } : {}),
          }, now);
          await event("hold", { reason: step.reason });
          return true;
        }
        case "unhold": {
          if (order.holdReason === null) return false;
          await updateCustomOrderFields(db, order.id, {
            holdReason: null, ...(byPerson ? { personFields: [...new Set([...order.personFields, "holdReason"])] } : {}),
          }, now);
          await event("unhold", {});
          return true;
        }
        case "issue": {
          if (issueOf(order.issue)?.text === step.text) return false;
          await updateCustomOrderFields(db, order.id, { issue: { text: step.text, by: await actorName(), at: now.toISOString() } }, now);
          await event("issue", { text: step.text });
          return true;
        }
        case "issue_clear": {
          if (order.issue === null) return false;
          await updateCustomOrderFields(db, order.id, { issue: null }, now);
          await event("issue_cleared", {});
          return true;
        }
        case "paid_word": {
          const current = paidWordOf(order.paidWord);
          if (step.word === null) {
            if (order.paidWord === null) return false;
            await updateCustomOrderFields(db, order.id, { paidWord: null }, now);
            await event("paid_word", { kind: null });
            return true;
          }
          if (current?.kind === step.word.kind && current.note === step.word.note) return false;
          await updateCustomOrderFields(db, order.id, { paidWord: { kind: step.word.kind, note: step.word.note, by: await actorName(), at: now.toISOString() } }, now);
          await event("paid_word", { kind: step.word.kind, ...(step.word.note === null ? {} : { note: step.word.note }) });
          return true;
        }
        case "fan_asked": {
          // The ask that stands is the one the order waits by until the page answers it: another message — a later one, or
          // an older one reported late — never moves it.
          if (order.fanAskedAt !== null) return false;
          await updateCustomOrderFields(db, order.id, { fanAsked: { at: step.at, ref: step.messageRef } }, now);
          await event("fan_asked", { messageRef: step.messageRef, at: step.at.toISOString() });
          return true;
        }
        case "fan_asked_clear": {
          if (order.fanAskedAt === null) return false;
          await updateCustomOrderFields(db, order.id, { fanAsked: null }, now);
          await event("fan_asked_cleared", {
            ...(step.messageRef === undefined ? {} : { messageRef: step.messageRef }), ...(step.at === undefined ? {} : { at: step.at.toISOString() }),
          });
          return true;
        }
        case "close": {
          await move("closed");
          await event("closed", {});
          return true;
        }
        case "cancel": {
          // A cancelled order gives its sales back (a slip of the finger, a refund): another order may take them.
          const payments = await listCustomOrderPayments(db, order.id);
          for (const sale of payments) await removeCustomOrderPayment(db, { orderId: order.id, transactionId: sale.transactionId });
          await move("cancelled", { note: step.reason ?? null });
          await event("cancelled", { from: order.state, released: payments.map((sale) => sale.transactionId), ...(step.reason ? { reason: step.reason } : {}) });
          return true;
        }
      }
    })();
    if (changed) await bumpCustomOrder(db, order.id, now);
    return changed;
  });
}

// ── The board's doors ───────────────────────────────────────────────────────

/** The page and fan a person gave, resolved: the page must be the viewer's to see, the fan a fan of the page. */
export async function resolveFanOnPage(
  db: Database,
  input: { pageLabel: string; fan: string },
): Promise<{ pageId: number; platform: string; fanId: number; fanRef: string } | null> {
  const page = await findPageSummaryByLabel(db, input.pageLabel);
  if (!page) return null;
  const parsed = fanInputOf(page.platform, input.fan);
  if (parsed === null) return null;
  const fan = await findPageFanByInput(db, { pageId: page.id, platform: page.platform, ...parsed });
  return fan === null ? null : { pageId: page.id, platform: page.platform, fanId: fan.fanId, fanRef: fan.platformUserId };
}

async function boardStep(app: CustomApp, viewer: CustomViewer, order: CustomOrderRow, body: CustomOrderActionBody, now: Date): Promise<CustomStep> {
  switch (body.action) {
    case "edit":
      // The card, and the agreed total: a person's, so an agent never overwrites it.
      return { action: "edit", by: "person", ...(body.card === undefined ? {} : { card: body.card }), ...(body.priceMills === undefined ? {} : { priceMills: body.priceMills }) };
    case "deadline":
      return { action: "deadline", deadlineOn: body.deadlineOn, by: "person", undoOf: body.undoOf };
    case "fan": {
      const found = await resolveFanOnPage(app.db, { pageLabel: body.pageLabel, fan: body.fan });
      if (found === null || !seesOrder(viewer, { pageId: found.pageId }) || !worksOnPage(viewer, found.pageId)) {
        throw new ConflictError("No such fan on the page", { reason: "fan_unknown" });
      }
      return { action: "fan", pageId: found.pageId, fanId: found.fanId, conversationRef: found.platform === "onlyfans" ? found.fanRef : null };
    }
    case "card":
    case "at_model": {
      const ref = body.telegramRef === undefined ? undefined : parseTelegramRef(body.telegramRef) ?? undefined;
      return body.action === "card" ? { action: "card", telegramRef: ref! } : { action: "at_model", telegramRef: ref };
    }
    case "checked":
      return { action: "checked" };
    case "payment": {
      const offered = await paymentCandidatesOf(app.db, order, ["tip", "subscription"], now, 50);
      if (!offered.some((sale) => String(sale.transactionId) === body.transactionRef)) throw notSuggested("The payment is not suggested for this order");
      return { action: "payment", transactionId: Number(body.transactionRef) };
    }
    case "unpay":
      return { action: "unpay", transactionId: Number(body.transactionRef), undoOf: body.undoOf };
    case "given": {
      // «Отдан» by the person's word: no message named (given before the hub saw the chat, a chat it does not read).
      if (body.messageRef === undefined) return { action: "given", messageRef: null, at: now };
      const offered = await deliveryCandidatesOf(app.db, order, 50);
      const found = offered.find((message) => message.messageRef === body.messageRef);
      if (found === undefined) throw notSuggested("The message is not suggested for this order");
      return { action: "given", messageRef: found.messageRef, at: found.at };
    }
    case "ungive":
      return { action: "ungive", undoOf: body.undoOf };
    case "retract": {
      // The board names the retraction itself, as it names a person's «Правка»: one event per version of the order.
      const link = parseTelegramRef(body.retracts);
      return {
        action: "retract", retracts: link === null ? { eventRef: body.retracts } : { telegramRef: link }, reason: body.reason, undoOf: body.undoOf,
        message: { telegramRef: null, eventRef: `workboard:retraction:${order.version + 1}`, at: null, author: null, excerpt: null },
      };
    }
    case "hold":
      return { action: "hold", reason: body.reason };
    case "unhold":
    case "issue_clear":
    case "fan_asked_clear":
      return { action: body.action };
    case "paid_word":
      return { action: "paid_word", word: body.word === null ? null : { kind: body.word.kind, note: body.word.note ?? null } };
    case "partly":
      return { action: "partly", note: body.note };
    case "revision":
      return { action: "revision", note: body.note, part: body.part };
    case "shot":
    case "close":
      return { action: body.action };
    case "refused":
      return { action: "refused", reason: body.reason };
    case "cancel":
      return { action: "cancel", reason: body.reason };
  }
}

/**
 * Who writes on the board: a cookie session, or the extension's own narrow token (products package R5) for what its
 * fan panel does — «Записать кастом» in the board's own form in its frame, and «Отдан»; it reads as a chatter
 * (customViewerOf). Answers the door the write is recorded by.
 */
function boardWriterDoor(principal: AuthPrincipal, action: CustomOrderAction | "record"): "workboard" | "extension" {
  if (principal.kind !== "agent" && principal.authMethod === "device_token" && principal.clientProfile === "chat-extension") {
    if (action !== "record" && action !== "given") throw notAllowed("From the extension an order is recorded or given; every other step is Workboard's");
    return "extension";
  }
  requireSessionUser(principal);
  return "workboard";
}

/**
 * The board's steps the released extension knows (its SDK checks `actions` against the contract it was built with, from
 * before the customs facts): the answer to the extension's own token never names another — it takes none of them anyway
 * (`boardWriterDoor`) — or the extension would refuse the whole answer.
 */
const EXTENSION_KNOWN_ACTIONS: ReadonlySet<CustomOrderAction> = new Set([
  "edit", "deadline", "fan", "card", "payment", "unpay", "checked", "at_model", "partly", "shot", "revision", "refused", "given", "close", "cancel",
]);
function answerFor(door: "workboard" | "extension", detail: CustomOrderDetailResponse): CustomOrderDetailResponse {
  return door === "extension" ? { ...detail, actions: detail.actions.filter((action) => EXTENSION_KNOWN_ACTIONS.has(action)) } : detail;
}

/** `customOrderAct`: one step on the board, answered with the order after it. */
export async function actOnCustomOrder(
  app: CustomApp,
  principal: AuthPrincipal,
  input: { code: string; body: CustomOrderActionBody },
  now: Date = new Date(),
): Promise<CustomOrderDetailResponse> {
  const door = boardWriterDoor(principal, input.body.action as CustomOrderAction);
  const human = principal as HumanAuthPrincipal;
  const viewer = await customViewerOf(app, human);
  const order = await visibleOrder(app, viewer, input.code);
  if (!mayTakeStep(viewer, order, input.body.action as CustomOrderAction)) throw notAllowed();
  const step = await boardStep(app, viewer, order, input.body, now);
  await applyCustomStep(app, { orderId: order.id, step, actor: { door, userId: human.user.id }, viewer, now });
  return answerFor(door, await detailOf(app, viewer, (await findCustomOrder(app.db, order.id))!, now));
}

/** A new order with its first event, its sale and its card in one transaction. Answers its id. */
export async function recordCustomOrder(
  app: CustomApp,
  input: {
    pageId: number | null;
    fanId: number | null;
    buyer: string | null;
    conversationRef: string | null;
    card: CustomOrderCard;
    deadlineOn: string | null;
    acceptedByUserId: number | null;
    origin: "extension" | "agent" | "workboard" | "import";
    contentopsRef?: string | null;
    sourceText?: string | null;
    /** The first card's time and author (a posted card): the order counts from then. */
    cardPostedAt?: Date | null;
    cardAuthor?: string | null;
    state?: CustomOrderStateRow;
    paymentTransactionId?: number | null;
    telegramRefs?: readonly string[];
    /** The agreed total, gross, and a wait on purpose (0436). */
    priceMills?: number | null;
    holdReason?: string | null;
    /** The fields a person gave at the record (their price): an agent never overwrites them. */
    personFields?: readonly string[];
    actor: CustomActor;
    createdAt?: Date;
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const paid = input.paymentTransactionId !== undefined && input.paymentTransactionId !== null;
    const state: CustomOrderStateRow = input.state ?? (paid ? "paid" : "recorded");
    const id = await insertCustomOrder(db, {
      pageId: input.pageId, fanId: input.fanId, buyer: input.buyer, conversationRef: input.conversationRef, card: input.card,
      deadlineOn: input.deadlineOn, state, acceptedByUserId: input.acceptedByUserId, origin: input.origin,
      contentopsRef: input.contentopsRef ?? null, sourceText: input.sourceText ?? null, at: input.createdAt ?? now,
      priceMills: input.priceMills ?? null, holdReason: input.holdReason ?? null, personFields: input.personFields ?? [],
    });
    if (paid) {
      const added = await addCustomOrderPayment(db, { orderId: id, transactionId: input.paymentTransactionId!, userId: input.actor.userId ?? null, at: now });
      if (!added) throw new ConflictError("The payment is taken by another custom", { reason: "not_suggested" });
    }
    for (const [index, ref] of [...new Set(input.telegramRefs ?? [])].entries()) {
      const first = index === 0 ? { postedAt: input.cardPostedAt ?? null, author: input.cardAuthor ?? null } : {};
      if (!(await addCustomOrderCard(db, { orderId: id, telegramRef: ref, at: now, ...first }))) {
        throw new ConflictError("The Telegram card belongs to another order", { reason: "taken" });
      }
    }
    await insertCustomOrderEvent(db, {
      orderId: id, event: "custom_order.recorded", door: input.actor.door, userId: input.actor.userId ?? null,
      agentKeyId: input.actor.agentKeyId ?? null, onBehalfOfUserId: input.actor.onBehalfOfUserId ?? null,
      changes: {
        state, origin: input.origin, pageId: input.pageId, fanConfirmed: input.fanId !== null,
        ...(paid ? { transactionId: input.paymentTransactionId } : {}),
        ...(input.telegramRefs && input.telegramRefs.length > 0 ? { telegramRefs: [...new Set(input.telegramRefs)] } : {}),
        ...(input.contentopsRef ? { contentopsRef: input.contentopsRef } : {}),
        ...(input.priceMills ? { priceMills: input.priceMills } : {}),
        ...(input.holdReason ? { hold: true } : {}),
      },
      at: now,
    });
    return id;
  });
}

/** `customOrderCreate`: «Записать кастом» on the board, from a sale that looks like one or for a fan of a page. */
export async function createCustomOrderOnBoard(
  app: CustomApp,
  principal: AuthPrincipal,
  body: CustomOrderCreateBody,
  now: Date = new Date(),
): Promise<CustomOrderDetailResponse> {
  const door = boardWriterDoor(principal, "record");
  const human = principal as HumanAuthPrincipal;
  const viewer = await customViewerOf(app, human);
  let pageId: number;
  let fanId: number | null = null;
  let conversationRef: string | null = null;
  let payment: number | null = null;
  if (body.transactionRef !== undefined) {
    const sale = await findCustomSale(app.db, Number(body.transactionRef));
    // «Записать кастом»: on a page the person works (never one their team cut only reads).
    if (sale === null || !seesOrder(viewer, { pageId: sale.pageId }) || !worksOnPage(viewer, sale.pageId)) throw new NotFoundError("The sale was not found");
    pageId = sale.pageId;
    fanId = sale.fanId;
    // A sale of the fan no order took, of the last month — or, whatever its day, one a matter «похоже на кастом без
    // заказа» still waits about (an order that holds it already refuses the payment below).
    const offered = await paymentCandidatesOf(app.db, { pageId, fanId }, ["tip", "subscription"], now, 200);
    if (!offered.some((one) => one.transactionId === sale.transactionId) && !(await waitingCustomSaleIds(app.db)).includes(sale.transactionId)) {
      throw notSuggested("The sale pays another order already");
    }
    payment = sale.transactionId;
  } else {
    const page = await findPageSummaryByLabel(app.db, body.pageLabel!);
    if (!page || !seesOrder(viewer, { pageId: page.id }) || !worksOnPage(viewer, page.id)) throw new NotFoundError(`Page "${body.pageLabel}" was not found`);
    pageId = page.id;
    if (body.fan !== undefined) {
      const found = await resolveFanOnPage(app.db, { pageLabel: page.label, fan: body.fan });
      if (found === null) throw new ConflictError("No such fan on the page", { reason: "fan_unknown" });
      fanId = found.fanId;
      if (found.platform === "onlyfans") conversationRef = found.fanRef;
    }
  }
  const telegramRef = body.telegramRef === undefined ? null : parseTelegramRef(body.telegramRef);
  const id = await recordCustomOrder(app, {
    pageId, fanId, buyer: fanId === null && body.fan !== undefined ? body.fan.slice(0, 300) : null, conversationRef, card: body.card,
    deadlineOn: null, acceptedByUserId: human.user.id, origin: door, paymentTransactionId: payment,
    telegramRefs: telegramRef === null ? [] : [telegramRef], actor: { door, userId: human.user.id }, now,
    ...(body.priceMills === undefined ? {} : { priceMills: body.priceMills, personFields: ["priceMills"] }),
  });
  return answerFor(door, await detailOf(app, viewer, (await findCustomOrder(app.db, id))!, now));
}

/** `customSaleDismiss`: «Не кастом» — by the person who led the chat, the lead, a team lead of the page or the owner. */
export async function dismissCustomLookalike(app: CustomApp, principal: AuthPrincipal, transactionRef: string, now: Date = new Date()): Promise<{ dismissed: boolean }> {
  requireSessionUser(principal);
  const viewer = await customViewerOf(app, principal);
  const transactionId = Number(transactionRef);
  const rows = await listCustomLookalikeSales(app.db, { from: new Date(now.getTime() - 60 * DAY_MS), to: now, limit: 1000, alsoIds: await waitingCustomSaleIds(app.db) });
  // «Не кастом» is a write: by the pages the person works, not the team's read cut.
  const row = lookalikesFor({ ...viewer, pageIds: viewer.workPageIds ?? viewer.pageIds }, rows).find((one) => one.transactionId === transactionId);
  if (row === undefined) throw new NotFoundError("The sale was not found");
  return { dismissed: await dismissCustomSale(app.db, { transactionId, userId: principal.user.id }) };
}
