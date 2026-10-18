import { gaugeSample, insertOpsMetricSamples, type OpsMetricSampleInput } from "@agency_hub_core/db";

import {
  notifySyncEngineIncident,
  resolveSyncEngineIncident,
  SYNC_ENGINE_SITE_JOURNAL_SUBKEY,
  type IncidentApp,
} from "../../services/notification-incidents.ts";
import { SYNC_METRICS_SAMPLE_EVERY_MINUTES } from "./metrics.ts";
import type { Metrics, SyncMetricLabels } from "./ports.ts";

// The engine's in-process counters (`Metrics`, ports.ts) in the `sync`
// process: what the actors, commits, sockets and page browsers count — a
// refusal, a dropped frame, a site request that could not be journaled.
// Counted in memory by name and by the labels of a closed vocabulary, and
// written every `ENGINE_COUNTERS_FLUSH_MS` (and once more at stop) into
// ops_metric_samples, the store of the golden signals and of the engine's
// families (`metrics.ts`): one reading per series in the p95 slot
// (`gaugeSample`), how many times it counted since the previous write.
//
// A series is `counter_<name>{<label>=<value>,…}` (labels sorted; without
// one, `counter_<name>`): a family of its own beside the sampler's gauges, so
// a counter and a gauge of one name (`sync_pace_violations`, `sync_alerts`)
// never share a series. Only what counted is written: a quiet process writes
// nothing. A label outside `ENGINE_COUNTER_LABELS` is folded into its series —
// a page, a route, an origin, a resource, an error's name would each multiply
// the series of the sample table, and the page status and the logs carry them.
//
// A counter of `ENGINE_COUNTER_ALERTS` opens its latch when a write's window
// counted it, and resolves it at the next window that counted none.

/** The counts of one write cover this long: the sampler's cadence of the
 *  engine's families. */
export const ENGINE_COUNTERS_FLUSH_MS = SYNC_METRICS_SAMPLE_EVERY_MINUTES * 60_000;

/** The stop's last write waits this long, then the process goes on stopping
 *  (its window is lost). */
export const ENGINE_COUNTERS_STOP_TIMEOUT_MS = 3_000;

/** The family prefix of the counters' series in ops_metric_samples. */
export const ENGINE_COUNTER_PREFIX = "counter_";

/** Labels a series keeps: closed vocabularies (a reason, an outcome, a kind,
 *  an HTTP status). */
export const ENGINE_COUNTER_LABELS: ReadonlySet<string> = new Set([
  "as",
  "boundary",
  "command",
  "detail",
  "effect",
  "hook",
  "how",
  "kind",
  "local",
  "of",
  "ok",
  "outcome",
  "plan",
  "reason",
  "state",
  "status",
  "subKey",
  "why",
  "workClass",
]);

/** A window's series beyond this many keep no labels (a vocabulary that
 *  turned out open must not grow the sample table). */
export const ENGINE_COUNTER_MAX_SERIES = 400;

const LABEL_VALUE_MAX = 48;

/** The series of a counter and its labels. */
export function engineCounterSeries(name: string, labels: SyncMetricLabels = {}): string {
  const kept = Object.keys(labels)
    .filter((key) => ENGINE_COUNTER_LABELS.has(key))
    .sort()
    .map((key) => `${key}=${String(labels[key]).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, LABEL_VALUE_MAX)}`);
  return `${ENGINE_COUNTER_PREFIX}${name}${kept.length === 0 ? "" : `{${kept.join(",")}}`}`;
}

/** What counted between two writes: by series, and by name over its series. */
export interface EngineCounterWindow {
  series: ReadonlyMap<string, number>;
  totals: ReadonlyMap<string, number>;
}

