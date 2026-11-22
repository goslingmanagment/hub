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

import { agentSaleRequestSchema } from "./agent-doors.ts";
import { intId, isoDateTime, isoTimestamp, mills } from "./primitives.ts";

/**
 * The states. `checked` («Проверен», products plan §4.5, package C3): the team's customs lead (with a team lead — the
 * lead) checked the card and gave it to shooting; the content side (ContentOps «Съёмка») takes it from there.
 */
export const CUSTOM_ORDER_STATES = [
  "recorded", "paid", "checked", "at_model", "partly", "shot", "revision", "refused", "given", "closed", "cancelled",
] as const;
export type CustomOrderState = (typeof CUSTOM_ORDER_STATES)[number];

export const CUSTOM_ORDER_ORIGINS = ["extension", "agent", "workboard", "import"] as const;

/**
 * The matters the custom checks keep (apps/runtime services/custom-orders/checks.ts), Hub's server the one
 * writer of each: an agent key opens or closes none of them.
 */
export const CUSTOM_ORDER_CHECK_KINDS = [
  "custom.not_at_model", "custom.checked_not_at_model", "custom.overdue", "custom.overdue_owner", "custom.shot_not_given", "custom.give_on_shift",
  "custom.unrecorded", "custom.card_without_order",
  // Behind the switch `customsFacts` (customs facts spec C1, C3): the owner's line of the paid cards two days not at the
  // model; a custom with no order (`custom_findings`) a day open, for the check's leader; the owner's line of those three
  // days open. `custom.unrecorded` and `custom.card_without_order` are retired into findings when the switch goes on.
  "custom.not_at_model_owner", "custom.finding", "custom.findings_owner",
] as const;
export type CustomOrderCheckKind = (typeof CUSTOM_ORDER_CHECK_KINDS)[number];
const CHECK_KIND_SET: ReadonlySet<string> = new Set(CUSTOM_ORDER_CHECK_KINDS);
export function isCustomOrderCheckKind(kind: string): kind is CustomOrderCheckKind {
  return CHECK_KIND_SET.has(kind);
}

/** `K-<number>`: what a person says and types, never one of ContentOps' `CUS-217`. */
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
/**
 * The order's number from a code somewhere in a line of text (a card's title «📦 Описание заказа К-123»): the Latin
 * or the Cyrillic letter, as a Russian keyboard types it, with its hyphen or right before the number. Null — the
 * line holds no code. A code is always printed with the Latin letter (`customOrderCode`).
 */
