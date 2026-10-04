import type { AdminClientHealthResponse } from "@agency_hub_core/contracts";

/**
 * The owner's client-health page as rows ready to print (chat-extension H-11c).
 * Pure: the page renders what this returns and decides nothing itself.
 *
 * The hub answers by client version and host build and names no person; this
 * model adds none. It hides nothing the hub sent and shows nothing the hub held
 * back: a group the hub marked as too small prints its size and a note.
 */

type PerfRow = AdminClientHealthResponse["perf"][number];

/** What each speed metric measures, in the order the page lists them. A metric not here prints its code. */
const PERF_METRICS: ReadonlyArray<readonly [metric: string, label: string]> = [
  ["routeToDockMs", "Смена чата → панель обновилась"],
  ["panelOpenMs", "Клавиша или клик → видимый отклик"],
  ["requestOverheadMs", "Клик → запрос ушёл (своя задержка расширения)"],
  ["ttfcMs", "Клик → первый кусок ответа AI (вместе с ожиданием модели)"],
  ["firstChunkPaintMs", "Первый кусок ответа → показан на экране"],
  ["insertMs", "Вставка текста в поле с проверкой"],
  ["boardOpenMs", "Открытие доски Spenders из сохранённых данных"],
  ["searchMs", "Поиск по доске"],
  ["handlerMs", "Обработчики расширения (каждый двадцатый)"],
  ["eventLatencyMs", "Клавиша или клик → следующая отрисовка"],
  ["composerInputDelayMs", "Задержка набора в поле сообщения"],
];

/** The counters the extension always sends, in the order the page lists them. Any other prints its code alone. */
const COUNTERS: ReadonlyArray<readonly [code: string, label: string]> = [
  ["p1.insert-misplaced", "Вставка в чужой чат"],
  ["p1.send-without-human", "Отправка без человека"],
  ["p1.read-without-human", "Чтение чата без человека"],
  ["insert.prevented", "Вставка остановлена проверкой"],
  ["send.held", "Отправка удержана"],
  ["send.uncertain", "Неизвестно, ушло ли сообщение"],
];

/** The ranges the page offers: each ends today. */
export const CLIENT_HEALTH_PERIODS = [
  { key: "today", label: "Сегодня", days: 1 },
  { key: "7d", label: "7 дней", days: 7 },
  { key: "30d", label: "30 дней", days: 30 },
] as const;

export type ClientHealthPeriod = (typeof CLIENT_HEALTH_PERIODS)[number]["key"];

const DAY_MS = 86_400_000;

/** A business date (YYYY-MM-DD) as the instant its day starts in UTC: for date arithmetic only. */
function utcDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The days a period covers, today included. Days are the hub's business dates (YYYY-MM-DD). */
export function clientHealthRange(period: ClientHealthPeriod, today: string): { from: string; to: string } {
  const { days } = CLIENT_HEALTH_PERIODS.find((entry) => entry.key === period)!;
  return { from: new Date(utcDay(today).getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10), to: today };
}

const DAY_AND_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

/** "3 октября" or "27 сентября – 3 октября". */
export function clientHealthRangeLabel(range: { from: string; to: string }): string {
  const print = (date: string) => DAY_AND_MONTH.format(utcDay(date));
  return range.from === range.to ? print(range.to) : `${print(range.from)} – ${print(range.to)}`;
}

const NUMBER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const NUMBER_ONE_DECIMAL = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

/** Milliseconds: one decimal under 10 ms, whole above. */
export function formatMs(value: number): string {
  return `${(value < 10 ? NUMBER_ONE_DECIMAL : NUMBER).format(value)} мс`;
}

/** A size the hub gives in kilobytes. */
export function formatKb(value: number): string {
  return value < 1024 ? `${NUMBER.format(value)} КБ` : `${NUMBER_ONE_DECIMAL.format(value / 1024)} МБ`;
}

/** The hub files a version or a build that is not a code under this placeholder. */
const OTHER = "(other)";

export function versionLabel(version: string): string {
  return version === OTHER ? "другие" : version;
}

/** Null is a build the extension could not read. */
export function buildLabel(build: string | null): string {
  if (build === null) return "не определена";
  return build === OTHER ? "другие" : build;
}

