import { z } from "zod";

import { cardOf, customOrderCode, parseTelegramRef, type CustomOrderCard } from "@agency_hub_core/contracts";
import {
  addCustomOrderMessage,
  findCustomOrderIdByContentops,
  findImportedCustomOrderWithoutCard,
  findPageFanByInput,
  findPageSummaryByLabel,
  listCustomOrderCardOwners,
  updateCustomOrderFields,
  type CustomOrderStateRow,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { recordCustomOrder } from "./index.ts";
import { fanInputOf, parseCardText } from "./rules.ts";

/**
 * Заказ кастома, the one-off import of the open orders (ecosystem plan
 * 2026-11-12, package I): ContentOps' orders (`GET /api/v1/<model>/orders`,
 * the open tab, as the API answers) and Gengar's board (`orders.json` as it
 * is), united by the Telegram card: every card of one order, whichever chat it
 * is in, makes one group, and every open group becomes exactly one order with
 * its old references (the cards, the ContentOps order). A buyer that matches no
 * fan of the page stays a string; a page that is not known stays unknown;
 * closed history (delivered and given, cancelled) is not imported. The data
 * comes as an argument file prepared outside the repository; without `--apply`
 * nothing is written and the plan says what it would create and what it could
 * not match.
 */

const contentopsMessageSchema = z.object({
  at: z.string().nullable().optional(),
  kind: z.string(),
  excerpt: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
}).passthrough();

const contentopsOrderSchema = z.object({
  id: z.string(),
  buyer: z.string().nullable(),
  account: z.string().nullable(),
  card: z.object({ ref: z.string(), url: z.string().optional(), author: z.string().optional(), posted_at: z.string(), text: z.string().nullable() }).passthrough(),
  brief: z.string().nullable().optional(),
  duration: z.object({ raw: z.string() }).passthrough().optional(),
  wants_video: z.boolean().optional(),
  wants_photos: z.number().int().nonnegative().optional(),
  deadline: z.string().nullable().optional(),
  fan_name: z.enum(["yes", "no", "unknown"]).optional(),
  parts: z.array(z.object({ kind: z.enum(["video", "photos"]), complete: z.boolean() }).passthrough()).default([]),
  revisions: z.array(z.object({ text: z.string().nullable(), message_url: z.string().nullable(), created_at: z.string(), done: z.unknown().nullable() }).passthrough()).default([]),
  messages: z.array(contentopsMessageSchema).default([]),
  state: z.string(),
  cancelled: z.unknown().nullable().optional(),
  closed_at: z.string().nullable().optional(),
}).passthrough();

const boardEntrySchema = z.object({
  model: z.string().optional(),
  fan: z.string().nullable().optional(),
  page: z.string().nullable().optional(),
  /** `<group key>:<message id>` (the board's own spelling), or null — no card yet. */
  card: z.string().nullable(),
  deadline: z.string().nullable().optional(),
  status: z.string().optional(),
  usd: z.number().nullable().optional(),
  pay: z.string().nullable().optional(),
  duration: z.string().nullable().optional(),
  model_at: z.string().nullable().optional(),
  fan_at: z.string().nullable().optional(),
}).passthrough();

export const customOrdersImportArgsSchema = z.object({
  version: z.literal(1),
  /** Cards posted before this day are not brought in (listed as old). */
  cardsSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The models' groups (chat ids without -100): a card there means the order is at the model. */
  modelGroupChats: z.array(z.string()).default([]),
  contentops: z.array(z.object({ model: z.string(), orders: z.array(contentopsOrderSchema) })).default([]),
  board: z.object({ open: z.array(boardEntrySchema).default([]), done: z.array(boardEntrySchema).default([]) }).passthrough().optional(),
  /** The board's group keys: `lp` → its chat and topic. */
  boardGroups: z.record(z.string(), z.object({ chat: z.string(), topic: z.number().int().positive() })).default({}),
  /** Card texts by card reference (`tg:<chat>/<topic>/<msg>`), when the sources carry none. */
  cardTexts: z.record(z.string(), z.string()).default({}),
}).strict();
export type CustomOrdersImportArgs = z.infer<typeof customOrdersImportArgsSchema>;

export interface PlannedOrder {
  refs: string[];
  contentopsRef: string | null;
  pageLabel: string | null;
  pageId: number | null;
  fanId: number | null;
  /** What the sources call the buyer, when no fan of the page matched it. */
  buyer: string | null;
  state: CustomOrderStateRow;
  card: CustomOrderCard;
  deadlineOn: string | null;
  postedAt: string | null;
  author: string | null;
  sourceText: string | null;
  partsDone: Array<"video" | "photos">;
  messages: Array<{ ref: string; ordinal: number; kind: "repost" | "delivery" | "revision" | "confirmation" | "note"; at: string | null; author: string | null; excerpt: string | null; done: boolean }>;
  /** Where it comes from: contentops, board, both. */
  from: string;
  /** What could not be matched, in words. */
  unmatched: string[];
}

export interface CustomOrdersImportPlan {
  orders: PlannedOrder[];
  skipped: Array<{ refs: string[]; reason: string; buyer: string | null }>;
  /** Already in Hub (an earlier import): left as they are. */
  existing: Array<{ refs: string[]; code: string }>;
}

type ImportApp = Pick<AppContext, "db">;

const MESSAGE_KINDS = new Set(["repost", "delivery", "revision", "confirmation", "note"]);
const OPEN_CONTENTOPS = new Set(["waiting", "partial", "revision", "overdue"]);

/** Union-find over card references: two sources of one order share one of its cards. */
class Groups {
  private parent = new Map<string, string>();
  find(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(key, root);
    return root;
  }
  join(keys: readonly string[]) {
    for (const key of keys.slice(1)) {
      const a = this.find(keys[0]!);
      const b = this.find(key);
      if (a !== b) this.parent.set(b, a);
    }
  }
}

/** «Tom (u100000001)», «Sam (sam_handle)», «handle123», a link: the handle to look the fan up by. */
export function buyerHandleOf(buyer: string | null | undefined): string | null {
  if (!buyer) return null;
  const inParens = /\(([^)]+)\)\s*$/u.exec(buyer.trim());
  const handle = (inParens ? inParens[1]! : buyer).trim();
  return handle === "" || /\s\+\s/u.test(handle) ? null : handle;
}

