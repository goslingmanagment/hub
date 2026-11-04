import type { NotificationsIncidentItem } from "@agency_hub_core/contracts";

import { buildPageSectionRoute } from "@/lib/navigation";

/**
 * The failures that are only the switched-off OnlyFans API: while it is off there
 * is nothing to repair, so they wait for nobody. One rule for the count on Главная
 * and the grey group on «Сбои» (design/screens/system.md §4, block 5): the two
 * cannot differ. The rest of the failures' words is the system group's and lives
 * here too.
 */
export function isOfapiOffFailure(item: Pick<NotificationsIncidentItem, "kind" | "platform" | "incidentKey">): boolean {
  // A late answer to OnlyFans' letter can freeze the page's money.
  if (item.kind === "ofapi_platform_notice") return false;
  if (item.kind.startsWith("ofapi_")) return true;
  if (item.platform === "onlyfans" && item.kind !== "chatspace_tab") return true;
  // golden_signal_lag:global:ofapi_delivery_history_age opened half an hour after the key went.
  return item.incidentKey.includes(":ofapi_");
}

export type FailureKind = NotificationsIncidentItem["kind"];

/** The name of a failure by its kind (design/ia.md §5.2). */
export const FAILURE_KIND_LABELS = {
  auth_blocked: "Вход заблокирован",
  proxy_failed: "Прокси не работает",
  proxy_missing: "Нет прокси",
  stream_failed_threshold: "Сбор падает 3 раза подряд",
  ofapi_auth: "OnlyFans API: доступ отклонён",
  ofapi_binding_conflict: "OnlyFans API: конфликт привязки",
  ofapi_low_credit: "Мало кредитов OnlyFans API",
  ofapi_webhook_silence: "События OnlyFans API замолчали",
  ofapi_burn_rate: "Кредиты сгорают необычно быстро",
  db_disk_usage: "База: мало места",
  observations_partitions: "База: разделы журнала",
  wrong_transactions_writer: "Операции пишет не тот процесс",
  read_gateway_capture: "Сбор: шлюз чтения",
  golden_signal_lag: "Отставание ключевых метрик",
  scheduler_silent: "Планировщик молчит",
  ops_sampler_silent: "Сбор метрик молчит",
  sync_silent: "Сбор Fansly молчит",
  fansly_sync_engine: "Сбор Fansly: сбой",
  ofapi_chargebacks_reconcile_failed: "Сверка возвратов OnlyFans",
  ofapi_link_stats_reconcile_failed: "Сверка статистики ссылок OnlyFans",
  ai_provider_billing: "ИИ: проблема с оплатой",
  ai_provider_failed: "ИИ: поставщик не отвечает",
  capture_payload_parity: "Расхождение сохранённых данных",
  publishing_stopped: "Hub остановил публикацию",
  publication_not_published: "Пост не вышел",
  ofapi_platform_notice: "OnlyFans написал странице",
  chatspace_tab: "Вкладка ChatSpace на сервере",
} satisfies Record<FailureKind, string>;

export function failureKindLabel(kind: string): string {
  return (FAILURE_KIND_LABELS as Record<string, string>)[kind] ?? "Сбой";
}

/** The filter's groups: the business kinds first. */
export const FAILURE_KIND_GROUPS: ReadonlyArray<{ label: string; kinds: readonly FailureKind[] }> = [
  {
    label: "Страницы и сбор данных",
    kinds: ["auth_blocked", "proxy_failed", "proxy_missing", "stream_failed_threshold", "sync_silent", "fansly_sync_engine", "publishing_stopped", "publication_not_published", "ofapi_platform_notice", "chatspace_tab"],
  },
  {
    label: "OnlyFans API",
    kinds: ["ofapi_auth", "ofapi_binding_conflict", "ofapi_low_credit", "ofapi_burn_rate", "ofapi_webhook_silence", "ofapi_chargebacks_reconcile_failed", "ofapi_link_stats_reconcile_failed"],
  },
  { label: "ИИ", kinds: ["ai_provider_billing", "ai_provider_failed"] },
  {
    label: "Система",
    kinds: ["db_disk_usage", "observations_partitions", "wrong_transactions_writer", "read_gateway_capture", "golden_signal_lag", "scheduler_silent", "ops_sampler_silent", "capture_payload_parity"],
  },
];

