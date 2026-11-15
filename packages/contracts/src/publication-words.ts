import { millsFromCreditsAt, millsToDecimalString } from "@agency_hub_core/shared";

/**
 * The one table of what Hub's codes about a publication mean, in a person's words: a status's reason, a check of the
 * draft, an approval's refusal, a withdrawal's and a deletion's outcome, a page's stop, a vault album's run. Hub's own
 * screen read them from here when it had one; now the person's door carries them to ContentOps' «Публикации»
 * (products package C2), so no product keeps a second, shorter table. A code this table does not know reads as
 * «другая причина» — never as the code.
 */

const ruPlural = (value: number, one: string, few: string, many: string): string => {
  const n = Math.abs(value) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
};
const count = (value: number, one: string, few: string, many: string) => `${value} ${ruPlural(value, one, few, many)}`;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** A status as one word (the journal, a refusal «уже другой статус»). */
export const PUBLICATION_STATUS_WORDS: Readonly<Record<string, string>> = {
  draft: "Ждёт утверждения",
  approved: "Утверждён",
  submitting: "Ставится",
  scheduled: "В расписании",
  processing: "Обрабатывается",
  published: "Вышел",
  unknown: "Исход неизвестен",
  missed: "Пропущен",
  not_published: "Не вышел",
  rejected: "Отклонён",
  withdrawn: "Убран из расписания",
  cancelled: "Отменён",
};

// ── a status's reason ───────────────────────────────────────────────────────

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
  withdrawn_cancel_acknowledged: "убран: Fansly ответил на снятие, что пост снят, и следующее чтение расписания его не показывает",
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
  // The checks' own codes (publications-fansly-checks.ts, publications-onlyfans-checks.ts: their reason lists).
  not_out_yet: "пост на площадке есть, но его время ещё не пришло",
  id_reads_another_post: "по номеру площадка показывает другой пост",
  still_in_schedule_by_content: "пост с тем же содержимым всё ещё в расписании площадки",
  list_shows_the_id: "номер поста есть в списке площадки, а сам пост не прочитался",
  found_in_schedule_by_id: "Hub нашёл пост по номеру в расписании площадки",
  collected_post_by_id: "Hub нашёл пост по номеру среди собранных",
  no_platform_ref: "у публикации нет номера на площадке",
  posts_incomplete: "посты страницы прочитаны неполно",
  still_processing: "площадка ещё обрабатывает пост",
  still_processing_at_last_check: "при последней проверке площадка всё ещё обрабатывала пост",
  readiness_unknown: "площадка не сказала, готов ли пост",
};

/** A match that is not one post, written after the place the check looked in (`timeline_could_be_unproven`). */
const PLACED_AMBIGUITY = /^(?:timeline|schedule|posts|stories)_(several_match|claimed_by_another|could_be_unproven)$/;

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

/** A status's reason (or a journal row's) in words; null — no reason. */
export function statusReasonWords(reason: string | null): string | null {
  if (reason === null || reason === "") return null;
  const exact = EVENT_REASONS[reason];
  if (exact !== undefined) return exact;
  const placed = PLACED_AMBIGUITY.exec(reason);
  if (placed) return EVENT_REASONS[placed[1]!]!;
  if (reason.startsWith("schedule_incomplete:")) {
    return `расписание площадки прочитано неполно (${queueIncompleteWords(reason.slice("schedule_incomplete:".length).split(","))})`;
  }
  // A vault album's reason (either platform): its parts in words, never «Другая причина».
  const album = albumReasonLine(reason);
  if (album !== null) return lowerFirst(album);
  if (reason.includes(":answer_without_id") || reason.includes(":answer_without_album")) {
    return "Fansly ответил без номера: Hub не знает, что создано";
  }
  const http = /^fansly_http_(\d{3})/.exec(reason);
  if (http) return `Fansly отказал (ответ ${http[1]})`;
  const prefixed = EVENT_REASON_PREFIXES.find(([prefix]) => reason.startsWith(prefix));
  if (prefixed !== undefined) return prefixed[1];
  return OTHER_REASON;
}