/** Newest version first: by its numbers, then as text; the placeholder last. */
export function compareVersionsNewestFirst(left: string, right: string): number {
  if (left === right) return 0;
  if (left === OTHER) return 1;
  if (right === OTHER) return -1;
  const numbers = (version: string) => version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  const [a, b] = [numbers(left), numbers(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const [x, y] = [a[index] ?? 0, b[index] ?? 0];
    if (Number.isNaN(x) || Number.isNaN(y)) break;
    if (x !== y) return y - x;
  }
  return left < right ? 1 : -1;
}

export interface ClientHealthContractRowView {
  key: string;
  version: string;
  build: string;
  reports: string;
  failedReports: string;
  /** "composer.editor — 3, chat.list — 1"; empty when no report missed anything. */
  missing: string;
}

export interface ClientHealthPerfRowView {
  key: string;
  version: string;
  build: string;
  count: string;
  /** Too few observations: the hub sent the size and no figure. */
  suppressed: boolean;
  mean: string;
  p50: string;
  p95: string;
  max: string;
}

export interface ClientHealthPerfMetricView {
  key: string;
  /** The metric's code, as the extension names it. */
  metric: string;
  /** What it measures; null for a metric this page does not know. */
  label: string | null;
  rows: ClientHealthPerfRowView[];
}

export interface ClientHealthCounterRowView {
  code: string;
  label: string | null;
  total: string;
}

/** Each figure is printed, or says that the version has too few reports for one. */
export interface ClientHealthFootprintRowView {
  version: string;
  caches: string;
  logs: string;
  domNodes: string;
}

export interface ClientHealthPageModel {
  /** No report in the range at all. */
  empty: boolean;
  /** Reports in the range, and those that said the host page failed the check. */
  reports: number;
  failedReports: number;
  minGroupSize: number;
  contract: ClientHealthContractRowView[];
  perf: ClientHealthPerfMetricView[];
  counters: ClientHealthCounterRowView[];
  footprint: ClientHealthFootprintRowView[];
}

const DASH = "—";
/** A footprint figure the hub held back: fewer reports than the minimum carried it. */
export const CLIENT_HEALTH_FEW_REPORTS = "мало отчётов";

function perfRowView(row: PerfRow): ClientHealthPerfRowView {
  const figure = (value: number | null) => (value === null ? DASH : formatMs(value));
  return {
    key: [row.clientName, row.clientVersion, row.hostKind, row.hostBuild ?? "", row.schemaVersion].join("|"),
    version: versionLabel(row.clientVersion),
    build: buildLabel(row.hostBuild),
    count: formatCount(row.count),
    suppressed: row.suppressed,
    mean: figure(row.mean),
    p50: figure(row.p50),
    p95: figure(row.p95),
    max: figure(row.max),
  };
}

export function clientHealthPageModel(data: AdminClientHealthResponse): ClientHealthPageModel {
  const contract = [...data.contract]
    .sort((left, right) => compareVersionsNewestFirst(left.clientVersion, right.clientVersion) || right.reports - left.reports)
    .map((row) => ({
      key: `${row.clientVersion}|${row.hostBuild ?? ""}`,
      version: versionLabel(row.clientVersion),
      build: buildLabel(row.hostBuild),
      reports: formatCount(row.reports),
      failedReports: formatCount(row.failedReports),
      missing: row.missing.map((entry) => `${entry.anchor} — ${formatCount(entry.reports)}`).join(", "),
    }));

  // One block per metric and schema version: two versions of a metric have other buckets and are not one table.
  const metricOrder = new Map(PERF_METRICS.map(([metric], index) => [metric, index]));
  const labels = new Map(PERF_METRICS);
  const blocks = new Map<string, { metric: string; schemaVersion: number; rows: PerfRow[] }>();
  for (const row of data.perf) {
    const key = `${row.metric}|${row.schemaVersion}`;
    const block = blocks.get(key) ?? { metric: row.metric, schemaVersion: row.schemaVersion, rows: [] };
    block.rows.push(row);
    blocks.set(key, block);
  }
  const perf = [...blocks.entries()]
    .sort(([, left], [, right]) => {
      const known = (metricOrder.get(left.metric) ?? PERF_METRICS.length) - (metricOrder.get(right.metric) ?? PERF_METRICS.length);
      return known || left.metric.localeCompare(right.metric) || left.schemaVersion - right.schemaVersion;
    })
    .map(([key, block]) => ({
      key,
      metric: block.metric,
      label: labels.get(block.metric) ?? null,
      rows: block.rows
        .sort((left, right) => compareVersionsNewestFirst(left.clientVersion, right.clientVersion) || right.count - left.count)
        .map(perfRowView),
    }));

  const counterOrder = new Map(COUNTERS.map(([code], index) => [code, index]));
  const counterLabels = new Map(COUNTERS);
  const counters = [...data.counters]
    .sort((left, right) => {
      const known = (counterOrder.get(left.code) ?? COUNTERS.length) - (counterOrder.get(right.code) ?? COUNTERS.length);
      return known || right.total - left.total || left.code.localeCompare(right.code);
    })
    .map((row) => ({ code: row.code, label: counterLabels.get(row.code) ?? null, total: formatCount(row.total) }));

  const footprint = [...data.footprint]
    .sort((left, right) => compareVersionsNewestFirst(left.clientVersion, right.clientVersion))
    .map((row) => ({
      version: versionLabel(row.clientVersion),
      caches: row.cachesKBp95 === null ? CLIENT_HEALTH_FEW_REPORTS : formatKb(row.cachesKBp95),
      logs: row.logsKBp95 === null ? CLIENT_HEALTH_FEW_REPORTS : formatKb(row.logsKBp95),
      domNodes: row.domNodesP95 === null ? CLIENT_HEALTH_FEW_REPORTS : formatCount(row.domNodesP95),
    }));

  return {
    empty: data.contract.length === 0 && data.perf.length === 0 && data.counters.length === 0 && data.footprint.length === 0,
    reports: data.contract.reduce((total, row) => total + row.reports, 0),
    failedReports: data.contract.reduce((total, row) => total + row.failedReports, 0),
    minGroupSize: data.minGroupSize,
    contract,
    perf,
    counters,
    footprint,
  };
}