export function findCustomOrderCode(text: string): number | null {
  const match = /(?:^|[^\p{L}\p{N}])[KkКк](?:\s*-\s*)?([1-9]\d{0,15})(?!\d)/u.exec(text);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
export const customOrderCodeSchema = z.string().trim().min(2).max(24).refine((value) => parseCustomOrderCode(value) !== null, {
  message: "a custom order code is K-<number>",
});

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

/**
 * A fact of an order (customs facts spec §4): `yes` — proven; `part` — partly (some money, some parts, sent and not
 * opened); `no` — not yet; `wait` — not yet, and it is the next move; `conflict` — the sources contradict it (a
 * reversed sale, a refusal); `unknown` — Hub cannot tell.
 */
export const CUSTOM_FACT_VALUES = ["yes", "part", "no", "wait", "conflict", "unknown"] as const;
export type CustomFactValue = (typeof CUSTOM_FACT_VALUES)[number];
export const customFactSchema = z.object({
  value: z.enum(CUSTOM_FACT_VALUES),
  /** What the value rests on, in people's words («получено $50 из $150»); absent — the value says it all. */
  note: z.string().optional(),
});
export type CustomFact = z.infer<typeof customFactSchema>;

/**
 * The four facts of an order, derived at read time from its row and its payments by one pure function
 * (custom-order-rules.ts, `customOrderFactsOf`), never stored: the fan's money arrived (`paid`), the model has the
 * card (`atModel`), the model delivered everything (`shot`), the fan received every file (`given`).
 */
export const customOrderFactsSchema = z.object({
  paid: customFactSchema,
  atModel: customFactSchema,
  shot: customFactSchema,
  given: customFactSchema,
});
export type CustomOrderFacts = z.infer<typeof customOrderFactsSchema>;

/** The owner's word on an order's payment: shot without payment (`gift`), or paid outside the platform (`off_platform`). */
export const CUSTOM_PAID_WORD_KINDS = ["gift", "off_platform"] as const;
export type CustomPaidWordKind = (typeof CUSTOM_PAID_WORD_KINDS)[number];
export const customPaidWordSchema = z.object({
  kind: z.enum(CUSTOM_PAID_WORD_KINDS),
  note: z.string().nullable(),
  /** Who said it, as the people registry named them then; null — not known. */
  by: z.string().nullable(),
  at: isoTimestamp,
});
export type CustomPaidWord = z.infer<typeof customPaidWordSchema>;

/** The sources disagree about the order: one sentence (≤ 200), who wrote it and when. The order burns while it stands. */
export const customOrderIssueSchema = z.object({
  text: z.string(),
  by: z.string().nullable(),
  at: isoTimestamp,
});
export type CustomOrderIssue = z.infer<typeof customOrderIssueSchema>;

/**
 * Whose move an order waits for (customs facts spec §4; the one rule, services/custom-orders/leaders.ts, so the board
 * and the matters never disagree): `person` — a person by name (the content manager, the acceptor, the check's
 * leader); `shift` — whoever is on shift on the fan's page now; `model` — the model shoots; `fan` — the fan has to open
 * what was sent; `owner` — the owner decides (a hold, a refusal, a reversed payment); `none` — nobody is named.
 */
export const CUSTOM_MOVE_WHO_KINDS = ["person", "shift", "model", "fan", "owner", "none"] as const;
export type CustomMoveWhoKind = (typeof CUSTOM_MOVE_WHO_KINDS)[number];
export const customOrderMoveSchema = z.object({
  /** The person's, the model's or the fan's name; null — the owner, or nobody named. */
  who: z.string().nullable(),
  whoKind: z.enum(CUSTOM_MOVE_WHO_KINDS),
  /** What to do, in people's words: «передать модели», «отдать фану». */
  what: z.string(),
});
export type CustomOrderMove = z.infer<typeof customOrderMoveSchema>;

/** The forwarding timer (customs facts spec C3): money linked or the owner's word, the card not at the model. */
export const CUSTOM_TIMER_LEVELS = ["amber", "red"] as const;
export type CustomTimerLevel = (typeof CUSTOM_TIMER_LEVELS)[number];
export const customOrderTimerSchema = z.object({
  kind: z.literal("forwarding"),
  /** amber after 24 h, red after 48 h; under 24 h there is no timer. */
  level: z.enum(CUSTOM_TIMER_LEVELS),
  /** Since when the paid card waits for the model: the later of the record and the first sale (or the owner's word). */
  since: isoTimestamp,
});
export type CustomOrderTimer = z.infer<typeof customOrderTimerSchema>;

/** One order as every session door reads it. */
export const customOrderSchema = z.object({
  id: intId,
  code: z.string(),
  /** Null — the page is not known (an imported order): «не подтверждено». */
  pageLabel: z.string().nullable(),
  platform: z.string().nullable(),
  model: z.string().nullable(),
  /** The model's slug (ContentOps' address of the model: «Съёмка в ContentOps»); null — the page is not known. */
  modelSlug: z.string().nullable(),
  /** Null — the fan is not confirmed (`buyer` is what the card says) or was erased (`fanErased`). */
  fan: customOrderFanSchema.nullable(),
  buyer: z.string().nullable(),
  fanErased: z.boolean(),
  card: customOrderCardSchema,
  /** What, in one line (the task's first line). */
  what: z.string(),
  deadlineOn: day.nullable(),
  state: z.enum(CUSTOM_ORDER_STATES),
  /** The state in people's words (`CUSTOM_STATE_WORDS`): every door shows the same word. */
  stateWord: z.string(),
  /**
   * «У кого сейчас»: who leads the order's current step (products plan §4.5, one rule — services/custom-orders/
   * leaders.ts) and where it is done; null — an ended order. `name` null — the owner (nobody leads it).
   */
  leader: z.object({
    name: z.string().nullable(),
    /** The step's side: the chat's (`check`, `give`) is Workboard's, the shooting is ContentOps'. */
    phase: z.enum(["check", "shoot", "give"]),
    product: z.enum(["workboard", "contentops"]),
  }).nullable(),
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
  /**
   * Moscow days from today to the deadline, in every state before «отдан» (0 — today, negative — past it); null — no
   * deadline, or the order is given or ended. Unlike `overdueDays`, a shot order still counts until the fan has it.
   */
  dueLeftDays: z.number().int().nullable(),
  /** The deadline was set by the system, «примерно» (recorded or first paid + 7 days); a later edit clears it. */
  deadlineDefault: z.boolean(),
  /** The four facts (`customOrderFactsOf`): paid, at the model, shot, given. */
  facts: customOrderFactsSchema,
  /** The agreed total, gross; null — not named (`facts.paid` is then never «yes» by the money). */
  priceMills: mills.nullable(),
  /** The owner's word on the payment: a gift, or paid outside the platform. */
  paidWord: customPaidWordSchema.nullable(),
  /** Why the order waits on purpose (the fan is unreachable, a prop is awaited): it does not burn. */
  holdReason: z.string().nullable(),
  /** The sources disagree about the order: the agent's one sentence. */
  issue: customOrderIssueSchema.nullable(),
  /** When the fan asked where the order is; null — he did not, or the page wrote to him since. */
  fanAskedAt: isoTimestamp.nullable(),
  /** Every file was sent to the fan and a priced one is not bought yet («отправлен, фан не открыл»): since when. */
  sentAt: isoTimestamp.nullable(),
  /** Whose move it is now (`customMoveOf`, leaders.ts); null — nobody's: given and waiting, closed, cancelled. */
  move: customOrderMoveSchema.nullable(),
  /**
   * It burns (customs facts spec §7): more than one full day past the deadline, shot and nothing sent for 12 h, the
   * fan asked where it is, a fact in conflict, an issue. Never on hold. Derived at read time (`customOrderUrgencyOf`).
   */
  burning: z.boolean(),
  /** Why it burns or what it waits for, one Russian line; null — nothing to say (an ended order). */
  reason: z.string().nullable(),
  /** The forwarding timer (C3); null — none runs, or under 24 h. */
  timer: customOrderTimerSchema.nullable(),
  /**
   * The parts ready in the current round: delivered whole after the last revision request about them (a delivery
   * that was sent back for revision does not count), or said whole by a person («снят»). The wanted parts not
   * here are what the order still waits for (`waitedParts`).
   */
  partsDone: z.array(z.enum(["video", "photos"])),
  /** Revision requests not fixed yet: «правка» while there is one. */
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
  /**
   * The sender's own id of the event (`contentops:delivery:<id>`; a person's «Правка» on the board is named by the
   * hub, `workboard:revision:<n>`); null — a Telegram message of the groups.
   */
  eventRef: z.string().nullable(),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(CUSTOM_ORDER_MESSAGE_KINDS),
  /** A delivery: its part. A revision request: the part it is about; null — the whole order. */
  part: z.enum(["video", "photos"]).nullable(),
  /** A delivery: that part is whole now; null — not said (an older delivery). */
  complete: z.boolean().nullable(),
  /** The message's own time (null — not given: the hub counts it from when it kept it). */
  at: isoTimestamp.nullable(),
  author: z.string().nullable(),
  excerpt: z.string().nullable(),
  /**
   * A revision request: when it was fixed — every part it is about came whole after it, or a word («снят», the
   * reader's «исправлено»). Null — open; open again when the delivery that had answered it is taken back.
   */
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

/**
 * The board's steps. Besides the path: `ungive` takes «отдан» back (the order is «снят» again), `retract` takes a
 * delivery back (the shooting's leader), `hold` / `unhold` the order's wait on purpose, `issue_clear` the agent's
 * sentence of a disagreement, `paid_word` the owner's word on the payment, `fan_asked_clear` the fan's «where is it»
 * answered (customs facts spec §6, §7, §9, §10).
 */
export const CUSTOM_ORDER_ACTIONS = [
  "edit", "deadline", "fan", "card", "payment", "unpay", "checked", "at_model", "partly", "shot", "revision", "refused", "given", "ungive",
  "retract", "close", "cancel", "hold", "unhold", "issue_clear", "paid_word", "fan_asked_clear",
] as const;
export type CustomOrderAction = (typeof CUSTOM_ORDER_ACTIONS)[number];

export const customOrdersBoardQuerySchema = z.object({
  /** One page's orders (an order of no known page shows on every page for the people who see it). */
  pageLabel: z.string().trim().min(1).max(120).optional(),
}).strict();

/**
 * An order on the board's lists: the order without its card document while the facts screen is on (`factsOn`: the
 * order's page has it), with the card's volume line alone; with the switch off, the card as before.
 */
export const customBoardOrderSchema = customOrderSchema.omit({ card: true }).extend({
  card: customOrderCardSchema.optional(),
  /** The card's «Длительность» («6 минут», «10 фото»); null — the card names none. */
  volume: z.string().nullable(),
});
export type CustomBoardOrder = z.infer<typeof customBoardOrderSchema>;

/**
 * How a person takes back a step the system or an agent took (customs facts spec §10): the sale off the order, «отдан»
 * off it, the delivery taken back (with a reason the person gives), the deadline back to what it was. Sent as the
 * board's step with `undoOf` — the history event it takes back.
 */
export const customUndoSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("unpay"), transactionRef: z.string() }),
  /** The mark it takes back: refused when «отдан» is another message's by then. */
  z.object({ action: z.literal("ungive"), messageRef: z.string() }),
  z.object({ action: z.literal("retract"), retracts: z.string() }),
  z.object({ action: z.literal("deadline"), deadlineOn: day.nullable() }),
]);
export type CustomUndo = z.infer<typeof customUndoSchema>;

