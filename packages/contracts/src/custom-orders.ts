/**
 * Заказ кастома (ecosystem plan 2026-11-12, package I): one object from the
 * fan's chat to the fan's hands. It is born by Gengar's `/tz` (an agent key
 * with write:customs) or «Записать кастом» in the fan's panel (the existing
 * extension routes, served from these orders), the lead moves it on the board
 * «Кастомы» in Workboard, the reader of the models' groups writes what the model
 * did, a chatter marks «Отдали фану». Every door names the same order by its
 * code `K-<number>`, which the card text carries.
 */
import { z } from "zod";

import { intId, isoDateTime, isoTimestamp, mills } from "./primitives.ts";

export const CUSTOM_ORDER_STATES = [
  "recorded", "paid", "at_model", "partly", "shot", "revision", "refused", "given", "closed", "cancelled",
] as const;
export type CustomOrderState = (typeof CUSTOM_ORDER_STATES)[number];
/** Still in work: neither given to the fan nor ended. */
export const CUSTOM_ORDER_OPEN_STATES: readonly CustomOrderState[] = ["recorded", "paid", "at_model", "partly", "shot", "revision", "refused"];
/** Ended: nothing moves it any more but a person's «правка» after «отдали». */
export const CUSTOM_ORDER_FINAL_STATES: readonly CustomOrderState[] = ["closed", "cancelled"];

export const CUSTOM_ORDER_ORIGINS = ["extension", "agent", "workboard", "import"] as const;

/**
 * The matters the custom checks keep (apps/runtime services/custom-orders/checks.ts), Hub's server the one
 * writer of each: an agent key opens or closes none of them.
 */
export const CUSTOM_ORDER_CHECK_KINDS = [
  "custom.not_at_model", "custom.overdue", "custom.overdue_owner", "custom.shot_not_given", "custom.give_on_shift",
  "custom.unrecorded", "custom.card_without_order",
] as const;
export type CustomOrderCheckKind = (typeof CUSTOM_ORDER_CHECK_KINDS)[number];
const CHECK_KIND_SET: ReadonlySet<string> = new Set(CUSTOM_ORDER_CHECK_KINDS);
export function isCustomOrderCheckKind(kind: string): kind is CustomOrderCheckKind {
  return CHECK_KIND_SET.has(kind);
}

/** `K-<number>`: what a person says and types, never one of ContentOps' `CUS-217`. */
export const CUSTOM_ORDER_CODE_PATTERN = /^K-[1-9]\d{0,15}$/;
export function customOrderCode(id: number): string {
  return `K-${id}`;
}
/** The order's number from what a person typed: `K-123`, `к-123` (Cyrillic), `K123`, `#K-123`. Null — no code. */
export function parseCustomOrderCode(text: string): number | null {
  const match = /^#?\s*[KkКк]\s*-?\s*([1-9]\d{0,15})$/u.exec(text.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
export const customOrderCodeSchema = z.string().trim().min(2).max(24).refine((value) => parseCustomOrderCode(value) !== null, {
  message: "a custom order code is K-<number>",
});

/**
 * A Telegram message, in ContentOps' form `tg:<chat>/<topic>/<message>` (chat
 * without `-100`). Pasted links and the other spellings are read by
 * `parseTelegramRef` (packages/contracts/src/custom-orders.ts).
 */
export const TELEGRAM_REF_PATTERN = /^tg:[a-z0-9_]+\/[0-9]+(\/[0-9]+)?$/;

function normalChat(raw: string): string | null {
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) {
    const digits = value.replace(/^-/, "");
    return digits.length >= 13 && digits.startsWith("100") ? digits.slice(3) : digits;
  }
  const name = value.replace(/^@/, "").toLowerCase();
  return /^[a-z][a-z0-9_]{3,}$/.test(name) ? name : null;
}

/**
 * Any spelling of a Telegram message: `https://t.me/c/123/45/678`, `t.me/name/678`,
 * `tg:123/45/678`, `tg-123-45-678` (ContentOps' order address). Null — not a message link.
 */
