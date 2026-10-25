import {
  PUBLICATION_STATUSES,
  millsFromDollars,
  millsToDecimalString,
  millsToNumber,
  type PublicationKind,
  type PublicationStatus,
} from "@agency_hub_core/shared";
import type { PublicationFinding, PublicationWire } from "@agency_hub_core/contracts";

import { ruPlural } from "@/lib/plural";

/**
 * The «Публикации» screen as words and rows ready to print (wall posts through
 * Hub, docs/plans/2026-10-23-wall-posts spec §9). Pure: the pages render what
 * this returns, and the bodies they send are the ones built here.
 *
 * Times are Moscow time, and the screen says so: the owner plans the pages'
 * days in it, whatever the viewer's own clock. Money is mills (1000 = $1) on
 * the wire; a person types and reads dollars.
 */

export const PUBLICATIONS_TIME_ZONE = "Europe/Moscow";
/** One read of the list; the screen says when it shows only the first ones. */
export const PUBLICATIONS_LIST_LIMIT = 500;

// ── words ────────────────────────────────────────────────────────────────────

export const KIND_LABELS: Readonly<Record<PublicationKind, string>> = {
  fyp_post: "FYP-пост",
  subscriber_post: "Пост для подписчиков",
  paid_post: "Платный пост",
  story: "Сториз",
};

/** spec §4, word for word. */
export const STATUS_LABELS: Readonly<Record<PublicationStatus, string>> = {
  draft: "Черновик",
  approved: "Утверждён",
  submitting: "Ставится",
  scheduled: "В расписании",
  processing: "Обрабатывается",
  published: "Вышел",
  not_published: "Не вышел",
  rejected: "Отклонён",
  unknown: "Неизвестно",
  missed: "Пропущен",
  withdrawn: "Снят",
  cancelled: "Отменён",
};

export const STATUS_BADGES: Readonly<Record<PublicationStatus, string>> = {
  draft: "badge",
  approved: "badge badge-info",
  submitting: "badge badge-info",
  scheduled: "badge badge-info",
  processing: "badge badge-info",
  published: "badge badge-success",
  not_published: "badge badge-danger",
  rejected: "badge badge-danger",
  unknown: "badge badge-warning",
  missed: "badge badge-warning",
  withdrawn: "badge",
  cancelled: "badge",
};

/** Why a status changed, as the journal says it. A reason this build does not know prints as Hub wrote it. */
const EVENT_REASONS: Readonly<Record<string, string>> = {
  edited: "правка",
  cancelled: "отменили",
  answered_went_out: "ответ человека: ушло",
  answered_did_not_go_out: "ответ человека: не ушло",
  account_changed: "сменился аккаунт, привязка или модель страницы",
  content_changed: "содержимое изменилось после утверждения",
  read_by_id: "Hub прочитал пост на площадке",
  matched_by_content: "Hub нашёл пост на площадке по тексту, файлам и времени",
  absent_by_id_schedule_and_posts: "поста нет ни по ID, ни в расписании, ни среди последних постов",
  absent_by_id_and_live_stories: "сториз нет ни по ID, ни среди текущих",
  withdrawn: "снят с расписания площадки",
  withdraw_confirmed_by_read: "снят: расписание площадки его больше не показывает",
  withdraw_still_in_schedule: "снятие отправлено, но расписание всё ещё показывает пост",
  withdraw_unconfirmed_incomplete: "снятие отправлено, проверить не удалось: расписание прочитано неполно",
  withdraw_unconfirmed_read_failed: "снятие отправлено, проверить не удалось: расписание не прочиталось",
  found_in_schedule: "Hub нашёл пост в расписании площадки",
  found_in_posts: "Hub нашёл пост на стене",
  found_in_collected_posts: "Hub нашёл пост среди собранных",
  reads_failed: "Hub долго не мог прочитать площадку",
  window_passed: "время отправки прошло, запрос не уходил",
  fansly_file_upload_unsupported: "новые файлы на Fansly Hub пока не загружает",
  still_in_schedule: "после своего времени пост всё ещё в расписании",
  absent_by_id_schedule_and_timeline: "поста нет ни по ID, ни в расписании, ни в ленте",
  found_in_timeline: "Hub нашёл пост в ленте страницы",
  story_read_unverified: "чтение сториз Fansly стенд ещё не проверил — посмотрите сториз на странице",
  story_not_seen: "Hub не увидел новую сториз на странице",
  story_listed: "Hub нашёл сториз среди сториз страницы",
  story_not_listed: "Hub не нашёл сториз среди сториз страницы — посмотрите страницу",
  too_close_to_schedule: "до времени поста оставалось меньше 5 минут: Fansly ставит пост в расписание заранее, сразу Hub не публикует",
  immediate_post_unverified: "пост «сразу» на Fansly ещё не проверен: Hub ставит посты только в расписание",
  deleted_after_publish: "удалён со стены Fansly: свежее чтение по ID его больше не показывает",
  delete_still_listed: "удаление отправлено, но Fansly всё ещё показывает пост — посмотрите страницу",
  delete_unconfirmed_read_failed: "удаление отправлено, проверить не удалось: пост по ID не прочитался — посмотрите страницу",
  "not_sent:upload_complete_500": "Fansly не принял загрузку файла — так бывает, когда этот файл уже есть у модели: выберите его из медиатеки",
};