/** Where a failure is repaired: a link, never a write. */
export interface FailureFix {
  label: string;
  to: string;
}

export interface FailureWords {
  title: string;
  /** «Что случилось». */
  what: string;
  /** «Что делать». */
  todo: string;
  /** The button «где чинить»; null: the visible button is «Закрыть сбой». */
  fix: FailureFix | null;
}

/** `kind:<page|global>:<tail>`: the tail tells cases of one kind apart. */
export function failureKeyTail(incidentKey: string): string {
  return incidentKey.split(":").slice(2).join(":");
}

const PASS_ON = "Передайте разработчику.";
const BY_ITSELF = "Обычно проходит сам.";

const COLLECTION: FailureFix = { label: "Сбор данных", to: "/system/collection" };
const AI_MONEY: FailureFix = { label: "Деньги на ИИ", to: "/money/costs/ai" };
const DATABASE: FailureFix = { label: "База данных", to: "/system/dev/database" };
const QUEUE: FailureFix = { label: "Очередь задач", to: "/system/dev/queue" };
const OFAPI: FailureFix = { label: "OnlyFans API", to: "/system/onlyfans-api" };

function pageCollection(page: string | null): FailureFix {
  return page === null ? COLLECTION : { label: "Сбор данных страницы", to: `/system/collection/${encodeURIComponent(page)}` };
}

function login(page: string | null): FailureFix {
  return page === null ? COLLECTION : { label: "Войти в Fansly", to: buildPageSectionRoute(page, "browser-login") };
}

const BROWSER_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  login_required: ["Fansly вышел из аккаунта в браузере страницы.", "Войдите в Fansly заново."],
  browser_down: ["Браузер страницы недоступен: страница не собирается.", "Посмотрите браузер под «Подробнее»."],
  proxy: ["Браузер не может дойти до Fansly через прокси.", "Проверьте прокси."],
  exit_ip_changed: ["У прокси сменился выходной IP. Браузер стоит до вашего решения.", "Решение и команда — на экране сбора страницы."],
  buffer: ["Браузер копит то, что не успел передать в Hub. На пределе страница остановится.", PASS_ON],
  selftest_failed: ["Самопроверка браузера не прошла. Страница стоит.", PASS_ON],
  protocol_changed: ["Fansly изменил протокол. Страница стоит.", PASS_ON],
  cdp_lost: ["Потеряно управление Chrome. Запрос мог уйти.", PASS_ON],
  site_unconfirmed: ["Запросы сайта ждут записи в Hub больше 2 минут.", BY_ITSELF],
  socket_cut: ["Защита разорвала один сокет сайта. Страница работает.", BY_ITSELF],
  exit_ip_unknown: ["Выходной IP не подтверждён: запросы Hub ждут, сайт работает.", "Проверка повторится сама."],
  browser_degraded: ["У браузера своя неполадка. Страница работает.", PASS_ON],
};

/** What a collection key is, for a person: the keys a live-path failure names. */
const ENGINE_RESOURCE_WORDS: Record<string, string> = {
  "dm-messages.history": "история чата",
  "dm-messages.head": "новые сообщения чата",
  "followers.reconcile": "сверка подписчиков",
  "followers.head": "новые подписчики",
};

/** The server's summary of an engine alert: `<detail> · [since …] · {context}`.
 *  Its reasons and the keys they name, when the context says them. */
function engineSummaryFacts(summary: string | null): { reasons: string[]; resources: string[] } {
  if (summary === null) return { reasons: [], resources: [] };
  const parts = summary.split(" · ");
  const lead = parts[0]?.trim() ?? "";
  const json = parts.slice(1).find((part) => part.trimStart().startsWith("{"));
  let context: Record<string, unknown> = {};
  try {
    const parsed: unknown = json === undefined ? {} : JSON.parse(json);
    if (parsed !== null && typeof parsed === "object") context = parsed as Record<string, unknown>;
  } catch {
    // An older or cut summary: its lead word still says the reason.
  }
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const reasons = strings(context.reasons);
  return { reasons: reasons.length > 0 ? reasons : lead.length > 0 ? [lead] : [], resources: strings(context.resources) };
}