/** Why Hub stopped a page's publishing. */
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

export function autostopReasonWords(reason: string | null): string | null {
  if (reason === null || reason === "") return null;
  return AUTOSTOP_REASONS[reason] ?? "Причина записана кодом";
}

// ── outcomes of the actions ─────────────────────────────────────────────────

const statusOf = (reason: string) => PUBLICATION_STATUS_WORDS[reason.slice("status_".length)];

/** Why Hub refused to approve one publication. */
export function approveRefusalWords(reason: string | null): string {
  if (reason === null) return "причина не названа";
  if (reason === "blocking_findings") return "есть замечания, которые не дают утвердить";
  if (reason === "version_conflict") return "пост изменили, пока вы смотрели: проверьте ещё раз";
  if (reason === "page_inactive") return "страница не активна";
  if (reason === "not_found") return "Hub его не нашёл";
  if (reason.startsWith("status_")) {
    const label = statusOf(reason);
    return label === undefined ? "у поста уже другой статус" : `пост уже не ждёт утверждения: «${label}»`;
  }
  return "другая причина";
}

const WITHDRAW_MIN_LEAD_MINUTES = 5;

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

const QUEUE_INCOMPLETE_HIDDEN = "list_whole_unverified";
const QUEUE_INCOMPLETE: Readonly<Record<string, string>> = {
  sync_in_process: "OnlyFans ещё собирает данные",
  count_mismatch: "число записей не сходится со счётчиком",
  day_over_100: "в дне больше 100 постов",
  read_budget: "прочитаны не все дни",
  past_days: "прошедшие дни не читаются",
};

/** Why a platform's schedule was read incompletely, in words (the permanent «whole list unverified» left out). */
export function queueIncompleteWords(reasons: readonly string[]): string {
  return reasons
    .filter((reason) => reason !== "" && reason !== QUEUE_INCOMPLETE_HIDDEN)
    .map((reason) => {
      const [code, detail] = reason.split(":", 2);
      if (code === "entries_unreadable") return `не прочитано записей: ${detail ?? "?"}`;
      return QUEUE_INCOMPLETE[reason] ?? "другая причина";
    })
    .join(", ") || "причина не названа";
}

