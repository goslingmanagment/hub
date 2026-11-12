import { millsToWholeCents } from "@agency_hub_core/shared";
import {
  findCustomOrderCode,
  cardOf,
  CUSTOM_STATE_WORDS,
  customOrderCode,
  DELIVERY_MOVES_FROM,
  type CustomOrderCard,
  type CustomOrderState,
} from "@agency_hub_core/contracts";

export {
  buyerLinkOf,
  cardOf,
  deadlinePassed,
  DELIVERY_MOVES_FROM,
  dottedDay,
  isBoardAction,
  leadsSteps,
  mayTakeStep,
  moscowDay,
  overdueDaysOf,
  renderCardText,
  seesOrder,
  STEP_FROM,
  STEP_TO,
  stepsFor,
  wantedParts,
  whatOf,
  type CustomStepName,
  type CustomViewer,
} from "@agency_hub_core/contracts";

/**
 * Заказ кастома: the server's own rules, pure — the card's text back into its
 * fields, a price as the team writes it, a fan as a person gives it, and the
 * old extension wire's four states. The rules every door shares are in
 * packages/contracts/src/custom-order-rules.ts.
 */

/**
 * The extension's four states (CLIENT_FAN_CUSTOM_STATES) for an order: the released extension knows no other.
 * `ordered` («ждёт оплаты») is only a recorded order no sale pays yet. Every other step in work — paid, at the
 * model, delivered in part, shot, in revision — is `paid`: its wording is the least wrong of the four, the order
 * is past its payment (often written in the card, not linked to a sale) and waits to be given, so «Отдали» stays.
 * Given or closed is `delivered`; a cancelled order or the model's refusal is `cancelled`.
 */
export function extensionStateOf(order: { state: CustomOrderState; payments: number }): "ordered" | "paid" | "delivered" | "cancelled" {
  if (order.state === "given" || order.state === "closed") return "delivered";
  if (order.state === "cancelled" || order.state === "refused") return "cancelled";
  return order.state === "recorded" && order.payments === 0 ? "ordered" : "paid";
}

/** The order's real step for the extension, shown as it is: its code, the board's word for its state, since when. */
export function extensionStepOf(order: { id: number; state: CustomOrderState; stateAt: Date }): { code: string; stepLabel: string; stepAt: string } {
  return { code: customOrderCode(order.id), stepLabel: CUSTOM_STATE_WORDS[order.state], stepAt: order.stateAt.toISOString() };
}

// ── The round ───────────────────────────────────────────────────────────────

export type CustomPart = "video" | "photos";

/** A delivery or a revision request of an order, as its round reads it. */
export interface RoundMessage {
  id: number;
  kind: "delivery" | "revision";
  /**
   * A delivery: its part (null — not said, a message brought in by the import: the first part the card orders, as
   * the door takes a delivery that names none). A request: the part it is about; null — the whole order.
   */
  part: CustomPart | null;
  /** The message's own time; when its sender gave none, when the hub kept it. */
  at: Date;
  /** A delivery: that part whole (null — not said, an older delivery: it counts as whole). */
  complete: boolean | null;
  /** A delivery taken back. */
  retracted: boolean;
  /** A request fixed; `doneByDelivery` — by the round itself, false — by a person's or the reader's word. */
  done: boolean;
  doneByDelivery: boolean;
}

export interface CustomRound {
  /** The wanted parts ready now, in the card's order. */
  partsDone: CustomPart[];
  /** The requests not fixed, the oldest first. */
  open: number[];
  /** Open requests whose every part is ready now: the round fixes them. */
  answered: number[];
  /** Requests the round had fixed whose part is ready no more: open again. */
  reopened: number[];
  /** Every wanted part ready and no request open: «снят». */
  whole: boolean;
  /** The deliveries not taken back, whole or not. */
  liveDeliveries: number;
}