/** A step of an order that came through the system's or an agent's door: «изменилось само». */
export const customSelfChangeSchema = z.object({
  /** The history event's id (`undoOf` of its undo). */
  id: intId,
  at: isoTimestamp,
  code: z.string(),
  /** The order's fan as the board names him (or the card's buyer); null — not known, or erased. */
  fan: z.string().nullable(),
  event: z.string(),
  /** system | api. */
  door: z.string(),
  /** An agent key's name; null — Hub itself. */
  actor: z.string().nullable(),
  changes: z.record(z.string(), z.unknown()),
  /** The viewer may take it back, so; null — not theirs to undo, or nothing to undo any more. */
  undo: customUndoSchema.nullable(),
});
export type CustomSelfChange = z.infer<typeof customSelfChangeSchema>;

/**
 * When the reader and the nightly pass last checked the sources (spec §9, «Система → Состояние»): `readerStale` — the
 * 30-minute reader is late.
 */
export const customVerifiedSchema = z.object({
  readerAt: isoTimestamp.nullable(),
  nightlyAt: isoTimestamp.nullable(),
  readerStale: z.boolean(),
});

export const customOrdersBoardResponseSchema = z.object({
  viewer: z.object({
    /** «Ведёт кастомы»: the lead's steps on every order. The owner has them too. */
    lead: z.boolean(),
    owner: z.boolean(),
    /** The viewer as the people registry names them (the login without a person): «Только мой ход» compares `move.who`. */
    name: z.string().nullable(),
  }),
  /**
   * Who leads customs, for the board's header: per model of the pages the viewer sees (of the viewer's realm only), by
   * the one rule (services/custom-orders/leaders.ts) — the check (Workboard) and the shooting (ContentOps). A name null
   * — nobody leads it: the owner.
   */
  leads: z.array(z.object({ model: z.string(), check: z.string().nullable(), shoot: z.string().nullable() })),
  /**
   * The facts screen is on (the live switch `customsFacts`): `orders` are the live orders alone, without their card;
   * the given and closed are read by `customOrdersDone`. Off: the open orders and the given and closed of the last 7
   * days, with their card, as before.
   */
  factsOn: z.boolean(),
  /** The oldest step first. */
  orders: z.array(customBoardOrderSchema),
  capped: z.boolean(),
  /** Sales that look like a custom with no order (the viewer's chats; the lead and the owner every page's). Empty while `factsOn`: the findings are. */
  lookalikes: z.array(customLookalikeSaleSchema),
  /**
   * How fresh the board is (customs facts spec §9), from «Система → Состояние»: the last good pass of the reader
   * (`customs-reader`, every 30 minutes) and of the nightly reconciliation (`customs-nightly`); null — never. `readerStale`
   * — the reader is past twice its period and ten minutes (the system state's own rule for «молчит»), or never ran.
   */
  verified: customVerifiedSchema,
  /**
   * The open findings the viewer resolves (`customFindingsList`): how many, their money, the first fans' names; and how
   * many of the last two weeks an agent dismissed as «не кастом» (a person may bring one back). Zero while the switch is
   * off.
   */
  findings: z.object({
    open: z.number().int().nonnegative(), amountMills: mills, fans: z.array(z.string()), agentDismissed: z.number().int().nonnegative(),
  }),
  /** The last 24 hours' steps by the system's or an agent's door on the viewer's orders (`customOrderChanges`): how many, the newest. */
  changes: z.object({ count: z.number().int().nonnegative(), newest: customSelfChangeSchema.nullable() }),
  /** How many are given and wait for the fan's word, and closed in the last 30 days (`customOrdersDone`); zero while off. */
  done: z.object({ given: z.number().int().nonnegative(), closed: z.number().int().nonnegative() }),
  serverNow: isoTimestamp,
});