export function parseTelegramRef(text: string): string | null {
  const value = text.trim();
  const parts = (chat: string, rest: string[]): string | null => {
    const normal = normalChat(chat);
    if (normal === null || rest.length < 1 || rest.length > 2 || rest.some((part) => !/^[1-9]\d{0,15}$/.test(part))) return null;
    return `tg:${normal}/${rest.join("/")}`;
  };
  const tg = /^tg:([^/\s]+)\/(\d+)(?:\/(\d+))?$/i.exec(value);
  if (tg) return parts(tg[1]!, [tg[2]!, tg[3]].filter((part): part is string => part !== undefined));
  const address = /^tg-([a-z0-9_]+)-(\d+)(?:-(\d+))?$/i.exec(value);
  if (address) return parts(address[1]!, [address[2]!, address[3]].filter((part): part is string => part !== undefined));
  const url = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([^?#\s]+)/i.exec(value);
  if (!url) return null;
  const path = url[1]!.replace(/\/+$/, "").split("/");
  if (path[0] === "c") return parts(path[1] ?? "", path.slice(2));
  return parts(path[0] ?? "", path.slice(1));
}
export const telegramRefInputSchema = z.string().trim().min(3).max(300).refine((value) => parseTelegramRef(value) !== null, {
  message: "a Telegram message link: https://t.me/c/<chat>/<topic>/<message> or tg:<chat>/<topic>/<message>",
});

const line = (max: number) => z.string().trim().min(1).max(max);
/**
 * The card «📦 Описание заказа» as the team writes it today, field by field: a
 * small document, every field optional (an empty one prints «-»).
 */
export const customOrderCardSchema = z.object({
  /** «Дата», as written on the card (an order of the system prints the day it was recorded). */
  date: line(40).optional(),
  /** «Имя: Tom (том)» — the name said in the video. */
  name: line(120).optional(),
  /** «Оплата»: the agreed price as the team writes it, «100$ тир Master + 50$», «100$ после готовности». */
  price: line(300).optional(),
  /** «Длительность»: «6 минут», «4 фото», «6-8 минут + 2 фото». */
  duration: line(200).optional(),
  /** «🎥 Описание задания» (a photo set: «📸»): the numbered steps, the phrases. */
  task: line(3000).optional(),
  /** «📸 Фото» of a video with photos. */
  photos: line(1000).optional(),
  /** «👗 Одежда». */
  clothes: line(1000).optional(),
  /** «🙈 Лицо». */
  face: line(200).optional(),
  /** «🗒 Заметки». */
  notes: line(1500).optional(),
  /** «🔥Срочность». */
  urgency: line(100).optional(),
  /** «⏳Сроки» when it is no date («Чем раньше тем лучше»); a date is the order's `deadlineOn`. */
  deadlineNote: line(200).optional(),
  /** Links of the references (files stay where they are). */
  attachments: z.array(z.string().trim().url().max(500)).max(20).optional(),
  /** Whether the video says the fan's name: yes (the card asks), no («без имени»), unknown (the card is silent). */
  nameInVideo: z.enum(["yes", "no", "unknown"]).optional(),
  /** What is ordered, for «сдан частично»: a video (absent — yes), and how many photos. */
  wantsVideo: z.boolean().optional(),
  wantsPhotos: z.number().int().min(0).max(500).optional(),
}).strict();
export type CustomOrderCard = z.infer<typeof customOrderCardSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const customOrderFanSchema = z.object({
  platform: z.string(),
  fanRef: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
});

/** One order as every session door reads it. */
export const customOrderSchema = z.object({
  id: intId,
  code: z.string(),
  /** Null — the page is not known (an imported order): «не подтверждено». */
  pageLabel: z.string().nullable(),
  platform: z.string().nullable(),
  model: z.string().nullable(),
  /** Null — the fan is not confirmed (`buyer` is what the card says) or was erased (`fanErased`). */
  fan: customOrderFanSchema.nullable(),
  buyer: z.string().nullable(),
  fanErased: z.boolean(),
  card: customOrderCardSchema,
  /** What, in one line (the task's first line). */
  what: z.string(),
  deadlineOn: day.nullable(),
  state: z.enum(CUSTOM_ORDER_STATES),
  stateAt: isoTimestamp,
  /** A refusal's reason; what a revision or a partial delivery is about. */
  stateNote: z.string().nullable(),
  /** The model's message the state comes from (`tg:…`). */
  stateRef: z.string().nullable(),
  /** The sum of the order's payments, as the hub shows money: gross and the page's net. */
  paidGrossMills: mills,
  paidNetMills: mills,
  payments: z.number().int().nonnegative(),
  givenAt: isoTimestamp.nullable(),
  givenMessageRef: z.string().nullable(),
  /** Who took the order (a login); null — imported. */
  acceptedBy: z.string().nullable(),
  /** The same person as the people registry names them; the login when the login has no person. */
  acceptedByName: z.string().nullable(),
  telegramRefs: z.array(z.string()),
  contentopsRef: z.string().nullable(),
  origin: z.enum(CUSTOM_ORDER_ORIGINS),
  /** Days past the deadline while the model has not delivered it whole; null — not overdue. */
  overdueDays: z.number().int().positive().nullable(),
  /** The parts the model delivered whole. */
  partsDone: z.array(z.enum(["video", "photos"])),
  /** Revision requests not fixed yet. */
  openRevisions: z.number().int().nonnegative(),
  /** Grows with every change; an agent's edit names the one it read. */
  version: z.number().int().positive(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type CustomOrder = z.infer<typeof customOrderSchema>;

export const CUSTOM_ORDER_MESSAGE_KINDS = ["repost", "delivery", "revision", "confirmation", "note"] as const;
/**
 * A significant message of the order: a Telegram message the reader of the models' groups records (known by its
 * link and ordinal), or an event of a sender with its own id of it (ContentOps' delivery, known by `eventRef`).
 */
export const customOrderMessageSchema = z.object({
  /** The Telegram message: what the row is known by, or the evidence of an event; null — an event with no message. */
  telegramRef: z.string().nullable(),
  /** The sender's own id of the event (`contentops:delivery:<id>`); null — a Telegram message of the groups. */
  eventRef: z.string().nullable(),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(CUSTOM_ORDER_MESSAGE_KINDS),
  part: z.enum(["video", "photos"]).nullable(),
  /** A delivery: that part is whole now; null — not said (an older delivery). */
  complete: z.boolean().nullable(),
  at: isoTimestamp.nullable(),
  author: z.string().nullable(),
  excerpt: z.string().nullable(),
  /** A revision request: when it was fixed. */
  doneAt: isoTimestamp.nullable(),
  /** A delivery taken back (a retraction): its part no longer counts. */
  retractedAt: isoTimestamp.nullable(),
});

/**
 * An event's own id, as its sender keeps it: `<sender>:<kind>:<id>` (`contentops:delivery:7d0c…`), unique per
 * order. Never a Telegram link: a link is the event's evidence (`message.telegramRef`).
 */
export const CUSTOM_ORDER_EVENT_REF_PATTERN = /^[a-z][a-z0-9_]*:[A-Za-z0-9._:-]{1,200}$/;
export const customOrderEventRefSchema = z.string().trim().min(3).max(200).regex(CUSTOM_ORDER_EVENT_REF_PATTERN)
  .refine((value) => !value.startsWith("tg:"), { message: "an event ref is the sender's own id; a Telegram link goes into message.telegramRef" });

/** A sale that looks like a custom with no order: a tier that includes one, or a tip whose note says so. */
export const customLookalikeSaleSchema = z.object({
  transactionRef: z.string(),
  pageLabel: z.string(),
  fan: customOrderFanSchema.nullable(),
  kind: z.enum(["tier", "tip_note"]),
  /** The tier's name, or the tip's note. */
  detail: z.string().nullable(),
  grossMills: mills,
  at: isoTimestamp,
});

export const CUSTOM_ORDER_ACTIONS = [
  "edit", "deadline", "fan", "card", "payment", "unpay", "at_model", "partly", "shot", "revision", "refused", "given", "close", "cancel",
] as const;
export type CustomOrderAction = (typeof CUSTOM_ORDER_ACTIONS)[number];

export const customOrdersBoardQuerySchema = z.object({
  /** One page's orders (an order of no known page shows on every page for the people who see it). */
  pageLabel: z.string().trim().min(1).max(120).optional(),
}).strict();

export const customOrdersBoardResponseSchema = z.object({
  viewer: z.object({
    /** «Ведёт кастомы»: the lead's steps on every order. The owner has them too. */
    lead: z.boolean(),
    owner: z.boolean(),
  }),
  /** Who leads customs (the people with the right, by their registry name), for the board's header. */
  leads: z.array(z.string()),
  /** Open orders, and the given and closed of the last 7 days, the oldest step first. */
  orders: z.array(customOrderSchema),
  capped: z.boolean(),
  /** Sales that look like a custom with no order (the viewer's chats; the lead and the owner every page's). */
  lookalikes: z.array(customLookalikeSaleSchema),
  serverNow: isoTimestamp,
});

export const customOrderParamsSchema = z.object({ code: customOrderCodeSchema });

export const customOrderPaymentSchema = z.object({
  transactionRef: z.string(),
  /** tip | subscription | message_purchase | … (the transaction's kind). */
  kind: z.string(),
  grossMills: mills,
  netMills: mills,
  at: isoTimestamp,
  /** The fan's note with a tip. */
  note: z.string().nullable(),
});

export const customOrderHistoryItemSchema = z.object({
  at: isoTimestamp,
  event: z.string(),
  /** A person's registry name (else the login) or an agent key's name; null — the system. */
  actor: z.string().nullable(),
  onBehalfOf: z.string().nullable(),
  door: z.string(),
  changes: z.record(z.string(), z.unknown()),
});

export const customOrderDetailResponseSchema = z.object({
  order: customOrderSchema,
  /** «Скопировать карточку»: the card in the exact text of today's card, with the code. */
  cardText: z.string(),
  /** The card's whole text as it was posted in Telegram, when the order came from a posted card. */
  sourceText: z.string().nullable(),
  /** The order's messages in the models' groups: deliveries, revision requests, notes. */
  messages: z.array(customOrderMessageSchema),
  payments: z.array(customOrderPaymentSchema),
  /** «Это оплата?»: the fan's tips and subscriptions on the page in 30 days that no order took. */
  paymentSuggestions: z.array(customOrderPaymentSchema),
  /** «Отдали фану: это он?»: media the page sent in the fan's chat since the payment (or the record). */
  deliverySuggestions: z.array(z.object({
    messageRef: z.string(),
    at: isoTimestamp,
    mediaCount: z.number().int().nonnegative(),
    priceMills: mills.nullable(),
  })),
  history: z.array(customOrderHistoryItemSchema),
  /** What the viewer may do with the order now. */
  actions: z.array(z.enum(CUSTOM_ORDER_ACTIONS)),
  serverNow: isoTimestamp,
});

const note = z.string().trim().min(1).max(500);
const ref = z.string().trim().min(1).max(64).regex(/^[1-9]\d{0,29}$/);
/** A fan as a person gives it: a profile link, a username, or the platform's number. */
const fanInput = z.string().trim().min(1).max(300);

export const customOrderActionBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), card: customOrderCardSchema }).strict(),
  z.object({ action: z.literal("deadline"), deadlineOn: day.nullable() }).strict(),
  z.object({ action: z.literal("fan"), pageLabel: z.string().trim().min(1).max(120), fan: fanInput }).strict(),
  z.object({ action: z.literal("card"), telegramRef: telegramRefInputSchema }).strict(),
  z.object({ action: z.literal("payment"), transactionRef: ref }).strict(),
  z.object({ action: z.literal("unpay"), transactionRef: ref }).strict(),
  z.object({ action: z.literal("at_model"), telegramRef: telegramRefInputSchema.optional() }).strict(),
  z.object({ action: z.literal("partly"), note: note.optional() }).strict(),
  z.object({ action: z.literal("shot") }).strict(),
  z.object({ action: z.literal("revision"), note: note.optional() }).strict(),
  z.object({ action: z.literal("refused"), reason: note }).strict(),
  z.object({ action: z.literal("given"), messageRef: ref }).strict(),
  z.object({ action: z.literal("close") }).strict(),
  z.object({ action: z.literal("cancel"), reason: note.optional() }).strict(),
]);
export type CustomOrderActionBody = z.infer<typeof customOrderActionBodySchema>;