function moscowDayOf(iso: string): string {
  return new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * An earlier import's order of these cards, of this ContentOps order, or — a source with neither (the board's «нет
 * карточки») — of the same page and fan with neither: a repeat of the import finds every order it stored. A database
 * without the orders' tables yet (a dry run before the deploy) has none.
 */
async function existingOrderOf(
  db: Database,
  refs: readonly string[],
  contentopsRef: string | null,
  cardless: { pageId: number | null; fanId: number | null; buyer: string | null } | null = null,
): Promise<number | null> {
  try {
    const owners = await listCustomOrderCardOwners(db, refs);
    if (owners.size > 0) return [...owners.values()][0]!;
    if (contentopsRef !== null) return await findCustomOrderIdByContentops(db, contentopsRef);
    return cardless === null || refs.length > 0 ? null : await findImportedCustomOrderWithoutCard(db, cardless);
  } catch (error) {
    const code = (error as { code?: unknown; cause?: { code?: unknown } }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
    if (code === "42P01") return null;
    throw error;
  }
}

/** The plan: what each open card becomes, and what is left out and why. Reads Hub (pages, fans, earlier imports); writes nothing. */
export async function planCustomOrdersImport(app: ImportApp, args: CustomOrdersImportArgs): Promise<CustomOrdersImportPlan> {
  const groups = new Groups();
  const boardRef = (card: string | null | undefined): string | null => {
    if (!card) return null;
    const [key, id] = card.split(":");
    const group = key === undefined ? undefined : args.boardGroups[key];
    return group && id ? parseTelegramRef(`tg:${group.chat}/${group.topic}/${id}`) : parseTelegramRef(card);
  };
  type Source = { kind: "contentops"; model: string; order: z.infer<typeof contentopsOrderSchema>; refs: string[] } | { kind: "board"; entry: z.infer<typeof boardEntrySchema>; refs: string[]; open: boolean };
  const sources: Source[] = [];
  for (const block of args.contentops) {
    for (const order of block.orders) {
      const refs = [order.card.ref, ...order.messages.filter((message) => message.kind === "repost" || message.kind === "card").map((message) => message.url ?? "")]
        .map((ref) => parseTelegramRef(ref)).filter((ref): ref is string => ref !== null);
      sources.push({ kind: "contentops", model: block.model, order, refs: [...new Set(refs)] });
    }
  }
  for (const [list, open] of [[args.board?.open ?? [], true], [args.board?.done ?? [], false]] as const) {
    for (const entry of list) {
      const ref = boardRef(entry.card);
      sources.push({ kind: "board", entry, refs: ref === null ? [] : [ref], open });
    }
  }
  // A source without a card (the board's «нет карточки») is a group of its own.
  sources.forEach((source, index) => {
    if (source.refs.length === 0) source.refs.push(`nocard:${index}`);
    groups.join(source.refs);
  });
  const byGroup = new Map<string, Source[]>();
  for (const source of sources) {
    const root = groups.find(source.refs[0]!);
    byGroup.set(root, [...(byGroup.get(root) ?? []), source]);
  }

  const plan: CustomOrdersImportPlan = { orders: [], skipped: [], existing: [] };
  for (const members of byGroup.values()) {
    const refs = [...new Set(members.flatMap((member) => member.refs))].filter((ref) => ref.startsWith("tg:")).sort();
    const contentops = members.filter((member): member is Extract<Source, { kind: "contentops" }> => member.kind === "contentops");
    const board = members.filter((member): member is Extract<Source, { kind: "board" }> => member.kind === "board");
    const co = contentops[0];
    const boardOpen = board.find((member) => member.open);
    const buyerOf = boardOpen?.entry.fan ?? co?.order.buyer ?? board[0]?.entry.fan ?? null;
    // Closed history stays out: given to the fan (the board), cancelled or closed (ContentOps), delivered and not on the board's open list.
    if (board.some((member) => !member.open)) { plan.skipped.push({ refs, reason: "отдан фану (доска Генгара)", buyer: buyerOf }); continue; }
    if (co && (co.order.cancelled || co.order.closed_at || co.order.state === "cancelled" || co.order.state === "closed")) { plan.skipped.push({ refs, reason: "закрыт или снят в ContentOps", buyer: buyerOf }); continue; }
    if (co && !boardOpen && !OPEN_CONTENTOPS.has(co.order.state)) { plan.skipped.push({ refs, reason: `сдан моделью (ContentOps: ${co.order.state}), открытого на доске нет`, buyer: buyerOf }); continue; }
    const postedAt = co?.order.card.posted_at ?? null;
    if (postedAt !== null && moscowDayOf(postedAt) < args.cardsSince) { plan.skipped.push({ refs, reason: `карточка старше ${args.cardsSince} (${moscowDayOf(postedAt)})`, buyer: buyerOf }); continue; }

    const contentopsRef = co ? `${co.model}/${co.order.id}` : null;
    const already = await existingOrderOf(app.db, refs, contentopsRef);
    if (already !== null) { plan.existing.push({ refs, code: customOrderCode(already) }); continue; }

    const unmatched: string[] = [];
    // The page: the board names it; ContentOps sometimes does (`account`). Never guessed from the model.
    const pageLabel = boardOpen?.entry.page ?? co?.order.account ?? null;
    const page = pageLabel === null ? null : await findPageSummaryByLabel(app.db, pageLabel);
    if (pageLabel === null) unmatched.push("страница не указана");
    else if (!page) unmatched.push(`страницы ${pageLabel} нет в Hub`);
    let fanId: number | null = null;
    const handle = buyerHandleOf(boardOpen?.entry.fan ?? co?.order.buyer);
    if (page && handle !== null) {
      const parsed = fanInputOf(page.platform, handle);
      const fan = parsed === null ? null : await findPageFanByInput(app.db, { pageId: page.id, platform: page.platform, ...parsed });
      if (fan) fanId = fan.fanId;
      else unmatched.push(`фан «${handle}» не найден на ${page.label}`);
    } else if (handle === null) {
      unmatched.push("покупатель не назван");
    } else {
      unmatched.push(`фан «${handle}» не сопоставлен: страница неизвестна`);
    }
    if (refs.length === 0 && contentopsRef === null) {
      const earlier = await existingOrderOf(app.db, refs, null, { pageId: page?.id ?? null, fanId, buyer: fanId === null ? buyerOf : null });
      if (earlier !== null) { plan.existing.push({ refs, code: customOrderCode(earlier) }); continue; }
    }

    const text = co?.order.card.text ?? refs.map((ref) => args.cardTexts[ref]).find((one) => one !== undefined) ?? null;
    const parsed = text === null ? null : parseCardText(text);
    const card: Record<string, unknown> = { ...(parsed?.card ?? {}) };
    if (card.task === undefined && co?.order.brief) card.task = co.order.brief;
    if (card.duration === undefined && (co?.order.duration?.raw ?? boardOpen?.entry.duration)) card.duration = co?.order.duration?.raw ?? boardOpen?.entry.duration;
    if (card.price === undefined && boardOpen?.entry.usd) card.price = `${boardOpen.entry.usd}$`;
    if (card.price === undefined && boardOpen?.entry.pay) card.price = boardOpen.entry.pay;
    if (co?.order.fan_name) card.nameInVideo = co.order.fan_name;
    if (co?.order.wants_video !== undefined) card.wantsVideo = co.order.wants_video;
    if (co?.order.wants_photos) card.wantsPhotos = co.order.wants_photos;

    // The state: ContentOps' step, the board's word, and whether a card is in a model's group.
    const atModel = refs.some((ref) => args.modelGroupChats.includes(ref.slice(3).split("/")[0]!));
    const paid = card.price !== undefined || (boardOpen?.entry.usd ?? 0) > 0;
    let state: CustomOrderStateRow;
    if (co?.order.state === "partial") state = "partly";
    else if (co?.order.state === "revision") state = "revision";
    else if (co && !OPEN_CONTENTOPS.has(co.order.state)) state = "shot";
    else if (boardOpen?.entry.status === "not_moved" || boardOpen?.entry.status === "no_card" || !atModel) state = paid ? "paid" : "recorded";
    else state = "at_model";

    const messages: PlannedOrder["messages"] = [];
    for (const message of co?.order.messages ?? []) {
      const ref = message.url ? parseTelegramRef(message.url) : null;
      if (ref === null || !MESSAGE_KINDS.has(message.kind)) continue;
      messages.push({
        ref, ordinal: 0, kind: message.kind as PlannedOrder["messages"][number]["kind"], at: message.at ?? null,
        author: message.author ? message.author.slice(0, 120) : null, excerpt: message.excerpt ? message.excerpt.slice(0, 500) : null, done: false,
      });
    }
    (co?.order.revisions ?? []).forEach((revision, index) => {
      const ref = revision.message_url ? parseTelegramRef(revision.message_url) : null;
      if (ref === null) return;
      messages.push({ ref, ordinal: index + 1, kind: "revision", at: revision.created_at, author: null, excerpt: revision.text ? revision.text.slice(0, 500) : null, done: revision.done !== null });
    });

    plan.orders.push({
      refs,
      contentopsRef,
      pageLabel: page?.label ?? pageLabel,
      pageId: page?.id ?? null,
      fanId,
      buyer: fanId === null ? (buyerOf ?? null) : null,
      state,
      card: cardOf(card),
      deadlineOn: co?.order.deadline ?? boardOpen?.entry.deadline ?? parsed?.deadlineOn ?? null,
      postedAt,
      author: co?.order.card.author ?? null,
      sourceText: text === null ? null : text.slice(0, 8000),
      partsDone: (co?.order.parts ?? []).filter((part) => part.complete).map((part) => part.kind),
      messages,
      from: co && board.length > 0 ? "ContentOps и доска" : co ? "ContentOps" : "доска Генгара",
      unmatched,
    });
  }
  plan.orders.sort((left, right) => (left.postedAt ?? "").localeCompare(right.postedAt ?? ""));
  return plan;
}

/** Writes the plan's orders (one transaction each); an order whose card is in Hub by now is left. Answers the codes. */
export async function applyCustomOrdersImport(app: ImportApp, plan: CustomOrdersImportPlan, now: Date = new Date()): Promise<string[]> {
  const codes: string[] = [];
  for (const order of plan.orders) {
    if ((await listCustomOrderCardOwners(app.db, order.refs)).size > 0) continue;
    const id = await recordCustomOrder(app, {
      pageId: order.pageId, fanId: order.fanId, buyer: order.buyer === null ? null : order.buyer.slice(0, 300), conversationRef: null,
      card: order.card, deadlineOn: order.deadlineOn, acceptedByUserId: null, origin: "import", contentopsRef: order.contentopsRef,
      sourceText: order.sourceText, state: order.state, telegramRefs: order.refs, actor: { door: "system" },
      cardPostedAt: order.postedAt === null ? null : new Date(order.postedAt), cardAuthor: order.author ? order.author.slice(0, 120) : null,
      ...(order.postedAt === null ? {} : { createdAt: new Date(order.postedAt) }), now,
    });
    await app.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      if (order.partsDone.length > 0) await updateCustomOrderFields(db, id, { partsDone: order.partsDone }, now);
      for (const message of order.messages) {
        await addCustomOrderMessage(db, {
          orderId: id, telegramRef: message.ref, ordinal: message.ordinal, kind: message.kind, part: null,
          postedAt: message.at === null ? null : new Date(message.at), author: message.author, excerpt: message.excerpt, at: now,
        });
      }
    });
    codes.push(customOrderCode(id));
  }
  return codes;
}

