import { CHATTER_SHIFT_END_IDLE_MINUTES, CHATTER_SHIFT_IDLE_PAUSE_MINUTES, CLIENT_ACTIVITY_LOST_MINUTES } from "@agency_hub_core/contracts";
import { formatDuration, formatTimeOfDay } from "./format.js";

/**
 * A shift going on, in words, by the hub's clock (`serverNow` of the read). A
 * shift goes on until CHATTER_SHIFT_END_IDLE_MINUTES after its last action, the
 * extension open or not, and through a break inside the person's own schedule
 * slot until the slot's end (Hub's chatter-shifts.ts), so «идёт» alone can be a
 * break or an end not yet known: these say which it looks like.
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

/**
 * The hover of `shiftIdleText`: what the words mean and when the shift is over without another action. Given the read's
 * `serverNow`, a shift still going past that hour is said to be in a break inside its slot.
 */
export function shiftIdleTitle(shift: LiveShift, serverNow?: string): string {
  const closesAt = Date.parse(shift.lastInputAt) + CHATTER_SHIFT_END_IDLE_MINUTES * MINUTE_MS;
  const facts = `Последнее действие в ${formatTimeOfDay(shift.lastInputAt)}, последний сигнал расширения в ${formatTimeOfDay(shift.lastBeatAt)}; `
    + "«нет связи» — расширение закрыто или без сети. ";
  const ends = `и кончится на последнем действии и ${CHATTER_SHIFT_IDLE_PAUSE_MINUTES} мин после него.`;
  // Still going an hour after the last action: only a break inside the person's own slot goes on so long.
  if (serverNow !== undefined && Date.parse(serverNow) >= closesAt) {
    return `${facts}Перерыв внутри своего слота по графику: смена идёт на паузе до конца слота. Если до его конца действий не будет, она закроется ${ends}`;
  }
  return `${facts}Смена идёт, пока не пройдёт ${CHATTER_SHIFT_END_IDLE_MINUTES} мин без действий, а в перерыве внутри своего слота по графику: до конца слота. `
    + `Если действий больше не будет, она закроется в ${formatTimeOfDay(closesAt)} (в слоте: в его конце) ${ends}`;
}

interface PausedShift {
  ongoing: boolean;
  endedAt: string;
  pauses: ReadonlyArray<{ from: string; to: string }>;
}

/**
 * When the break going on now began: the last pause of a shift going on, when it runs to the shift's end so far (Hub
 * counts a break going on now as a pause already); null — at work now, or over.
 */
export function pausedSince(shift: PausedShift): string | null {
  if (!shift.ongoing) return null;
  const last = shift.pauses.at(-1);
  return last !== undefined && Date.parse(last.to) >= Date.parse(shift.endedAt) ? last.from : null;
}

/** «пауза с 11:02» of a shift going on in a break; null — at work now, or over. */
export function shiftPauseText(shift: PausedShift): string | null {
  const since = pausedSince(shift);
  return since === null ? null : `пауза с ${formatTimeOfDay(since)}`;
}
