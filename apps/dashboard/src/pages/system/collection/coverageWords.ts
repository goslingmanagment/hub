import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

import { formatCount } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import type { AnalyticsPanelState } from "@/pages/analytics-query-state";
import { engineReadingState, engineReadingTone, engineReadingWords } from "@/pages/settings/engine/engineDisplay";

// The collection words of a page's coverage, moved from the old
// components/analytics/CoveragePanel.tsx when its panel left the screens.

type Engine = NonNullable<StatsCoverageResponse["engine"]>;
type EngineStreamRow = Engine["streams"][number];

type EngineBadge = { text: string; tone: "off" | "on"; detail: string };

/**
 * The one thing that is true of a stream now. "reading" is a claim, not a
 * default: it takes a host that runs the page, work that is open and keys
 * nothing stops — by the engine's own hold evaluator (the page's hold, a
 * resource breaker, a 429's hold of the stream's routes) and the owner's
 * pauses, which the server judges key by key (`stopped`, `stops`). Without a
 * host nothing of the page is read, whatever its work says; a stream nothing
 * asked for yet has neither work nor a read.
 */
export function engineStreamBadge(engine: Pick<Engine, "mode" | "ownerRunning">, stream: EngineStreamRow): EngineBadge {
  const state = engineReadingState({
    mode: engine.mode,
    ownerRunning: engine.ownerRunning,
    stopped: stream.stopped,
    stops: stream.stops,
    paused: stream.paused,
    needsAttention: stream.needsAttention,
    activeWork: stream.activeWork,
    everRead: stream.succeededAt !== null,
  });
  // The owner's pause is said as loudly as a hold: the stream is not read.
  const off = engineReadingTone(state) === "warn" || state === "paused";
  return { ...engineReadingWords(state, "ru"), tone: off ? "off" : "on" };
}

/** The one line the collapsed card shows: is this page's data being read. */
export function coverageSummary(state: AnalyticsPanelState<StatsCoverageResponse>): string {
  if (state.status === "loading") return "Загружаем сведения о том, какие данные собраны.";
  if (state.status === "error") return "Не удалось загрузить сведения о сборе данных.";
  const engine = state.data.engine;
  if (engine === null) return "Сбор данных Fansly не ведёт эту страницу — новые данные не поступают.";
  if (!engine.ownerRunning) {
    return engine.mode === "handover"
      ? "Страница переключается на новый сбор данных — пока ничего не читается."
      : "Сбор данных остановлен: страницу сейчас никто не читает.";
  }
  const total = engine.streams.length;
  const off = engine.streams.filter((stream) => engineStreamBadge(engine, stream).tone === "off").length;
  const streams = (value: number) => `${formatCount(value)} ${ruPlural(value, "поток", "потока", "потоков")}`;
  if (off === 0) return `Сбор данных работает: ${streams(total)} без остановок.`;
  return `Сбор данных работает с ограничениями: ${formatCount(off)} из ${streams(total)} `
    + "на паузе, удержаны или требуют внимания.";
}