/** Reasons Hub writes with a detail after a colon: the head says what happened. */
const EVENT_REASON_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["absent_unproven:", "поста не видно, но доказать, что он не вышел, Hub пока не может"],
  ["not_sent:", "запрос поста не уходил"],
  ["delete_no_answer:", "удаление отправлено, ответ потерян — посмотрите страницу"],
  ["delete_answer_", "удаление отправлено, ответ не прочитан — посмотрите страницу"],
];

export function eventReasonLabel(reason: string | null): string | null {
  if (reason === null || reason === "") return null;
  const exact = EVENT_REASONS[reason];
  if (exact !== undefined) return exact;
  const prefixed = EVENT_REASON_PREFIXES.find(([prefix]) => reason.startsWith(prefix));
  if (prefixed !== undefined) return `${prefixed[1]} (${reason.slice(prefixed[0].length)})`;
  return EVENT_REASONS[reason] ?? reason;
}

function count(value: number, one: string, few: string, many: string): string {
  return `${value} ${ruPlural(value, one, few, many)}`;
}

export function publicationsCountLabel(value: number): string {
  return count(value, "публикация", "публикации", "публикаций");
}

// ── Moscow days and times ────────────────────────────────────────────────────

type DateParts = Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;

/** One formatter per zone: a list of 500 rows asks for a few thousand dates. */
const ZONE_FORMATS = new Map<string, Intl.DateTimeFormat>();

