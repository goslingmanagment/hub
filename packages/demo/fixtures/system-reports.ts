import type { AgentReportMeta } from "@agency_hub_core/contracts";
import { daysAgo, demoError, hoursAgo, iso, isoDay, type DemoHandlers, type DemoRequest } from "../core.ts";

/**
 * Agent reports (package O): the pages the invented agency's agents publish.
 * «traffic» is the traffic routine's board (the shape `trafficctl dashboard`
 * prints: a wide table, lists, a rule, the footnotes); the customs board is
 * opened to team leads; the hiring board is older than its validity, so the
 * stale mark shows. Every channel, contractor and sum is made up.
 */

const TRAFFIC_KEY = { agentKeyId: 11, name: "Трафик" } as const;
const BOARD_KEY = { agentKeyId: 12, name: "Доски агентства" } as const;

/** A day of Moscow, `YYYY-MM-DD`, `days` before the request. */
function moscowDay(now: Date, days: number): string {
  return isoDay(new Date(now.getTime() + 3 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000));
}

/** `DD.MM` of a Moscow day. */
function short(day: string): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}`;
}

function trafficBody(now: Date, publishedAt: Date): string {
  const today = moscowDay(now, 0);
  const week = (from: number, to: number) => `${short(moscowDay(now, from))}–${short(moscowDay(now, to))}`;
  return [
    "# Трафик: доска каналов (Mia Hart)",
    "",
    `Состояние на ${today} (MSK) · сгенерировано ${publishedAt.toISOString().slice(0, 19)}+00:00`,
    "",
    "| Канал | Статус (с даты) | Подрядчик | Цикл | Прогресс | Грейд | Ждём | Дней |",
    "|---|---|---|---|---|---|---|---:|",
    `| Reddit | простой (с ${moscowDay(now, 131)}) | — | — | — | — | owner (ack) | 131 |`,
    `| Instagram основа | заблокирован (с ${moscowDay(now, 140)}) | north-studio | — | — | — | owner (ack) | 128 |`,
    `| Instagram ферма | остановлен (с ${moscowDay(now, 43)}) | farm-desk | — | — | — | — | — |`,
    `| SFS (OF Free) | работает (с ${moscowDay(now, 129)}) | shout-room | — | — | — | — | — |`,
    `| FYP (Fansly mia-1) | работает (с —) | fyp-lab | ${moscowDay(now, 114)} · running | 38/60 (claimed) | C (нативный счётчик Fansly, 8ч) | — | — |`,
    `| Короткие видео | работает (с ${moscowDay(now, 57)}) | clip-works | pack-02 · running | ~152/500 (est) | B (сгруппированные ссылки, данные 10ч) | — | — |`,
    `| YouTube | простой (с ${moscowDay(now, 155)}) | — | — | — | — | — | — |`,
    "",
    "## На проверку",
    "",
    "Пусто.",
    "",
    "### Сверки по счётчику страницы",
    "",
    `- **sfs** ${week(10, 4)}: площадка 61, заявка 61 → сходится · $25.01`,
    `- **sfs** ${week(17, 11)}: площадка 57, заявка 56 (-1) → сходится · $23.37`,
    `- **sfs** ${week(24, 18)}: площадка 51, заявка 51 → сходится · $20.91`,
    "",
    "## Атрибуция",
    "",
    `- **mia-1** за ${week(7, 1)}: нет атрибуции по ссылкам`,
    `- **mia-of** за ${week(7, 1)}: нет данных страницы за 1 из 7 дн.`,
    `- **mia-vip-of** за ${week(7, 1)}: ссылки: дыра в снимках у 29`,
    "",
    "## Открытые ожидания",
    "",
    `- **reddit** · ждём: owner · с ${moscowDay(now, 129)} (129д) [ack] — выбрать подрядчика перезапуска`,
    `- **insta-main** · ждём: owner · с ${moscowDay(now, 128)} (128д) [ack] — решение по платной верификации (~$300 / ~$180); депозит $94 у подрядчика`,
    "",
    "## Алерты сегодня",
    "",
    "- `unbound_link_growth` **—** ссылки без канала растут за 7д: of_trial:20001 +4 claims, привязать к каналу или закрыть",
    "",
    "---",
    "",
    "Числа доставки, помеченные `claimed`, — заявка подрядчика без независимого источника; `est` — оценка по дельте ссылок.",
    "",
    "Вердикт — согласованность заявки со снимками площадки, а не проверка факта: два снимка в сутки дают интервал шириной около дневного объёма канала.",
  ].join("\n");
}

const CUSTOMS_BODY = [
  "# Кастомы: что висит",
  "",
  "| Заказ | Страница | Оплачен | Срок | Что ждём |",
  "|---|---|---:|---|---|",
  "| Видео 5 мин, «утро» | mia-1 | $120.00 | завтра | съёмку |",
  "| Фото 10 шт. | nova-1 | $45.00 | просрочен на 2 дня | правку |",
  "",
  "Сданные и снятые в доску не попадают.",
].join("\n");

const HIRING_BODY = [
  "# Найм: кто на подходе",
  "",
  "1. Двое кандидатов ждут ответа больше суток.",
  "2. Одна пробная смена назначена на пятницу.",
  "",
  "> Решения по кандидатам принимает владелец.",
].join("\n");

interface DemoReport {
  meta: AgentReportMeta;
  body: string;
}

function meta(input: Omit<AgentReportMeta, "staleAt" | "stale" | "bytes">, body: string, now: Date): AgentReportMeta {
  const staleAt = input.validHours === null ? null : new Date(Date.parse(input.publishedAt) + input.validHours * 60 * 60 * 1000);
  return {
    ...input,
    bytes: new TextEncoder().encode(body).length,
    staleAt: staleAt === null ? null : iso(staleAt),
    stale: staleAt !== null && now.getTime() > staleAt.getTime(),
  };
}

function demoReports(request: DemoRequest): DemoReport[] {
  const now = request.now;
  const trafficAt = hoursAgo(now, 2.6);
  const traffic = trafficBody(now, trafficAt);
  const customsAt = hoursAgo(now, 0.7);
  const hiringAt = daysAgo(now, 2);
  return [
    {
      body: traffic,
      meta: meta({
        slug: "traffic", title: "Трафик: доска каналов", section: "traffic", teamLeads: false, validHours: 9,
        version: 41, publishedAt: iso(trafficAt), publishedBy: TRAFFIC_KEY,
      }, traffic, now),
    },
    {
      body: CUSTOMS_BODY,
      meta: meta({
        slug: "customs-board", title: "Кастомы: что висит", section: "content", teamLeads: true, validHours: 24,
        version: 7, publishedAt: iso(customsAt), publishedBy: BOARD_KEY,
      }, CUSTOMS_BODY, now),
    },
    {
      body: HIRING_BODY,
      meta: meta({
        slug: "hiring", title: "Найм: кто на подходе", section: "team", teamLeads: false, validHours: 24,
        version: 3, publishedAt: iso(hiringAt), publishedBy: BOARD_KEY,
      }, HIRING_BODY, now),
    },
  ];
}

/** The owner reads every report, a team lead the ones opened to team leads, a chatter none. */
function readable(request: DemoRequest): DemoReport[] {
  if (request.role === "chatter") return [];
  return demoReports(request).filter((report) => request.role === "owner" || report.meta.teamLeads);
}

export const reportHandlers: DemoHandlers = {
  reportsList: (request) => {
    if (request.role === "chatter") return demoError(403, "forbidden", "Forbidden");
    const reports = readable(request).map((report) => report.meta)
      .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
    return { reports, serverNow: iso(request.now) };
  },
  reportGet: (request) => {
    if (request.role === "chatter") return demoError(403, "forbidden", "Forbidden");
    const found = readable(request).find((report) => report.meta.slug === request.params.slug);
    if (!found) return demoError(404, "not_found", "No such report");
    return { report: { ...found.meta, body: found.body }, serverNow: iso(request.now) };
  },
};
