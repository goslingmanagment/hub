import { millsToWholeCents } from "@agency_hub_core/shared";
import {
  cardOf,
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
 * In work it is `paid` once a sale pays it (or it says so), else `ordered`; given or closed is `delivered`; a
 * cancelled order or the model's refusal is `cancelled`.
 */
export function extensionStateOf(order: { state: CustomOrderState; payments: number }): "ordered" | "paid" | "delivered" | "cancelled" {
  if (order.state === "given" || order.state === "closed") return "delivered";
  if (order.state === "cancelled" || order.state === "refused") return "cancelled";
  return order.state === "paid" || order.payments > 0 ? "paid" : "ordered";
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
        const found = /K-([1-9]\d{0,15})/u.exec(rest);
        code = found ? Number(found[1]) : null;
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
 * Whether a buyer's string (an order no fan of the page was matched for keeps it as the card named him) names this
 * fan: his profile link, @handle, username or the platform's number. A name alone («Том») names nobody.
 */
export function buyerNamesFan(buyer: string, fan: { platform: string; platformUserId: string; username: string | null }): boolean {
  const handle = buyerHandleOf(buyer);
  if (handle === null) return false;
  if (handle === fan.platformUserId) return true;
  const parsed = fanInputOf(fan.platform, handle);
  if (parsed === null) return false;
  if (parsed.platformUserId !== null) return parsed.platformUserId === fan.platformUserId;
  return fan.username !== null && parsed.username !== null && parsed.username.toLowerCase() === fan.username.toLowerCase();
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