/** The parts a revision request is about: the one it names when the card orders it, else every wanted part. */
export function partsAbout(wanted: readonly CustomPart[], part: CustomPart | null | undefined): readonly CustomPart[] {
  return part !== null && part !== undefined && wanted.includes(part) ? [part] : wanted;
}

/**
 * The readiness of an order by its current round, per part — the one computation every message step goes through.
 * A part is ready when a whole delivery of it that was not taken back is newer than the last revision request about
 * it: the delivery that was sent back for revision never counts again, however whole. Or while a word stands for it:
 *   - a person's «снят» on the board (`saidWholeAt`): every wanted part, until a request newer than that word is
 *     about the part. A delivery taken back afterwards does not undo it: what a person decided by hand stays;
 *   - `partsDone` as the order kept it (the reader's «снят», an imported part), which a step takes away by naming
 *     the part in `questioned`: a new request about it, a whole delivery of it taken back.
 * A request is fixed when every part it is about came whole after it (or a word stands for the part); one fixed by
 * a word stays fixed, one the round fixed opens again when the delivery that answered it is taken back — not when
 * a newer request sends the part back once more. «Newer» is by the message's own time, then by the order the hub
 * kept them in.
 */
export function roundOf(input: {
  wanted: readonly CustomPart[];
  partsDone: readonly CustomPart[];
  messages: readonly RoundMessage[];
  questioned?: readonly CustomPart[];
  saidWholeAt?: Date | null;
}): CustomRound {
  const { wanted, messages } = input;
  const questioned = input.questioned ?? [];
  const said = input.saidWholeAt?.getTime() ?? null;
  const newer = (left: RoundMessage, right: RoundMessage) =>
    left.at.getTime() === right.at.getTime() ? left.id > right.id : left.at.getTime() > right.at.getTime();
  const requests = messages.filter((message) => message.kind === "revision").sort((left, right) => (newer(left, right) ? 1 : -1));
  const deliveries = messages.filter((message) => message.kind === "delivery" && !message.retracted);
  const about = (request: RoundMessage) => partsAbout(wanted, request.part);
  /** A whole delivery of the part that stays, newer than `request` (none — any). */
  const cameAfter = (part: CustomPart, request: RoundMessage | undefined) => deliveries.some((delivery) =>
    (delivery.part ?? wanted[0]) === part && delivery.complete !== false && (request === undefined || newer(delivery, request)));
  /** A person's «снят» stands for the part: no request about it is as new as that word. */
  const byHand = (part: CustomPart) => said !== null && !requests.some((request) => about(request).includes(part) && request.at.getTime() >= said);
  const kept = (part: CustomPart) => input.partsDone.includes(part) && !questioned.includes(part);
  const partsDone = wanted.filter((part) => byHand(part) || kept(part)
    || cameAfter(part, requests.findLast((request) => about(request).includes(part))));
  const round: CustomRound = { partsDone, open: [], answered: [], reopened: [], whole: false, liveDeliveries: deliveries.length };
  for (const request of requests) {
    if (request.done && !request.doneByDelivery) continue;
    // A person's «снят» after the request answers it for good, whatever is asked or taken back later.
    const saidAfter = said !== null && said > request.at.getTime();
    if (saidAfter || about(request).every((part) => kept(part) || cameAfter(part, request))) {
      if (!request.done) round.answered.push(request.id);
    } else {
      round.open.push(request.id);
      if (request.done) round.reopened.push(request.id);
    }
  }
  round.whole = round.open.length === 0 && wanted.every((part) => partsDone.includes(part));
  return round;
}

/**
 * Where an order's kept messages put it, from a state they move it from (DELIVERY_MOVES_FROM): «снят» when every
 * wanted part is ready and no request is open, «правка» while a request is open (or while a revision still waits
 * for its part), «сдан частично» once anything is delivered; else the state stays. The one function the delivery
 * step and the recomputation of an order by its kept messages (`custom-orders:settle`) share.
 */