/** «Отдано, ждём слово фана» and «Закрыто за месяц»: the orders given and not closed, and closed in the last `days`. */
export const customOrdersDoneQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
}).strict();

export const customOrdersDoneResponseSchema = z.object({
  /** Given, waiting for the fan's word (it closes by itself 72 h after the mark), the newest first. */
  given: z.array(customBoardOrderSchema),
  /** Closed in the last `days`, the newest first. */
  closed: z.array(customBoardOrderSchema),
  capped: z.boolean(),
  serverNow: isoTimestamp,
});

/** «За сутки изменилось само»: the last 24 hours' steps of the system's and the agents' doors on the viewer's orders, the newest first. */
export const customOrderChangesResponseSchema = z.object({
  changes: z.array(customSelfChangeSchema),
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
  /** The event's own id: a person's undo names the step it takes back by it (`undoOf`). */
  id: intId,
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
/** The agreed total, gross, in mills. */
const priceMills = mills.positive().max(1_000_000_000);
const ref = z.string().trim().min(1).max(64).regex(/^[1-9]\d{0,29}$/);
/** A fan as a person gives it: a profile link, a username, or the platform's number. */
const fanInput = z.string().trim().min(1).max(300);
/** A person's undo names the history event it takes back (`history[].id`): the event records it as `undoOf`. */
const undoOf = intId.optional();
/** A delivery to take back: its eventRef, or the Telegram link of its message (every delivery of that message). */
const retractsInput = z.string().trim().min(3).max(300).refine((value) => parseTelegramRef(value) !== null || CUSTOM_ORDER_EVENT_REF_PATTERN.test(value), {
  message: "the delivery's eventRef, or the Telegram link of its message",
});

export const customOrderActionBodySchema = z.discriminatedUnion("action", [
  /** The card (the whole of it), and the agreed total, gross (null — not named any more): a person's, never overwritten by an agent. */
  z.object({ action: z.literal("edit"), card: customOrderCardSchema.optional(), priceMills: priceMills.nullable().optional() }).strict(),
  z.object({ action: z.literal("deadline"), deadlineOn: day.nullable(), undoOf }).strict(),
  z.object({ action: z.literal("fan"), pageLabel: z.string().trim().min(1).max(120), fan: fanInput }).strict(),
  z.object({ action: z.literal("card"), telegramRef: telegramRefInputSchema }).strict(),
  z.object({ action: z.literal("payment"), transactionRef: ref }).strict(),
  z.object({ action: z.literal("unpay"), transactionRef: ref, undoOf }).strict(),
  /** «Проверен»: the card is checked, the order goes to shooting. */
  z.object({ action: z.literal("checked") }).strict(),
  z.object({ action: z.literal("at_model"), telegramRef: telegramRefInputSchema.optional(), deadlineOn: day.optional() }).strict(),
  z.object({ action: z.literal("partly"), note: note.optional() }).strict(),
  z.object({ action: z.literal("shot") }).strict(),
  /** «Правка»: a request about one part (`part`), or — none named — about the whole order. */
  z.object({ action: z.literal("revision"), note: note.optional(), part: z.enum(["video", "photos"]).optional() }).strict(),
  z.object({ action: z.literal("refused"), reason: note }).strict(),
  /**
   * «Отдан»: by the message the hub suggests, or — none named — by the person's word (an order given before the hub
   * saw the chat, a Fansly chat the hub does not read).
   */
  z.object({ action: z.literal("given"), messageRef: ref.optional() }).strict(),
  /**
   * «Не отдан»: «отдан» taken back — the order is «снят» again; the message stays off it from then on. `messageRef` — the
   * mark the person saw: refused (409 `mark_changed`) when «отдан» is another message's by now.
   */
  z.object({ action: z.literal("ungive"), undoOf, messageRef: ref.optional() }).strict(),
  /** A delivery taken back by the shooting's leader (or the owner): its part stops counting. */
  z.object({ action: z.literal("retract"), retracts: retractsInput, reason: note, undoOf }).strict(),
  z.object({ action: z.literal("close") }).strict(),
  z.object({ action: z.literal("cancel"), reason: note.optional() }).strict(),
  /** The order waits on purpose (the fan is unreachable, a prop is awaited): it does not burn. */
  z.object({ action: z.literal("hold"), reason: note }).strict(),
  z.object({ action: z.literal("unhold") }).strict(),
  /** The agent's sentence of a disagreement is settled. */
  z.object({ action: z.literal("issue_clear") }).strict(),
  /** The owner's word on the payment: a gift, or paid outside the platform; null — the word is taken back. */
  z.object({
    action: z.literal("paid_word"),
    word: z.object({ kind: z.enum(CUSTOM_PAID_WORD_KINDS), note: note.optional() }).strict().nullable(),
  }).strict(),
  /** The page answered the fan's «where is it»: the ask is off the order. */
  z.object({ action: z.literal("fan_asked_clear") }).strict(),
]);
export type CustomOrderActionBody = z.infer<typeof customOrderActionBodySchema>;

/** «Записать кастом» on the board: from a sale that looks like a custom (its page and fan), or on a page for a fan. */
export const customOrderCreateBodySchema = z.object({
  transactionRef: ref.optional(),
  pageLabel: z.string().trim().min(1).max(120).optional(),
  fan: fanInput.optional(),
  card: customOrderCardSchema,
  /** The agreed total, gross (the card's `price` stays the team's words). */
  priceMills: priceMills.optional(),
  telegramRef: telegramRefInputSchema.optional(),
}).strict().refine((body) => body.transactionRef !== undefined || body.pageLabel !== undefined, {
  message: "a sale, or a page", path: ["pageLabel"],
});

export const customSaleParamsSchema = z.object({ transactionRef: ref });
export const customSaleDismissResponseSchema = z.object({ dismissed: z.boolean() });

// ── Findings: a custom with no order (customs facts spec §8) ────────────────

/**
 * Where a trace of a custom with no order was found: a sale (Hub's id), the fan's chat (a message), the chatters' work
 * chat or the model's group (a Telegram message), a line of a shift report.
 */
export const CUSTOM_FINDING_SOURCES = ["sale", "fan_chat", "work_chat", "model_group", "shift_report"] as const;
export type CustomFindingSource = (typeof CUSTOM_FINDING_SOURCES)[number];
export const CUSTOM_FINDING_STATUSES = ["open", "recorded", "linked", "dismissed"] as const;
/**
 * Why a finding is no order: не кастом, выбрал секстинг, не воспользовался, дубль, тест, кастом не просил (a tier bought, no
 * custom asked for: the owner's decision of 2026-11-22, 0437).
 */
export const CUSTOM_FINDING_DISMISS_REASONS = ["not_custom", "sexting", "unused", "duplicate", "test", "not_asked"] as const;

export const customFindingSchema = z.object({
  id: intId,
  source: z.enum(CUSTOM_FINDING_SOURCES),
  /** The trace's reference in its source: a sale's Hub id, a message's id or link, a report line. */
  ref: z.string(),
  pageLabel: z.string().nullable(),
  fan: customOrderFanSchema.nullable(),
  amountMills: mills.nullable(),
  /** The words that make it look like a custom (≤ 300). */
  quote: z.string().nullable(),
  happenedAt: isoTimestamp,
  status: z.enum(CUSTOM_FINDING_STATUSES),
  /** The order it was recorded as or linked to. */
  orderCode: z.string().nullable(),
  dismissReason: z.enum(CUSTOM_FINDING_DISMISS_REASONS).nullable(),
  resolvedAt: isoTimestamp.nullable(),
  /** The agent key that resolved it (the reader's «не кастом»), by its name; null — a person, the system, or open. */
  resolvedByAgent: z.string().nullable(),
  createdAt: isoTimestamp,
});
export type CustomFinding = z.infer<typeof customFindingSchema>;

export const customFindingParamsSchema = z.object({ findingId: z.string().trim().regex(/^[1-9]\d{0,18}$/) });

/**
 * «Найдено без заказа»: the open findings the viewer resolves, the newest first; and the ones an agent dismissed as «не
 * кастом» in the last two weeks («Отклонено агентом»), which a person may bring back (`reopen`).
 */
export const customFindingsListResponseSchema = z.object({
  findings: z.array(customFindingSchema),
  dismissedByAgent: z.array(customFindingSchema),
  serverNow: isoTimestamp,
});

/**
 * A finding resolved by the check's leader of its page (the customs lead, the owner): recorded as an order (the board's
 * «Записать кастом», filled from the finding; a sale's finding brings its sale as the payment, a card's finding its card),
 * linked to an order there is (a sale's finding pays it, checked as the agent's sale is: the order's fan, its model, a
 * live sale no other order holds and the platform did not take back; a card's finding attaches its card), dismissed with
 * a reason from the list, or — dismissed by an agent — brought back (`reopen`: open again).
 */
export const customFindingActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("record"), card: customOrderCardSchema,
    /** The page and the fan when the finding names none. */
    pageLabel: z.string().trim().min(1).max(120).optional(), fan: fanInput.optional(),
    /** The agreed total, gross. */
    priceMills: priceMills.optional(),
    telegramRef: telegramRefInputSchema.optional(),
  }).strict(),
  z.object({ action: z.literal("link"), code: customOrderCodeSchema }).strict(),
  z.object({ action: z.literal("dismiss"), reason: z.enum(CUSTOM_FINDING_DISMISS_REASONS) }).strict(),
  z.object({ action: z.literal("reopen") }).strict(),
]);
export type CustomFindingActionBody = z.infer<typeof customFindingActionBodySchema>;