/** Alert 2 (`live_degraded`) by its reasons: only a down socket, frames Hub
 *  cannot read or a halted browser buffer delay new messages; work held for
 *  review stops only the keys it names. */
function liveDegradedWhat(summary: string | null): string {
  const { reasons, resources } = engineSummaryFacts(summary);
  const live: string[] = [];
  if (reasons.includes("socket_down")) live.push("сокет страницы не на связи");
  if (reasons.includes("protocol_changed")) live.push("Hub не разбирает часть кадров сокета");
  if (reasons.includes("browser_buffer_halted")) live.push("браузер страницы держит кадры и ответы сайта");
  const held = reasons.includes("quarantined")
    ? `Отложено на разбор: ${resources.length > 0 ? resources.map((key) => ENGINE_RESOURCE_WORDS[key] ?? key).join(", ") : "часть сбора"}.`
    : null;
  if (live.length > 0) {
    const first = live.join(", ");
    return `Новые сообщения приходят с задержкой: ${first}.${held === null ? "" : ` ${held}`}`;
  }
  if (held !== null) return `${held} Новые сообщения приходят.`;
  return "Новые сообщения приходят с задержкой: связь, неразобранные кадры или отложенная работа.";
}

/** The tails of a Fansly collection failure (`fansly_sync_engine:<page>:<tail>`). */
function engineWords(tail: string, page: string | null, summary: string | null): Omit<FailureWords, "title"> {
  const at = pageCollection(page);
  const says = (what: string, todo: string, fix: FailureFix = at) => ({ what, todo, fix });
  if (tail.startsWith("page_stopped:pace_violation")) return says("Два запроса ушли ближе паузы. Такого быть не должно.", "Передайте разработчику, потом закройте сбой.");
  if (tail.startsWith("page_stopped")) return says("Сбор остановил страницу: 429, вход, сеть или сервер сбора.", "Посмотрите, что держит страницу.");
  if (tail.startsWith("live_degraded")) return says(liveDegradedWhat(summary), "Посмотрите, что отложено.");
  if (tail.startsWith("freshness")) return says("Сообщения, деньги или срочная работа опаздывают.", "Посмотрите сбор страницы.");
  if (tail.startsWith("stuck")) return says("Запрос или плановый сбор не двигается.", "Посмотрите сбор страницы.");
  if (tail.startsWith("process")) return says("Сервер сбора молчит больше 2 минут.", PASS_ON, COLLECTION);
  if (tail.startsWith("route_limited")) return says("Fansly просит подождать: ответил 429 на один адрес. Остальное работает.", BY_ITSELF);
  if (tail.startsWith("public_lookup")) return says("Публичная проверка аккаунтов остановилась. Ничего не отправляется.", "Запускается командой сервера.", COLLECTION);
  if (tail.startsWith("evaluator") || tail.startsWith("site_journal")) return says("Часть проверок сбора не считается.", PASS_ON, COLLECTION);
  if (tail.startsWith("browser:")) {
    const case_ = tail.slice("browser:".length).split(":")[0] ?? "";
    const known = BROWSER_WORDS[case_];
    if (known) return says(known[0], known[1], case_ === "login_required" ? login(page) : at);
  }
  return says("Сбор Fansly сообщил о сбое.", "Посмотрите сбор страницы.");
}

/** The subject of OnlyFans' letter, as the server wrote it: «Updated Terms of Service». */
function noticeSubject(summary: string): string {
  const quoted = /«([^»]+)»/.exec(summary)?.[1];
  const subject = (quoted ?? summary.replace(/^OnlyFans notice:\s*/i, "")).trim();
  return `Письмо «${subject}».`;
}

/**
 * What a failure says on its row and in its panel: its name, what happened and
 * what to do in plain words, and where it is repaired. By the kind and the tail of
 * the key; a case without words gets its kind's general phrase, and the server's
 * own text stays in the panel under «Подробнее».
 */