export function stateByMessages(state: CustomOrderState, round: Pick<CustomRound, "whole" | "open" | "partsDone" | "liveDeliveries">): CustomOrderState {
  if (!DELIVERY_MOVES_FROM.includes(state)) return state;
  if (round.whole) return "shot";
  if (round.open.length > 0 || state === "revision") return "revision";
  return round.partsDone.length > 0 || round.liveDeliveries > 0 ? "partly" : state;
}

const SECTIONS: ReadonlyArray<{ key: keyof CustomOrderCard | "buyer" | "deadline" | "header"; match: RegExp }> = [
  { key: "header", match: /^📦\s*Описание заказа/u },
  { key: "date", match: /^Дата\s*:/u },
  { key: "buyer", match: /^Покупатель\s*:/u },
  { key: "name", match: /^Имя\s*:/u },
  { key: "price", match: /^Оплата\s*:/u },
  { key: "duration", match: /^Длительность\s*:/u },
  { key: "task", match: /^(?:🎥|📸)?\s*Описание задания\s*:/u },
  { key: "photos", match: /^📸\s*Фото\s*:/u },
  { key: "clothes", match: /^👗?\s*Одежда\s*:/u },
  { key: "face", match: /^🙈?\s*Лицо\s*:/u },
  { key: "notes", match: /^🗒?\s*Заметки\s*:/u },
  { key: "urgency", match: /^🔥\s*Срочность\s*:/u },
  { key: "deadline", match: /^⏳\s*Сроки\s*:/u },
];

/**
 * A card's text back into its fields (the import, a pasted card): each line that opens a known section takes the
 * text after its colon and the lines below it up to the next section. «-» is empty. «⏳Сроки: До 30.10.2026» is the
 * deadline day; any other words stay the deadline's note. Unknown lines before the first section are dropped.
 */
export function parseCardText(text: string): { card: CustomOrderCard; deadlineOn: string | null; buyer: string | null; code: number | null } {
  const values = new Map<string, string[]>();
  let current: string | null = null;
  let code: number | null = null;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/\uFE0F/gu, "").replace(/^[`*_\s]+|[`*_\s]+$/gu, "");
    const section = SECTIONS.find((candidate) => candidate.match.test(line));
    if (section) {
      current = section.key;
      const rest = line.replace(section.match, "").trim();
      if (section.key === "header") {
        // «K-123» as people type it: the Latin letter or the Cyrillic one of a Russian keyboard.
        code = findCustomOrderCode(rest);
        values.set("header", []);
        continue;
      }
      values.set(current, rest === "" ? [] : [rest]);
      continue;
    }
    if (current !== null && current !== "header") values.get(current)!.push(raw.trimEnd());
  }
  const value = (key: string): string | undefined => {
    const joined = (values.get(key) ?? []).join("\n").replace(/^\n+|\n+$/g, "").trim();
    return joined === "" || joined === "-" || joined === "—" ? undefined : joined;
  };
  const deadlineText = value("deadline");
  const day = deadlineText === undefined ? null : /(\d{1,2})\.(\d{1,2})\.(\d{4})/u.exec(deadlineText);
  const deadlineOn = day ? `${day[3]}-${day[2]!.padStart(2, "0")}-${day[1]!.padStart(2, "0")}` : null;
  const draft: Record<string, unknown> = {
    date: value("date"),
    name: value("name"),
    price: value("price"),
    duration: value("duration"),
    task: value("task"),
    photos: value("photos"),
    clothes: value("clothes"),
    face: value("face"),
    notes: value("notes"),
    urgency: value("urgency"),
    deadlineNote: deadlineOn === null ? deadlineText : undefined,
  };
  return { card: cardOf(draft), deadlineOn, buyer: value("buyer") ?? null, code };
}

/** «Tom (u100000001)», «Sam (sam_handle)», «handle123», a link: the handle to look the fan up by. */
export function buyerHandleOf(buyer: string | null | undefined): string | null {
  if (!buyer) return null;
  const inParens = /\(([^)]+)\)\s*$/u.exec(buyer.trim());
  const handle = (inParens ? inParens[1]! : buyer).trim();
  return handle === "" || /\s\+\s/u.test(handle) ? null : handle;
}

