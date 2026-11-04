import {
  PUBLICATION_STATUSES,
  PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES,
  millsFromDollars,
  millsToDecimalString,
  millsToNumber,
  type PublicationKind,
  type PublicationStatus,
} from "@agency_hub_core/shared";
import type { PublicationFinding, PublicationQueueSnapshotWire, PublicationWire } from "@agency_hub_core/contracts";

import { formatAgo, formatDate, formatDay, formatMills, formatMomentAgo, formatWeekdayDay } from "@/lib/format";
import { pageFromSearch } from "@/lib/pageParam";
import { ruPlural } from "@/lib/plural";
import { PUBLICATION_STATUS, OFAPI_OFF_WORD, type StatusTone, type StatusWord } from "@/lib/statusWords";

/**
 * The «Публикации» screen as words and rows ready to print (wall posts through
 * Hub, docs/plans/2026-10-23-wall-posts spec §9; design/screens/publications.md).
 * Pure: the screen renders what this returns, and the bodies it sends are the
 * ones built here.
 *
 * Times are Moscow time: the owner plans the pages' days in it, whatever the
 * viewer's own clock. Money is mills (1000 = $1) on the wire; a person types and
 * reads dollars.
 */

export const PUBLICATIONS_TIME_ZONE = "Europe/Moscow";
/** One read of the list; the screen says when it shows only the first ones. */
export const PUBLICATIONS_LIST_LIMIT = 500;
/** The reads behind «Ждут утверждения», «Исход неизвестен» and «Не вышли»: the home's keys. */
export const PUBLICATIONS_WAITING_LIMIT = 1000;
/** Manual entries of one page in one day shown before «и ещё N». */
export const MANUAL_PER_PAGE_DAY = 20;

// ── words ────────────────────────────────────────────────────────────────────

export const KIND_LABELS: Readonly<Record<PublicationKind, string>> = {
  fyp_post: "Пост в ленту For You",
  subscriber_post: "Пост для подписчиков",
  paid_post: "Платный пост",
  story: "Сториз",
  vault_album: "Альбом медиатеки",
};

/** «Пост в ленту For You» → «пост в ленту For You»: a name keeps its capital. */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The word of a status, as the journal and the filter name it (lib/statusWords.ts). */
export const STATUS_LABELS: Readonly<Record<PublicationStatus, string>> = Object.fromEntries(
  PUBLICATION_STATUSES.map((status) => [status, PUBLICATION_STATUS[status]?.word ?? status]),
) as Record<PublicationStatus, string>;

/** The filter's words: one line for `withdrawn`, which covers both of its meanings. */
export const STATUS_FILTER_LABELS: Readonly<Record<PublicationStatus, string>> = {
  ...STATUS_LABELS,
  withdrawn: "Убран или удалён",
};

const FALLBACK_STATUS: StatusWord = { word: "Нет данных", tone: "off" };

/** One publication's status word: `withdrawn` tells the wall from the schedule by its reason. */
export function statusWord(publication: Pick<PublicationWire, "status" | "statusReason">): StatusWord {
  if (publication.status === "withdrawn" && publication.statusReason === "deleted_after_publish") {
    return PUBLICATION_STATUS.deletedFromWall ?? FALLBACK_STATUS;
  }
  return PUBLICATION_STATUS[publication.status] ?? FALLBACK_STATUS;
}

/** A status in the journal: «Убран из расписания», or «Удалён со стены» by its reason. */
export function journalStatusLabel(status: PublicationStatus, reason: string | null): string {
  return statusWord({ status, statusReason: reason }).word;
}

/** Why a status changed, as the journal says it. */
const EVENT_REASONS: Readonly<Record<string, string>> = {
  edited: "правка",
  cancelled: "отменили",
  answered_went_out: "ответ человека: ушло",
  answered_did_not_go_out: "ответ человека: не ушло",
  account_changed: "сменился аккаунт, привязка или модель страницы",
  content_changed: "содержимое изменилось после утверждения",
  read_by_id: "Hub прочитал пост на площадке",
  matched_by_content: "Hub нашёл пост на площадке по тексту, файлам и времени",
  absent_by_id_schedule_and_posts: "поста нет ни по номеру, ни в расписании, ни среди последних постов",
  absent_by_id_and_live_stories: "сториз нет ни по номеру, ни среди текущих",
  withdrawn: "убран из расписания площадки",
  withdraw_confirmed_by_read: "убран: расписание площадки его больше не показывает",
  withdraw_still_in_schedule: "команда отправлена, но расписание всё ещё показывает пост",
  withdraw_unconfirmed_incomplete: "команда отправлена, проверить не удалось: расписание прочитано неполно",
  withdraw_unconfirmed_read_failed: "команда отправлена, проверить не удалось: расписание не прочиталось",
  found_in_schedule: "Hub нашёл пост в расписании площадки",
  found_in_posts: "Hub нашёл пост на стене",
  found_in_collected_posts: "Hub нашёл пост среди собранных",
  reads_failed: "Hub долго не мог прочитать площадку",
  window_passed: "время отправки прошло, запрос не уходил",
  fansly_file_upload_unsupported: "новые файлы на Fansly Hub пока не загружает",
  still_in_schedule: "после своего времени пост всё ещё в расписании",
  absent_by_id_schedule_and_timeline: "поста нет ни по номеру, ни в расписании, ни в ленте",
  found_in_timeline: "Hub нашёл пост в ленте страницы",
  story_read_unverified: "Hub пока не проверяет сториз Fansly: посмотрите сториз на странице",
  story_not_seen: "Hub не увидел новую сториз на странице",
  story_listed: "Hub нашёл сториз среди сториз страницы",
  story_not_listed: "Hub не нашёл сториз среди сториз страницы — посмотрите страницу",
  too_close_to_schedule: "до времени поста оставалось меньше 5 минут: Fansly ставит пост в расписание заранее, сразу Hub не публикует",
  immediate_post_unverified: "пост «сразу» на Fansly ещё не проверен: Hub ставит посты только в расписание",
  deleted_after_publish: "удалён со стены Fansly: свежее чтение по номеру его больше не показывает",
  delete_still_listed: "удаление отправлено, но Fansly всё ещё показывает пост — посмотрите страницу",
  delete_unconfirmed_read_failed: "удаление отправлено, проверить не удалось: пост по номеру не прочитался — посмотрите страницу",
  "not_sent:upload_complete_500": "Fansly не принял загрузку файла — так бывает, когда этот файл уже есть у модели: выберите его из медиатеки",
  not_sent: "запрос поста не уходил",
  not_approved: "пост больше не утверждён, запрос не уходил",
  approval_form_unreadable: "утверждённую версию не удалось прочитать",
  post_unreadable: "Hub не смог прочитать пост на площадке",
  story_unreadable: "Hub не смог прочитать пост на площадке",
  collected_posts_only: "Hub сверил только с уже собранными постами",
  could_be_unproven: "на площадке есть похожие посты, какой из них этот, неясно",
  several_match: "на площадке есть похожие посты, какой из них этот, неясно",
  post_claimed_by_another: "этот пост уже привязан к другой публикации",
  claimed_by_another: "этот пост уже привязан к другой публикации",
  fansly_unsuccessful: "Fansly ответил отказом",
  upload_not_started: "файлы поста ещё загружаются",
  uploading: "файлы поста ещё загружаются",
};

