import {
  customOrderCode,
  parseCustomOrderCode,
  parseTelegramRef,
  type CustomOrder,
  type CustomOrderAction,
  type CustomOrderActionBody,
  type CustomOrderCard,
  type CustomOrderCardPatch,
  type CustomOrderCreateBody,
  type CustomOrderMessage,
  type CustomOrderDetailResponse,
  type CustomOrderPayment,
  type CustomOrdersBoardResponse,
} from "@agency_hub_core/contracts";
import {
  addCustomOrderCard,
  addCustomOrderMessage,
  addCustomOrderPayment,
  bumpCustomOrder,
  dismissCustomSale,
  findCustomOrder,
  findCustomSale,
  findPageFanByInput,
  findPageSummaryByLabel,
  insertCustomOrder,
  insertCustomOrderEvent,
  listCustomDeliverySuggestions,
  listCustomLookalikeSales,
  listCustomOrderActorNames,
  listCustomOrderPayments,
  listCustomOrders,
  listCustomPaymentCandidates,
  listObjectEvents,
  listPersonFans,
  listUsersWithPersonRight,
  listCustomOrderMessages,
  lockCustomOrder,
  markCustomOrderRevisionDone,
  moveCustomOrder,
  removeCustomOrderPayment,
  updateCustomOrderFields,
  type CustomLookalikeRow,
  type CustomOrderMessageRow,
  type CustomOrderRow,
  type CustomOrderSaleRow,
  type CustomOrderStateRow,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { requireSessionUser, type AuthPrincipal, type HumanAuthPrincipal } from "../auth.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import {
  cardOf,
  fanInputOf,
  isBoardAction,
  leadsSteps,
  mayTakeStep,
  overdueDaysOf,
  renderCardText,
  seesOrder,
  STEP_FROM,
  STEP_TO,
  stepsFor,
  wantedParts,
  whatOf,
  type CustomViewer,
} from "./rules.ts";

/**
 * Заказ кастома (ecosystem plan 2026-11-12, package I): the core every door
 * goes through — the board's reads, one step of an order with its history
 * event in the same transaction, a record. Who may take a step is rules.ts's;
 * which sale may pay an order and which message carried it are Hub's
 * suggestions, never a free number. Database only: nothing here sends a
 * message or asks a platform.
 */

type CustomApp = Pick<AppContext, "db">;

/** How long a sale is offered as a payment, and how many. */
export const CUSTOM_PAYMENT_DAYS = 30;
/** The board shows the given and closed orders of the last week. */
const DONE_DAYS = 7;
const BOARD_LIMIT = 500;
const DAY_MS = 86_400_000;

