/**
 * The words of «Состояние»: a routine's and a copy's state, its period, its
 * place. One place for them, so the rows, the group lines and the details say
 * the same thing.
 */
import type { CopyState, RoutineState, SystemPlace, SystemStateRoutine } from "@agency_hub_core/contracts";
import { formatAgo, formatDateTime, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import type { StatusTone } from "@/lib/statusWords";

export const PLACE_TITLE: Readonly<Record<SystemPlace, string>> = { server: "Сервер", mac: "Мак", pc: "ПК" };
export const PLACES: readonly SystemPlace[] = ["server", "mac", "pc"];

export const ROUTINE_WORD: Readonly<Record<RoutineState, { word: string; tone: StatusTone }>> = {
  silent: { word: "Молчит", tone: "broken" },
  failing: { word: "Сбои подряд", tone: "broken" },
  empty_long: { word: "Пустой вход", tone: "broken" },
  failed_once: { word: "Сбой", tone: "attention" },
  empty: { word: "Пустой вход", tone: "attention" },
  unchecked: { word: "Не проверено", tone: "off" },
  outcome_unknown: { word: "Итог не виден", tone: "moving" },
  pending: { word: "Ещё не запускалась", tone: "moving" },
  skipped: { word: "Нечего делать", tone: "moving" },
  ok: { word: "Работает", tone: "good" },
};

export const COPY_WORD: Readonly<Record<CopyState, { word: string; tone: StatusTone }>> = {
  stale: { word: "Устарела", tone: "broken" },
  unchecked: { word: "Не проверено", tone: "off" },
  fresh: { word: "Свежая", tone: "good" },
};

/** «раз в 15 мин», «раз в час», «раз в сутки», «раз в 22 дня»: the longest gap of its schedule. */
export function periodWords(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `раз в ${minutes} мин`;
  if (minutes === 60) return "раз в час";
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `раз в ${hours} ч` : `раз в ${hours} ч ${rest} мин`;
  }
  const days = Math.round(minutes / (24 * 60));
  if (days === 1) return "раз в сутки";
  if (days === 7) return "раз в неделю";
  return `раз в ${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

const MOSCOW_DAY = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", year: "numeric", month: "numeric", day: "numeric" });

/** «14:05 (мск)» today, «3 нояб., 14:05 (мск)» another day. */
export function moscowAt(at: string, now: number = Date.now()): string {
  const sameDay = MOSCOW_DAY.format(new Date(at)) === MOSCOW_DAY.format(new Date(now));
  return `${sameDay ? formatTimeOfDay(at) : formatDateTime(at, { yearUnlessCurrent: true })} (мск)`;
}

/** «4 дня», «5 ч», «40 мин»: how long. */
export function spanWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  const days = Math.round(hours / 24);
  return `${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

/** The second line of a routine: what its state means, in plain words, with its last success. */
export function routineLine(routine: SystemStateRoutine, now: number = Date.now()): string {
  const period = periodWords(routine.periodSeconds);
  const success = routine.lastSuccessAt ? `последний успех ${formatAgo(routine.lastSuccessAt, now)}` : "успеха не было";
  const ran = routine.lastRunAt ? formatAgo(routine.lastRunAt, now) : null;
  const detail = routine.detail ? ` ${routine.detail.replace(/[.\s]+$/, "")}.` : "";
  switch (routine.state) {
    case "silent":
      return ran ? `Последний запуск ${ran}, а ждали ${period}.` : `Ни одного запуска, а ждали ${period}.`;
    case "failing":
      return `Сбоев подряд: ${routine.failedStreak}.${detail} ${capital(success)}.`;
    case "failed_once":
      return `Последний запуск со сбоем${ran ? `, ${ran}` : ""}.${detail} ${capital(success)}.`;
    case "empty_long":
    case "empty": {
      const since = routine.emptySince ?? routine.lastRunAt;
      const limit = routine.emptyThresholdSeconds === null ? "" : `, порог ${spanWords(routine.emptyThresholdSeconds * 1000)}`;
      return `${since ? `Работает, но на входе пусто уже ${spanWords(now - Date.parse(since))}` : "На входе пусто"}${limit}. ${capital(success)}.`;
    }
    case "unchecked":
      return `Не проверено: место не присылает состояние. ${capital(success)}.`;
    case "outcome_unknown":
      return `Запуск ${ran ?? ""}, итог отсюда не виден · ${period}`;
    case "pending":
      return `Ещё не запускалась · ${period}`;
    case "skipped":
      return `Делать было нечего${ran ? `, проверка ${ran}` : ""} · ${period}`;
    case "ok":
      return `${capital(success)} · ${period}`;
  }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** «1,2 ГБ», «230 МБ», «18 КБ». */
export function bytesWords(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: digits })}\u00a0${units[unit]}`;
}