/** Reasons Hub writes with a detail after a colon: the head says what happened. Most specific first. */
const EVENT_REASON_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["absent_unproven:", "поста не видно, но доказать, что он не вышел, Hub пока не может"],
  ["window_passed after held: ", "время отправки прошло, а отправить не давали — запрос не уходил"],
  ["held: ", "отправку задержали, публикация ждёт — запрос не уходил"],
  ["upload_over_daily_credits:", "загрузка файлов поста вместе с самим постом дороже дневного лимита кредитов OnlyFans API — нужны файлы поменьше или лимит побольше"],
  ["delete_no_answer:", "удаление отправлено, ответ потерян — посмотрите страницу"],
  ["delete_answer_", "удаление отправлено, ответ не прочитан — посмотрите страницу"],
  ["answered_id_claimed:", "этот пост уже привязан к другой публикации"],
  ["no_answer:", "ответ потерян: Hub не знает, ушёл ли пост"],
  ["answer_", "ответ не прочитан: Hub не знает, ушёл ли пост"],
  ["upload_refused:", "Hub не принял файл или запрос до отправки"],
  ["refused_before_send:", "Hub не принял файл или запрос до отправки"],
  ["not_prepared:", "Hub не принял файл или запрос до отправки"],
  ["upload_paused:", "файлы поста ещё загружаются"],
  ["not_sent:", "запрос поста не уходил"],
  ["withdraw_", "команда отправлена, итог не подтверждён — посмотрите страницу"],
  ["delete_", "команда отправлена, итог не подтверждён — посмотрите страницу"],
];

const OTHER_REASON = "Другая причина";

/** A reason in words; the code itself lives only under «Подробнее». */
export function eventReasonLabel(reason: string | null): string | null {
  if (reason === null || reason === "") return null;
  const exact = EVENT_REASONS[reason];
  if (exact !== undefined) return exact;
  if (reason.includes(":answer_without_id") || reason.includes(":answer_without_album")) {
    return "Fansly ответил без номера: Hub не знает, что создано";
  }
  const http = /^fansly_http_(\d{3})/.exec(reason);
  if (http) return `Fansly отказал (ответ ${http[1]})`;
  const prefixed = EVENT_REASON_PREFIXES.find(([prefix]) => reason.startsWith(prefix));
  if (prefixed !== undefined) return prefixed[1];
  return OTHER_REASON;
}

/** Why Hub stopped a page's publishing (a free string, written by code). */
const AUTOSTOP_REASONS: Readonly<Record<string, string>> = {
  browser_login_lost: "Fansly вышел из аккаунта в браузере страницы",
  browser_challenge: "Fansly запросил проверку в браузере страницы",
  fansly_http_401: "Fansly не принял вход (ответ 401)",
  fansly_http_403: "Fansly отказал в запросе публикации (ответ 403)",
  fansly_http_429: "Fansly просит подождать (ответ 429)",
  authorization_refused: "OnlyFans API отказал в доступе к странице",
  vendor_http_401: "OnlyFans API отказал в доступе к странице",
  vendor_http_403: "OnlyFans API отказал в доступе к странице",
  ofapi_account_not_found: "OnlyFans API больше не находит аккаунт страницы",
};

export function autostopReasonLabel(reason: string | null): string {
  if (reason === null || reason === "") return "причина не записана";
  return AUTOSTOP_REASONS[reason] ?? "Причина записана кодом";
}

function count(value: number, one: string, few: string, many: string): string {
  return `${value} ${ruPlural(value, one, few, many)}`;
}

