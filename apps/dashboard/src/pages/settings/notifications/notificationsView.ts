import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

/**
 * The daily report's hour. Hub stores it in UTC (`reportHourUtc`); the owner
 * picks it by Moscow, which has no daylight saving: the shift is a constant 3 h.
 */
const MOSCOW_OFFSET_HOURS = 3;

export function moscowHourFromUtc(hourUtc: number): number {
  return (((hourUtc + MOSCOW_OFFSET_HOURS) % 24) + 24) % 24;
}

export function utcHourFromMoscow(moscowHour: number): number {
  return (((moscowHour - MOSCOW_OFFSET_HOURS) % 24) + 24) % 24;
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** What Telegram refused, in words; the raw text stays in the title. */
export function telegramErrorRu(raw: string | null | undefined): string {
  const text = (raw ?? "").toLowerCase();
  if (text.includes("429")) return "Telegram просит подождать";
  if (text.includes("401") || text.includes("403")) return "Telegram не принял бота";
  if (text.includes("400") || text.includes("chat not found")) return "Telegram не нашёл чат";
  return "Telegram не принял сообщение";
}

/** A Telegram chat's kind in words. */
export function chatTypeRu(type: string): string {
  switch (type) {
    case "private": return "личный чат";
    case "group": return "группа";
    case "supergroup": return "супергруппа";
    case "channel": return "канал";
    default: return type;
  }
}

/** Why a report was skipped. */
export function skippedReasonRu(error: string | null): string | null {
  if (error === "disabled") return "оповещения были выключены";
  if (error === "unconfigured") return "Telegram не был подключён";
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"" };

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot);/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * The report's text as Telegram shows it: `<b>` and `<i>` become elements, the
 * entities their letters, everything else stays text. No HTML is injected.
 */
export function telegramHtml(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /<(b|i)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let key = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) out.push(createElement(Fragment, { key: key++ }, decode(text.slice(last, match.index))));
    const tag = match[1] === "b" ? "b" : "i";
    out.push(createElement(tag, { key: key++, className: tag === "b" ? "font-semibold" : undefined }, decode(match[2] ?? "")));
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(createElement(Fragment, { key: key++ }, decode(text.slice(last))));
  return out;
}