/** Who did a step and through which door (object_events). */
export interface CustomActor {
  door: "extension" | "workboard" | "telegram" | "api" | "system";
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
 * (opened from the extension, no password) reads as a chatter whatever the role, as everywhere it is let in.
 */
export async function customViewerOf(app: CustomApp, principal: HumanAuthPrincipal): Promise<CustomViewer> {
  const leads = await customLeads(app.db);
  const role = principal.narrowDeviceTokenId === undefined && (principal.user.role === "owner" || principal.user.role === "team_lead")
    ? principal.user.role
    : "chatter";
  return { userId: principal.user.id, role, pageIds: principal.assignedPageIds, lead: leads.some((lead) => lead.userId === principal.user.id) };
}

// ── The wire ────────────────────────────────────────────────────────────────

export function orderWire(row: CustomOrderRow, now: Date = new Date()): CustomOrder {
  const card = cardOf(row.card);
  return {
    id: row.id,
    code: customOrderCode(row.id),
    pageLabel: row.pageLabel,
    platform: row.platform,
    model: row.modelName,
    fan: row.fanId === null || row.fanRef === null || row.platform === null
      ? null
      : { platform: row.platform, fanRef: row.fanRef, username: row.fanUsername, displayName: row.fanDisplayName },
    buyer: row.fanId === null ? row.buyer : null,
    fanErased: row.fanErasedAt !== null,
    card,
    what: whatOf(card),
    deadlineOn: row.deadlineOn,
    state: row.state,
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
    partsDone: row.partsDone,
    openRevisions: row.openRevisions,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function messageWire(message: CustomOrderMessageRow): CustomOrderMessage {
  return {
    telegramRef: message.telegramRef,
    ordinal: message.ordinal,
    kind: message.kind,
    part: message.part,
    at: message.postedAt?.toISOString() ?? null,
    author: message.author,
    excerpt: message.excerpt,
    doneAt: message.doneAt?.toISOString() ?? null,
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
export function lookalikesFor(viewer: CustomViewer, rows: readonly CustomLookalikeRow[]): CustomLookalikeRow[] {
  if (viewer.lead || viewer.role === "owner") return [...rows];
  if (viewer.role === "team_lead") return rows.filter((row) => viewer.pageIds.includes(row.pageId));
  return rows.filter((row) => row.ledByUserIds.includes(viewer.userId) && viewer.pageIds.includes(row.pageId));
}

export async function readCustomOrdersBoard(
  app: CustomApp,
  principal: AuthPrincipal,
  query: { pageLabel?: string | undefined },
  now: Date = new Date(),
): Promise<CustomOrdersBoardResponse> {
  requireSessionUser(principal);
  const viewer = await customViewerOf(app, principal);
  let pageId: number | null = null;
  if (query.pageLabel !== undefined) {
    const page = await findPageSummaryByLabel(app.db, query.pageLabel);
    if (!page || !seesOrder(viewer, { pageId: page.id })) throw new NotFoundError(`Page "${query.pageLabel}" was not found`);
    pageId = page.id;
  }
  const everything = viewer.lead || viewer.role === "owner";
  const pageIds = pageId !== null ? [pageId] : everything ? "all" as const : viewer.pageIds;
  const [rows, lookalikes, leads] = await Promise.all([
    listCustomOrders(app.db, { pageIds, unknownPage: everything || viewer.role === "team_lead", doneSince: new Date(now.getTime() - DONE_DAYS * DAY_MS), limit: BOARD_LIMIT + 1 }),
    listCustomLookalikeSales(app.db, { from: new Date(now.getTime() - DONE_DAYS * DAY_MS), to: now, limit: 200 }),
    customLeads(app.db),
  ]);
  const visible = rows.filter((row) => seesOrder(viewer, row));
  return {
    viewer: { lead: leadsSteps(viewer), owner: viewer.role === "owner" },
    leads: [...new Set(leads.map((lead) => lead.displayName))],
    orders: visible.slice(0, BOARD_LIMIT).map((row) => orderWire(row, now)),
    capped: visible.length > BOARD_LIMIT,
    lookalikes: lookalikesFor(viewer, lookalikes)
      .filter((row) => pageId === null || row.pageId === pageId)
      .map((row) => ({
        transactionRef: String(row.transactionId),
        pageLabel: row.pageLabel,
        fan: row.fanRef === null ? null : { platform: row.platform, fanRef: row.fanRef, username: row.fanUsername, displayName: row.fanDisplayName },
        kind: row.kind,
        detail: row.detail,
        grossMills: row.grossMills,
        at: row.at.toISOString(),
      })),
    serverNow: now.toISOString(),
  };
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
    at: event.createdAt.toISOString(),
    event: event.event,
    actor: event.actorUserId !== null ? names.users.get(event.actorUserId) ?? null
      : event.actorAgentKeyId !== null ? names.agentKeys.get(event.actorAgentKeyId) ?? null : null,
    onBehalfOf: event.onBehalfOfUserId === null ? null : names.users.get(event.onBehalfOfUserId) ?? null,
    door: event.door,
    changes: event.changes,
  }));
}

const IN_WORK: readonly CustomOrderStateRow[] = ["recorded", "paid", "at_model", "partly", "shot", "revision"];

async function detailOf(app: CustomApp, viewer: CustomViewer, order: CustomOrderRow, now: Date): Promise<CustomOrderDetailResponse> {
  const working = IN_WORK.includes(order.state);
  const [payments, offered, deliveries, history, messages] = await Promise.all([
    listCustomOrderPayments(app.db, order.id),
    order.state === "cancelled" ? Promise.resolve([]) : paymentCandidatesOf(app.db, order, ["tip", "subscription"], now, 10),
    working ? deliveryCandidatesOf(app.db, order, 10) : Promise.resolve([]),
    historyOf(app.db, order.id),
    orderMessagesOf(app.db, order.id),
  ]);
  return {
    order: orderWire(order, now),
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

/** A message of the order in Telegram, as a door gives it. */
export interface CustomMessageInput {
  telegramRef: string;
  at: Date | null;
  author: string | null;
  excerpt: string | null;
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
    /** A person's edit marks its fields as theirs; an agent's never overwrites such a field. */
    by: "person" | "agent";
    ifVersion?: number;
  }
  | { action: "deadline"; deadlineOn: string | null }
  | { action: "fan"; pageId: number; fanId: number; conversationRef: string | null }
  | { action: "card"; telegramRef: string; postedAt?: Date | null; author?: string | null }
  | { action: "payment"; transactionId: number }
  | { action: "unpay"; transactionId: number }
  | { action: "at_model"; telegramRef?: string | undefined }
  | { action: "partly"; note?: string | undefined; ref?: string | undefined }
  | { action: "revision"; note?: string | undefined; ref?: string | undefined; message?: CustomMessageInput; ordinal?: number }
  | { action: "shot"; ref?: string | undefined }
  | { action: "refused"; reason: string; ref?: string | undefined }
  | { action: "given"; messageRef: string; at: Date }
  | { action: "close" }
  | { action: "cancel"; reason?: string | undefined }
  | { action: "delivery"; message: CustomMessageInput; part: "video" | "photos" | undefined; complete: boolean }
  | { action: "revision_done"; telegramRef: string; ordinal: number }
  | { action: "message"; kind: "repost" | "confirmation" | "note"; message: CustomMessageInput };

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

/**
 * One step of an order in one transaction, with its history event and a new version: the state checked under
 * the order's lock (two people at once — the second gets `changed: false` or 409, never a double step). `viewer`
 * null — a door whose rights were checked before (an agent key, the system). Answers whether anything changed.
 */
export async function applyCustomStep(
  app: CustomApp,
  input: { orderId: number; step: CustomStep; actor: CustomActor; viewer: CustomViewer | null; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const step = input.step;
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockCustomOrder(db, input.orderId))) throw notFound();
    const order = (await findCustomOrder(db, input.orderId))!;
    if (input.viewer !== null) {
      if (!seesOrder(input.viewer, order)) throw notFound();
      if (!isBoardAction(step.action) || !mayTakeStep(input.viewer, order, step.action)) throw notAllowed();
    }
    if (!STEP_FROM[step.action].includes(order.state)) throw notAllowed(`An order «${order.state}» takes no step «${step.action}»`);
    const event = (name: string, changes: Record<string, unknown>) => insertCustomOrderEvent(db, {
      orderId: order.id, event: `custom_order.${name}`, door: input.actor.door, userId: input.actor.userId ?? null,
      agentKeyId: input.actor.agentKeyId ?? null, onBehalfOfUserId: input.actor.onBehalfOfUserId ?? null, changes, at: now,
    });
    const move = (to: CustomOrderStateRow, extra: { note?: string | null; ref?: string | null } = {}) =>
      moveCustomOrder(db, { orderId: order.id, from: [order.state], to, ...extra, at: now });
    const addMessage = (message: CustomMessageInput, kind: "repost" | "delivery" | "revision" | "confirmation" | "note", extra: { part?: "video" | "photos" | null; ordinal?: number } = {}) =>
      addCustomOrderMessage(db, {
        orderId: order.id, telegramRef: message.telegramRef, ordinal: extra.ordinal ?? 0, kind, part: extra.part ?? null,
        postedAt: message.at, author: message.author, excerpt: message.excerpt, at: now,
      });

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
          const touched = [...keys, ...(deadlineChanged ? ["deadlineOn"] : [])];
          if (step.by === "agent") {
            const theirs = touched.filter((key) => order.personFields.includes(key));
            if (theirs.length > 0) {
              throw new ConflictError(`A person edited these fields; they are not overwritten: ${theirs.join(", ")}`, { reason: "edited_by_person" });
            }
          }
          if (touched.length === 0 && !sourceChanged) return false;
          await updateCustomOrderFields(db, order.id, {
            card: next,
            ...(deadlineChanged ? { deadlineOn: step.deadlineOn ?? null } : {}),
            ...(sourceChanged ? { sourceText: step.sourceText } : {}),
            ...(step.by === "person" ? { personFields: [...new Set([...order.personFields, ...touched])] } : {}),
          }, now);
          await event("edited", { fields: touched, ...(deadlineChanged ? { deadlineOn: step.deadlineOn ?? null } : {}), ...(sourceChanged ? { sourceText: true } : {}) });
          return true;
        }
        case "deadline": {
          if (step.deadlineOn === order.deadlineOn) return false;
          await updateCustomOrderFields(db, order.id, { deadlineOn: step.deadlineOn, personFields: [...new Set([...order.personFields, "deadlineOn"])] }, now);
          await event("deadline", { from: order.deadlineOn, to: step.deadlineOn });
          return true;
        }
        case "fan": {
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
          const back = order.state === "paid" && (await listCustomOrderPayments(db, order.id)).length === 0;
          if (back) await move("recorded");
          await event("payment_removed", { transactionId: step.transactionId, ...(back ? { state: "recorded" } : {}) });
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
          const added = await addMessage(step.message, "delivery", { part });
          const partsDone = step.complete ? [...new Set([...order.partsDone, part])] : order.partsDone;
          const whole = wanted.every((one) => partsDone.includes(one));
          const to: CustomOrderStateRow = whole ? "shot" : "partly";
          const moves = order.state !== to;
          if (!added && !moves && partsDone.length === order.partsDone.length) return false;
          if (partsDone.length !== order.partsDone.length) await updateCustomOrderFields(db, order.id, { partsDone }, now);
          if (moves) await move(to, { ref: step.message.telegramRef });
          await event("delivery", {
            from: order.state, to, part, complete: step.complete, telegramRef: step.message.telegramRef,
            ...(step.message.excerpt ? { excerpt: step.message.excerpt } : {}),
          });
          return true;
        }
        case "partly":
        case "shot":
        case "refused": {
          const note = step.action === "refused" ? step.reason : step.action === "shot" ? null : step.note ?? null;
          const ref = step.ref ?? null;
          if (order.state === step.action && order.stateRef === ref && order.stateNote === note && ref !== null) return false;
          if (step.action === "shot") await updateCustomOrderFields(db, order.id, { partsDone: wantedParts(cardOf(order.card)) }, now);
          await move(STEP_TO[step.action]!, { note, ref });
          await event(step.action, { from: order.state, ...(note === null ? {} : { note }), ...(ref === null ? {} : { ref }) });
          return true;
        }
        case "revision": {
          const note = step.note ?? step.message?.excerpt ?? null;
          const added = step.message === undefined ? true : await addMessage({ ...step.message, excerpt: note }, "revision", { ordinal: step.ordinal ?? 0 });
          if (!added) return false;
          const ref = step.ref ?? step.message?.telegramRef ?? null;
          if (order.state !== "revision" || order.stateNote !== note || order.stateRef !== ref) await move("revision", { note, ref });
          await event("revision", { from: order.state, ...(note === null ? {} : { note }), ...(ref === null ? {} : { ref }), ...(step.ordinal ? { ordinal: step.ordinal } : {}) });
          return true;
        }
        case "revision_done": {
          if (!(await markCustomOrderRevisionDone(db, { orderId: order.id, telegramRef: step.telegramRef, ordinal: step.ordinal, at: now }))) return false;
          await event("revision_done", { telegramRef: step.telegramRef, ordinal: step.ordinal });
          return true;
        }
        case "message": {
          const added = await addMessage(step.message, step.kind);
          let card = false;
          if (step.kind === "repost") {
            card = await addCustomOrderCard(db, { orderId: order.id, telegramRef: step.message.telegramRef, at: now, postedAt: step.message.at, author: step.message.author });
            if (!card && !order.telegramRefs.includes(step.message.telegramRef)) throw new ConflictError("The Telegram card belongs to another order", { reason: "taken" });
          }
          if (!added && !card) return false;
          await event("message", { kind: step.kind, telegramRef: step.message.telegramRef });
          return true;
        }
        case "given": {
          await moveCustomOrder(db, { orderId: order.id, from: [order.state], to: "given", given: { messageRef: step.messageRef, at: step.at }, at: now });
          await event("given", { from: order.state, messageRef: step.messageRef, sentAt: step.at.toISOString() });
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
      return { action: "edit", card: body.card, by: "person" };
    case "deadline":
      return { action: "deadline", deadlineOn: body.deadlineOn };
    case "fan": {
      const found = await resolveFanOnPage(app.db, { pageLabel: body.pageLabel, fan: body.fan });
      if (found === null || !seesOrder(viewer, { pageId: found.pageId })) {
        throw new ConflictError("No such fan on the page", { reason: "fan_unknown" });
      }
      return { action: "fan", pageId: found.pageId, fanId: found.fanId, conversationRef: found.platform === "onlyfans" ? found.fanRef : null };
    }
    case "card":
    case "at_model": {
      const ref = body.telegramRef === undefined ? undefined : parseTelegramRef(body.telegramRef) ?? undefined;
      return body.action === "card" ? { action: "card", telegramRef: ref! } : { action: "at_model", telegramRef: ref };
    }
    case "payment": {
      const offered = await paymentCandidatesOf(app.db, order, ["tip", "subscription"], now, 50);
      if (!offered.some((sale) => String(sale.transactionId) === body.transactionRef)) throw notSuggested("The payment is not suggested for this order");
      return { action: "payment", transactionId: Number(body.transactionRef) };
    }
    case "unpay":
      return { action: "unpay", transactionId: Number(body.transactionRef) };
    case "given": {
      const offered = await deliveryCandidatesOf(app.db, order, 50);
      const found = offered.find((message) => message.messageRef === body.messageRef);
      if (found === undefined) throw notSuggested("The message is not suggested for this order");
      return { action: "given", messageRef: found.messageRef, at: found.at };
    }
    case "partly":
    case "revision":
      return { action: body.action, note: body.note };
    case "shot":
    case "close":
      return { action: body.action };
    case "refused":
      return { action: "refused", reason: body.reason };
    case "cancel":
      return { action: "cancel", reason: body.reason };
  }
}

/** `customOrderAct`: one step on the board, answered with the order after it. */
export async function actOnCustomOrder(
  app: CustomApp,
  principal: AuthPrincipal,
  input: { code: string; body: CustomOrderActionBody },
  now: Date = new Date(),
): Promise<CustomOrderDetailResponse> {
  requireSessionUser(principal);
  const viewer = await customViewerOf(app, principal);
  const order = await visibleOrder(app, viewer, input.code);
  if (!mayTakeStep(viewer, order, input.body.action as CustomOrderAction)) throw notAllowed();
  const step = await boardStep(app, viewer, order, input.body, now);
  await applyCustomStep(app, { orderId: order.id, step, actor: { door: "workboard", userId: principal.user.id }, viewer, now });
  return detailOf(app, viewer, (await findCustomOrder(app.db, order.id))!, now);
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
  requireSessionUser(principal);
  const viewer = await customViewerOf(app, principal);
  let pageId: number;
  let fanId: number | null = null;
  let conversationRef: string | null = null;
  let payment: number | null = null;
  if (body.transactionRef !== undefined) {
    const sale = await findCustomSale(app.db, Number(body.transactionRef));
    if (sale === null || !seesOrder(viewer, { pageId: sale.pageId })) throw new NotFoundError("The sale was not found");
    pageId = sale.pageId;
    fanId = sale.fanId;
    const offered = await paymentCandidatesOf(app.db, { pageId, fanId }, ["tip", "subscription"], now, 200);
    if (!offered.some((one) => one.transactionId === sale.transactionId)) throw notSuggested("The sale pays another order already");
    payment = sale.transactionId;
  } else {
    const page = await findPageSummaryByLabel(app.db, body.pageLabel!);
    if (!page || !seesOrder(viewer, { pageId: page.id })) throw new NotFoundError(`Page "${body.pageLabel}" was not found`);
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
    deadlineOn: null, acceptedByUserId: principal.user.id, origin: "workboard", paymentTransactionId: payment,
    telegramRefs: telegramRef === null ? [] : [telegramRef], actor: { door: "workboard", userId: principal.user.id }, now,
  });
  return detailOf(app, viewer, (await findCustomOrder(app.db, id))!, now);
}

/** `customSaleDismiss`: «Не кастом» — by the person who led the chat, the lead, a team lead of the page or the owner. */
export async function dismissCustomLookalike(app: CustomApp, principal: AuthPrincipal, transactionRef: string, now: Date = new Date()): Promise<{ dismissed: boolean }> {
  requireSessionUser(principal);
  const viewer = await customViewerOf(app, principal);
  const transactionId = Number(transactionRef);
  const rows = await listCustomLookalikeSales(app.db, { from: new Date(now.getTime() - 60 * DAY_MS), to: now, limit: 1000 });
  const row = lookalikesFor(viewer, rows).find((one) => one.transactionId === transactionId);
  if (row === undefined) throw new NotFoundError("The sale was not found");
  return { dismissed: await dismissCustomSale(app.db, { transactionId, userId: principal.user.id }) };
}