export function postsCountLabel(value: number): string {
  return count(value, "пост", "поста", "постов");
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

/** "3 нояб.", with the year when it is not `todayKey`'s: "30 авг. 2025 г.". */
export function dayDateLabel(dayKey: string, todayKey: string): string {
  return todayKey.slice(0, 4) === dayKey.slice(0, 4) ? formatDay(dayKey) : formatDate(`${dayKey}T12:00:00+03:00`, { includeYear: true });
}

/** "Сегодня, вт 3 нояб.", "Чт, 5 нояб."; another year: "30 авг. 2025 г.". */
export function dayLabel(dayKey: string, todayKey: string): string {
  if (todayKey.slice(0, 4) !== dayKey.slice(0, 4)) return dayDateLabel(dayKey, todayKey);
  const [weekday = "", date = ""] = formatWeekdayDay(dayKey).split(", ");
  const near = dayKey === todayKey ? "Сегодня"
    : dayKey === addDays(todayKey, 1) ? "Завтра"
      : dayKey === addDays(todayKey, -1) ? "Вчера"
        : null;
  return near === null ? `${upperFirst(weekday)}, ${date}` : `${near}, ${weekday} ${date}`;
}

/** "3 нояб., 14:05" (Moscow) for any instant on the screen. */
export function momentLabel(at: string | null, todayKey: string, timeZone = PUBLICATIONS_TIME_ZONE): string {
  if (at === null) return "—";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  return `${dayDateLabel(dayKeyOf(date, timeZone), todayKey)}, ${timeOf(at, timeZone)}`;
}

/** "сегодня 14:05" or "3 нояб., 14:05": the head of a post's panel. */
export function whenLabel(at: string, todayKey: string): string {
  return dayKeyOf(at) === todayKey ? `сегодня ${timeOf(at)}` : momentLabel(at, todayKey);
}

export interface PublicationDay {
  key: string;
  label: string;
  publications: PublicationWire[];
}

/**
 * The publications by their Moscow publish day, earliest first, each day in
 * publish order.
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

// ── the address of a view: page, status, date window, panels ────────────────

export const PUBLICATION_WINDOWS = [
  { key: "next7", label: "7 дней вперёд", phrase: "за 7 дней вперёд" },
  { key: "next30", label: "30 дней вперёд", phrase: "за 30 дней вперёд" },
  { key: "last7", label: "Последние 7 дней", phrase: "за последние 7 дней" },
  { key: "last30", label: "Последние 30 дней", phrase: "за последние 30 дней" },
  { key: "all", label: "Все даты", phrase: "за все даты" },
] as const;
export type PublicationWindow = (typeof PUBLICATION_WINDOWS)[number]["key"];

/** «Не вышли»: three statuses read as one filter. */
export const NOT_OUT_STATUSES = ["not_published", "rejected", "missed"] as const satisfies readonly PublicationStatus[];
export type PublicationStatusFilter = PublicationStatus | "not_out";

export interface PublicationsView {
  pageLabel: string | null;
  status: PublicationStatusFilter | null;
  window: PublicationWindow;
  panel: "settings" | null;
  publication: number | null;
}

const WINDOW_KEYS: ReadonlySet<string> = new Set(PUBLICATION_WINDOWS.map((item) => item.key));
const STATUS_KEYS: ReadonlySet<string> = new Set([...PUBLICATION_STATUSES, "not_out"]);

/** A link edited by hand lands on the screen: anything unknown is the default. */
export function parsePublicationsView(search: URLSearchParams): PublicationsView {
  const status = search.get("status");
  const window = search.get("window");
  const publication = search.get("publication");
  const id = publication !== null && /^\d{1,12}$/.test(publication) ? Number(publication) : 0;
  return {
    pageLabel: pageFromSearch(search),
    status: status !== null && STATUS_KEYS.has(status) ? status as PublicationStatusFilter : null,
    window: window !== null && WINDOW_KEYS.has(window) ? window as PublicationWindow : "next7",
    panel: search.get("panel") === "settings" ? "settings" : null,
    publication: id > 0 ? id : null,
  };
}

/**
 * The address of a change: the view's own parameters set over `base`, every
 * other parameter of `base` kept (`?page=all` included). Defaults are left out.
 * The page is never set here: it is the filter's, chosen through the chip.
 */
export function publicationsSearch(change: Partial<Omit<PublicationsView, "pageLabel">>, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(base);
  const put = (name: string, value: string | null) => {
    if (value === null) next.delete(name);
    else next.set(name, value);
  };
  if ("status" in change) put("status", change.status ?? null);
  if ("window" in change) put("window", change.window === undefined || change.window === "next7" ? null : change.window);
  if ("panel" in change) put("panel", change.panel ?? null);
  if ("publication" in change) put("publication", change.publication == null ? null : String(change.publication));
  return next;
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

/** «за 7 дней вперёд»: the phrase of an empty list. */
export function windowPhrase(window: PublicationWindow): string {
  return PUBLICATION_WINDOWS.find((item) => item.key === window)?.phrase ?? "";
}

// ── money: mills on the wire, dollars for a person ──────────────────────────

/** Who may reply to a Fansly post, as the owner reads it. */
export function replyLockLabel(lock: readonly string[]): string {
  const names: Record<string, string> = { followers: "подписанные на модель", subscribers: "подписчики" };
  return lock.map((who) => names[who] ?? "другие").join(" или ");
}

/** "$15.00", "$9.99"; no price is a dash. */
export function priceLabel(valueMills: number | null): string {
  return valueMills === null ? "—" : formatMills(valueMills);
}

/** "$5–40"; with cents "$5.50–$40.00"; or what a page without a range means. */
export function priceRangeLabel(minMills: number | null, maxMills: number | null): string {
  if (minMills === null || maxMills === null) return "вилка не задана";
  const min = dollarsInput(minMills);
  const max = dollarsInput(maxMills);
  if (!min.includes(".") && !max.includes(".")) return `$${min}–${max}`;
  return `${formatMills(minMills)}–${formatMills(maxMills)}`;
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

/** Whether Hub stopped this page's publishing by itself (an autostop). */
export function isStopped(settings: Pick<PublicationPageSettings, "autostopReason" | "autostoppedAt">): boolean {
  return settings.autostopReason !== null || settings.autostoppedAt !== null;
}

/** «Платные посты $5–40 · не больше 6 постов в сутки». */
export function pageLimitsLine(settings: PublicationPageSettings): string {
  const range = settings.paidPriceMinMills === null || settings.paidPriceMaxMills === null
    ? "Платные посты: вилка не задана"
    : `Платные посты ${priceRangeLabel(settings.paidPriceMinMills, settings.paidPriceMaxMills)}`;
  const limit = settings.dailyLimit === null ? "без предела в сутки"
    : `не больше ${count(settings.dailyLimit, "поста", "постов", "постов")} в сутки`;
  return `${range} · ${limit}`;
}

export function repostLine(days: number): string {
  return `Файл считается повтором, если выходил за последние ${count(days, "день", "дня", "дней")}`;
}

// ── a page's publishing, in one word (spec §1.3, block 3) ───────────────────

export interface PagePublishing {
  /** The strip's word; null: all is well, only the green dot. */
  word: string | null;
  /** The settings panel's badge: always a word. */
  badge: StatusWord;
  tone: StatusTone;
  /** The reason in a sentence: the panel's line, the strip's tooltip. */
  reason: string;
  /** What to press about it. */
  action: "login" | "edit" | "settings" | "refresh" | null;
  /** The hub's raw answer of a failed read: only under «Подробнее». */
  detail: string | null;
  /** Hub does not publish on this page now (rows 1–6). */
  notPublishing: boolean;
  /** Hub stopped it by itself: withdrawals are refused. */
  stopped: boolean;
  /** OnlyFans while its API is off: every write about it is off. */
  ofapiOff: boolean;
}

export interface PagePublishingInput {
  platform: string;
  settings: PublicationPageSettings | undefined;
  globalEnabled: boolean;
  /** Unknown never claims the API is off. */
  ofapi: "on" | "off" | "unknown";
  /** `publishingOnlyfansEnabled`; null when the config did not answer. */
  onlyfansSwitch: boolean | null;
  needsLogin: boolean;
  queue: PublicationQueueSnapshotWire | undefined;
  todayKey: string;
  now?: number;
}

function state(word: string | null, tone: StatusTone, reason: string, action: PagePublishing["action"], extra: Partial<PagePublishing> = {}): PagePublishing {
  return {
    word, badge: { word: word ?? "Публикует", tone }, tone, reason, action, detail: null,
    notPublishing: tone === "off" || tone === "broken", stopped: false, ofapiOff: false, ...extra,
  };
}

/** The first of nine conditions that holds, top down (spec §1.3, block 3). */
export function pagePublishing(input: PagePublishingInput): PagePublishing {
  const { settings, queue, todayKey } = input;
  const onlyfans = input.platform === "onlyfans";
  const stopped = settings !== undefined && isStopped(settings);
  if (onlyfans && input.ofapi === "off") {
    return state(OFAPI_OFF_WORD, "off", "Публикация недоступна: OnlyFans API выключен с 1 ноября.", null, { ofapiOff: true, stopped });
  }
  const stoppedAt = settings?.autostoppedAt ? ` ${momentLabel(settings.autostoppedAt, todayKey)}` : "";
  if (settings?.autostopReason === "browser_login_lost" || (input.needsLogin && !onlyfans)) {
    const reason = settings?.autostopReason === "browser_login_lost"
      ? `Hub остановил публикацию${stoppedAt}: ${autostopReasonLabel("browser_login_lost")}. Посты в расписании Fansly остаются. Войдите в Fansly, потом включите публикацию снова: включение снимает остановку.`
      : "Fansly просит войти заново. Новые посты Hub не поставит.";
    return state("Нужен вход", "broken", reason, "login", { stopped });
  }
  if (stopped) {
    return state("Остановлена", "broken",
      `Hub остановил публикацию${stoppedAt}: ${lowerFirst(autostopReasonLabel(settings?.autostopReason ?? null))}. Включите снова, когда разберётесь: включение снимает остановку.`,
      "edit", { stopped: true });
  }
  if (settings !== undefined && !settings.enabled) {
    return state("Выключена", "off", "Hub не ставит новые посты и не загружает файлы на эту страницу. Уже поставленное остаётся в расписании площадки.", "edit");
  }
  if (!input.globalEnabled) return state("Не публикует", "off", "Общий выключатель выключен.", "settings");
  if (onlyfans && input.onlyfansSwitch === false) {
    return state("Не публикует", "off", "Выключатель «Публикация на OnlyFans» выключен.", null);
  }
  if (queue !== undefined && queue.lastFailure !== null && queue.lastFailedAt !== null
    && (queue.readAt === null || queue.lastFailedAt > queue.readAt)) {
    return state("Расписание не читается", "attention",
      `Последнее чтение расписания не удалось: ${momentLabel(queue.lastFailedAt, todayKey)}.`, "refresh", { detail: queue.lastFailure });
  }
  if (queue !== undefined && queue.stale && queue.readAt !== null) {
    return state("Расписание устарело", "attention",
      `Расписание прочитано ${momentLabel(queue.readAt, todayKey)}, ${formatAgo(queue.readAt, input.now)}.`, "refresh");
  }
  return state(null, "good", "Публикует", null);
}

/** «Расписание прочитано в 14:05, 12 мин назад: постов Hub 3, поставлено вручную 1». */
export function queueReadLine(queue: PublicationQueueSnapshotWire, now: number = Date.now()): string {
  if (queue.readAt === null) return "Расписание ещё не читалось";
  const manual = queue.entries.filter((entry) => entry.publicationId === null).length;
  const moment = formatMomentAgo(queue.readAt, now);
  const today = /^\d{2}:\d{2},/.test(moment);
  return `Расписание прочитано ${today ? "в " : ""}${moment}: постов Hub ${queue.entries.length - manual}, поставлено вручную ${manual}`;
}

// ── one row ──────────────────────────────────────────────────────────────────

/** The start of the text on one line; the panel has it whole. */
export function textStart(text: string, max = 90): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return "Без текста";
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

type MediaItem = PublicationWire["media"][number];

/** «2 файла», «2 файла, 1 превью», «без файлов». */
export function mediaSummary(media: readonly Pick<MediaItem, "role">[]): string {
  const files = media.filter((item) => item.role === "media").length;
  const previews = media.filter((item) => item.role === "preview").length;
  const head = files === 0 ? "без файлов" : count(files, "файл", "файла", "файлов");
  return previews === 0 ? head : `${head}, ${previews} превью`;
}

/** «Пост для подписчиков, 2 файла, 1 превью, перезалив»: the row's second line. */
export function postSubLine(publication: Pick<PublicationWire, "kind" | "media" | "repost">): string {
  return `${KIND_LABELS[publication.kind]}, ${mediaSummary(publication.media)}${publication.repost ? ", перезалив" : ""}`;
}

/** A file of a post by its name, or by what it is. */
export function mediaName(item: Pick<MediaItem, "source" | "name">): string {
  if (item.name) return item.name;
  return item.source === "vault" ? "из медиатеки" : "загруженный файл";
}

/** Every file of a publication of one role and attachment, in order. */
export function mediaOf(media: readonly MediaItem[], role: MediaItem["role"], attachment = 0): MediaItem[] {
  return media.filter((item) => item.role === role && item.attachment === attachment).sort((a, b) => a.position - b.position);
}

/** Who sees an extra attachment of a Fansly post, as the owner reads it. */
export function attachmentAccessLabel(extra: PublicationWire["extraAttachments"][number]): string {
  const tiers = extra.tierRefs.length === 0 ? "" : " выбранных уровней";
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

/** Who wrote it: a person by their login, an agent by its key's name; the number goes under «Подробнее». */
export function authorLabel(author: PublicationWire["author"], names: Names): string {
  if (author.kind === "agent") {
    const name = author.agentKeyId === null ? undefined : names.agentKeys.get(author.agentKeyId);
    return name === undefined ? "агент" : `агент «${name}»`;
  }
  const name = author.userId === null ? undefined : names.users.get(author.userId);
  return name ?? "сотрудник";
}

/** Who moved a status: a person, an agent key, or Hub itself. */
export function actorLabel(event: { actorKind: string; actorUserId: number | null; actorAgentKeyId: number | null }, names: Names): string {
  if (event.actorKind === "hub") return "Hub";
  if (event.actorKind === "agent") {
    const name = event.actorAgentKeyId === null ? undefined : names.agentKeys.get(event.actorAgentKeyId);
    return name ?? "агент";
  }
  const name = event.actorUserId === null ? undefined : names.users.get(event.actorUserId);
  return name ?? "сотрудник";
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
  return dayCount === null ? "много постов" : postsCountLabel(dayCount);
}

/** «Файл 3 из медиатеки», «Загруженный файл 2»: found in the post itself, without the platform's numbers. */
export function mediaKeyLabel(key: string | null, media: readonly MediaItem[] = []): string {
  if (key === null) return "Файл";
  const [source, ref] = key.split(":", 2);
  const item = media.find((candidate) => source === "vault"
    ? candidate.source === "vault" && candidate.mediaRef === ref
    : candidate.source === "file" && String(candidate.fileId) === ref);
  const place = item === undefined ? "" : ` ${item.position + 1}`;
  if (item?.role === "preview") return `Превью${place}`;
  if (source === "vault") return item === undefined ? "Файл из медиатеки" : `Файл${place} из медиатеки`;
  if (source === "file") return `Загруженный файл${place}`;
  return "Файл";
}

/** A finding's day: a bare "YYYY-MM-DD" is a calendar day as Hub counted it, an instant is shown in Moscow. */
function findingDay(at: string | null, todayKey: string): string {
  if (at === null) return "?";
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return dayDateLabel(at, todayKey);
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "?" : dayDateLabel(dayKeyOf(date), todayKey);
}

export const OTHER_FINDING = "Другое замечание";

/** One finding of the draft checks (spec §8.1) as a person reads it. */
export function findingText(finding: PublicationFinding, todayKey: string, media: readonly MediaItem[] = []): string {
  const day = findingDay(finding.at, todayKey);
  const file = mediaKeyLabel(finding.mediaKey, media);
  switch (finding.code) {
    case "publish_time_past":
      return "Время выхода уже прошло";
    case "file_of_another_model":
      return `${file}: файл другой модели, не модели этой страницы`;
    case "media_not_on_page":
      return `${file}: его нет среди файлов этой страницы`;
    case "repost_within_threshold": {
      const where = finding.publicationId !== null ? `уже стоит в другой публикации на ${day}` : `выходил ${day}`;
      const days = detailNumber(finding, "thresholdDays");
      const threshold = days === null ? "" : `, это ближе ${count(days, "дня", "дней", "дней")}`;
      return finding.severity === "blocking"
        ? `${file} ${where}${threshold}. Утвердить можно только с отметкой «перезалив»`
        : `Перезалив: ${lowerFirst(file)} ${where}`;
    }
    case "posted_before":
      return `${file} уже выходил ${day}`;
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
      return "Выбранной стены нет на странице";
    case "wall_default_unknown":
      return "Стена не выбрана, а основную стену страницы Hub не знает";
    case "tier_not_on_page":
      return "Выбранного уровня подписки нет на странице";
    case "onlyfans_file_too_large": {
      const bytes = detailNumber(finding, "byteSize");
      return `${file}${bytes === null ? "" : ` (${Math.ceil(bytes / 1_000_000)} МБ)`}: на OnlyFans Hub загружает файлы до 100 МБ — возьмите файл из медиатеки или поменьше`;
    }
    case "onlyfans_file_upload_unsupported":
      return `${file}: новый файл на OnlyFans тогда загрузить было нельзя — сохраните черновик ещё раз`;
    case "fansly_file_upload_unsupported":
      return `${file}: новые файлы на Fansly Hub пока не загружает — возьмите файл из медиатеки страницы`;
    case "fansly_several_tiers_unsupported":
      return "Пост для нескольких уровней подписки на Fansly Hub пока не ставит — выберите один уровень или всех подписчиков";
    case "platform_schedule_incomplete":
      return "Расписание площадки прочитано не целиком (у OnlyFans дни больше 100 постов, лимит чтений) — повтор файла там мог не попасть в проверку";
    case "file_deleted":
      return `${file}: удалён с сервера через 7 дней после загрузки, загрузите его снова`;
    default:
      return OTHER_FINDING;
  }
}

export const FINDING_TONES: Readonly<Record<PublicationFinding["severity"], string>> = {
  blocking: "post-note-danger",
  warning: "post-note-warning",
  info: "post-note-muted",
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

/** Hub withdraws a post from a platform's schedule only this long before its time or earlier. */
export const WITHDRAW_MIN_LEAD_MINUTES = PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES;

/**
 * «Убрать из расписания»: a Hub post in the platform's schedule, 15 minutes or
 * more before its time, whose command did not leave yet. Undefined = no
 * action; null = it can be pressed; a string = why it cannot now.
 */
export function withdrawBlock(
  publication: Pick<PublicationWire, "platform" | "kind" | "status" | "publishAt" | "withdrawal">,
  pageStopped: boolean,
  now: Date,
): string | null | undefined {
  if (publication.kind === "story" || publication.status !== "scheduled") return undefined;
  if (publication.withdrawal !== null && publication.withdrawal.state !== "prepared") return "Команду уже отправляли: у неё свой исход";
  if (pageStopped) return "Публикация на странице остановлена: убрать нельзя, расписание на площадке осталось";
  if (Date.parse(publication.publishAt) - now.getTime() < WITHDRAW_MIN_LEAD_MINUTES * 60_000) {
    return `До выхода меньше ${WITHDRAW_MIN_LEAD_MINUTES} минут: Hub не убирает — пост мог уже выйти`;
  }
  return null;
}

/**
 * «Удалить со стены» (owner, 2026-10-24): a Fansly post Hub published, out on
 * the wall with its post number, whose deletion did not leave yet. Undefined =
 * no action; null = it can be pressed; a string = why it cannot now.
 */
export function deletePostBlock(
  publication: Pick<PublicationWire, "platform" | "kind" | "status" | "platformPostRef" | "deletion">,
  pageStopped: boolean,
): string | null | undefined {
  if (publication.platform !== "fansly" || publication.kind === "story" || publication.status !== "published" || publication.platformPostRef === null) return undefined;
  if (publication.deletion !== null && publication.deletion.state !== "prepared") return "Команду уже отправляли: у неё свой исход";
  if (pageStopped) return "Публикация на странице остановлена: удалить нельзя, пост на стене остался";
  return null;
}

/** What the owner is told before a deletion, under «Подробнее». */
export const DELETE_POST_CONFIRM_TEXT = "Hub отправит одну команду удаления через браузер страницы, потом прочитает пост по номеру: "
  + "если его больше нет — статус «Удалён со стены». Ответ потерян — «Исход неизвестен», повторно Hub не отправит.";

/** What happened to the deletion Hub sent, while the post is still «Вышел». */
export function deletionNote(publication: Pick<PublicationWire, "status" | "deletion">): string | null {
  const deletion = publication.deletion;
  if (deletion === null || publication.status !== "published") return null;
  if (deletion.state === "prepared") return "удаление не ушло — можно нажать ещё раз";
  if (deletion.state === "dispatching") return "удаление идёт: Hub отправляет его через браузер страницы";
  if (deletion.state === "confirmed") return "Fansly принял удаление — Hub проверяет пост";
  if (deletion.state === "rejected") return "Fansly отказал в удалении: пост на стене, удалите на площадке";
  return null;
}

const DELETE_REASONS: Readonly<Record<string, string>> = {
  not_fansly: "это не пост Fansly",
  story_not_deleted_here: "сториз так не удаляется",
  no_platform_ref: "у публикации нет номера поста на площадке",
  publishing_stopped: "публикация на странице остановлена",
  route_unverified: "это действие на Fansly ещё не проверено",
  delete_in_progress: "удаление уже идёт",
  delete_already_sent: "удаление уже отправляли",
  delete_already_recorded: "удаление уже записано",
  delete_then_read: "Hub удалит и прочитает пост по номеру",
  window_passed: "за 30 минут запрос не ушёл",
  no_sync_page: "страница не подключена к сбору данных",
};

/** One deletion's answer in words. */
export function deletePostResultText(result: { outcome: string; reason: string | null }): string {
  const reason = result.reason ?? "";
  if (result.outcome === "accepted") return "Принято: Hub удалит пост и проверит его по номеру — итог появится в статусе через несколько минут";
  if (reason.startsWith("status_")) return `Не удалён: статус «${STATUS_LABELS[reason.slice("status_".length) as PublicationStatus] ?? "другой"}»`;
  return `Не удалён: ${DELETE_REASONS[reason] ?? "другая причина"}`;
}

/** The platform's name as the screen says it. */
export function platformName(platform: string): string {
  return platform === "fansly" ? "Fansly" : platform === "onlyfans" ? "OnlyFans" : "Telegram";
}

/** What the owner is told before a withdrawal: how Hub does it on that platform. */
export function withdrawConfirmText(platform: PublicationWire["platform"]): string {
  return platform === "fansly"
    ? `Hub попросит браузер страницы свежо прочитать расписание: если пост там есть и до выхода больше ${WITHDRAW_MIN_LEAD_MINUTES} минут, `
      + "отправит одну команду убрать его. Итог — статус публикации через несколько минут. Ответ потерян — «Исход неизвестен», повторно Hub не отправит."
    : `Hub сначала свежо прочитает расписание: если пост там есть и до выхода больше ${WITHDRAW_MIN_LEAD_MINUTES} минут, отправит одну команду удаления. `
      + "Ответ потерян — «Исход неизвестен», повторно Hub не отправит.";
}

/** What happened to the withdrawal Hub sent, when the status alone does not say it. */
export function withdrawalNote(publication: Pick<PublicationWire, "status" | "withdrawal" | "platform">): string | null {
  const withdrawal = publication.withdrawal;
  if (withdrawal === null || publication.status !== "scheduled") return null;
  if (withdrawal.state === "prepared") return "команда убрать пост не ушла — можно нажать ещё раз";
  if (withdrawal.state === "dispatching" && publication.platform === "fansly") return "идёт: Hub читает расписание, потом уберёт пост";
  if (withdrawal.state === "confirmed" && publication.platform === "fansly") return "Fansly принял команду — Hub проверяет расписание";
  if (withdrawal.state === "rejected") return `${platformName(publication.platform)} отказала: пост в расписании, уберите его на площадке`;
  return null;
}

const WITHDRAW_REASONS: Readonly<Record<string, string>> = {
  too_close_to_publish_time: `до выхода меньше ${WITHDRAW_MIN_LEAD_MINUTES} минут`,
  publishing_stopped_schedule_stays: "публикация на странице остановлена — расписание на площадке осталось",
  withdraw_already_sent: "команду уже отправляли",
  not_in_schedule: "свежее расписание его не показывает",
  schedule_ambiguous: "в расписании несколько похожих записей",
  story_has_no_schedule: "у сториз нет расписания",
  not_onlyfans: "это не пост OnlyFans",
  not_fansly: "это не пост Fansly",
  no_platform_ref: "у публикации нет номера на площадке",
  withdrawn: "убран",
  route_unverified: "это действие на Fansly ещё не проверено",
  withdraw_in_progress: "команда уже идёт",
  withdraw_already_recorded: "команда уже записана",
  schedule_read_then_cancel: "Hub прочитает расписание и уберёт пост",
  schedule_not_read: "свежее расписание не прочиталось",
  schedule_not_fresh: "свежее расписание не прочиталось",
  window_passed: `до выхода осталось меньше ${WITHDRAW_MIN_LEAD_MINUTES} минут`,
  no_sync_page: "страница не подключена к сбору данных",
  withdraw_unconfirmed_time_passed: "команда отправлена, но время выхода уже прошло — проверьте страницу",
};

/** One withdrawal's outcome in words. */
export function withdrawResultText(result: { outcome: "withdrawn" | "unknown" | "rejected" | "not_sent" | "refused" | "accepted"; reason: string | null }): string {
  const reason = result.reason ?? "";
  const known = WITHDRAW_REASONS[reason] ?? EVENT_REASONS[reason];
  if (result.outcome === "withdrawn") return "убран из расписания";
  if (result.outcome === "accepted") return "принято: Hub свежо прочитает расписание и уберёт пост — итог появится в статусе через несколько минут";
  if (result.outcome === "unknown") return `исход неизвестен${known ? `: ${known}` : ""} — проверьте вручную`;
  if (result.outcome === "rejected") return "площадка отказала — пост остался в расписании";
  if (result.outcome === "not_sent") return "команда не ушла — можно попробовать ещё раз";
  if (reason.startsWith("schedule_incomplete:")) return `не убран: расписание прочитано неполно (${queueIncompleteText(reason.slice("schedule_incomplete:".length).split(","))})`;
  if (reason.startsWith("schedule_read_failed:")) return "не убран: расписание не прочиталось";
  if (reason.startsWith("status_")) return `не убран: статус «${STATUS_LABELS[reason.slice("status_".length) as PublicationStatus] ?? "другой"}»`;
  return `не убран: ${known ?? "другая причина"}`;
}

/** Fansly's «the whole list, unverified» is permanent and changes nothing: it is not shown. */
const QUEUE_INCOMPLETE_HIDDEN = "list_whole_unverified";

const QUEUE_INCOMPLETE: Readonly<Record<string, string>> = {
  sync_in_process: "OnlyFans ещё собирает данные",
  count_mismatch: "число записей не сходится со счётчиком",
  day_over_100: "в дне больше 100 постов",
  read_budget: "прочитаны не все дни",
  past_days: "прошедшие дни не читаются",
};

function queueIncompleteReason(reason: string): string {
  const [code, detail] = reason.split(":", 2);
  if (code === "entries_unreadable") return `не прочитано записей: ${detail ?? "?"}`;
  return QUEUE_INCOMPLETE[reason] ?? "другая причина";
}

/** The real reasons of an incomplete read; empty when only the hidden one is there. */
export function queueIncompleteReasons(reasons: readonly string[]): string[] {
  return reasons.filter((reason) => reason !== "" && reason !== QUEUE_INCOMPLETE_HIDDEN);
}

export function queueIncompleteText(reasons: readonly string[]): string {
  return queueIncompleteReasons(reasons).map(queueIncompleteReason).join(", ") || "причина не названа";
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
  if (reason === "blocking_findings") return "есть замечания, которые не дают утвердить";
  if (reason === "version_conflict") return "пост изменили, пока вы смотрели: проверьте ещё раз";
  if (reason === "page_inactive") return "страница не активна";
  if (reason === "not_found") return "Hub его не нашёл";
  if (reason.startsWith("status_")) {
    const label = STATUS_LABELS[reason.slice("status_".length) as PublicationStatus];
    return label === undefined ? "у поста уже другой статус" : `пост уже не ждёт утверждения: «${label}»`;
  }
  return "другая причина";
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
      title: publication === null ? "пост"
        : `${publication.pageLabel}, ${momentLabel(publication.publishAt, todayKey)}, ${lowerFirst(KIND_LABELS[publication.kind])}`,
      reason: refusalReasonLabel(result.reason),
      findings: publication === null || result.reason !== "blocking_findings" ? []
        : orderedFindings(publication.findings).filter((finding) => finding.severity === "blocking").map((finding) => findingText(finding, todayKey, publication.media)),
    };
  });
  return { approved: results.length - refused.length, refused };
}

/** A refused action (cancel, resolve, settings) in words; the hub's English is never shown. */
export function actionFailure(error: unknown): string {
  const { status, code } = (typeof error === "object" && error !== null ? error : {}) as { status?: unknown; code?: unknown };
  if (status === 409 && code === "publication_version_conflict") return "Публикацию только что изменили. Список обновлён: посмотрите ещё раз.";
  if (status === 409 && code === "publication_not_editable") return "Уже нельзя: статус публикации изменился. Список обновлён.";
  if (status === 409 && code === "publication_not_unknown") return "Исход уже известен: публикацию разобрали или Hub сам нашёл пост. Список обновлён.";
  if (status === 404) return "Hub не нашёл эту публикацию или страницу. Список обновлён.";
  if (status === 400) return "Hub не принял данные.";
  if (status === 403) return "Это может только владелец.";
  return "Hub не ответил. Проверьте список и попробуйте ещё раз.";
}

// ── approval: the facts of windows A and B (spec §1.4, §5.5) ───────────────

/** Who sees a post of this kind once it is out. */
export function audienceLabel(publication: Pick<PublicationWire, "kind" | "tierRefs" | "priceMills" | "subscribersOnly">): string {
  switch (publication.kind) {
    case "fyp_post": return "Все, кому Fansly покажет ленту For You";
    case "subscriber_post": {
      const who = publication.tierRefs.length > 0 ? "Подписчики выбранных уровней" : "Подписчики страницы";
      return publication.priceMills === null ? who : `${who}, остальные — за ${priceLabel(publication.priceMills)}`;
    }
    case "paid_post": return publication.subscribersOnly ? "Подписчики, которые купят пост" : "Все, кто купит пост";
    case "story": return "Те, кто открывает сториз страницы";
    case "vault_album": return "Никто из фанов: альбом остаётся в медиатеке";
  }
}

/** Whether an approval can be taken back, and until when. */
export function cancelLabel(kinds: readonly PublicationKind[]): string {
  const posts = kinds.some((kind) => kind !== "story" && kind !== "vault_album");
  const stories = kinds.includes("story");
  const albums = kinds.includes("vault_album");
  if (posts && !stories && !albums) return `Можно, но не ближе ${WITHDRAW_MIN_LEAD_MINUTES} минут до выхода`;
  if (stories && !posts && !albums) return "Можно, пока Hub её не отправил: сториз уходит в своё время";
  if (albums && !posts && !stories) return "Можно, пока Hub его не отправил";
  return `Посты — не ближе ${WITHDRAW_MIN_LEAD_MINUTES} минут до выхода, сториз и альбомы — пока Hub их не отправил`;
}

const KIND_COUNTS: Readonly<Record<PublicationKind, (value: number) => string>> = {
  fyp_post: (value) => `${value} в ленту For You`,
  subscriber_post: (value) => `${value} для подписчиков`,
  paid_post: (value) => count(value, "платный", "платных", "платных"),
  story: (value) => `${value} сториз`,
  vault_album: (value) => `${count(value, "альбом", "альбома", "альбомов")} медиатеки`,
};

/** «mia-1, Fansly, модель Mia Hart»: where a write lands, named from the object. */
export function placeLabel(pageLabel: string, platform: string, modelName: string | null | undefined): string {
  return `${pageLabel}, ${platformName(platform)}${modelName ? `, модель ${modelName}` : ""}`;
}

/** «Пост для подписчиков, «Sunday mood: coffee…», 2 файла». */
export function whatLabel(publication: Pick<PublicationWire, "kind" | "text" | "media">): string {
  const text = publication.text.trim() === "" ? "без текста" : `«${textStart(publication.text, 40)}»`;
  return `${KIND_LABELS[publication.kind]}, ${text}, ${mediaSummary(publication.media)}`;
}

export interface ApprovalSummary {
  count: number;
  /** The pages of the selected rows, in order of first appearance: never the filter's. */
  pages: string[];
  title: string;
  confirmLabel: string;
  places: string;
  kinds: string;
  when: string;
  audience: string;
  cancel: string;
  /** «mia-2: Выключена», or null when every page publishes. */
  notNow: string | null;
  toast: string;
}

/**
 * The facts of «Утвердить выбранные» (window B), from the rows themselves:
 * how many, on which pages, what, when, who sees, whether it can be undone.
 */
export function approvalSummary(
  rows: readonly Pick<PublicationWire, "pageLabel" | "kind" | "publishAt">[],
  pageStates: ReadonlyMap<string, Pick<PagePublishing, "notPublishing" | "badge">>,
  todayKey: string,
): ApprovalSummary {
  const perPage = new Map<string, number>();
  const perKind = new Map<PublicationKind, number>();
  for (const row of rows) {
    perPage.set(row.pageLabel, (perPage.get(row.pageLabel) ?? 0) + 1);
    perKind.set(row.kind, (perKind.get(row.kind) ?? 0) + 1);
  }
  const pages = [...perPage.keys()];
  const places = [...perPage.entries()].map(([page, value], index) => `${page} — ${index === 0 ? postsCountLabel(value) : value}`).join(", ");
  const kinds = (Object.keys(KIND_COUNTS) as PublicationKind[]).filter((kind) => perKind.has(kind))
    .map((kind) => KIND_COUNTS[kind](perKind.get(kind) ?? 0)).join(", ");
  const times = rows.map((row) => row.publishAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  const first = times[0] ?? null;
  const last = times.at(-1) ?? null;
  const when = first === null ? "—" : first === last ? momentLabel(first, todayKey) : `${momentLabel(first, todayKey)} – ${momentLabel(last, todayKey)}`;
  const notNow = pages.filter((page) => pageStates.get(page)?.notPublishing).map((page) => `${page}: ${pageStates.get(page)?.badge.word ?? ""}`);
  const n = rows.length;
  return {
    count: n,
    pages,
    title: `Утвердить ${postsCountLabel(n)}?`,
    confirmLabel: `Утвердить ${postsCountLabel(n)}`,
    places,
    kinds,
    when,
    audience: pages.length === 1 ? "Фаны этой страницы" : "Фаны этих страниц",
    cancel: cancelLabel(rows.map((row) => row.kind)),
    notNow: notNow.length === 0 ? null : notNow.join(", "),
    toast: n === 1 ? `Утверждён пост на ${pages[0] ?? ""}.` : `Утверждено ${postsCountLabel(n)}: ${pages.join(", ")}.`,
  };
}

/** «Выбрано 2 поста на mia-1», «Выбрано 4 поста на 3 страницах: mia-1, nova-1, mia-3». */
export function selectionLabel(rows: readonly Pick<PublicationWire, "pageLabel">[]): string {
  const pages = [...new Set(rows.map((row) => row.pageLabel))];
  const head = `Выбрано ${postsCountLabel(rows.length)}`;
  return pages.length === 1 ? `${head} на ${pages[0]}` : `${head} на ${count(pages.length, "странице", "страницах", "страницах")}: ${pages.join(", ")}`;
}

// ── the third line of a row (spec §1.3, block 6) ────────────────────────────

export interface RowNote {
  text: string;
  tone: "danger" | "warning" | "muted";
}

const MOVED_ON: ReadonlySet<PublicationStatus> = new Set(["unknown", "not_published", "rejected", "missed"]);

/** One note under a row, the first that applies; the panel has every one. */
export function rowNote(
  publication: PublicationWire,
  page: Pick<PagePublishing, "notPublishing" | "badge"> | undefined,
  todayKey: string,
): RowNote | null {
  const draft = publication.status === "draft";
  const more = (items: readonly unknown[]) => (items.length > 1 ? ` · ещё ${items.length - 1}` : "");
  const blocking = publication.findings.filter((finding) => finding.severity === "blocking");
  if (draft && blocking[0] !== undefined) {
    return { text: `Нельзя утвердить: ${lowerFirst(findingText(blocking[0], todayKey, publication.media))}${more(blocking)}`, tone: "danger" };
  }
  const commandNote = deletionNote(publication) ?? withdrawalNote(publication);
  if (commandNote !== null) return { text: upperFirst(commandNote), tone: "warning" };
  const reason = eventReasonLabel(publication.statusReason);
  if (MOVED_ON.has(publication.status) && reason !== null) return { text: upperFirst(reason), tone: "muted" };
  if (draft && reason !== null) return { text: `Вернулся в черновики: ${reason}`, tone: "warning" };
  if (publication.status === "approved" && publication.statusReason?.startsWith("held: ") && reason !== null) {
    return { text: upperFirst(reason), tone: "muted" };
  }
  if (publication.status === "approved" && page?.notPublishing) {
    return { text: `${publication.pageLabel} сейчас не публикует: ${page.badge.word}`, tone: "muted" };
  }
  const warnings = publication.findings.filter((finding) => finding.severity === "warning");
  if (draft && warnings[0] !== undefined) {
    return { text: `${findingText(warnings[0], todayKey, publication.media)}${more(warnings)}`, tone: "warning" };
  }
  return null;
}

// ── the feed: posts and the entries put by hand, by day ─────────────────────

type QueueEntry = PublicationQueueSnapshotWire["entries"][number];

export interface ManualEntry {
  entry: QueueEntry;
  pageLabel: string;
  platform: string;
}

/**
 * The platforms' entries without a Hub publication, as the view shows them:
 * the page of the filter, the window's dates, only with no status or
 * «В расписании», and OnlyFans' only while its API is not off.
 */
export function manualFeedRows(
  queues: readonly PublicationQueueSnapshotWire[],
  view: { pageLabel: string | null; status: PublicationStatusFilter | null; window: PublicationWindow },
  range: { from?: string; to?: string },
  ofapiOff: boolean,
): ManualEntry[] {
  if (view.status !== null && view.status !== "scheduled") return [];
  const from = range.from === undefined ? null : Date.parse(range.from);
  const to = range.to === undefined ? null : Date.parse(range.to);
  const rows: ManualEntry[] = [];
  for (const queue of queues) {
    if (view.pageLabel !== null && queue.pageLabel !== view.pageLabel) continue;
    if (ofapiOff && queue.platform === "onlyfans") continue;
    for (const entry of queue.entries) {
      if (entry.publicationId !== null) continue;
      if (entry.publishAt === null) {
        if (view.window === "all") rows.push({ entry, pageLabel: queue.pageLabel, platform: queue.platform });
        continue;
      }
      const at = Date.parse(entry.publishAt);
      if ((from !== null && at < from) || (to !== null && at >= to)) continue;
      rows.push({ entry, pageLabel: queue.pageLabel, platform: queue.platform });
    }
  }
  return rows;
}

export type FeedRow =
  | { kind: "post"; publication: PublicationWire }
  | { kind: "manual"; manual: ManualEntry }
  | { kind: "more"; pageLabel: string; count: number };

export interface FeedDay {
  key: string;
  label: string;
  rows: FeedRow[];
  /** Every row of the day, the hidden manual entries included. */
  total: number;
  manual: number;
}

/** The posts and the entries by hand, day by day, each day in time order. */
export function feedDays(publications: readonly PublicationWire[], manual: readonly ManualEntry[], todayKey: string): FeedDay[] {
  type Item = { at: number; page: string; id: number; row: FeedRow };
  const byDay = new Map<string, Item[]>();
  const undated: ManualEntry[] = [];
  const add = (key: string, item: Item) => {
    const list = byDay.get(key);
    if (list) list.push(item);
    else byDay.set(key, [item]);
  };
  for (const publication of publications) {
    add(dayKeyOf(publication.publishAt), { at: Date.parse(publication.publishAt), page: publication.pageLabel, id: publication.id, row: { kind: "post", publication } });
  }
  for (const item of manual) {
    if (item.entry.publishAt === null) undated.push(item);
    else add(dayKeyOf(item.entry.publishAt), { at: Date.parse(item.entry.publishAt), page: item.pageLabel, id: Number.MAX_SAFE_INTEGER, row: { kind: "manual", manual: item } });
  }
  const days: FeedDay[] = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => {
    items.sort((a, b) => a.at - b.at || a.page.localeCompare(b.page) || a.id - b.id);
    const shownPerPage = new Map<string, number>();
    const hiddenPerPage = new Map<string, number>();
    const rows: FeedRow[] = [];
    let manualCount = 0;
    for (const item of items) {
      if (item.row.kind !== "manual") {
        rows.push(item.row);
        continue;
      }
      manualCount += 1;
      const shown = shownPerPage.get(item.page) ?? 0;
      if (shown < MANUAL_PER_PAGE_DAY) {
        shownPerPage.set(item.page, shown + 1);
        rows.push(item.row);
      } else {
        hiddenPerPage.set(item.page, (hiddenPerPage.get(item.page) ?? 0) + 1);
      }
    }
    for (const [pageLabel, hidden] of hiddenPerPage) rows.push({ kind: "more", pageLabel, count: hidden });
    return { key, label: dayLabel(key, todayKey), rows, total: items.length, manual: manualCount };
  });
  if (undated.length > 0) {
    days.push({
      key: "undated",
      label: "Поставлено вручную, без даты",
      rows: undated.map((item) => ({ kind: "manual" as const, manual: item })),
      total: undated.length,
      manual: undated.length,
    });
  }
  return days;
}

/** «9 постов», «9 постов, из них 2 поставлены вручную». */
export function feedCountLabel(total: number, manual: number): string {
  const head = postsCountLabel(total);
  return manual === 0 ? head : `${head}, из них ${manual} ${ruPlural(manual, "поставлен", "поставлены", "поставлены")} вручную`;
}

/** «Поставлен вручную, 2 файла». */
export function manualSubLine(entry: Pick<QueueEntry, "mediaCount">): string {
  return entry.mediaCount === null ? "Поставлен вручную" : `Поставлен вручную, ${count(entry.mediaCount, "файл", "файла", "файлов")}`;
}

// ── the answer to «Исход неизвестен» (spec §8.2) ─────────────────────────────

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
  const postRefError = postRef !== "" && !/^[0-9A-Za-z_-]{1,64}$/.test(postRef) ? "Номер поста — цифры и латинские буквы, без пробелов" : null;
  if (postRef === "" || postRefError !== null) return { body: null, missing: "Укажите номер поста на площадке", postRefError };
  if (draft.state === null) return { body: null, missing: "Выберите: стоит в расписании или уже вышел", postRefError: null };
  return { body: { outcome: "went_out", state: draft.state, platformPostRef: postRef }, missing: null, postRefError: null };
}