export function failureWords(item: Pick<NotificationsIncidentItem, "kind" | "incidentKey" | "pageLabel" | "errorSummary">): FailureWords {
  const title = failureKindLabel(item.kind);
  const page = item.pageLabel;
  const tail = failureKeyTail(item.incidentKey);
  const says = (what: string, todo: string, fix: FailureFix | null): FailureWords => ({ title, what, todo, fix });
  switch (item.kind) {
    case "auth_blocked":
      return says("Fansly не принимает вход этой страницы. Сбор остановлен.", "Войдите в Fansly заново.", login(page));
    case "proxy_failed":
      return says("Hub не может дойти до площадки через прокси страницы.", "Проверьте прокси. После первого удачного запроса сбой закроется сам.", pageCollection(page));
    case "proxy_missing":
      return says("У страницы нет прокси, поэтому Hub к ней не обращается.", "Задайте прокси при подключении страницы.", pageCollection(page));
    case "stream_failed_threshold":
      return says("Поток падает три раза подряд.", "Обычно проходит сам. Если нет, посмотрите сбор страницы.", pageCollection(page));
    case "sync_silent":
      if (tail.startsWith("send_guard_closed")) return says("Hub не отправляет запросы страницы: ждёт завершения прошлого запроса.", BY_ITSELF, pageCollection(page));
      if (tail.startsWith("pace_violation")) return says("Два запроса страницы ушли ближе паузы. Такого быть не должно.", PASS_ON, pageCollection(page));
      return says("Сбор Fansly не отчитывается дольше обычного.", "Посмотрите сбор данных.", pageCollection(page));
    case "fansly_sync_engine":
      return { title, ...engineWords(tail, page, item.errorSummary) };
    case "publishing_stopped":
      return says("Hub сам выключил публикацию страницы.", "Посмотрите причину и включите снова.", {
        label: "Настройки публикации",
        to: page === null ? "/publications?panel=settings" : `/publications?page=${encodeURIComponent(page)}&panel=settings`,
      });
    case "publication_not_published":
      return says("Утверждённый пост не вышел вовремя.", "Посмотрите пост и решите, что с ним делать.", {
        label: "К публикациям",
        to: page === null
          ? "/publications?status=not_published&window=last7"
          : `/publications?page=${encodeURIComponent(page)}&status=not_published&window=last7`,
      });
    case "ofapi_platform_notice":
      return says(
        `${item.errorSummary ? `${noticeSubject(item.errorSummary)} ` : ""}По правилам OnlyFans поздний ответ может заморозить доход страницы.`,
        "Прочитайте и ответьте на самой OnlyFans, раздел Notifications, потом закройте сбой.",
        null,
      );
    case "chatspace_tab":
      if (tail.startsWith("signed_out")) return says("Вкладка вышла из OnlyMonster.", "Войдите снова на экране вкладки.", null);
      if (tail.startsWith("in_chat")) return says("Вкладка стоит в чате фана: открытый чат помечается прочитанным.", "Верните её на обзор аккаунтов.", null);
      if (tail.startsWith("socket_down")) return says("Связь ChatSpace не поднимается 5 минут, лента OnlyFans стоит.", "На экране вкладки нажмите Reconnect.", null);
      if (tail.startsWith("socket")) return says("Вкладка не видит страницу.", "Откройте аккаунт в боковой панели вкладки.", null);
      return says("Вкладка не отчитывается. Лента OnlyFans остановится, когда чаттеры закроют свои вкладки.", PASS_ON, null);
    case "ai_provider_billing": {
      if (tail.startsWith("account:")) {
        return says(`У счёта Anthropic ${tail.slice("account:".length)} кончились деньги или ключ не принят. Hub тратит следующий счёт.`, "Посмотрите деньги на ИИ.", AI_MONEY);
      }
      const voice: Readonly<Record<string, string>> = {
        "elevenlabs:key": "ElevenLabs: ключ не принят.",
        "elevenlabs:refused": "ElevenLabs: отказ в голосовых.",
        "elevenlabs:subscription": "ElevenLabs: подписка не активна.",
        "elevenlabs:characters_out": "ElevenLabs: символы кончились.",
        "elevenlabs:characters_low": "ElevenLabs: символы на исходе.",
      };
      return says(voice[tail] ?? "Ни один счёт Anthropic не работает.", "Посмотрите деньги на ИИ.", AI_MONEY);
    }
    case "ai_provider_failed":
      return says("Поставщик ИИ не отвечает.", BY_ITSELF, AI_MONEY);
    case "db_disk_usage":
      return says("На диске базы мало места.", "Посмотрите, что занимает место.", DATABASE);
    case "observations_partitions":
      return says("Разделы журнала на следующий месяц не созданы.", PASS_ON, DATABASE);
    case "scheduler_silent":
      return says("Планировщик задач не отчитывается.", "Посмотрите очередь задач.", QUEUE);
    case "ops_sampler_silent":
      return says("Сбор метрик сервера не отчитывается.", "Посмотрите очередь задач.", QUEUE);
    case "read_gateway_capture":
      return says("Шлюз чтения не сохранил данные.", "Посмотрите сбор страницы.", pageCollection(page));
    case "wrong_transactions_writer":
      return says("Операции страницы пытался записать не тот процесс.", PASS_ON, null);
    case "golden_signal_lag":
      return says("Ключевая метрика вышла за порог.", PASS_ON, null);
    case "capture_payload_parity":
      return says("Сохранённые данные разошлись с полученными.", PASS_ON, null);
    case "ofapi_auth":
      return says("OnlyFans API отклонил доступ к аккаунту страницы.", "Посмотрите OnlyFans API.", page === null ? OFAPI : pageCollection(page));
    case "ofapi_binding_conflict":
      return says("Аккаунт OnlyFans API привязан не так, как ждёт Hub.", "Посмотрите OnlyFans API.", page === null ? OFAPI : pageCollection(page));
    case "ofapi_low_credit":
      return says("Кредитов OnlyFans API осталось мало.", "Посмотрите OnlyFans API.", OFAPI);
    case "ofapi_webhook_silence":
      return says("События OnlyFans API давно не приходят.", "Посмотрите OnlyFans API.", OFAPI);
    case "ofapi_burn_rate":
      return says("Кредиты OnlyFans API тратятся быстрее обычного.", "Посмотрите OnlyFans API.", OFAPI);
    case "ofapi_chargebacks_reconcile_failed":
      return says("Сверка возвратов OnlyFans не прошла.", "Посмотрите OnlyFans API.", OFAPI);
    case "ofapi_link_stats_reconcile_failed":
      return says("Сверка статистики ссылок OnlyFans не прошла.", "Посмотрите OnlyFans API.", OFAPI);
  }
  return says("Hub заметил проблему.", PASS_ON, null);
}

