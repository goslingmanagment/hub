import type { SyncBlockStatus } from "@agency_hub_core/contracts";

// One vocabulary for the two sync screens of System — Fansly and OnlyFans:
// the same block means the same word on both, a stream is named the same, and
// a button that runs the same mutation says the same verb. Each screen still
// words its own states (`engine/engineBlockDisplay.ts`, `syncBlockDisplay.ts`).

type BlockKey = SyncBlockStatus["block"];

export const SYNC_BLOCK_LABELS: Readonly<Record<BlockKey, string>> = {
  connection: "Подключение",
  financials: "Финансы",
  audience: "Аудитория",
  messages_live: "Список чатов",
  messages_history: "Сообщения",
};

/** A stream as both screens name it, in lower case (a cell, a list). */
const STREAM_LABELS: Readonly<Record<string, string>> = {
  light: "подключение",
  fan_identities: "профили фанов",
  transactions: "операции",
  top_spenders: "топ фанов",
  subscribers: "подписчики",
  followers: "фолловеры",
  followers_reconcile: "сверка фолловеров",
  dm_conversations: "список чатов",
  dm_messages: "сообщения",
  media_stats: "статистика медиа",
  stats_snapshot: "статистика аккаунта",
};

export function syncStreamLabel(stream: string): string {
  return STREAM_LABELS[stream] ?? stream.replaceAll("_", " ");
}

/** The verbs of the block buttons, the same on both screens. */
export const SYNC_LEVER_LABELS = {
  trigger: "Обновить сейчас",
  pause: "Пауза",
  resume: "Снять паузу",
  reset: "Сбросить",
} as const;

/** "раз в 5 мин": how often a stream is read. */
export function syncCadenceText(seconds: number): string {
  if (seconds < 60) return `раз в ${Math.max(0, Math.round(seconds))} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `раз в ${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `раз в ${hours} ч`;
  return `раз в ${Math.round(hours / 24)} сут`;
}
