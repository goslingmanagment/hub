import type {
  AdminAiSpendQuery,
  AdminAiSpendResponse,
  AiSpendRow,
} from "@agency_hub_core/contracts";
import {
  AI_SPEND_DIMENSIONS,
  listAiSettingChanges,
  listAiSpendByChatterMinute,
  listAiSpendCells,
  listAiSpendConversations,
  listAiSpendFeatureUse,
  listAiSpendTopCalls,
  listChatterActivityMinutes,
  sumAiSpendBetween,
  type AiSpendCell,
  type AiSpendDimension,
} from "@agency_hub_core/db";
import { MOSCOW_TIME_ZONE, aiUsageLedgerFeatures, businessDateToUtcStart, nextBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { aiGatewayModelRates } from "./ai-gateway-pricing.ts";
import { shiftsOfMinutes, type ActivityMinute } from "./chatter-shifts.ts";
import { BadRequestError } from "./errors.ts";

/** The longest period one report reads. */
export const AI_SPEND_MAX_DAYS = 92;
/** Shift costs read the period's last days only (the shift reader's own cap). */
const AI_SPEND_SHIFT_DAYS = 7;
/** Spend compared before and after a setting change, each side. */
const SETTING_EFFECT_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Features whose answer is a draft the extension reports using (copied,
 *  inserted, edited, sent). Recap, notes and reviews are read, not sent. */
const DRAFT_FEATURES = new Set(["fast-reply", "improve-draft", "hi-greeting", "ping", "coach-chat", "help-me", "voice-script"]);

type SpendCellSums = Omit<AiSpendCell, "dimension" | "key" | "label" | "model">;

/** A recorded price split by token type at the model's list rates. Cache
 *  writes without a TTL split are placed at the 5m rate up to what the price
 *  leaves room for at the 1h rate; whatever the rates cannot place (an
 *  estimate, a fallback at another model's price) is `other`. */
export function splitSpendParts(model: string, cell: SpendCellSums): AiSpendRow["parts"] {
  const rates = aiGatewayModelRates(model);
  if (!rates) {
    return { inputMicroUsd: 0, cacheReadMicroUsd: 0, cacheWriteMicroUsd: 0, outputMicroUsd: 0, otherMicroUsd: cell.costMicroUsd };
  }
  const input = Math.round(cell.inputTokens * rates.input);
  const cacheRead = Math.round(cell.cacheReadTokens * rates.cacheRead);
  const output = Math.round(cell.outputTokens * rates.output);
  let cacheWrite = Math.round(
    cell.cacheWrite5mTokens * rates.cacheWrite5m
    + cell.cacheWrite1hTokens * rates.cacheWrite1h
    + cell.cacheWriteUnsplitTokens * rates.cacheWrite5m,
  );
  const left = cell.costMicroUsd - input - cacheRead - output - cacheWrite;
  if (cell.cacheWriteUnsplitTokens > 0 && left > 0) {
    cacheWrite += Math.min(left, Math.round(cell.cacheWriteUnsplitTokens * (rates.cacheWrite1h - rates.cacheWrite5m)));
  }
  return {
    inputMicroUsd: input,
    cacheReadMicroUsd: cacheRead,
    cacheWriteMicroUsd: cacheWrite,
    outputMicroUsd: output,
    otherMicroUsd: cell.costMicroUsd - input - cacheRead - output - cacheWrite,
  };
}

function emptyRow(key: string, label: string): AiSpendRow {
  return {
    key,
    label,
    calls: 0,
    costMicroUsd: 0,
    approximateMicroUsd: 0,
    regenerationCalls: 0,
    regenerationMicroUsd: 0,
    failedCalls: 0,
    failedMicroUsd: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, output: 0 },
    parts: { inputMicroUsd: 0, cacheReadMicroUsd: 0, cacheWriteMicroUsd: 0, outputMicroUsd: 0, otherMicroUsd: 0 },
  };
}