const STATE_WORDS: Record<CustomOrderStateRow, string> = {
  recorded: "записан", paid: "оплачен", at_model: "у модели", partly: "сдан частично", shot: "снят", revision: "правка",
  refused: "отказ модели", given: "отдан", closed: "закрыт", cancelled: "отменён",
};

/** The plan for a person: Russian, one line per order, then what could not be matched and what was left out. */
export function renderCustomOrdersImport(plan: CustomOrdersImportPlan, input: { title: string; preparedAt: string }): string {
  const lines = [`# ${input.title}`, "", `Собрано: ${input.preparedAt}. Будет заведено заказов: ${plan.orders.length}; уже в Hub: ${plan.existing.length}; не переносится: ${plan.skipped.length}.`, ""];
  lines.push("## Будут заведены", "", "| # | Карточки | Откуда | Страница | Фан | Шаг | Срок | Оплата | Не сопоставлено |", "|---|---|---|---|---|---|---|---|---|");
  plan.orders.forEach((order, index) => {
    lines.push(`| ${index + 1} | ${order.refs.join("<br>") || "нет карточки"} | ${order.from} | ${order.pageLabel ?? "не подтверждена"} | ${order.fanId !== null ? "подтверждён" : `не подтверждён: ${order.buyer ?? "-"}`} | ${STATE_WORDS[order.state]} | ${order.deadlineOn ?? "-"} | ${order.card.price ?? "-"} | ${order.unmatched.join("; ") || "-"} |`);
  });
  const unmatched = plan.orders.filter((order) => order.unmatched.length > 0);
  lines.push("", `## Не сопоставлено (${unmatched.length})`, "");
  for (const order of unmatched) lines.push(`- ${order.refs[0] ?? "без карточки"}: ${order.unmatched.join("; ")}`);
  if (plan.existing.length > 0) {
    lines.push("", "## Уже в Hub", "");
    for (const one of plan.existing) lines.push(`- ${one.code}: ${one.refs.join(", ")}`);
  }
  lines.push("", `## Не переносится (${plan.skipped.length})`, "");
  for (const one of plan.skipped) lines.push(`- ${one.refs.join(", ") || "без карточки"}${one.buyer ? ` (${one.buyer})` : ""}: ${one.reason}`);
  return `${lines.join("\n")}\n`;
}
