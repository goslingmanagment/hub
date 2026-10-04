import type { AdminSyncBlockResponse, SyncBlockStatus } from "@agency_hub_core/contracts";

import { ruPlural } from "@/lib/plural";

import {
  engineAgeText,
  engineClockText,
  engineCount,
  engineDurationText,
  engineReadingState,
  engineReadingTone,
  engineReadingWords,
  engineStopText,
  engineWaitWords,
  isCredentialsStop,
  type EngineReadingState,
  type EngineReadingTone,
  type EngineStop,
} from "./engineDisplay.js";

// The five blocks of a Fansly page on the «Синк» tab, in the tab's language:
// what each block is, what is true of it now — read, paused, held, without an
// owner, in need of the owner — what its buttons do, and what a button did.
// Every fact is the server's (`SyncBlockStatus.engine`: the keys the block's
// buttons move, what stops them by the engine's own hold evaluator, the work
// in quarantine); this file only words them.

export type EngineBlockKey = SyncBlockStatus["block"];
export type EngineBlockInfo = NonNullable<SyncBlockStatus["engine"]>;
/** A block of a page the Fansly Sync Engine owns. */
export type EngineBlock = SyncBlockStatus & { engine: EngineBlockInfo };
export type EngineSubstream = SyncBlockStatus["substreams"][number];

export function isEngineBlock(block: SyncBlockStatus): block is EngineBlock {
  return block.state === "engine" && block.engine !== undefined;
}

const BLOCK_ORDER: readonly EngineBlockKey[] = ["connection", "financials", "audience", "messages_live", "messages_history"];

export function engineBlockOrder(): readonly EngineBlockKey[] {
  return BLOCK_ORDER;
}

const BLOCK_LABELS: Record<EngineBlockKey, string> = {
  connection: "Подключение",
  financials: "Финансы",
  audience: "Аудитория",
  messages_live: "Список чатов",
  messages_history: "Сообщения чатов",
};

const BLOCK_DESCRIPTIONS: Record<EngineBlockKey, string> = {
  connection: "Проверяет, что аккаунт страницы подключён и авторизован.",
  financials: "Транзакции и рейтинг топ-спендеров.",
  audience: "Подписчики и фолловеры страницы, профили фанов.",
  messages_live: "Список чатов: новые чаты, последнее сообщение каждого, профили собеседников.",
  messages_history: "Сообщения чатов: новые сообщения и история по заявкам.",
};

const STREAM_LABELS: Record<string, string> = {
  light: "подключение",
  transactions: "транзакции",
  top_spenders: "топ-спендеры",
  subscribers: "подписчики",
  followers: "фолловеры",
  followers_reconcile: "сверка фолловеров",
  dm_conversations: "список чатов",
  dm_messages: "сообщения чатов",
};

export function engineBlockLabel(block: EngineBlockKey): string {
  return BLOCK_LABELS[block];
}

export function engineBlockDescription(block: EngineBlockKey): string {
  return BLOCK_DESCRIPTIONS[block];
}

export function engineStreamLabel(stream: string): string {
  return STREAM_LABELS[stream] ?? stream.replaceAll("_", " ");
}

/** What a block of a Fansly page the engine does not own says (the server's
 *  reason `fansly_sync_engine_off`). */
export const ENGINE_BLOCK_NOT_READ = "Fansly Sync Engine не ведёт эту страницу: блок никто не читает.";

// ── what is true of a block and of its streams ───────────────────────────────

export function engineBlockState(block: EngineBlock): EngineReadingState {
  return engineReadingState({
    mode: block.engine.mode,
    ownerRunning: block.engine.ownerRunning,
    stopped: block.engine.stopped,
    stops: block.engine.stops,
    paused: block.engine.paused,
    needsAttention: block.needsAttention,
    activeWork: block.engine.activeWork,
    everRead: block.succeededAt !== null,
  });
}

export function engineSubstreamState(block: EngineBlock, substream: EngineSubstream): EngineReadingState {
  return engineReadingState({
    mode: block.engine.mode,
    ownerRunning: block.engine.ownerRunning,
    stopped: substream.engine?.stopped ?? "none",
    stops: substream.engine?.stops ?? [],
    paused: substream.engine?.paused ?? false,
    needsAttention: substream.needsAttention,
    activeWork: substream.engine?.activeWork ?? 0,
    everRead: substream.succeededAt !== null,
  });
}

export interface EngineTone {
  badge: string;
  dot: string;
  text: string;
}

const TONES: Record<EngineReadingTone, EngineTone> = {
  ok: { badge: "border-green/30 bg-green/10 text-green", dot: "bg-green", text: "text-text-secondary" },
  quiet: { badge: "border-border bg-hover-alt text-text-secondary", dot: "bg-text-muted", text: "text-text-secondary" },
  warn: { badge: "border-warning/30 bg-warning/10 text-warning-dark", dot: "bg-warning-dark", text: "text-warning-dark" },
};

export function engineStateTone(state: EngineReadingState): EngineTone {
  return TONES[engineReadingTone(state)];
}

