import type { Platform } from "@agency_hub_core/shared";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  checkNewPassword,
  previousBusinessDate,
} from "@agency_hub_core/shared";

// Decision 349 (PLAN §2 "Словарь"): everything a person reads on /join and
// /account is written in terms of ЛОГИН, ПАРОЛЬ and УСТРОЙСТВА. The words
// «токен», «ключ», «API», «bearer», «активация», «резервация», «префикс» do not
// appear here — `tests/dashboard-account-copy-vocabulary.test.ts` scans every
// string in this directory and fails if one does.

/** The one static guide both clients and the "done" screen link to. */
export const START_GUIDE_URL = "https://ext.gosling-agency.ru/start.html";

interface ClientOffer {
  platform: Platform;
  label: string;
  href: string;
}

/**
 * One offer per platform, keyed by platform so a new platform is a map entry
 * and not a branch (the platform-branch ratchet: no `platform ===` anywhere in
 * the dashboard's own code).
 */
const CLIENT_OFFERS = new Map<Platform, ClientOffer>([
  ["fansly", {
    platform: "fansly",
    label: "Установить расширение для Fansly",
    href: "https://ext.gosling-agency.ru/install.html",
  }],
  ["onlyfans", {
    platform: "onlyfans",
    label: "Скачать приложение для OnlyFans",
    href: "https://ext.gosling-agency.ru/desktop/",
  }],
]);

const PLATFORM_LABELS = new Map<Platform, string>([
  ["fansly", "Fansly"],
  ["onlyfans", "OnlyFans"],
]);

export function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS.get(platform) ?? platform;
}

/**
 * The "done" screen offers only the clients this person actually needs — the
 * platforms of the pages assigned to them, in a stable order, deduplicated.
 */
export function clientOffersForPlatforms(platforms: readonly Platform[]): ClientOffer[] {
  const wanted = new Set(platforms);
  return [...CLIENT_OFFERS.values()].filter((offer) => wanted.has(offer.platform));
}

/** Pages grouped by platform for «Кто я», in the catalogue's own order. */
export function groupPagesByPlatform<T extends { platform: Platform }>(
  pages: readonly T[],
): { platform: Platform; label: string; pages: T[] }[] {
  const groups = new Map<Platform, T[]>();
  for (const page of pages) {
    const bucket = groups.get(page.platform);
    if (bucket) bucket.push(page);
    else groups.set(page.platform, [page]);
  }
  return [...groups.entries()].map(([platform, items]) => ({
    platform,
    label: platformLabel(platform),
    pages: items,
  }));
}