export interface DeliveryWord {
  text: string;
  /** `quiet`: grey; `warning`: a bare warning badge; plain otherwise. */
  look: "plain" | "quiet" | "warning";
}

/** The Telegram column in one word. */
export function deliveryWord(item: Pick<NotificationsIncidentItem, "outboxState" | "notificationCount">): DeliveryWord {
  switch (item.outboxState) {
    case "delivered": return { text: "Доставлено", look: "plain" };
    case "pending": return { text: "В очереди", look: "plain" };
    case "leased": return { text: "Отправляется", look: "plain" };
    case "suppressed": return { text: "Не отправлялось", look: "quiet" };
    case "exhausted": return { text: "Не доставлено", look: "warning" };
    default:
      return item.notificationCount > 0 ? { text: `Отправлено: ${item.notificationCount}`, look: "plain" } : { text: "—", look: "quiet" };
  }
}

/** Why the Telegram column says what it says: the panel's line. */
export function deliveryReason(item: Pick<NotificationsIncidentItem, "outboxState" | "outboxSuppressionReason" | "outboxAttemptCount" | "notificationCount">): string {
  const attempts = `Попыток: ${item.outboxAttemptCount ?? 0}.`;
  switch (item.outboxState) {
    case "pending": return `Оповещение ждёт отправки. ${attempts}`;
    case "leased": return `Оповещение сейчас отправляется. ${attempts}`;
    case "delivered": return `Оповещение доставлено в Telegram. ${attempts}`;
    case "exhausted": return `Все попытки отправки исчерпаны. ${attempts}`;
    case "suppressed":
      return item.outboxSuppressionReason === "ai_critical_alerts_disabled"
        ? "Критичные оповещения ИИ были выключены, когда сбой изменился."
        : item.outboxSuppressionReason === "sync_failure_alerts_disabled"
          ? "Оповещения о сбоях сбора были выключены, когда сбой изменился."
          : "Уведомления были выключены, когда сбой изменился.";
    default:
      return item.notificationCount > 0 ? `Отправлено оповещений: ${item.notificationCount}.` : "Оповещений не было.";
  }
}