/** One withdrawal's outcome in words. */
export function withdrawResultWords(result: { outcome: string; reason: string | null }): string {
  const reason = result.reason ?? "";
  const known = WITHDRAW_REASONS[reason] ?? EVENT_REASONS[reason];
  if (result.outcome === "withdrawn") return "Убран из расписания";
  if (result.outcome === "accepted") return "Принято: Hub свежо прочитает расписание и уберёт пост — итог появится в статусе через несколько минут";
  if (result.outcome === "unknown") return `Исход неизвестен${known ? `: ${known}` : ""} — проверьте вручную`;
  if (result.outcome === "rejected") return "Площадка отказала — пост остался в расписании";
  if (result.outcome === "not_sent") return "Команда не ушла — можно попробовать ещё раз";
  if (reason.startsWith("schedule_incomplete:")) {
    return `Не убран: расписание прочитано неполно (${queueIncompleteWords(reason.slice("schedule_incomplete:".length).split(","))})`;
  }
  if (reason.startsWith("schedule_read_failed:")) return "Не убран: расписание не прочиталось";
  if (reason.startsWith("status_")) return `Не убран: статус «${statusOf(reason) ?? "другой"}»`;
  // A test page's refusal and any other sentence Hub wrote in words: as written.
  if (/[а-яё]/i.test(reason)) return `Не убран: ${reason}`;
  return `Не убран: ${known ?? "другая причина"}`;
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
export function deleteResultWords(result: { outcome: string; reason: string | null }): string {
  const reason = result.reason ?? "";
  if (result.outcome === "accepted") return "Принято: Hub удалит пост и проверит его по номеру — итог появится в статусе через несколько минут";
  if (reason.startsWith("status_")) return `Не удалён: статус «${statusOf(reason) ?? "другой"}»`;
  if (/[а-яё]/i.test(reason)) return `Не удалён: ${reason}`;
  return `Не удалён: ${DELETE_REASONS[reason] ?? "другая причина"}`;
}

/**
 * What happened to the withdrawal or the deletion Hub sent, while the status alone does not say it: a withdrawal of a
 * post still «В расписании», a deletion of a post still «Вышел». Null — nothing to say.
 */
export function commandNoteWords(publication: {
  status: string;
  platform: string;
  withdrawal: { state: string } | null;
  deletion: { state: string } | null;
}): string | null {
  const platform = publication.platform === "fansly" ? "Fansly" : publication.platform === "onlyfans" ? "OnlyFans" : "площадка";
  const deletion = publication.deletion;
  if (deletion !== null && publication.status === "published") {
    if (deletion.state === "prepared") return "удаление не ушло — можно нажать ещё раз";
    if (deletion.state === "dispatching") return "удаление идёт: Hub отправляет его через браузер страницы";
    if (deletion.state === "confirmed") return "Fansly принял удаление — Hub проверяет пост";
    if (deletion.state === "rejected") return "Fansly отказал в удалении: пост на стене, удалите на площадке";
  }
  const withdrawal = publication.withdrawal;
  if (withdrawal !== null && publication.status === "scheduled") {
    if (withdrawal.state === "prepared") return "команда убрать пост не ушла — можно нажать ещё раз";
    if (withdrawal.state === "dispatching" && publication.platform === "fansly") return "идёт: Hub читает расписание, потом уберёт пост";
    if (withdrawal.state === "confirmed" && publication.platform === "fansly") return "Fansly принял команду — Hub проверяет расписание";
    if (withdrawal.state === "rejected") return `${platform} отказала: пост в расписании, уберите его на площадке`;
  }
  return null;
}

// ── the checks of a draft ───────────────────────────────────────────────────

export interface FindingLike {
  code: string;
  severity: string;
  mediaKey: string | null;
  at: string | null;
  publicationId: number | null;
  detail: Readonly<Record<string, number | string | null>>;
}

export interface MediaLike {
  role: string;
  position: number;
  source: string;
  mediaRef?: string | null;
  fileId?: number | null;
  name?: string | null;
}

function detailNumber(finding: FindingLike, key: string): number | null {
  const value = finding.detail[key];
  return typeof value === "number" ? value : typeof value === "string" && value !== "" && !Number.isNaN(Number(value)) ? Number(value) : null;
}

const dayFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });

/** A finding's day: a bare «YYYY-MM-DD» is a calendar day as Hub counted it, an instant is Moscow's. */
function findingDay(at: string | null): string {
  if (at === null) return "?";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(at) ? new Date(`${at}T12:00:00+03:00`) : new Date(at);
  return Number.isNaN(date.getTime()) ? "?" : dayFormat.format(date);
}

/** «Файл 3 из медиатеки», «Загруженный файл 2»: found in the post itself, without the platform's numbers. */
function mediaKeyWords(key: string | null, media: readonly MediaLike[]): string {
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

export function bytesWords(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1).replace(".", ",")} ГБ`;
  if (bytes >= 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000_000))} МБ`;
  return `${Math.max(1, Math.round(bytes / 1_000))} КБ`;
}

const dollars = (mills: number | null) => (mills === null ? "?" : `$${(mills / 1000).toFixed(2)}`);