function addCell(row: AiSpendRow, cell: AiSpendCell) {
  row.calls += cell.calls;
  row.costMicroUsd += cell.costMicroUsd;
  row.approximateMicroUsd += cell.approximateMicroUsd;
  row.regenerationCalls += cell.regenerationCalls;
  row.regenerationMicroUsd += cell.regenerationMicroUsd;
  row.failedCalls += cell.failedCalls;
  row.failedMicroUsd += cell.failedMicroUsd;
  row.tokens.input += cell.inputTokens;
  row.tokens.cacheRead += cell.cacheReadTokens;
  row.tokens.cacheWrite5m += cell.cacheWrite5mTokens;
  row.tokens.cacheWrite1h += cell.cacheWrite1hTokens;
  row.tokens.cacheWriteUnsplit += cell.cacheWriteUnsplitTokens;
  row.tokens.output += cell.outputTokens;
  const parts = splitSpendParts(cell.model, cell);
  row.parts.inputMicroUsd += parts.inputMicroUsd;
  row.parts.cacheReadMicroUsd += parts.cacheReadMicroUsd;
  row.parts.cacheWriteMicroUsd += parts.cacheWriteMicroUsd;
  row.parts.outputMicroUsd += parts.outputMicroUsd;
  row.parts.otherMicroUsd += parts.otherMicroUsd;
}

const CHRONOLOGICAL: ReadonlySet<AiSpendDimension> = new Set(["day", "hour", "dayFeature"]);

/** One dimension's cells folded over models: dearest first, or in time order
 *  for days and hours. */
export function foldSpendCells(cells: readonly AiSpendCell[], dimension: AiSpendDimension): AiSpendRow[] {
  const rows = new Map<string, AiSpendRow>();
  for (const cell of cells) {
    if (cell.dimension !== dimension) continue;
    const row = rows.get(cell.key) ?? emptyRow(cell.key, cell.label);
    addCell(row, cell);
    rows.set(cell.key, row);
  }
  return [...rows.values()].sort((a, b) => CHRONOLOGICAL.has(dimension)
    ? a.key.localeCompare(b.key)
    : b.costMicroUsd - a.costMicroUsd || a.key.localeCompare(b.key));
}

const LEDGER_FEATURES: ReadonlySet<string> = new Set(aiUsageLedgerFeatures);

/** Settings that steer one lane, by name: their effect is that lane's spend. */
const SETTING_FEATURES: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/^fanFacts/, ["fan-facts"]],
  [/^aiNotes/, ["fan-notes-fill"]],
  [/^aiMediaDescribe/, ["media-describe"]],
  [/^aiCoach/, ["coach-chat"]],
];

/** The features a setting change touched: the keys whose value changed in a
 *  per-feature setting (a JSON object keyed by feature), or the lane a
 *  setting is named for; null for a setting of the whole hub. */
export function settingChangeFeatures(key: string, oldValue: unknown, newValue: unknown): string[] | null {
  const named = SETTING_FEATURES.find(([pattern]) => pattern.test(key));
  if (named) return [...named[1]];
  const parse = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  };
  const before = parse(oldValue);
  const after = parse(newValue);
  const isMap = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isMap(before) && !isMap(after)) return null;
  const a = isMap(before) ? before : {};
  const b = isMap(after) ? after : {};
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => LEDGER_FEATURES.has(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
  return changed.length > 0 ? changed : null;
}

export function spendWindow(hours: number, microUsd: number) {
  return {
    hours: Math.round(hours * 10) / 10,
    microUsd,
    perDayMicroUsd: hours >= 1 ? Math.round((microUsd / hours) * 24) : null,
  };
}

export interface ShiftWindow {
  userId: number;
  username: string;
  startedAt: number;
  endedAt: number;
  workedMinutes: number;
}

/** A chatter's AI spend inside their shifts, per shift and per worked hour;
 *  what they spent outside every shift is counted apart. */