export const customFindingActionResponseSchema = z.object({ finding: customFindingSchema });

// ── The agent's door (write:customs) ────────────────────────────────────────

/**
 * The fields of the board and the order's page that ContentOps «Съёмка» (which reads the agent's shape) does not
 * carry: the facts and what they are read from (customs facts spec). The agent's wire carries them to a key with
 * `read:money` only (`facts.paid` is about the fan's money); to any other key it stays as it was.
 */
const BOARD_ONLY_FIELDS = {
  dueLeftDays: true, deadlineDefault: true, facts: true, priceMills: true, paidWord: true, holdReason: true, issue: true, fanAskedAt: true, sentAt: true,
} as const;
/**
 * The board's own reading of an order (whose move, what burns and why, the forwarding timer): off the agent's wire, but
 * whose move and whether it burns on the live list to a key with `read:messages` (the reader's reminders read the
 * board's one rule, never a copy of it).
 */
const BOARD_READING_FIELDS = { move: true, burning: true, reason: true, timer: true } as const;

/** An order as an agent key reads it: no money but the card's own price line; the facts with `read:money`. */
export const agentCustomOrderSchema = customOrderSchema.omit({ paidGrossMills: true, paidNetMills: true, ...BOARD_ONLY_FIELDS, ...BOARD_READING_FIELDS })
  .extend(customOrderSchema.pick(BOARD_ONLY_FIELDS).partial().shape)
  .extend(customOrderSchema.pick({ move: true, burning: true }).partial().shape)
  .extend({
    /** The card's text with the code, as «Скопировать карточку» gives it. */
    cardText: z.string(),
    sourceText: z.string().nullable(),
    messages: z.array(customOrderMessageSchema),
    /**
     * `state=live`, to a key with `read:money`, on an order whose money is not complete (`facts.paid` not yes): the fan's
     * sales (any account of the person) of the last 30 days, on the key's pages of the order's model, that pay no order
     * and that no person took off this one — the newest first, at most 10 (a fan often pays before the card is written).
     * The reader reads the chat around each and names one back (`step payment --sale <saleRef>`) or leaves it; Hub never
     * links one by its amount.
     */
    unlinkedSales: z.array(z.object({
      saleRef: z.string(),
      pageLabel: z.string(),
      /** tip | subscription | message_purchase. */
      kind: z.string(),
      grossMills: mills,
      at: isoTimestamp,
    })).optional(),
  });