/** One check of a draft as a person reads it. */
export function findingWords(finding: FindingLike, media: readonly MediaLike[] = []): string {
  const day = findingDay(finding.at);
  const file = mediaKeyWords(finding.mediaKey, media);
  const posts = () => {
    const dayCount = detailNumber(finding, "dayCount");
    return dayCount === null ? "много постов" : count(dayCount, "пост", "поста", "постов");
  };
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
    case "price_out_of_range":
      return `Цена ${dollars(detailNumber(finding, "priceMills"))} вне вилки страницы ${dollars(detailNumber(finding, "minMills"))}–${dollars(detailNumber(finding, "maxMills"))}`;
    case "paid_post_off_on_onlyfans":
      return "Платные посты на OnlyFans пока выключены: цену при создании поста ещё не проверили";
    case "volume_high":
      return `${day}: ${posts()}, а обычно ${String(finding.detail.usualPerDay ?? "?").replace(".", ",")} в день`;
    case "daily_limit_exceeded":
      return `${day}: ${posts()} при пределе страницы ${String(finding.detail.dailyLimit ?? "?")} в сутки`;
    case "wall_not_on_page":
      return "Выбранной стены нет на странице";
    case "wall_default_unknown":
      return "Стена не выбрана, а основную стену страницы Hub не знает";
    case "tier_not_on_page":
      return "Выбранного уровня подписки нет на странице";
    case "onlyfans_file_too_large": {
      const bytes = detailNumber(finding, "byteSize");
      if (detailNumber(finding, "byHand") === 1) {
        const named = media.find((item) => item.source === "file" && `file:${item.fileId}` === finding.mediaKey)?.name ?? file;
        const limit = detailNumber(finding, "maxBytes");
        return `${named}${bytes === null ? "" : ` (${bytesWords(bytes)})`}: больше ${limit === null ? "предела" : bytesWords(limit)} — добавить руками`;
      }
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
      return "Другое замечание";
  }
}

// ── a vault album ───────────────────────────────────────────────────────────

const files = (value: number) => count(value, "файл", "файла", "файлов");

/** Why an album waits or was not sent: the executor's admission and steps. */
const HOLD_WORDS: Readonly<Record<string, string>> = {
  publishing_off: "публикация выключена",
  vault_albums_off: "альбомы OnlyFans выключены",
  page_publishing_off: "публикация страницы выключена",
  key_scope_no_vault: "ключ OnlyFans API не пускает в медиатеку",
  vault_credits_paused: "потолок альбомов 0 — пауза",
  vault_credits_day_left: "не хватает дневного потолка",
  balance_low: "мало кредитов на балансе",
  balance_unknown: "баланс кредитов неизвестен",
  page_busy_with_album: "на странице идёт другой альбом",
  album_title_ambiguous: "у страницы несколько альбомов с этим названием",
  lists_not_read: "Hub не прочитал альбомы страницы",
  album_not_read: "Hub не прочитал альбом",
  album_contents_not_read: "Hub не прочитал, что уже в альбоме",
  album_create_not_sent: "создание альбома не ушло",
  album_create: "создание альбома не ушло",
  album_media: "добавление в альбом не ушло",
  album_media_unknown: "добавление в альбом не ушло",
  window_passed: "за 12 часов не начал",
  not_approved: "альбом больше не утверждён",
  approval_form_unreadable: "утверждённую версию не удалось прочитать",
};

/** Why the uploads stopped. */
const STOP_WORDS: Readonly<Record<string, string>> = {
  three_failures: "три сбоя подряд",
  price_exceeded: "трата превысила цену на 10 %",
  authorization_refused: "OnlyFans API отказал в доступе",
  stopped: "загрузки остановлены",
};

export function albumStopWords(code: string | null): string {
  return code === null ? STOP_WORDS.stopped! : STOP_WORDS[code] ?? STOP_WORDS.stopped!;
}

function holdWord(code: string): string | null {
  const head = code.split(":")[0] ?? code;
  return HOLD_WORDS[head] ?? null;
}

export interface AlbumReasonPart {
  text: string;
  /** The files it names, by name. */
  names: string[];
}

const names = (list: string | undefined) => (list === undefined || list === "" ? [] : list.split(",").map((entry) => entry.split("=")[0] ?? entry));

/** A step's reason that says the answer was lost or differed (the album is `unknown`). */
const NOT_CONFIRMED = /_found$|unknown|no_answer|answer_|attempt_missing|request_unreadable/;