const ROLE_LABELS: Record<string, string> = {
  owner: "владелец",
  team_lead: "старший",
  chatter: "чаттер",
  content_manager: "контент-менеджер",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

// --- The password a person chooses through a link (§4.2, shared rule) ---

export const PASSWORD_HINT =
  `Не короче ${PASSWORD_MIN_LENGTH} символов. Подойдёт любая фраза, которую помнишь только ты.`;

const POLICY_MESSAGES: Record<string, string> = {
  too_short: `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов.`,
  too_long: `Пароль должен быть не длиннее ${PASSWORD_MAX_LENGTH} символов.`,
  common: "Такой пароль слишком простой — его легко угадать. Придумай другой.",
};

/**
 * The same rule the kernel enforces, run locally so the person is told before
 * the round trip. The server stays authoritative: a rejection there is shown
 * with the same wording (see `redeemFailureMessage`).
 */
export function passwordProblem(password: string, confirmation: string): string | null {
  const verdict = checkNewPassword(password);
  if (verdict !== "ok") return POLICY_MESSAGES[verdict] ?? POLICY_MESSAGES.too_short!;
  if (password !== confirmation) return "Пароли не совпадают.";
  return null;
}

/** The password rule for the cabinet's own change form (contract: 8…256). */
export const CHANGE_PASSWORD_MIN_LENGTH = 8;

export function changePasswordProblem(
  newPassword: string,
  confirmation: string,
): string | null {
  if (newPassword.length < CHANGE_PASSWORD_MIN_LENGTH) {
    return `Новый пароль должен быть не короче ${CHANGE_PASSWORD_MIN_LENGTH} символов.`;
  }
  if (newPassword.length > PASSWORD_MAX_LENGTH) {
    return `Новый пароль должен быть не длиннее ${PASSWORD_MAX_LENGTH} символов.`;
  }
  if (newPassword !== confirmation) return "Пароли не совпадают.";
  return null;
}

// --- Link states -------------------------------------------------------

/** One sentence for every way a link can be unusable — state, 404 or 409. */
export const LINK_UNUSABLE_MESSAGE = "Ссылка недействительна. Попроси новую у владельца.";

export type LinkKind = "invite" | "password_reset";

export function joinHeadline(kind: LinkKind, username: string): string {
  return kind === "password_reset"
    ? `${username}, придумай новый пароль`
    : `Привет, ${username}! Придумай пароль для ChatGoose`;
}

export function joinSubheadline(kind: LinkKind): string {
  return kind === "password_reset"
    ? "Все прежние входы завершены — после нового пароля войди заново на каждом устройстве."
    : "Логин уже есть — осталось придумать пароль, с которым ты будешь входить.";
}

export function doneHeadline(kind: LinkKind): string {
  return kind === "password_reset" ? "Новый пароль сохранён" : "Готово";
}

/**
 * Turns a failed redemption into one honest sentence. A password the server
 * refused reads as a password problem; anything about the link itself reads as
 * the single "ask for a new one" line.
 */
export function redeemFailureMessage(
  error: { status: number | null; reason?: string | null } | null,
): string {
  const status = error?.status ?? null;
  if (status === 400) {
    return "Такой пароль не подходит: он слишком простой или слишком короткий. Придумай другой.";
  }
  if (status === 429) {
    return "Слишком много попыток. Подожди минуту и попробуй снова.";
  }
  if (status === 404 || status === 409) return LINK_UNUSABLE_MESSAGE;
  return "Не получилось сохранить пароль. Попробуй ещё раз.";
}

/** The secret arrives in the URL fragment and nowhere else (§4.1 п.2). */
export function readLinkToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

// --- The cabinet's spend window ---------------------------------------

export const USAGE_WINDOW_DAYS = 30;

/** The last 30 business days ending today, inclusive. */
export function usageWindow(today: string): { from: string; to: string } {
  let from = today;
  for (let index = 1; index < USAGE_WINDOW_DAYS; index += 1) {
    from = previousBusinessDate(from);
  }
  return { from, to: today };
}

export function dailyRowFor(
  daily: readonly { date: string; requestCount: number; costMicroUsd: number }[],
  businessDate: string,
): { date: string; requestCount: number; costMicroUsd: number } {
  return daily.find((row) => row.date === businessDate)
    ?? { date: businessDate, requestCount: 0, costMicroUsd: 0 };
}

const FEATURE_LABELS: Record<string, string> = {
  "fast-reply": "Быстрый ответ",
  "fan-summary": "Досье фана",
  "improve-draft": "Улучшить черновик",
  "help-me": "Подсказка",
  "chat-review": "Разбор переписки",
  "scan": "Скан",
  "ping": "Пинг",
  "hi-greeting": "Приветствие",
  "coach-chat": "Коуч",
  "voice-script": "Голосовой сценарий",
};

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

/** «вход 3 дня назад» — the only device metadata a person ever sees. */
export function lastSeenLabel(lastUsedAt: string | null, now: Date = new Date()): string {
  if (!lastUsedAt) return "ещё не входили";
  const then = new Date(lastUsedAt).getTime();
  if (Number.isNaN(then)) return "ещё не входили";
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));
  if (minutes < 5) return "вход только что";
  if (minutes < 60) return `вход ${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `вход ${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вход вчера";
  return `вход ${days} дн назад`;
}