/**
 * How a buyer's string (an order no fan of the page was matched for keeps it as the card named him) names this
 * fan; null — it does not.
 *   number — by the platform's number: the number itself, or a profile link or a chat address that carries it. It
 *            is his alone by itself.
 *   login  — by his login: an explicit reference to it (a profile link with it, `@handle`; any letter case), or a
 *            bare word — the whole string, or its part in brackets as the team writes «Имя (ник)» — that is the
 *            username letter for letter. A bare word that only looks like it («Alex» where the fan is `alex`) is a
 *            name, and a name names nobody. A login is his alone only while no other fan of the order's page
 *            carries it: the caller checks that (the erasure).
 */
export function buyerNamesFan(buyer: string, fan: { platform: string; platformUserId: string; username: string | null }): "number" | "login" | null {
  const handle = buyerHandleOf(buyer);
  if (handle === null) return null;
  if (handle === fan.platformUserId) return "number";
  const parsed = fanInputOf(fan.platform, handle);
  if (parsed === null) return null;
  if (parsed.platformUserId !== null) return parsed.platformUserId === fan.platformUserId ? "number" : null;
  if (fan.username === null || parsed.username === null) return null;
  const explicit = handle.startsWith("@") || /(?:fansly\.com|onlyfans\.com)\//iu.test(handle);
  const his = explicit ? parsed.username.toLowerCase() === fan.username.toLowerCase() : parsed.username === fan.username;
  return his ? "login" : null;
}

/** The card's fields that hold the fan's own words — what he asked for, the name said, his references: erased with him. */
export const CUSTOM_CARD_FAN_TEXTS = ["name", "task", "notes", "photos", "clothes", "attachments"] as const;

/** «120$», «$120», «120», «120.50 $» → mills; anything else (several sums, words) → null. */
export function priceMillsOf(price: string | undefined): number | null {
  if (price === undefined) return null;
  const match = /^\$?\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*\$?$/u.exec(price.trim());
  if (!match) return null;
  return Number(match[1]) * 1000 + Number((match[2] ?? "0").padEnd(2, "0")) * 10;
}

/** Mills → «120$» / «120.50$», the team's way of writing a price. */
export function priceTextOf(priceMills: number): string {
  const cents = millsToWholeCents(priceMills);
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `${dollars}$` : `${dollars}.${String(rest).padStart(2, "0")}$`;
}

/**
 * A fan as a person gives it, on a platform: a profile link (Fansly, OnlyFans, a ChatSpace chat), `@username`, a
 * username, or the platform's number. Null — nothing usable.
 */
export function fanInputOf(platform: string, text: string): { platformUserId: string | null; username: string | null } | null {
  const value = text.trim();
  if (value === "") return null;
  const chatspace = /chat\.onlymonster\.ai\/accounts\/\d+\/chats\/(\d+)/iu.exec(value);
  if (chatspace) return { platformUserId: chatspace[1]!, username: null };
  const link = /(?:https?:\/\/)?(?:www\.)?(fansly\.com|onlyfans\.com)\/([^/?#\s]+)/iu.exec(value);
  if (link) {
    const site = link[1]!.toLowerCase();
    if ((site === "fansly.com") !== (platform === "fansly")) return null;
    const handle = link[2]!;
    if (site === "onlyfans.com" && /^u\d+$/u.test(handle)) return { platformUserId: handle.slice(1), username: null };
    return { platformUserId: null, username: handle };
  }
  if (/^[1-9]\d{0,29}$/u.test(value)) return { platformUserId: value, username: null };
  const name = value.replace(/^@/u, "");
  return /^[A-Za-z0-9_.-]{1,64}$/u.test(name) ? { platformUserId: null, username: name } : null;
}