function albumPart(part: string): AlbumReasonPart | null {
  const [head = "", ...rest] = part.split(":");
  const tail = rest.join(":");
  const ratio = (value: string | undefined) => {
    const [n = "0", m = "0"] = (value ?? "").split("/");
    return `${n} из ${m}`;
  };
  switch (head) {
    case "files_failed": return { text: `Отказ: ${ratio(rest[0])}`, names: names(rest.slice(1).join(":")) };
    case "files_unknown": return { text: `Исход неизвестен: ${ratio(rest[0])}`, names: names(rest.slice(1).join(":")) };
    case "files_too_big": return { text: `Слишком большие: ${rest[0] ?? "?"} — добавить руками`, names: names(rest.slice(1).join(":")) };
    case "files_not_tried": return { text: `Не пробовали: ${rest[0] ?? "?"} — ${albumStopWords(rest[1] ?? null)}`, names: names(rest.slice(2).join(":")) };
    case "files_missing": return { text: `Нет в альбоме: ${rest[0] ?? "?"}`, names: names(rest.slice(1).join(":")) };
    case "files_not_ready": return { text: `Ещё обрабатываются: ${rest[0] ?? "?"}`, names: names(rest.slice(1).join(":")) };
    case "order_differs": return { text: `Порядок другой с ${rest[0] ?? "?"}-го файла`, names: names(rest.slice(1).join(":")) };
    case "cards_not_renamed": return { text: `Без нового имени: ${rest[0] ?? "?"}`, names: names(rest.slice(1).join(":")) };
    case "album_not_read": return { text: "Альбом не прочитался после заливки", names: [] };
    case "album_gone": return { text: "Альбома больше нет на странице", names: [] };
    case "album_contents_not_read": return { text: "Hub не прочитал, что уже в альбоме", names: [] };
    case "album_create":
      return { text: NOT_CONFIRMED.test(tail) ? "Ответ на создание альбома потерян" : tail.endsWith("_not_read") ? "Альбомы не прочитались после создания" : "Альбом не создан", names: [] };
    case "album_media":
      return { text: tail === "not_sent" ? "Файлы залиты, в альбом не добавлены" : NOT_CONFIRMED.test(tail) ? "Добавление в альбом не подтверждено" : "Файлы не добавились в альбом", names: [] };
    case "album_rename": return { text: "Файлы не переименованы", names: [] };
    case "album_read": return { text: "Альбом не прочитался после заливки", names: [] };
    case "no_file_landed": return { text: "Ни один файл не залит", names: [] };
    case "three_failures":
    case "price_exceeded": return { text: `Загрузки остановлены: ${albumStopWords(head)}`, names: [] };
    case "album_over_daily_credits": return { text: "Дороже всего дневного потолка альбомов", names: [] };
    case "not_sent": {
      const word = holdWord(tail);
      return word === null ? null : { text: `Не отправлен: ${word}`, names: [] };
    }
    default: return null;
  }
}

/** An album's reason in parts, or null when it is not an album's. */
export function albumReasonParts(reason: string | null): AlbumReasonPart[] | null {
  if (reason === null || reason === "") return null;
  if (reason.startsWith("held: ")) {
    const word = holdWord(reason.slice("held: ".length));
    return word === null ? null : [{ text: `Ждёт: ${word}`, names: [] }];
  }
  if (reason.startsWith("not_sent:")) {
    const word = holdWord(reason.slice("not_sent:".length));
    return word === null ? null : [{ text: `Не отправлен: ${word}`, names: [] }];
  }
  const parts = reason.split(";").map(albumPart);
  const known = parts.filter((part): part is AlbumReasonPart => part !== null);
  return known.length === 0 ? null : known;
}

/** An album's reason as one line: its first part, and how many more. */
export function albumReasonLine(reason: string | null): string | null {
  const parts = albumReasonParts(reason);
  if (parts === null) return null;
  const first = parts[0]!.text;
  return parts.length > 1 ? `${first} · ещё ${parts.length - 1}` : first;
}

const numberFormat = new Intl.NumberFormat("ru-RU");

export function creditsWords(value: number): string {
  return `${numberFormat.format(value)} ${ruPlural(value, "кредит", "кредита", "кредитов")}`;
}

/** «≈ $8,17»: dollars of credits (display only). */
export function creditsUsdWords(credits: number, centsPer1000: number): string {
  return `≈ $${millsToDecimalString(millsFromCreditsAt(credits, centsPer1000)).slice(0, -1).replace(".", ",")}`;
}