function add(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** The `Metrics` of the `sync` process. */
export class EngineCounters implements Metrics {
  #series = new Map<string, number>();
  #totals = new Map<string, number>();

  increment(name: string, labels: SyncMetricLabels = {}, by = 1): void {
    if (!Number.isFinite(by) || by <= 0) return;
    let series = engineCounterSeries(name, labels);
    if (!this.#series.has(series) && this.#series.size >= ENGINE_COUNTER_MAX_SERIES) series = engineCounterSeries(name);
    add(this.#series, series, by);
    add(this.#totals, name, by);
  }

  /** What counted since the last drain; the counts start again from zero. */
  drain(): EngineCounterWindow {
    const window = { series: this.#series, totals: this.#totals };
    this.#series = new Map();
    this.#totals = new Map();
    return window;
  }

  /** Counts a write could not store go into the next window. */
  restore(window: EngineCounterWindow): void {
    for (const [series, count] of window.series) add(this.#series, series, count);
    for (const [name, count] of window.totals) add(this.#totals, name, count);
  }
}

/** A window's samples: one per series that counted. */
export function engineCounterSamples(window: EngineCounterWindow): OpsMetricSampleInput[] {
  return [...window.series].flatMap(([series, count]) => gaugeSample(series, count));
}

export interface EngineCounterAlert {
  /** The counter, over all its series. */
  name: string;
  subKey: typeof SYNC_ENGINE_SITE_JOURNAL_SUBKEY;
  /** The latch's summary of `count` in a window of `windowMs`. */
  summary(count: number, windowMs: number): string;
}

export const ENGINE_COUNTER_ALERTS: readonly EngineCounterAlert[] = [
  {
    // `#journalObserved` (actor.ts): its failure was a warn line only, and the
    // sync container's logs keep hours.
    name: "sync_site_observed_commit_failed",
    subKey: SYNC_ENGINE_SITE_JOURNAL_SUBKEY,
    summary: (count, windowMs) => `${count} site request(s) a page's browser sent on its own could not be journaled `
      + `in the last ${Math.max(1, Math.round(windowMs / 60_000))} min: until one commits, the pace audit and the route clocks miss them `
      + "(an operator of protocol minor 6 tells them again until Hub confirms; an older one's are lost). "
      + "The sync log names the page (\"an observed site request could not be journaled\").",
  },
];

/** Open the latch of every alerted counter the window counted; resolve the
 *  others' — unless `final` (a stop's short window proves nothing clean). */
export async function judgeEngineCounterAlerts(
  app: IncidentApp,
  window: EngineCounterWindow,
  input: { windowMs: number; final: boolean; now?: Date },
): Promise<void> {
  const at = input.now ?? new Date();
  for (const alert of ENGINE_COUNTER_ALERTS) {
    const count = window.totals.get(alert.name) ?? 0;
    if (count > 0) {
      await notifySyncEngineIncident(app, {
        subKey: alert.subKey,
        pageId: null,
        pageLabel: null,
        detail: alert.name,
        errorSummary: alert.summary(count, input.windowMs),
        occurredAt: at,
      });
    } else if (!input.final) {
      await resolveSyncEngineIncident(app, { subKey: alert.subKey, pageId: null, pageLabel: null, recoveredAt: at });
    }
  }
}

export interface EngineCounterFlush {
  /** Writes the last window, then stops (bounded by
   *  `ENGINE_COUNTERS_STOP_TIMEOUT_MS`). Idempotent. */
  stop(): Promise<void>;
}

/**
 * Write the counters' windows every `intervalMs`, one write at a time; a
 * write that fails puts its counts back into the next window. Each write
 * judges `ENGINE_COUNTER_ALERTS` on its window.
 */
export function startEngineCounterFlush(
  app: IncidentApp,
  counters: EngineCounters,
  options: { intervalMs?: number; stopTimeoutMs?: number } = {},
): EngineCounterFlush {
  const intervalMs = options.intervalMs ?? ENGINE_COUNTERS_FLUSH_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? ENGINE_COUNTERS_STOP_TIMEOUT_MS;
  let windowStartedMs = Date.now();
  let inFlight: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;

  const flush = async (final: boolean) => {
    const window = counters.drain();
    const windowMs = Date.now() - windowStartedMs;
    windowStartedMs = Date.now();
    const samples = engineCounterSamples(window);
    try {
      if (samples.length > 0) await insertOpsMetricSamples(app.db, samples);
    } catch (error) {
      counters.restore(window);
      app.logger.warn({ err: error, series: samples.length }, "Fansly sync engine counters not written; they count in the next write");
    }
    try {
      await judgeEngineCounterAlerts(app, window, { windowMs, final });
    } catch (error) {
      app.logger.warn({ err: error }, "Fansly sync engine counter alerts not judged");
    }
  };

  const run = () => {
    if (stopping !== null || inFlight !== null) return;
    inFlight = flush(false).finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopping ??= (async () => {
        clearInterval(timer);
        let bound: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => {
          bound = setTimeout(resolve, stopTimeoutMs);
          bound.unref?.();
        });
        try {
          await Promise.race([(async () => {
            await inFlight;
            await flush(true);
          })(), deadline]);
        } finally {
          clearTimeout(bound);
        }
      })();
      return stopping;
    },
  };
}