/** «Записать кастом» on the board: from a sale that looks like a custom (its page and fan), or on a page for a fan. */
export const customOrderCreateBodySchema = z.object({
  transactionRef: ref.optional(),
  pageLabel: z.string().trim().min(1).max(120).optional(),
  fan: fanInput.optional(),
  card: customOrderCardSchema,
  telegramRef: telegramRefInputSchema.optional(),
}).strict().refine((body) => body.transactionRef !== undefined || body.pageLabel !== undefined, {
  message: "a sale, or a page", path: ["pageLabel"],
});

export const customSaleParamsSchema = z.object({ transactionRef: ref });
export const customSaleDismissResponseSchema = z.object({ dismissed: z.boolean() });

// ── The agent's door (write:customs) ────────────────────────────────────────

/** An order as an agent key reads it: no money but the card's own price line. */
export const agentCustomOrderSchema = customOrderSchema.omit({ paidGrossMills: true, paidNetMills: true }).extend({
  /** The card's text with the code, as «Скопировать карточку» gives it. */
  cardText: z.string(),
  sourceText: z.string().nullable(),
  messages: z.array(customOrderMessageSchema),
});

export const agentCustomOrdersQuerySchema = z.object({
  /** open (default): not given and not ended; all: the last 200 of every state. */
  state: z.enum(["open", "all"]).default("open"),
  code: customOrderCodeSchema.optional(),
  telegramRef: telegramRefInputSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();

export const agentCustomOrdersResponseSchema = z.object({
  orders: z.array(agentCustomOrderSchema),
  serverNow: isoTimestamp,
});

const login = z.string().trim().min(1).max(64);

export const agentCustomOrderCreateBodySchema = z.object({
  /** The fan's page, of the key's grant; absent — not known yet. */
  pageLabel: z.string().trim().min(1).max(120).optional(),
  /** The fan: a profile link, a username or the platform's number; unmatched it stays the buyer's string. */
  fan: fanInput.optional(),
  /** The chatter who took the order (their login). */
  acceptedBy: login.optional(),
  card: customOrderCardSchema,
  deadlineOn: day.optional(),
  /** The card's message in Telegram, when it is already posted. */
  telegramRef: telegramRefInputSchema.optional(),
  /** When the card was posted and by whom (its Telegram name): the order counts from then. */
  postedAt: isoDateTime({ offset: true }).optional(),
  author: z.string().trim().min(1).max(120).optional(),
  /** The card's whole text as posted, without Markdown. */
  sourceText: z.string().trim().min(1).max(8000).optional(),
  /**
   * One more order for a fan who has an open one on the page: without it such a create is refused (409
   * `open_orders`, the open orders named) — the custom is most likely one of them.
   */
  another: z.boolean().optional(),
  /** The person on whose word the agent writes (their login). */
  onBehalfOf: login.optional(),
}).strict();

/**
 * A message of the order in Telegram: its link, when, who, a short verbatim excerpt (not a copy of the chat). The
 * link is the step's identity; a step with `eventRef` is known by that, and the link (optional then) is its evidence.
 */
const agentMessageSchema = z.object({
  telegramRef: telegramRefInputSchema.optional(),
  at: isoDateTime({ offset: true }).optional(),
  author: z.string().trim().min(1).max(120).optional(),
  excerpt: z.string().trim().min(1).max(500).optional(),
}).strict();

/** Only the fields that changed: a value sets it, `null` empties it, an absent key stays as it is. */
export type CustomOrderCardPatch = { [K in keyof CustomOrderCard]?: Exclude<CustomOrderCard[K], undefined> | null };
const cardPatchSchema = z.object(Object.fromEntries(
  Object.entries(customOrderCardSchema.shape).map(([key, field]) => [key, (field as z.ZodOptional<z.ZodType>).unwrap().nullable().optional()]),
)).strict() as unknown as z.ZodType<CustomOrderCardPatch>;

export const agentCustomOrderUpdateBodySchema = z.discriminatedUnion("action", [
  /**
   * «Держи обновлённую», or what the reader found changed on the card: only the fields given. With `ifVersion`
   * the edit is refused (409 `version_changed`) when the order changed since that version; a field a person edited
   * is never overwritten (409 `edited_by_person`, the fields named).
   */
  z.object({
    action: z.literal("edit"), card: cardPatchSchema, deadlineOn: day.nullable().optional(),
    sourceText: z.string().trim().min(1).max(8000).optional(), ifVersion: z.number().int().positive().optional(), onBehalfOf: login.optional(),
  }).strict(),
  /** The card reached the model's group (its copy there, if any). */
  z.object({ action: z.literal("at_model"), telegramRef: telegramRefInputSchema.optional(), onBehalfOf: login.optional() }).strict(),
  /**
   * The model delivered (a file, an album, the line «6-08 го хард.mov»): the message is kept with its excerpt;
   * `complete` — that part is whole now. Every wanted part whole — shot; else partly. While a revision is open
   * the order stays «правка» until a delivery with `complete` answers it (it closes the open requests).
   * `eventRef` — the sender's own id of the delivery (ContentOps'): known by it, the link then optional evidence.
   */
  z.object({
    action: z.literal("delivery"), eventRef: customOrderEventRefSchema.optional(), message: agentMessageSchema,
    part: z.enum(["video", "photos"]).optional(), complete: z.boolean().default(true), onBehalfOf: login.optional(),
  }).strict(),
  z.object({ action: z.literal("partly"), ref: telegramRefInputSchema, note: note.optional(), onBehalfOf: login.optional() }).strict(),
  /** Every part is whole: «снят». Open revision requests are fixed by it. */
  z.object({ action: z.literal("shot"), ref: telegramRefInputSchema, onBehalfOf: login.optional() }).strict(),
  /** A revision request (several in one message: `ordinal` 1, 2…); a repeat changes nothing. */
  z.object({
    action: z.literal("revision"), eventRef: customOrderEventRefSchema.optional(), message: agentMessageSchema,
    ordinal: z.number().int().min(0).max(50).default(0), text: note, onBehalfOf: login.optional(),
  }).strict(),
  /** A revision request is fixed (a new version came and the reader or a person saw it): by its link and ordinal, or its eventRef. */
  z.object({
    action: z.literal("revision_done"), telegramRef: telegramRefInputSchema.optional(), eventRef: customOrderEventRefSchema.optional(),
    ordinal: z.number().int().min(0).max(50).default(0), onBehalfOf: login.optional(),
  }).strict(),
  /**
   * A delivery taken back (ContentOps «это другой заказ»): `retracts` names it — its eventRef, or the Telegram link
   * of the message it came with (every delivery of that message). Its part stops counting and the state follows the
   * parts that stay. The retraction is an event of its own (`eventRef`); `message` — its evidence and author.
   */
  z.object({
    action: z.literal("retract"), eventRef: customOrderEventRefSchema,
    retracts: z.string().trim().min(3).max(300).refine((value) => parseTelegramRef(value) !== null || CUSTOM_ORDER_EVENT_REF_PATTERN.test(value), {
      message: "the delivery's eventRef, or the Telegram link of its message",
    }),
    reason: note,
    message: agentMessageSchema.optional(), onBehalfOf: login.optional(),
  }).strict(),
  z.object({ action: z.literal("refused"), ref: telegramRefInputSchema, reason: note, onBehalfOf: login.optional() }).strict(),
  /** A return, the fan's refusal, a duplicate card. */
  z.object({ action: z.literal("cancel"), reason: note, onBehalfOf: login.optional() }).strict(),
  /** Another message of the order: a repost of the card (it becomes the order's card too), a confirmation, a note. */
  z.object({
    action: z.literal("message"), kind: z.enum(["repost", "confirmation", "note"]), eventRef: customOrderEventRefSchema.optional(),
    message: agentMessageSchema, onBehalfOf: login.optional(),
  }).strict(),
  /** Attach a Telegram card (a copy in another chat) to the order. */
  z.object({ action: z.literal("card"), telegramRef: telegramRefInputSchema, onBehalfOf: login.optional() }).strict(),
]).superRefine((body, context) => {
  // A message step is known by its Telegram link, or by the sender's own eventRef; a repost is a card, so a link.
  if ((body.action === "delivery" || body.action === "revision" || body.action === "message") && body.message.telegramRef === undefined
    && (body.eventRef === undefined || (body.action === "message" && body.kind === "repost"))) {
    context.addIssue({ code: "custom", path: ["message", "telegramRef"], message: "the message's Telegram link, or the step's eventRef (a repost: the link)" });
  }
  if (body.action === "revision_done" && (body.telegramRef === undefined) === (body.eventRef === undefined)) {
    context.addIssue({ code: "custom", path: ["telegramRef"], message: "the revision's Telegram link, or its eventRef: one of them" });
  }
});

/** The event a message step names, and what the hub did with it. */
export const agentCustomOrderEventSchema = z.object({
  /** The step's eventRef, else its Telegram link (as the hub writes it, `tg:…`). */
  ref: z.string(),
  /** stored — kept now; already — the hub had this very event (the same ref and kind) before. */
  result: z.enum(["stored", "already"]),
});

export const agentCustomOrderResponseSchema = z.object({
  order: agentCustomOrderSchema,
  /** What the call did: created, changed, or nothing (the same again). */
  outcome: z.enum(["created", "changed", "unchanged"]),
  /**
   * A message step (delivery, revision, message, retract): the event the hub keeps for it. Null — the hub kept no
   * such event (its link holds another kind of message, or the order's state takes no such step), and every other
   * step. A sender that must know its event is in the hub checks this, not the status.
   */
  event: agentCustomOrderEventSchema.nullable(),
});

/** The reader of the models' groups: the cards it found that no order has, for the lead. */
export const agentCustomCardsBodySchema = z.object({
  cards: z.array(z.object({
    telegramRef: telegramRefInputSchema,
    /** When the card was posted. */
    postedAt: isoTimestamp.optional(),
    /** Where: «<the model's group> / Customs». */
    where: z.string().trim().min(1).max(120).optional(),
  }).strict()).max(500),
  /** The list is every unmatched card the reader sees now: the ones not in it are gone (their matters close). */
  complete: z.boolean().default(false),
}).strict();

export const agentCustomCardsResponseSchema = z.object({
  /** The cards that do belong to an order: no matter for them. */
  matched: z.array(z.object({ telegramRef: z.string(), code: z.string() })),
  opened: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});

export type CustomOrdersBoardResponse = z.infer<typeof customOrdersBoardResponseSchema>;
export type CustomOrderDetailResponse = z.infer<typeof customOrderDetailResponseSchema>;
export type CustomOrderCreateBody = z.infer<typeof customOrderCreateBodySchema>;
export type CustomLookalikeSale = z.infer<typeof customLookalikeSaleSchema>;
export type CustomOrderPayment = z.infer<typeof customOrderPaymentSchema>;
export type CustomOrderMessage = z.infer<typeof customOrderMessageSchema>;
export type AgentCustomOrder = z.infer<typeof agentCustomOrderSchema>;
export type AgentCustomOrdersQuery = z.infer<typeof agentCustomOrdersQuerySchema>;
export type AgentCustomOrderCreateBody = z.infer<typeof agentCustomOrderCreateBodySchema>;
export type AgentCustomOrderUpdateBody = z.infer<typeof agentCustomOrderUpdateBodySchema>;
export type AgentCustomCardsBody = z.infer<typeof agentCustomCardsBodySchema>;
