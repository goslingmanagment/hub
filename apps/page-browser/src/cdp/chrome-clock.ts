// Chrome's clock read against the operator's (Astra's review of PR 15, round
// 7): CDP's timestamps (Network.MonotonicTime) are Chrome's TimeTicks, a
// clock of its own base. One reading: the operator's t0, Chrome's TimeTicks
// T from `Performance.getMetrics` (its `Timestamp`: read inside Chrome while
// the command runs — no request, nothing to any network), the operator's t1.
// The offset (operator − Chrome) lies in [t0 − T, t1 − T]; the lower bound
// is taken, so a timestamp mapped by it is at most (t1 − t0) before the same
// instant on the operator's clock, never after. A reading whose round trip is
// longer than `CALIBRATION_MAX_MS` is refused as a tight calibration, but
// keeps its lower bound for a session with no clock yet.

import type { CdpPort } from "./client.ts";
import { monoMs } from "../shared/util.ts";

/** The longest round trip a tight calibration of Chrome's clock takes. */
export const CALIBRATION_MAX_MS = 1_000;

export interface ChromeClockReading {
  /** Chrome's TimeTicks (ms) + `offset` ≤ the operator's mono of the same
   *  instant, by at most `spread`. */
  offset: number;
  spread: number;
  /** When it was read (operator mono). */
  takenMono: number;
}

/** One reading of Chrome's clock in `sessionId` (`Performance` enabled
 *  first when `enable`), or why it is refused (a slow one's bound kept). */
export async function readChromeClock(cdp: CdpPort, sessionId: string, options: { enable: boolean; timeoutMs?: number }): Promise<ChromeClockReading | { refused: string; reading?: ChromeClockReading }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (options.enable) await cdp.send("Performance.enable", {}, sessionId, timeoutMs);
  const t0 = monoMs();
  const reply = await cdp.send<{ metrics?: Array<{ name?: unknown; value?: unknown }> }>("Performance.getMetrics", {}, sessionId, timeoutMs);
  const t1 = monoMs();
  const value = reply.metrics?.find((metric) => metric.name === "Timestamp")?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return { refused: "no Timestamp in Chrome's metrics" };
  const reading = { offset: t0 - value * 1000, spread: t1 - t0, takenMono: t1 };
  if (reading.spread > CALIBRATION_MAX_MS) return { refused: `a round trip of ${Math.round(reading.spread)} ms`, reading };
  return reading;
}

/** Readings taken together (one calibration), as one: the largest lower
 *  bound of the offset — each is at most the true one, so the largest is
 *  too, and it is at most the smallest spread below it. */
export function tightestOf(readings: readonly ChromeClockReading[]): ChromeClockReading | null {
  if (readings.length === 0) return null;
  return {
    offset: Math.max(...readings.map((reading) => reading.offset)),
    spread: Math.min(...readings.map((reading) => reading.spread)),
    takenMono: Math.max(...readings.map((reading) => reading.takenMono)),
  };
}

/** `timestampSeconds` (Network.MonotonicTime) on the operator's clock by
 *  `reading`: never later than `ceilingMono` (the event's take). */
export function chromeToOperator(timestampSeconds: number, reading: ChromeClockReading, ceilingMono: number): number {
  return Math.min(ceilingMono, timestampSeconds * 1000 + reading.offset);
}