const FILE_STATE_WORDS: Readonly<Record<string, string>> = {
  pending: "ждёт",
  in_album: "уже в альбоме",
  reused: "уже на странице",
  uploading: "заливается",
  uploaded: "залит",
  failed: "отказ",
  unknown: "неизвестно",
  too_big: "руками",
  not_tried: "не пробовали",
};

export interface AlbumRunLike {
  step: string | null;
  files: number;
  done: number;
  reused: number;
  refused: number;
  unknown: number;
  notTried: number;
  tooBig: number;
  currentFile: string | null;
  estimateCredits: number;
  spentCredits: number;
  stopReason: string | null;
  fileList: ReadonlyArray<{ name: string; bytes: number; state: string; credits: number }>;
  account: { dailyCredits: number; spentToday: number; left: number; balance: number | null; centsPer1000: number } | null;
  linkMaxBytes: number;
}

/** A vault album's run as a person reads it: the progress, the files left out, the price and the day's ceiling. */
export interface AlbumRunWords {
  /** «Залито 31 из 87», or «87 файлов» before it starts. */
  landed: string;
  /** The file going up now. */
  current: string | null;
  /** «Отказ 2 · Исход неизвестен 1 · Руками, больше 1 ГБ 1 · Не пробовали 3». */
  missing: string | null;
  /** Why the uploads stopped. */
  stop: string | null;
  /** «Цена 5 486 кредитов ≈ $8,17» before, «Потрачено 1 200 из 5 486 кредитов» after it starts. */
  price: string;
  /** «Потолок альбомов в сутки 20 000 кредитов · потрачено сегодня 3 000 · осталось 17 000». */
  ceiling: string | null;
  files: Array<{ name: string; size: string; state: string }>;
}

/**
 * `account`: the OnlyFans API account's day ceiling, what is left of it and the balance — agency money, the owner's
 * alone (a content manager reads the album's own run and cost, and why the uploads stopped, in words).
 */
export function albumRunWords(run: AlbumRunLike, options: { account: boolean } = { account: true }): AlbumRunWords {
  const started = run.step !== null;
  const cents = run.account?.centsPer1000 ?? 149;
  const missing = [
    run.refused > 0 ? `Отказ ${run.refused}` : null,
    run.unknown > 0 ? `Исход неизвестен ${run.unknown}` : null,
    run.tooBig > 0 ? `Руками, больше ${bytesWords(run.linkMaxBytes)} ${run.tooBig}` : null,
    run.notTried > 0 ? `Не пробовали ${run.notTried}` : null,
  ].filter((part): part is string => part !== null);
  const account = run.account;
  return {
    landed: started ? `Залито ${run.done + run.reused} из ${run.files}` : files(run.files),
    current: started && run.step !== "done" ? run.currentFile : null,
    missing: missing.length === 0 ? null : missing.join(" · "),
    stop: run.stopReason === null ? null : albumStopWords(run.stopReason),
    price: started
      ? `Потрачено ${numberFormat.format(run.spentCredits)} из ${creditsWords(run.estimateCredits)} ${creditsUsdWords(run.spentCredits, cents)}`
      : `Цена ${creditsWords(run.estimateCredits)} ${creditsUsdWords(run.estimateCredits, cents)}`,
    ceiling: account === null || !options.account
      ? null
      : account.dailyCredits === 0
        ? "Потолок альбомов в сутки 0 — пауза"
        : `Потолок альбомов в сутки ${creditsWords(account.dailyCredits)} · потрачено сегодня ${numberFormat.format(account.spentToday)} · осталось ${numberFormat.format(account.left)}`
          + (account.balance === null ? "" : ` · на балансе ${numberFormat.format(account.balance)}`),
    files: run.fileList.map((file) => ({
      name: file.name,
      size: bytesWords(file.bytes),
      state: started || file.state !== "pending" ? FILE_STATE_WORDS[file.state] ?? "другое" : "",
    })),
  };
}
