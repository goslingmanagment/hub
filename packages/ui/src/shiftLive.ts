import { CHATTER_SHIFT_END_IDLE_MINUTES, CHATTER_SHIFT_IDLE_PAUSE_MINUTES, CLIENT_ACTIVITY_LOST_MINUTES } from "@agency_hub_core/contracts";
import { formatDuration, formatTimeOfDay } from "./format.js";

/**
 * A shift going on, in words, by the hub's clock (`serverNow` of the read). A
 * shift goes on until CHATTER_SHIFT_END_IDLE_MINUTES after its last action, the
 * extension open or not, so «идёт» alone can be a break or an end not yet
 * known: these say which it looks like.
 */

const MINUTE_MS = 60_000;

interface LiveShift {
  ongoing: boolean;
  endedAt: string;
  lastInputAt: string;
  lastBeatAt: string;
}

function minutesSince(at: string, serverNow: string): number {
  return Math.max(0, Math.floor((Date.parse(serverNow) - Date.parse(at)) / MINUTE_MS));
}

/** The shift's numbers may still move: it goes on, or it ended under CHATTER_SHIFT_END_IDLE_MINUTES ago (late messages and sales). */
export function shiftSettling(shift: Pick<LiveShift, "ongoing" | "endedAt">, serverNow: string): boolean {
  return shift.ongoing || Date.parse(serverNow) - Date.parse(shift.endedAt) < CHATTER_SHIFT_END_IDLE_MINUTES * MINUTE_MS;
}

/** «без действий 25 мин · нет связи 20 мин» for a shift going on; null — someone is at work now, or it is over. */
export function shiftIdleText(shift: LiveShift, serverNow: string): string | null {
  if (!shift.ongoing) return null;
  const idle = minutesSince(shift.lastInputAt, serverNow);
  const silent = minutesSince(shift.lastBeatAt, serverNow);
  const parts: string[] = [];
  if (idle >= CHATTER_SHIFT_IDLE_PAUSE_MINUTES) parts.push(`без действий ${formatDuration(idle)}`);
  if (silent > CLIENT_ACTIVITY_LOST_MINUTES) parts.push(`нет связи ${formatDuration(silent)}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The hover of `shiftIdleText`: what the words mean and when the shift is over without another action. */
export function shiftIdleTitle(shift: LiveShift): string {
  const closesAt = Date.parse(shift.lastInputAt) + CHATTER_SHIFT_END_IDLE_MINUTES * MINUTE_MS;
  return `Последнее действие в ${formatTimeOfDay(shift.lastInputAt)}, последний сигнал расширения в ${formatTimeOfDay(shift.lastBeatAt)}; `
    + "«нет связи» — расширение закрыто или без сети. "
    + `Смена идёт, пока не пройдёт ${CHATTER_SHIFT_END_IDLE_MINUTES} мин без действий: если действий больше не будет, в ${formatTimeOfDay(closesAt)} `
    + `она закроется и кончится на последнем действии и ${CHATTER_SHIFT_IDLE_PAUSE_MINUTES} мин после него.`;
}