export const agentCustomOrdersQuerySchema = z.object({
  /**
   * open (default): not given and not ended; live: open and the given ones not closed yet (the reader watches them
   * until they close); all: the last 200 of every state.
   */
  state: z.enum(["open", "live", "all"]).default("open"),
  code: customOrderCodeSchema.optional(),
  telegramRef: telegramRefInputSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();

export const agentCustomOrdersResponseSchema = z.object({
  orders: z.array(agentCustomOrderSchema),
  serverNow: isoTimestamp,
});

const login = z.string().trim().min(1).max(64);
/** Why the order waits on purpose (the fan is unreachable, a prop is awaited). */
const holdReason = note;

export const agentCustomOrderCreateBodySchema = z.object({
  /** The fan's page, of the key's grant; absent — not known yet. */
  pageLabel: z.string().trim().min(1).max(120).optional(),
  /** The fan: a profile link, a username or the platform's number; unmatched it stays the buyer's string. */
  fan: fanInput.optional(),
  /** The chatter who took the order (their login). */
  acceptedBy: login.optional(),
  card: customOrderCardSchema,
  deadlineOn: day.optional(),
  /** The agreed total, gross (needs `read:money`; the card's `price` stays the team's words). */
  priceMills: priceMills.optional(),
  /** Why the order waits on purpose (needs `read:messages`: the agent read it in the chats). */
  holdReason: holdReason.optional(),
  /**
   * The sales that pay the order, as the agent read them in the fan's chat (needs `read:money`). Hub links each that
   * holds by its rules and answers per sale (`sales`); a sale that does not hold never fails the create.
   */
  sales: z.array(agentSaleRequestSchema).min(1).max(20).optional(),
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
    /**
     * The agreed total, gross; null — not named any more (needs `read:money`). A hold's reason; null — the order waits no
     * more (needs `read:messages`).
     */
    priceMills: priceMills.nullable().optional(), holdReason: holdReason.nullable().optional(),
  }).strict(),
  /**
   * A sale pays the order (needs `read:money`): of the order's fan (any account of the person), on a page of the
   * order's model among the key's pages; a tip, a subscription or a message purchase; held by no other order, not
   * taken back, not taken off this order by a person. 409 with the reason otherwise.
   */
  z.object({ action: z.literal("payment"), sale: agentSaleRequestSchema, onBehalfOf: login.optional() }).strict(),
  /**
   * «Отдан» by the page's message that carried the order (needs `read:messages`): sent by a page of the order's model
   * among the key's pages to any account of the order's fan, after the order was recorded, its last revision request and
   * a person's last «не отдан», with media; a priced one bought — the purchase of its one priced offer becomes the order's
   * payment in the same step (the same message named again links one the mark was set without). Refused while the order
   * has a file named by its code (Hub's own rule finds that delivery), for a message a person took off the order, and
   * when the order moved while it was checked (409 `version_changed`). Never by a word.
   */
  z.object({ action: z.literal("given"), messageRef: ref, onBehalfOf: login.optional() }).strict(),
  /** The order's fan (needs `read:messages`): by the platform's id on a page of the key; only while the order has none. */
  z.object({ action: z.literal("fan"), pageLabel: z.string().trim().min(1).max(120), fanRef: ref, onBehalfOf: login.optional() }).strict(),
  /** The fan asked where the order is (needs `read:messages`): his message in the order's chat. */
  z.object({ action: z.literal("fan_asked"), messageRef: ref, onBehalfOf: login.optional() }).strict(),
  /** The deadline moved, as the chatter agreed with the fan: why, in a few words. Never over a person's deadline. */
  z.object({ action: z.literal("deadline"), deadlineOn: day.nullable(), reason: note, onBehalfOf: login.optional() }).strict(),
  /**
   * The sources disagree about the order (the card at the model differs from what the fan bought…): one sentence (needs
   * `read:messages`). Cleared by the agent only when it set it (409 `not_yours`: a person settles another's).
   */
  z.object({ action: z.literal("issue"), text: z.string().trim().min(1).max(200), onBehalfOf: login.optional() }).strict(),
  z.object({ action: z.literal("issue_clear"), onBehalfOf: login.optional() }).strict(),
  /** The card reached the model's group (its copy there, if any). */
  z.object({ action: z.literal("at_model"), telegramRef: telegramRefInputSchema.optional(), onBehalfOf: login.optional() }).strict(),
  /**
   * The model delivered (a file, an album, the line «6-08 го хард.mov»): the message is kept with its excerpt;
   * `complete` — that part is whole now. The order's readiness is by its current round, per part: a part is ready
   * when a whole delivery of it is newer than the last revision request about it (by `message.at`, the message's
   * own time; without it the hub counts the delivery from now), so a delivery from before a request answers
   * nothing, whenever it is reported. A whole delivery fixes only the requests whose every part is ready now, never
   * the other part's. Every wanted part ready and no request open — shot; «правка» while one is open; else partly.
   * `eventRef` — the sender's own id of the delivery (ContentOps'): known by it, the link then optional evidence.
   */
  z.object({
    action: z.literal("delivery"), eventRef: customOrderEventRefSchema.optional(), message: agentMessageSchema,
    part: z.enum(["video", "photos"]).optional(), complete: z.boolean().default(true), onBehalfOf: login.optional(),
  }).strict(),
  /**
   * A state by a message of the model's group (`ref`): partly, shot, refused. Taken once per message: the same step
   * by a message the order's history already has changes nothing (`unchanged`), whatever the order's state is now.
   */
  z.object({ action: z.literal("partly"), ref: telegramRefInputSchema, note: note.optional(), onBehalfOf: login.optional() }).strict(),
  /** Every part is whole: «снят». Open revision requests are fixed by it. */
  z.object({ action: z.literal("shot"), ref: telegramRefInputSchema, onBehalfOf: login.optional() }).strict(),
  /**
   * A revision request (several in one message: `ordinal` 1, 2…); a repeat changes nothing. `part` — the part it is
   * about (the video, the photos); without it the request is about the whole order and waits for every wanted part
   * to come whole again.
   */
  z.object({
    action: z.literal("revision"), eventRef: customOrderEventRefSchema.optional(), message: agentMessageSchema,
    ordinal: z.number().int().min(0).max(50).default(0), text: note, part: z.enum(["video", "photos"]).optional(), onBehalfOf: login.optional(),
  }).strict(),
  /** A revision request is fixed (a new version came and the reader or a person saw it): by its link and ordinal, or its eventRef. */
  z.object({
    action: z.literal("revision_done"), telegramRef: telegramRefInputSchema.optional(), eventRef: customOrderEventRefSchema.optional(),
    ordinal: z.number().int().min(0).max(50).default(0), onBehalfOf: login.optional(),
  }).strict(),
  /**
   * A delivery taken back (ContentOps «это другой заказ»): `retracts` names it — its eventRef, or the Telegram link
   * of the message it came with (every delivery of that message). Its part stops counting unless a whole delivery
   * that stays is newer than the last request about it; the requests it had answered are open again, and the state
   * follows («правка», or what the parts that stay say). «Снят» that a person set by hand on the board stays: the
   * retraction is then only a line of the order's history. The retraction is an event of its own (`eventRef`);
   * `message` — its evidence and author.
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

/**
 * Why a named sale does not pay the order (customs facts spec §5): `capability_missing` — the key lacks read:money;
 * `not_found` — no such sale on the key's pages; `order_no_page`, `order_no_fan` — the order names no page or no fan to
 * check it against; `other_model` — a page of another model; `other_fan` — another fan's; `wrong_kind` — not a tip, a
 * subscription or a message purchase, or no live sale; `taken` — another order holds it; `reversed` — the platform took
 * it back; `rejected` — a person took it off this order; `not_allowed` — the order's state takes no payment.
 */
export const AGENT_CUSTOM_SALE_REFUSALS = [
  "capability_missing", "not_found", "order_no_page", "order_no_fan", "other_model", "other_fan", "wrong_kind", "taken", "reversed",
  "rejected", "not_allowed",
] as const;
export type AgentCustomSaleRefusal = (typeof AGENT_CUSTOM_SALE_REFUSALS)[number];

/** One named sale and what became of it. */
export const agentCustomSaleOutcomeSchema = z.object({
  /** The sale as it was named. */
  sale: agentSaleRequestSchema,
  /** Hub's id of the sale; null — not found. */
  saleRef: z.string().nullable(),
  /** linked — it pays the order now; already — it did before; refused — it does not (`reason`). */
  result: z.enum(["linked", "already", "refused"]),
  reason: z.enum(AGENT_CUSTOM_SALE_REFUSALS).nullable(),
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
  /** A create that named sales: each, and what became of it. Absent — none named. */
  sales: z.array(agentCustomSaleOutcomeSchema).optional(),
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

/**
 * What the reader found of a custom with no order (needs `read:money` + `read:messages`), each once by `(source, ref)`:
 * a sale (`ref` — Hub's id of the sale: its page, fan, sum and time are Hub's), a message of the fan's chat, of the
 * work chat or of the model's group, a report line. `notCustom` — a candidate the reader read and found no custom:
 * kept dismissed («не кастом»), so it is not offered again; a finding already there stays as it is (its resolution is
 * a person's).
 */
export const agentCustomFindingsBodySchema = z.object({
  findings: z.array(z.object({
    source: z.enum(CUSTOM_FINDING_SOURCES),
    ref: z.string().trim().min(1).max(200),
    /** The page, of the key's pages; absent — not known (a card in the work chat). */
    pageLabel: z.string().trim().min(1).max(120).optional(),
    /** The fan's platform id on that page. */
    fanRef: ref.optional(),
    amountMills: mills.positive().optional(),
    /** The words that make it look like a custom, verbatim (≤ 300). */
    quote: z.string().trim().min(1).max(300).optional(),
    happenedAt: isoDateTime({ offset: true }),
    notCustom: z.literal(true).optional(),
  }).strict().superRefine((item, context) => {
    if (item.notCustom !== true && item.quote === undefined) context.addIssue({ code: "custom", path: ["quote"], message: "a finding quotes its words" });
    if (item.fanRef !== undefined && item.pageLabel === undefined) context.addIssue({ code: "custom", path: ["pageLabel"], message: "a fan is named on a page" });
  })).min(1).max(200),
}).strict();

export const agentCustomFindingsResponseSchema = z.object({
  findings: z.array(z.object({
    source: z.enum(CUSTOM_FINDING_SOURCES),
    ref: z.string(),
    /**
     * created — a new open finding; dismissed — kept as «не кастом»; already — Hub had this one (in whatever status);
     * not_found — its page, fan or sale is not on the key's pages.
     */
    outcome: z.enum(["created", "dismissed", "already", "not_found"]),
    /** The finding's id; null — not found. */
    id: intId.nullable(),
  })),
});

export type CustomOrdersBoardResponse = z.infer<typeof customOrdersBoardResponseSchema>;
export type CustomOrdersDoneResponse = z.infer<typeof customOrdersDoneResponseSchema>;
export type CustomFindingsListResponse = z.infer<typeof customFindingsListResponseSchema>;
export type CustomOrderChangesResponse = z.infer<typeof customOrderChangesResponseSchema>;
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
export type AgentCustomSaleOutcome = z.infer<typeof agentCustomSaleOutcomeSchema>;
export type AgentCustomFindingsBody = z.infer<typeof agentCustomFindingsBodySchema>;
export type AgentCustomFindingsResponse = z.infer<typeof agentCustomFindingsResponseSchema>;