export function attributeShiftSpend(
  shifts: readonly ShiftWindow[],
  minuteCosts: readonly { userId: number; minute: Date; costMicroUsd: number }[],
) {
  const perHour = (microUsd: number, minutes: number) => minutes > 0 ? Math.round((microUsd / minutes) * 60) : null;
  const byUser = new Map<number, { username: string; shifts: number; workedMinutes: number; inShiftsMicroUsd: number }>();
  for (const shift of shifts) {
    const person = byUser.get(shift.userId) ?? { username: shift.username, shifts: 0, workedMinutes: 0, inShiftsMicroUsd: 0 };
    person.shifts += 1;
    person.workedMinutes += shift.workedMinutes;
    byUser.set(shift.userId, person);
  }
  let inShifts = 0;
  let outside = 0;
  for (const cost of minuteCosts) {
    const at = cost.minute.getTime();
    const shift = shifts.find((candidate) => candidate.userId === cost.userId && at >= candidate.startedAt && at < candidate.endedAt);
    if (shift) {
      inShifts += cost.costMicroUsd;
      byUser.get(shift.userId)!.inShiftsMicroUsd += cost.costMicroUsd;
    } else {
      outside += cost.costMicroUsd;
    }
  }
  const workedMinutes = shifts.reduce((sum, shift) => sum + shift.workedMinutes, 0);
  return {
    shifts: shifts.length,
    workedMinutes,
    inShiftsMicroUsd: inShifts,
    outsideShiftsMicroUsd: outside,
    perShiftMicroUsd: shifts.length > 0 ? Math.round(inShifts / shifts.length) : null,
    perWorkedHourMicroUsd: perHour(inShifts, workedMinutes),
    byChatter: [...byUser.entries()]
      .map(([userId, person]) => ({
        userId,
        username: person.username,
        shifts: person.shifts,
        workedMinutes: person.workedMinutes,
        inShiftsMicroUsd: person.inShiftsMicroUsd,
        perShiftMicroUsd: person.shifts > 0 ? Math.round(person.inShiftsMicroUsd / person.shifts) : null,
        perWorkedHourMicroUsd: perHour(person.inShiftsMicroUsd, person.workedMinutes),
      }))
      .sort((a, b) => b.inShiftsMicroUsd - a.inShiftsMicroUsd),
  };
}

async function readShiftSpend(app: Pick<AppContext, "db">, window: { from: Date; to: Date }, now: Date) {
  const [activity, minuteCosts] = await Promise.all([
    listChatterActivityMinutes(app.db, { from: window.from, to: window.to, pages: "all" }),
    listAiSpendByChatterMinute(app.db, { from: window.from, toExclusive: window.to }),
  ]);
  const people = new Map<number, { username: string; minutes: ActivityMinute[] }>();
  for (const row of activity) {
    const person = people.get(row.userId) ?? { username: row.username, minutes: [] };
    person.minutes.push({ at: row.minute.getTime(), pageLabel: row.pageLabel, input: row.input });
    people.set(row.userId, person);
  }
  const shifts: ShiftWindow[] = [];
  for (const [userId, person] of people) {
    for (const shift of shiftsOfMinutes(person.minutes, Math.min(now.getTime(), window.to.getTime()))) {
      shifts.push({ userId, username: person.username, startedAt: shift.startedAt, endedAt: shift.endedAt, workedMinutes: shift.workedMinutes });
    }
  }
  return { from: window.from.toISOString(), to: window.to.toISOString(), ...attributeShiftSpend(shifts, minuteCosts) };
}

export function resolveAiSpendRange(query: AdminAiSpendQuery, now: Date) {
  const from = businessDateToUtcStart(query.from, MOSCOW_TIME_ZONE);
  const toExclusive = businessDateToUtcStart(nextBusinessDate(query.to), MOSCOW_TIME_ZONE);
  if (toExclusive.getTime() - from.getTime() > AI_SPEND_MAX_DAYS * DAY_MS) {
    throw new BadRequestError(`The period is at most ${AI_SPEND_MAX_DAYS} days`);
  }
  return { from, toExclusive, until: new Date(Math.min(toExclusive.getTime(), now.getTime())) };
}