export function engineStateLabel(state: EngineReadingState): string {
  const { text } = engineReadingWords(state, "ru");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "через 12 мин", "сейчас": when open work is due. */
export function engineDueText(iso: string, now: number): string {
  const seconds = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (seconds <= 0) return "сейчас";
  if (seconds < 60) return "меньше чем через минуту";
  return `через ${engineDurationText(seconds)}`;
}

/** A stop as the tab writes it. With `keysOf` (how many keys the block or the
 *  stream has) the keys are named unless the stop takes them all. */
export function engineBlockStopText(stop: EngineStop, now: number, keysOf?: number): string {
  return engineStopText(stop, {
    language: "ru",
    until: (iso) => engineClockText(iso, now),
    listKeys: keysOf !== undefined && stop.resources.length < keysOf,
  });
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function readText(succeededAt: string | null, now: number): string {
  const age = engineAgeText(succeededAt, now);
  return age === null ? "ещё не читалось" : `последнее чтение ${age} назад`;
}

/** A block's quarantined and refused work: "в карантине 1, Fansly отказывает 2". */
export function engineAttentionText(info: Pick<EngineBlockInfo, "quarantined" | "blockedByVendor">): string {
  return [
    info.quarantined.count > 0 ? `в карантине ${engineCount(info.quarantined.count)}` : null,
    info.blockedByVendor.count > 0 ? `Fansly отказывает ${engineCount(info.blockedByVendor.count)}` : null,
  ].filter((part): part is string => part !== null).join(", ");
}

/** A block in one line (the page's card of the list): what is true of it —
 *  with what stops it and what of it needs the owner — and when it was last
 *  read. A hold of the whole page is named once, on the page: its blocks say
 *  only that the page is held. */
export function engineBlockSummary(block: EngineBlock, now: number = Date.now()): string {
  const state = engineBlockState(block);
  const words = engineReadingWords(state, "ru").text;
  if (state === "no_owner" || state === "switching") return words;
  const [first] = block.engine.stops;
  const stop = first === undefined
    ? null
    : `${lowerFirst(engineBlockStopText(first, now))}${block.engine.stops.length > 1 ? ` и ещё ${block.engine.stops.length - 1}` : ""}`;
  const attention = engineAttentionText(block.engine);
  const parts: string[] = [];
  switch (state) {
    case "paused":
    case "held":
      parts.push(stop ?? words);
      break;
    case "partly_paused":
    case "partly_held":
      parts.push(stop === null ? words : `${words}: ${stop}`);
      break;
    case "page_held":
    case "attention":
    case "reading":
      parts.push(words);
      break;
    case "idle":
    case "never_read":
      // Nothing to say but when it was read.
      break;
  }
  if (attention !== "") parts.push(attention);
  parts.push(readText(block.succeededAt, now));
  return parts.join(" · ");
}

/** What a stream of a block says in the "Состояние" column: what is true of
 *  it, and for a stream that is read — why its earliest work waits. */
export function engineSubstreamStateText(block: EngineBlock, substream: EngineSubstream): string {
  const state = engineSubstreamState(block, substream);
  if (engineReadingTone(state) === "ok") {
    const waits = substream.statusReason?.code == null ? null : engineWaitWords(substream.statusReason.code, "ru");
    if (waits !== null) return waits.charAt(0).toUpperCase() + waits.slice(1);
  }
  return engineStateLabel(state);
}

/** The commands that list work a block needs the owner for: quarantined rows
 *  are a state of their own; rows Fansly refuses stay open, so those are
 *  listed by their key. */
export function engineAttentionLines(block: EngineBlock, pageLabel: string): string[] {
  const list = `pnpm cli sync work list --page ${pageLabel}`;
  const { quarantined, blockedByVendor } = block.engine;
  return [
    ...(quarantined.count > 0
      ? [`В карантине: ${engineCount(quarantined.count)} (${quarantined.resources.join(", ")}) · ${list} --state quarantined`]
      : []),
    ...blockedByVendor.resources.map((resource) =>
      `Fansly отказывает: ${resource} · ${list} --state open --resource ${resource}`),
  ];
}

/** The block's page is held for its credentials: only new ones end it. */
export function engineBlockCredentialsRefused(block: EngineBlock): boolean {
  return block.engine.stops.some(isCredentialsStop);
}

// ── the buttons ──────────────────────────────────────────────────────────────

export interface EngineBlockButtons {
  /** "Sync now": the block's polls due now — only while live, and only for a
   *  block with a poll the owner has not paused. */
  trigger: boolean;
  /** Pause the block's keys that are not paused; null: every one is. */
  pause: { label: string } | null;
  /** Resume the block's paused keys; null: none is. */
  resume: { label: string } | null;
  /** Requeue the block's quarantined rows; null: none is quarantined. */
  requeue: { label: string } | null;
}

/**
 * The buttons of a block act on the block's own keys (`engine.keys`; no key
 * is another block's): "sync now" on its polls, pause and resume on the keys
 * themselves, the requeue on their quarantined rows. A partial pause is shown
 * as partial: each button says how many keys it moves.
 */
export function engineBlockButtons(block: EngineBlock): EngineBlockButtons {
  const { keys, pausedKeys, pausedAll, pollKeys, quarantined, mode } = block.engine;
  const live = mode === "live";
  const paused = pausedKeys.length;
  const free = keys.length - paused;
  const partial = paused > 0 && free > 0;
  return {
    trigger: live && !pausedAll && pollKeys.some((key) => !pausedKeys.includes(key)),
    pause: free === 0 ? null : { label: partial ? `Пауза для остальных (${free})` : "Пауза" },
    resume: paused === 0 ? null : { label: partial ? `Снять паузу (${paused} из ${keys.length})` : "Снять паузу" },
    requeue: live && quarantined.count > 0 ? { label: `Вернуть из карантина (${engineCount(quarantined.count)})` } : null,
  };
}

/** What the requeue's confirmation says: the rows it takes, by key. */
export function engineRequeueConfirmText(block: EngineBlock, pageLabel: string): string {
  const { count, resources } = block.engine.quarantined;
  const rows = `${engineCount(count)} ${ruPlural(count, "строка", "строки", "строк")}`;
  return `${rows} в карантине (${resources.join(", ")}) на ${pageLabel} ${ruPlural(count, "запустится", "запустятся", "запустятся")} снова: `
    + "сохранённый ответ применяется из журнала без нового запроса. Ничего не удаляется.";
}

export type EngineLeverAction = AdminSyncBlockResponse["action"];

/** What a lever's toast says, and how: `success` — it did what the button
 *  says; `warning` — it did, and nothing will be sent anyway; `message` —
 *  there was nothing to do. */
export interface EngineLeverNotice {
  kind: "success" | "warning" | "message";
  text: string;
}

/** A stop that takes every key of the block; the first, in the engine's
 *  order. `after`: only the stops a resume of the block's keys leaves. */
function stopOfEveryKey(block: EngineBlock, after: "now" | "resume"): EngineStop | null {
  const all = block.engine.keys.length;
  return block.engine.stops.find((stop) =>
    stop.resources.length === all && !(after === "resume" && stop.reason === "paused" && stop.by.includes("keys"))) ?? null;
}

/** Why nothing of a block is sent, for a notice: no host runs the page, or a
 *  stop takes every key. Null: something of it can be sent. */
function nothingSentBecause(block: EngineBlock, after: "now" | "resume", now: number): string | null {
  if (!block.engine.ownerRunning) {
    return block.engine.mode === "handover" ? "страница переключается на движок" : "страницу не ведёт ни один sync-хост";
  }
  const stop = stopOfEveryKey(block, after);
  return stop === null ? null : lowerFirst(engineBlockStopText(stop, now));
}

/**
 * What a lever did, from the server's answer (`engine.affected`: the polls
 * made due, the keys paused or resumed, the rows requeued) and the block as it
 * stood: never "done" for a lever that moved nothing, and never silent about
 * a block of which nothing will be sent anyway.
 */
export function engineLeverNotice(
  action: EngineLeverAction,
  block: EngineBlock,
  response: Pick<AdminSyncBlockResponse, "engine">,
  now: number = Date.now(),
): EngineLeverNotice {
  const label = engineBlockLabel(block.block);
  const affected = response.engine?.affected ?? 0;
  // What the lever did, and — when nothing of the block is sent anyway — that.
  const but = (did: string, blocked: string | null, moved: boolean): EngineLeverNotice => (blocked === null
    ? { kind: moved ? "success" : "message", text: `${label}: ${did}` }
    : { kind: "warning", text: `${label}: ${did}; запросы не уйдут — ${blocked}` });
  switch (action) {
    case "trigger":
      return but(
        affected === 0
          ? "ни один опрос не сдвинут — опросы блока уже в очереди или выполняются"
          : `${engineCount(affected)} ${ruPlural(affected, "опрос поставлен", "опроса поставлены", "опросов поставлено")} в очередь`,
        nothingSentBecause(block, "now", now),
        affected > 0,
      );
    case "pause":
      return affected === 0
        ? { kind: "message", text: `${label}: ключи блока уже на паузе` }
        : { kind: "success", text: `${label}: на паузе ${engineCount(affected)} ${ruPlural(affected, "ключ", "ключа", "ключей")}` };
    case "resume":
      return affected === 0
        ? { kind: "message", text: `${label}: на паузе ничего не было` }
        : but(
          `пауза снята с ${engineCount(affected)} ${ruPlural(affected, "ключа", "ключей", "ключей")}`,
          nothingSentBecause(block, "resume", now),
          true,
        );
    case "reset":
      return affected === 0
        ? { kind: "message", text: `${label}: в карантине ничего не было — возвращать нечего` }
        : {
          kind: "success",
          text: `${label}: из карантина ${ruPlural(affected, "возвращена", "возвращены", "возвращено")} `
            + `${engineCount(affected)} ${ruPlural(affected, "строка", "строки", "строк")}`,
        };
  }
}

/** A period as the tab writes it: "раз в 5 мин". */
export function engineCadenceText(seconds: number): string {
  return `раз в ${engineDurationText(seconds)}`;
}