function zoneParts(at: Date, timeZone: string): DateParts {
  let format = ZONE_FORMATS.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    ZONE_FORMATS.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The calendar day of an instant in `timeZone`, as "YYYY-MM-DD". */
export function dayKeyOf(at: Date | string, timeZone = PUBLICATIONS_TIME_ZONE): string {
  const date = typeof at === "string" ? new Date(at) : at;
  const parts = zoneParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** "14:05" in `timeZone`. */
export function timeOf(at: string, timeZone = PUBLICATIONS_TIME_ZONE): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = zoneParts(date, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** The day `days` after a "YYYY-MM-DD" day (negative: before). */
export function addDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The instant a "YYYY-MM-DD" day starts in `timeZone`, as an ISO string (UTC). */
export function dayStartIso(dayKey: string, timeZone = PUBLICATIONS_TIME_ZONE): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day);
  // The zone's offset at that moment; a second pass covers a day whose
  // midnight sits on the other side of a clock change from the guess.
  const offsetAt = (instant: number) => {
    const parts = zoneParts(new Date(instant), timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first)).toISOString();
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** "24 октября", with the year when it is not `todayKey`'s. */
export function dayDateLabel(dayKey: string, todayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const sameYear = todayKey.startsWith(`${year}-`);
  return `${day} ${MONTHS[month - 1]}${sameYear ? "" : ` ${year}`}`;
}

/** "Сегодня, пятница, 24 октября"; a day further away has its weekday and date only. */
export function dayLabel(dayKey: string, todayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  const near = dayKey === todayKey ? "Сегодня"
    : dayKey === addDays(todayKey, 1) ? "Завтра"
      : dayKey === addDays(todayKey, -1) ? "Вчера"
        : null;
  const date = `${weekday}, ${dayDateLabel(dayKey, todayKey)}`;
  return near === null ? date.charAt(0).toUpperCase() + date.slice(1) : `${near}, ${date}`;
}

/** "24 октября, 14:05" (Moscow) for any instant on the screen. */
export function momentLabel(at: string | null, todayKey: string, timeZone = PUBLICATIONS_TIME_ZONE): string {
  if (at === null) return "—";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  return `${dayDateLabel(dayKeyOf(date, timeZone), todayKey)}, ${timeOf(at, timeZone)}`;
}

export interface PublicationDay {
  key: string;
  label: string;
  publications: PublicationWire[];
}

/**
 * The publications by their Moscow publish day, earliest first, each day in
 * publish order. The screen prints one block per day.
 */
export function groupPublicationsByDay(
  publications: readonly PublicationWire[],
  todayKey: string,
  timeZone = PUBLICATIONS_TIME_ZONE,
): PublicationDay[] {
  const ordered = [...publications].sort((a, b) =>
    (Date.parse(a.publishAt) - Date.parse(b.publishAt)) || a.pageLabel.localeCompare(b.pageLabel) || a.id - b.id);
  const days: PublicationDay[] = [];
  for (const publication of ordered) {
    const key = dayKeyOf(publication.publishAt, timeZone);
    const last = days.at(-1);
    if (last?.key === key) last.publications.push(publication);
    else days.push({ key, label: dayLabel(key, todayKey), publications: [publication] });
  }
  return days;
}

// ── the address of a view: page, status and date window ─────────────────────

export const PUBLICATION_WINDOWS = [
  { key: "next7", label: "7 дней вперёд" },
  { key: "next30", label: "30 дней вперёд" },
  { key: "last7", label: "Последние 7 дней" },
  { key: "last30", label: "Последние 30 дней" },
  { key: "all", label: "Все даты" },
] as const;
export type PublicationWindow = (typeof PUBLICATION_WINDOWS)[number]["key"];

export interface PublicationsView {
  pageLabel: string | null;
  status: PublicationStatus | null;
  window: PublicationWindow;
}

const WINDOW_KEYS: ReadonlySet<string> = new Set(PUBLICATION_WINDOWS.map((item) => item.key));
const STATUS_KEYS: ReadonlySet<string> = new Set(PUBLICATION_STATUSES);

/** A link edited by hand lands on the screen: anything unknown is the default. */
export function parsePublicationsView(search: URLSearchParams): PublicationsView {
  const page = search.get("page");
  const status = search.get("status");
  const window = search.get("window");
  return {
    pageLabel: page !== null && page !== "" ? page : null,
    status: status !== null && STATUS_KEYS.has(status) ? status as PublicationStatus : null,
    window: window !== null && WINDOW_KEYS.has(window) ? window as PublicationWindow : "next7",
  };
}

/** The query string of a view; defaults are left out. */
export function publicationsSearch(view: PublicationsView): URLSearchParams {
  const search = new URLSearchParams();
  if (view.pageLabel !== null) search.set("page", view.pageLabel);
  if (view.status !== null) search.set("status", view.status);
  if (view.window !== "next7") search.set("window", view.window);
  return search;
}

/**
 * The publish-time window of a view as the API takes it (`from` inclusive,
 * `to` exclusive). Built from the Moscow day, not from the clock, so the query
 * stays the same all day long. "Days ahead" start at today's midnight and the
 * last days end at tomorrow's: both include today.
 */
export function windowRange(window: PublicationWindow, todayKey: string, timeZone = PUBLICATIONS_TIME_ZONE): { from?: string; to?: string } {
  const span = (fromDays: number, toDays: number) => ({
    from: dayStartIso(addDays(todayKey, fromDays), timeZone),
    to: dayStartIso(addDays(todayKey, toDays), timeZone),
  });
  switch (window) {
    case "next7": return span(0, 7);
    case "next30": return span(0, 30);
    case "last7": return span(-6, 1);
    case "last30": return span(-29, 1);
    case "all": return {};
  }
}

// ── money: mills on the wire, dollars for a person ──────────────────────────

/** "$9.99", "$15" (a whole price without cents); no price is a dash. */
/** Who may reply to a Fansly post, as the owner reads it. */
export function replyLockLabel(lock: readonly string[]): string {
  const names: Record<string, string> = { followers: "подписанные на модель", subscribers: "подписчики" };
  return lock.map((who) => names[who] ?? who).join(" или ");
}

export function priceLabel(valueMills: number | null): string {
  return valueMills === null ? "—" : `$${dollarsInput(valueMills)}`;
}

/** "$5–$30", or what a page without a range means. */
export function priceRangeLabel(minMills: number | null, maxMills: number | null): string {
  if (minMills === null || maxMills === null) return "вилка не задана";
  return `${priceLabel(minMills)}–${priceLabel(maxMills)}`;
}

/** Mills as the text of a dollars field: 5000 → "5", 9990 → "9.99", 5500 → "5.50". */
export function dollarsInput(valueMills: number | null): string {
  if (valueMills === null) return "";
  const [whole, fraction = "000"] = millsToDecimalString(valueMills).split(".");
  if (/^0+$/.test(fraction)) return whole ?? "0";
  const cents = fraction.slice(0, 2);
  // A price that is not whole cents (Hub never sets one) keeps every digit.
  return fraction.endsWith("0") ? `${whole}.${cents}` : `${whole}.${fraction}`;
}

/**
 * A dollars field → mills. Accepts "9", "9.99", "9,99", "$9.99"; empty is no
 * value. Whole cents only: a platform price has no tenth of a cent. Converted
 * by the shared money codec, never through a float.
 */
export function parseDollars(text: string): { mills: number | null; error: string | null } {
  const normalized = text.trim().replace(/^\$\s*/, "").replace(",", ".");
  if (normalized === "") return { mills: null, error: null };
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(normalized)) {
    return { mills: null, error: "Сумма в долларах, например 9.99" };
  }
  const mills = millsToNumber(millsFromDollars(normalized));
  if (mills <= 0) return { mills: null, error: "Сумма больше нуля" };
  return { mills, error: null };
}

// ── page settings ────────────────────────────────────────────────────────────

/** One page's publishing settings as the hub answers them. */
export interface PublicationPageSettings {
  pageLabel: string;
  platform: string;
  enabled: boolean;
  autostopReason: string | null;
  autostoppedAt: string | null;
  paidPriceMinMills: number | null;
  paidPriceMaxMills: number | null;
  repostThresholdDays: number;
  dailyLimit: number | null;
  updatedAt: string | null;
}

export interface PublicationSettingsBody {
  enabled: boolean;
  paidPriceMinMills: number | null;
  paidPriceMaxMills: number | null;
  repostThresholdDays: number;
  dailyLimit: number | null;
}

export interface SettingsDraft {
  enabled: boolean;
  priceMin: string;
  priceMax: string;
  repostDays: string;
  dailyLimit: string;
}

export type SettingsErrors = Partial<Record<"priceMin" | "priceMax" | "price" | "repostDays" | "dailyLimit", string>>;

export function settingsDraftFrom(settings: PublicationPageSettings): SettingsDraft {
  return {
    enabled: settings.enabled,
    priceMin: dollarsInput(settings.paidPriceMinMills),
    priceMax: dollarsInput(settings.paidPriceMaxMills),
    repostDays: String(settings.repostThresholdDays),
    dailyLimit: settings.dailyLimit === null ? "" : String(settings.dailyLimit),
  };
}

function wholeNumber(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/** The settings body the editor sends, or what stops it (the hub's contract, in words). */
export function settingsForm(draft: SettingsDraft): { body: PublicationSettingsBody | null; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const min = parseDollars(draft.priceMin);
  const max = parseDollars(draft.priceMax);
  if (min.error !== null) errors.priceMin = min.error;
  if (max.error !== null) errors.priceMax = max.error;
  if (min.error === null && max.error === null) {
    if ((min.mills === null) !== (max.mills === null)) {
      errors.price = "Задайте обе границы или оставьте обе пустыми";
    } else if (min.mills !== null && max.mills !== null && min.mills > max.mills) {
      errors.price = "Нижняя граница больше верхней";
    }
  }
  const repostDays = wholeNumber(draft.repostDays, 1, 365);
  if (repostDays === null) errors.repostDays = "Целое число дней от 1 до 365";
  const dailyLimit = draft.dailyLimit.trim() === "" ? null : wholeNumber(draft.dailyLimit, 1, 10_000);
  if (draft.dailyLimit.trim() !== "" && dailyLimit === null) errors.dailyLimit = "Целое число от 1 до 10 000 или пусто";
  if (Object.keys(errors).length > 0 || repostDays === null) return { body: null, errors };
  return {
    body: {
      enabled: draft.enabled,
      paidPriceMinMills: min.mills,
      paidPriceMaxMills: max.mills,
      repostThresholdDays: repostDays,
      dailyLimit,
    },
    errors,
  };
}

export type PageState = { tone: "ok" | "off" | "stopped"; label: string };

/** A page's publishing in two words; the autostop wins over the switch. */
export function pageState(settings: Pick<PublicationPageSettings, "enabled" | "autostopReason">): PageState {
  if (settings.autostopReason !== null) return { tone: "stopped", label: "Автостоп" };
  return settings.enabled ? { tone: "ok", label: "Включена" } : { tone: "off", label: "Выключена" };
}

// ── one row ──────────────────────────────────────────────────────────────────

/** The start of the text on one line; the cell's tooltip has it whole. */
export function textStart(text: string, max = 90): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return "без текста";
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

type MediaItem = PublicationWire["media"][number];

function mediaRefLabel(item: MediaItem): string {
  return item.source === "vault" ? `волт ${item.mediaRef ?? "?"}` : `файл №${item.fileId ?? "?"}`;
}

/** "2 файла: волт 8812, файл №3", then the previews of a paid post. */
export function mediaSummary(media: readonly MediaItem[]): string {
  const files = media.filter((item) => item.role === "media").sort((a, b) => a.position - b.position);
  const previews = media.filter((item) => item.role === "preview");
  const shown = files.slice(0, 2).map(mediaRefLabel);
  const rest = files.length - shown.length;
  const head = files.length === 0 ? "без файлов"
    : `${count(files.length, "файл", "файла", "файлов")}: ${shown.join(", ")}${rest > 0 ? ` и ещё ${rest}` : ""}`;
  return previews.length === 0 ? head : `${head}; превью: ${previews.length}`;
}

/** Every file of a publication, for the detail view. */
export function mediaList(media: readonly MediaItem[], role: MediaItem["role"], attachment = 0): string[] {
  return media.filter((item) => item.role === role && item.attachment === attachment).sort((a, b) => a.position - b.position).map(mediaRefLabel);
}

/** Who sees an extra attachment of a Fansly post, as the owner reads it. */
export function attachmentAccessLabel(extra: PublicationWire["extraAttachments"][number]): string {
  const tiers = extra.tierRefs.length === 0 ? "" : ` (уровни ${extra.tierRefs.join(", ")})`;
  switch (extra.access) {
    case "everyone":
      return "всем";
    case "subscribers":
      return extra.priceMills === null ? `подписчикам${tiers}` : `подписчикам${tiers} бесплатно, остальным за ${priceLabel(extra.priceMills)}`;
    case "paid":
      return extra.subscribersOnly ? `только подписчикам${tiers} за ${priceLabel(extra.priceMills)}` : `за ${priceLabel(extra.priceMills)}`;
  }
}

export interface Names {
  users: ReadonlyMap<number, string>;
  agentKeys: ReadonlyMap<number, string>;
}

/** Who wrote it: a person by their login, an agent by its key's name. */
export function authorLabel(author: PublicationWire["author"], names: Names): string {
  if (author.kind === "agent") {
    const name = author.agentKeyId === null ? undefined : names.agentKeys.get(author.agentKeyId);
    return name === undefined ? `агент, ключ №${author.agentKeyId ?? "?"}` : `агент «${name}»`;
  }
  const name = author.userId === null ? undefined : names.users.get(author.userId);
  return name ?? `человек №${author.userId ?? "?"}`;
}

/** Who moved a status: a person, an agent key, or Hub itself. */
export function actorLabel(event: { actorKind: string; actorUserId: number | null; actorAgentKeyId: number | null }, names: Names): string {
  if (event.actorKind === "hub") return "Hub";
  return authorLabel({
    kind: event.actorKind === "agent" ? "agent" : "human",
    userId: event.actorUserId,
    agentKeyId: event.actorAgentKeyId,
  }, names);
}

// ── findings ────────────────────────────────────────────────────────────────

function detailNumber(finding: PublicationFinding, key: string): number | null {
  const value = finding.detail[key];
  return typeof value === "number" ? value : typeof value === "string" && value !== "" && !Number.isNaN(Number(value)) ? Number(value) : null;
}

function detailText(finding: PublicationFinding, key: string): string {
  const value = finding.detail[key];
  return value === null || value === undefined ? "?" : String(value);
}

/** "6 постов" in the day the finding is about, this publication included. */
function postsCount(finding: PublicationFinding): string {
  const dayCount = detailNumber(finding, "dayCount");
  return dayCount === null ? "много постов" : count(dayCount, "пост", "поста", "постов");
}

function mediaKeyLabel(key: string | null): string {
  if (key === null) return "Файл";
  const [source, ref] = key.split(":", 2);
  if (source === "vault") return `Файл волта ${ref ?? ""}`.trim();
  if (source === "file") return `Загруженный файл №${ref ?? ""}`.trim();
  return `Файл ${key}`;
}

/** A finding's day: a bare "YYYY-MM-DD" is a calendar day as Hub counted it, an instant is shown in Moscow. */
function findingDay(at: string | null, todayKey: string): string {
  if (at === null) return "?";
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return dayDateLabel(at, todayKey);
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : dayDateLabel(dayKeyOf(date), todayKey);
}

/** One finding of the draft checks (spec §8.1) as a person reads it. */
export function findingText(finding: PublicationFinding, todayKey: string): string {
  const day = findingDay(finding.at, todayKey);
  const media = mediaKeyLabel(finding.mediaKey);
  switch (finding.code) {
    case "publish_time_past":
      return "Время выхода уже прошло";
    case "file_of_another_model":
      return `${media}: файл другой модели, не модели этой страницы`;
    case "media_not_on_page":
      return `${media}: его нет среди медиа этой страницы`;
    case "repost_within_threshold": {
      const where = finding.publicationId !== null ? `уже стоит в публикации №${finding.publicationId} на ${day}`
        : `выходил ${day}${finding.postRef === null ? "" : ` (пост ${finding.postRef})`}`;
      const days = detailNumber(finding, "thresholdDays");
      const threshold = days === null ? "" : `, это ближе ${count(days, "дня", "дней", "дней")}`;
      return finding.severity === "blocking"
        ? `${media} ${where}${threshold}. Утвердить можно только с отметкой «перезалив»`
        : `Перезалив: ${media.charAt(0).toLowerCase()}${media.slice(1)} ${where}`;
    }
    case "posted_before":
      return `${media} уже выходил ${day}${finding.postRef === null ? "" : ` (пост ${finding.postRef})`}`;
    case "price_range_not_set":
      return "У страницы не задана вилка цен платных постов";
    case "price_out_of_range": {
      const price = detailNumber(finding, "priceMills");
      return `Цена ${priceLabel(price)} вне вилки страницы ${priceRangeLabel(detailNumber(finding, "minMills"), detailNumber(finding, "maxMills"))}`;
    }
    case "paid_post_off_on_onlyfans":
      return "Платные посты на OnlyFans пока выключены: цену при создании поста ещё не проверили";
    case "volume_high":
      return `${day}: ${postsCount(finding)}, а обычно ${detailText(finding, "usualPerDay").replace(".", ",")} в день`;
    case "daily_limit_exceeded":
      return `${day}: ${postsCount(finding)} при пределе страницы ${detailText(finding, "dailyLimit")} в сутки`;
    case "wall_not_on_page":
      return `Стены ${detailText(finding, "wallRef")} нет на странице`;
    case "wall_default_unknown":
      return "Стена не выбрана, а основную стену страницы Hub не знает";
    case "tier_not_on_page":
      return `Уровня подписки ${detailText(finding, "tierRef")} нет на странице`;
    case "onlyfans_file_too_large": {
      const bytes = detailNumber(finding, "byteSize");
      return `${media}${bytes === null ? "" : ` (${Math.ceil(bytes / 1_000_000)} МБ)`}: на OnlyFans Hub загружает файлы до 100 МБ — возьмите файл из волта или поменьше`;
    }
    case "onlyfans_file_upload_unsupported":
      return `${media}: новый файл на OnlyFans тогда загрузить было нельзя — сохраните черновик ещё раз`;
    case "fansly_file_upload_unsupported":
      return `${media}: новые файлы на Fansly Hub пока не загружает — возьмите файл из волта страницы`;
    case "fansly_several_tiers_unsupported":
      return "Пост для нескольких уровней подписки на Fansly Hub пока не ставит — выберите один уровень или всех подписчиков";
    default:
      return finding.code;
  }
}

export const FINDING_TONES: Readonly<Record<PublicationFinding["severity"], string>> = {
  blocking: "text-danger",
  warning: "text-warning-dark",
  info: "text-text-muted",
};

/** Blocking first: they are why a draft cannot be approved. */
export function orderedFindings(findings: readonly PublicationFinding[]): PublicationFinding[] {
  const rank = { blocking: 0, warning: 1, info: 2 } as const;
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ── actions ─────────────────────────────────────────────────────────────────

/** A draft with no blocking finding: what «Утвердить» and the selection accept. */
export function isApprovable(publication: Pick<PublicationWire, "status" | "blocked">): boolean {
  return publication.status === "draft" && !publication.blocked;
}

/** Cancelled before Hub sends it: a draft or an approved one (spec §4). */
export function isCancellable(publication: Pick<PublicationWire, "status">): boolean {
  return publication.status === "draft" || publication.status === "approved";
}

/** Hub withdraws a post from OnlyFans' schedule only this long before its time or earlier. */
export const WITHDRAW_MIN_LEAD_MINUTES = 15;

/**
 * «Снять» (plan PR 5b): a Hub post in OnlyFans' schedule, 15 minutes or more
 * before its time, whose withdrawal did not leave yet. Undefined = no button;
 * null = it can be pressed; a string = why it cannot now.
 */
export function withdrawBlock(
  publication: Pick<PublicationWire, "platform" | "kind" | "status" | "publishAt" | "withdrawal">,
  pageStopped: boolean,
  now: Date,
): string | null | undefined {
  if (publication.kind === "story" || publication.status !== "scheduled") return undefined;
  if (publication.withdrawal !== null && publication.withdrawal.state !== "prepared") return "Снятие уже отправляли: у него свой исход";
  if (pageStopped) return "Публикация на странице остановлена: снять нельзя, расписание на площадке осталось";
  if (Date.parse(publication.publishAt) - now.getTime() < WITHDRAW_MIN_LEAD_MINUTES * 60_000) {
    return "До выхода меньше 15 минут: Hub не снимает — пост мог уже выйти";
  }
  return null;
}

/**
 * «Удалить с площадки» (owner, 2026-10-24): a Fansly post Hub published, out
 * on the wall with its post id, whose deletion did not leave yet. Undefined =
 * no button; null = it can be pressed; a string = why it cannot now.
 */
export function deletePostBlock(
  publication: Pick<PublicationWire, "platform" | "kind" | "status" | "platformPostRef" | "deletion">,
  pageStopped: boolean,
): string | null | undefined {
  if (publication.platform !== "fansly" || publication.kind === "story" || publication.status !== "published" || publication.platformPostRef === null) return undefined;
  if (publication.deletion !== null && publication.deletion.state !== "prepared") return "Удаление уже отправляли: у него свой исход";
  if (pageStopped) return "Публикация на странице остановлена: удалить нельзя, пост на стене остался";
  return null;
}

/** What the owner is told before a deletion. */
export const DELETE_POST_CONFIRM_TEXT = "Пост исчезнет с ленты Fansly. Hub отправит одну команду удаления через браузер страницы, "
  + "потом прочитает пост по ID: если его больше нет — статус «Снят». Ответ потерян — «Неизвестно», повторно Hub не отправит.";

/** What happened to the deletion Hub sent, while the post is still «Вышел». */
export function deletionNote(publication: Pick<PublicationWire, "status" | "deletion">): string | null {
  const deletion = publication.deletion;
  if (deletion === null || publication.status !== "published") return null;
  const why = deletion.errorCode ? ` (${DELETE_REASONS[deletion.errorCode] ?? deletion.errorCode})` : "";
  if (deletion.state === "prepared") return `удаление не ушло${why} — можно нажать ещё раз`;
  if (deletion.state === "dispatching") return "удаление идёт: Hub отправляет его через браузер страницы";
  if (deletion.state === "confirmed") return "Fansly принял удаление — Hub проверяет пост по ID";
  if (deletion.state === "rejected") return `Fansly отказал в удалении${deletion.errorCode ? ` (${deletion.errorCode})` : ""}: пост на стене, удалите на площадке`;
  return null;
}

const DELETE_REASONS: Readonly<Record<string, string>> = {
  not_fansly: "это не пост Fansly",
  story_not_deleted_here: "сториз так не удаляется",
  no_platform_ref: "у публикации нет ID поста на площадке",
  publishing_stopped: "публикация на странице остановлена",
  route_unverified: "удаление с Fansly ещё не проверено",
  delete_in_progress: "удаление уже идёт",
  delete_already_sent: "удаление уже отправляли",
  delete_already_recorded: "удаление уже записано",
  delete_then_read: "Hub удалит и прочитает пост по ID",
  window_passed: "за 30 минут запрос не ушёл",
  no_sync_page: "страница не подключена к синхронизации",
};

/** One deletion's answer in words. */
export function deletePostResultText(result: { outcome: string; reason: string | null }): string {
  const reason = result.reason ?? "";
  if (result.outcome === "accepted") return "Принято: Hub удалит пост и проверит по ID — итог появится в статусе через несколько минут";
  if (reason.startsWith("status_")) return `Не удалён: статус «${STATUS_LABELS[reason.slice("status_".length) as PublicationStatus] ?? reason}»`;
  return `Не удалён: ${DELETE_REASONS[reason] ?? reason}`;
}

/** The platform's name as the screen says it. */
export function platformName(platform: PublicationWire["platform"]): string {
  return platform === "fansly" ? "Fansly" : "OnlyFans";
}

/** What the owner is told before a withdrawal: how Hub does it on that platform. */
export function withdrawConfirmText(platform: PublicationWire["platform"]): string {
  return platform === "fansly"
    ? "Hub попросит браузер страницы свежо прочитать расписание: если пост там есть и до выхода больше 15 минут, отправит одну "
      + "команду снятия. Итог — статус публикации через несколько минут. Ответ потерян — «Неизвестно», повторно Hub не отправит."
    : "Hub сначала свежо прочитает расписание: если пост там есть и до выхода больше 15 минут, отправит одну команду удаления. "
      + "Ответ потерян — исход «Неизвестно», повторно Hub не отправит.";
}

/** What happened to the withdrawal Hub sent, when the status alone does not say it. */
export function withdrawalNote(publication: Pick<PublicationWire, "status" | "withdrawal" | "platform">): string | null {
  const withdrawal = publication.withdrawal;
  if (withdrawal === null || publication.status !== "scheduled") return null;
  const why = withdrawal.errorCode ? ` (${WITHDRAW_REASONS[withdrawal.errorCode] ?? withdrawal.errorCode})` : "";
  if (withdrawal.state === "prepared") return `снятие не ушло${publication.platform === "fansly" ? why : ""} — можно нажать ещё раз`;
  if (withdrawal.state === "dispatching" && publication.platform === "fansly") return "снятие идёт: Hub читает расписание, потом снимает";
  if (withdrawal.state === "confirmed" && publication.platform === "fansly") return "Fansly принял снятие — Hub проверяет расписание";
  if (withdrawal.state === "rejected") return `${platformName(publication.platform)} отказал в снятии${withdrawal.errorCode ? ` (${withdrawal.errorCode})` : ""}: пост в расписании, снимите на площадке`;
  return null;
}

const WITHDRAW_REASONS: Readonly<Record<string, string>> = {
  too_close_to_publish_time: "до выхода меньше 15 минут",
  publishing_stopped_schedule_stays: "публикация на странице остановлена — расписание на площадке осталось",
  withdraw_already_sent: "снятие уже отправляли",
  not_in_schedule: "свежее расписание его не показывает",
  schedule_ambiguous: "в расписании несколько похожих записей",
  story_has_no_schedule: "у сториз нет расписания",
  not_onlyfans: "это не пост OnlyFans",
  not_fansly: "это не пост Fansly",
  no_platform_ref: "у публикации нет ID на площадке",
  withdrawn: "снят",
  route_unverified: "снятие с Fansly ещё не проверено на тестовом аккаунте",
  withdraw_in_progress: "снятие уже идёт",
  withdraw_already_recorded: "снятие уже записано",
  schedule_read_then_cancel: "Hub прочитает расписание и снимет",
  schedule_not_read: "свежее расписание не прочиталось",
  schedule_not_fresh: "свежее расписание не прочиталось",
  window_passed: "до выхода осталось меньше 15 минут",
  no_sync_page: "страница не подключена к синхронизации",
  withdraw_unconfirmed_time_passed: "снятие отправлено, но время выхода уже прошло — проверьте страницу",
};

/** One withdrawal's outcome in words. */
export function withdrawResultText(result: { outcome: "withdrawn" | "unknown" | "rejected" | "not_sent" | "refused" | "accepted"; reason: string | null }): string {
  const reason = result.reason ?? "";
  const known = WITHDRAW_REASONS[reason] ?? EVENT_REASONS[reason];
  if (result.outcome === "withdrawn") return "снят с расписания";
  if (result.outcome === "accepted") return "принято: Hub свежо прочитает расписание и снимет — итог появится в статусе через несколько минут";
  if (result.outcome === "unknown") return `исход неизвестен${known ? `: ${known}` : ""} — разберите вручную`;
  if (result.outcome === "rejected") return `площадка отказала${reason ? ` (${reason})` : ""} — пост остался в расписании`;
  if (result.outcome === "not_sent") return "команда не ушла — можно попробовать ещё раз";
  if (reason.startsWith("schedule_incomplete:")) return `не снят: расписание прочитано неполно (${queueIncompleteText(reason.slice("schedule_incomplete:".length).split(","))})`;
  if (reason.startsWith("schedule_read_failed:")) return "не снят: расписание не прочиталось";
  if (reason.startsWith("status_")) return `не снят: статус «${STATUS_LABELS[reason.slice("status_".length) as PublicationStatus] ?? reason}»`;
  return `не снят: ${known ?? reason}`;
}

const QUEUE_INCOMPLETE: Readonly<Record<string, string>> = {
  sync_in_process: "OnlyFans ещё синхронизирует",
  count_mismatch: "число записей не сходится со счётчиком",
  day_over_100: "в дне больше 100 постов",
  read_budget: "прочитаны не все дни",
  past_days: "прошедшие дни не читаются",
  list_whole_unverified: "что Fansly отдаёт всё расписание целиком, стенд ещё не подтвердил",
};

function queueIncompleteReason(reason: string): string {
  const [code, detail] = reason.split(":", 2);
  if (code === "entries_unreadable") return `не прочитано записей: ${detail ?? "?"}`;
  return QUEUE_INCOMPLETE[reason] ?? reason;
}

export function queueIncompleteText(reasons: readonly string[]): string {
  return reasons.filter((reason) => reason !== "").map(queueIncompleteReason).join(", ") || "причина не названа";
}

/**
 * The approve body for the selection: the versions the person saw, in the
 * order the screen shows them (the hub approves in this order, so a file
 * twice in one batch is refused on its second, later copy).
 */
export function approvalItems(
  shown: readonly Pick<PublicationWire, "id" | "version" | "status" | "blocked">[],
  selected: ReadonlySet<number>,
): Array<{ id: number; version: number }> {
  return shown.filter((item) => selected.has(item.id) && isApprovable(item)).map(({ id, version }) => ({ id, version }));
}

/** Why the hub refused to approve one publication. */
export function refusalReasonLabel(reason: string | null): string {
  if (reason === null) return "причина не названа";
  if (reason === "blocking_findings") return "есть блокирующие замечания";
  if (reason === "version_conflict") return "её изменили, пока вы смотрели: проверьте ещё раз";
  if (reason === "page_inactive") return "страница не активна";
  if (reason === "not_found") return "Hub её не нашёл";
  if (reason.startsWith("status_")) {
    const status = reason.slice("status_".length);
    const label = STATUS_LABELS[status as PublicationStatus];
    return label === undefined ? `статус ${status}` : `она уже не черновик: «${label}»`;
  }
  return reason;
}

export interface ApprovalRefusal {
  id: number;
  title: string;
  reason: string;
  findings: string[];
}

/** The hub's per-item answer to an approval, as the screen reports it. */
export function approvalOutcome(
  results: ReadonlyArray<{ id: number; outcome: "approved" | "refused"; reason: string | null; publication: PublicationWire | null }>,
  todayKey: string,
): { approved: number; refused: ApprovalRefusal[] } {
  const refused = results.filter((result) => result.outcome === "refused").map((result) => {
    const publication = result.publication;
    return {
      id: result.id,
      title: publication === null ? `№${result.id}`
        : `${publication.pageLabel}, ${momentLabel(publication.publishAt, todayKey)}, ${KIND_LABELS[publication.kind].toLowerCase()}`,
      reason: refusalReasonLabel(result.reason),
      findings: publication === null || result.reason !== "blocking_findings" ? []
        : orderedFindings(publication.findings).filter((finding) => finding.severity === "blocking").map((finding) => findingText(finding, todayKey)),
    };
  });
  return { approved: results.length - refused.length, refused };
}

/** A refused action (cancel, resolve, settings) in words; the hub's English is never shown alone. */
export function actionFailure(error: unknown): string {
  const { status, code, message } = (typeof error === "object" && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown };
  if (status === 409 && code === "publication_version_conflict") return "Публикацию только что изменили. Список обновлён: посмотрите ещё раз.";
  if (status === 409 && code === "publication_not_editable") return "Уже нельзя: статус публикации изменился. Список обновлён.";
  if (status === 409 && code === "publication_not_unknown") return "Исход уже известен: публикацию разобрали или Hub сам нашёл пост. Список обновлён.";
  if (status === 404) return "Hub не нашёл эту публикацию или страницу. Список обновлён.";
  if (status === 400) return `Hub не принял данные${typeof message === "string" && message !== "" ? `: ${message}` : ""}.`;
  if (status === 403) return "Это может только владелец.";
  return "Hub не ответил. Проверьте список и попробуйте ещё раз.";
}

// ── the answer to «Неизвестно» (spec §8.2) ───────────────────────────────────

export interface ResolveDraft {
  outcome: "went_out" | "did_not_go_out" | null;
  state: "scheduled" | "published" | null;
  postRef: string;
}

export const EMPTY_RESOLVE_DRAFT: ResolveDraft = { outcome: null, state: null, postRef: "" };

export type ResolveBody =
  | { outcome: "went_out"; state: "scheduled" | "published"; platformPostRef: string }
  | { outcome: "did_not_go_out" };

/** The resolve body, or the one thing still missing. */
export function resolveForm(draft: ResolveDraft): { body: ResolveBody | null; missing: string | null; postRefError: string | null } {
  if (draft.outcome === null) return { body: null, missing: "Выберите, ушёл ли пост", postRefError: null };
  if (draft.outcome === "did_not_go_out") return { body: { outcome: "did_not_go_out" }, missing: null, postRefError: null };
  const postRef = draft.postRef.trim();
  const postRefError = postRef !== "" && !/^[0-9A-Za-z_-]{1,64}$/.test(postRef) ? "ID поста — цифры и латинские буквы, без пробелов" : null;
  if (postRef === "" || postRefError !== null) return { body: null, missing: "Укажите ID поста на площадке", postRefError };
  if (draft.state === null) return { body: null, missing: "Выберите: стоит в расписании или уже вышел", postRefError: null };
  return { body: { outcome: "went_out", state: draft.state, platformPostRef: postRef }, missing: null, postRefError: null };
}