export async function getAdminAiSpendReport(
  app: Pick<AppContext, "db">,
  query: AdminAiSpendQuery,
  now = new Date(),
): Promise<AdminAiSpendResponse> {
  const { from, toExclusive, until } = resolveAiSpendRange(query, now);
  const range = { from, toExclusive, timeZone: MOSCOW_TIME_ZONE };
  const shiftFrom = new Date(Math.max(from.getTime(), until.getTime() - AI_SPEND_SHIFT_DAYS * DAY_MS));
  const [cells, featureUse, topCalls, conversations, changes, shifts] = await Promise.all([
    listAiSpendCells(app.db, range),
    listAiSpendFeatureUse(app.db, range),
    listAiSpendTopCalls(app.db, { ...range, limit: 25 }),
    listAiSpendConversations(app.db, { ...range, limit: 15 }),
    // A change just before the period still explains its first days.
    listAiSettingChanges(app.db, { from: new Date(from.getTime() - SETTING_EFFECT_HOURS * HOUR_MS), toExclusive }),
    until > shiftFrom
      ? readShiftSpend(app, { from: shiftFrom, to: until }, now)
      : Promise.resolve({ from: shiftFrom.toISOString(), to: until.toISOString(), ...attributeShiftSpend([], []) }),
  ]);

  const total = emptyRow("all", "all");
  for (const cell of cells) {
    if (cell.dimension === "branch") addCell(total, cell);
  }
  const breakdowns = Object.fromEntries(
    AI_SPEND_DIMENSIONS.map((dimension) => [dimension, foldSpendCells(cells, dimension)]),
  ) as AdminAiSpendResponse["breakdowns"];

  const settingChanges = await Promise.all(changes.map(async (change) => {
    const features = settingChangeFeatures(change.key, change.oldValue, change.newValue);
    const at = change.changedAt.getTime();
    const beforeFrom = new Date(at - SETTING_EFFECT_HOURS * HOUR_MS);
    const afterTo = new Date(Math.min(at + SETTING_EFFECT_HOURS * HOUR_MS, now.getTime()));
    const scope = features ?? undefined;
    const [before, after] = await Promise.all([
      sumAiSpendBetween(app.db, { from: beforeFrom, toExclusive: change.changedAt, ...(scope ? { features: scope } : {}) }),
      afterTo.getTime() > at
        ? sumAiSpendBetween(app.db, { from: change.changedAt, toExclusive: afterTo, ...(scope ? { features: scope } : {}) })
        : Promise.resolve(0),
    ]);
    return {
      at: change.changedAt.toISOString(),
      key: change.key,
      username: change.username,
      oldValue: change.oldValue,
      newValue: change.newValue,
      features,
      before: spendWindow(SETTING_EFFECT_HOURS, before),
      after: spendWindow(Math.max(0, afterTo.getTime() - at) / HOUR_MS, after),
    };
  }));

  return {
    generatedAt: now.toISOString(),
    from: query.from,
    to: query.to,
    timeZone: MOSCOW_TIME_ZONE,
    total,
    breakdowns,
    features: featureUse
      .map((row) => {
        const tracksUse = DRAFT_FEATURES.has(row.feature);
        return {
          feature: row.feature,
          calls: row.calls,
          costMicroUsd: row.costMicroUsd,
          perCallMicroUsd: row.calls > 0 ? Math.round(row.costMicroUsd / row.calls) : null,
          tracksUse,
          usedCalls: row.usedCalls,
          sentCalls: row.sentCalls,
          sentMessages: row.sentMessages,
          perSentMessageMicroUsd: tracksUse && row.sentMessages > 0 ? Math.round(row.costMicroUsd / row.sentMessages) : null,
          unusedCalls: tracksUse ? row.unusedCalls : 0,
          unusedMicroUsd: tracksUse ? row.unusedMicroUsd : 0,
        };
      })
      .sort((a, b) => b.costMicroUsd - a.costMicroUsd),
    conversations: {
      count: conversations.conversations,
      costMicroUsd: conversations.costMicroUsd,
      perConversationMicroUsd: conversations.conversations > 0
        ? Math.round(conversations.costMicroUsd / conversations.conversations)
        : null,
      top: conversations.top,
    },
    topCalls: topCalls.map((call) => ({ ...call, completedAt: call.completedAt.toISOString() })),
    shifts,
    settingChanges,
  };
}

function usd(microUsd: number | null) {
  if (microUsd === null) return "—";
  const value = microUsd / 1_000_000;
  return Math.abs(value) < 0.01 && value !== 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function share(part: number, whole: number) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

/** The report as text for an agent's terminal (`ai:spend`): the answer to
 *  "what did AI money go to" in one screen. */
export function formatAiSpendReport(report: AdminAiSpendResponse): string {
  const lines: string[] = [];
  const total = report.total;
  lines.push(`Траты на ИИ ${report.from}…${report.to} (${report.timeZone}), по журналу хаба`);
  lines.push(
    `Всего ${usd(total.costMicroUsd)} за ${total.calls} вызовов (${usd(total.calls > 0 ? Math.round(total.costMicroUsd / total.calls) : null)} вызов)`
      + `; оценка ${usd(total.approximateMicroUsd)}; ошибки/отмены ${usd(total.failedMicroUsd)}; перегенерации ${usd(total.regenerationMicroUsd)}`,
  );
  const parts = total.parts;
  lines.push(
    `Из чего: вход без кеша ${usd(parts.inputMicroUsd)} (${share(parts.inputMicroUsd, total.costMicroUsd)}), чтение кеша ${usd(parts.cacheReadMicroUsd)}, `
      + `запись кеша ${usd(parts.cacheWriteMicroUsd)}, выход+размышления ${usd(parts.outputMicroUsd)} (${share(parts.outputMicroUsd, total.costMicroUsd)}), прочее ${usd(parts.otherMicroUsd)}`,
  );
  const section = (title: string, rows: readonly AiSpendRow[], limit = 12) => {
    if (rows.length === 0) return;
    lines.push("", title);
    for (const row of rows.slice(0, limit)) {
      lines.push(`  ${row.label.padEnd(22)} ${usd(row.costMicroUsd).padStart(9)} ${share(row.costMicroUsd, total.costMicroUsd).padStart(4)}  ${String(row.calls).padStart(6)} выз.`);
    }
  };
  section("Ветка (human — клик чаттера, background — фон хаба)", report.breakdowns.branch);
  section("Функция", report.breakdowns.feature);
  section("Модель", report.breakdowns.model);
  section("Effort", report.breakdowns.effort);
  section("Окно (сообщений в промпте)", report.breakdowns.window);
  section("Чаттер", report.breakdowns.chatter);
  section("Страница", report.breakdowns.page);
  section("Ключ Anthropic", report.breakdowns.account);
  section("Исход", report.breakdowns.outcome);
  section("День", report.breakdowns.day, 92);
  if (report.features.length > 0) {
    lines.push("", "Юнит-экономика (вызовы чаттеров)");
    for (const feature of report.features) {
      lines.push(
        `  ${feature.feature.padEnd(16)} вызов ${usd(feature.perCallMicroUsd)}`
          + (feature.tracksUse
            ? `; отправлено ${feature.sentMessages} сообщ. → ${usd(feature.perSentMessageMicroUsd)} за отправленное; не использовано ${feature.unusedCalls} (${usd(feature.unusedMicroUsd)})`
            : "; использование не отслеживается"),
      );
    }
  }
  const shifts = report.shifts;
  if (shifts.shifts > 0) {
    lines.push("", `Смены ${shifts.from.slice(0, 10)}…${shifts.to.slice(0, 10)}: ${shifts.shifts} смен, ${usd(shifts.perShiftMicroUsd)} за смену, ${usd(shifts.perWorkedHourMicroUsd)} за час; вне смен ${usd(shifts.outsideShiftsMicroUsd)}`);
  }
  if (report.conversations.count > 0) {
    lines.push("", `Чаты: ${report.conversations.count}, ${usd(report.conversations.perConversationMicroUsd)} на чат; дороже всех:`);
    for (const chat of report.conversations.top.slice(0, 5)) {
      lines.push(`  ${chat.pageLabel ?? "—"} ${chat.conversationId} ${usd(chat.costMicroUsd)} (${chat.calls} выз.: ${chat.features.join(", ")})`);
    }
  }
  if (report.topCalls.length > 0) {
    lines.push("", "Самые дорогие вызовы:");
    for (const call of report.topCalls.slice(0, 8)) {
      lines.push(
        `  #${call.id} ${call.completedAt.slice(0, 16)} ${call.feature} ${call.reasoningEffort ?? ""} ${usd(call.costMicroUsd)}`
          + ` in=${call.inputTokens} read=${call.cacheReadTokens} write=${call.cacheWriteTokens} out=${call.outputTokens}`
          + ` ${call.username ?? "фон"} ${call.pageLabel ?? ""} ${call.outcome}`,
      );
    }
  }
  if (report.settingChanges.length > 0) {
    lines.push("", "Правки настроек ИИ (до → после, в сутки):");
    for (const change of report.settingChanges) {
      lines.push(
        `  ${change.at.slice(0, 16)} ${change.key}${change.features ? ` [${change.features.join(", ")}]` : ""} ${change.username ?? ""}:`
          + ` ${usd(change.before.perDayMicroUsd)} → ${usd(change.after.perDayMicroUsd)} (после: ${change.after.hours} ч)`,
      );
    }
  }
  return lines.join("\n");
}
