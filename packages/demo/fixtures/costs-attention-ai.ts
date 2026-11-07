/**
 * The demo's AI ledger: every AI call of the invented agency, cut into
 * day × person × feature × page cells. «Траты на ИИ», «Расходы на AI»,
 * the personal limits, the Anthropic accounts and the reconciliation all
 * read these same cells, so their numbers agree with each other.
 *
 * Money is micro-USD, days are Moscow days (UTC+3), as the hub keeps them.
 */
import type { AiSpendRow, KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, hashString, intBetween, iso, microUsd, queryString, rng, type DemoRequest } from "../core.ts";
import { DEMO_PAGES, DEMO_USERS, demoFans, demoPage } from "../world.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MSK_OFFSET_MS = 3 * HOUR_MS;

// --- Moscow days -------------------------------------------------------------

export function moscowDay(date: Date): string {
  return new Date(date.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 Moscow of a business day, as a UTC instant. */
export function moscowDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - MSK_OFFSET_MS);
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function dayList(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/** Share of a Moscow day already lived at `now`: 1 for a past day, 0 for a future one. */
function dayFraction(day: string, now: Date): number {
  const start = moscowDayStart(day).getTime();
  if (now.getTime() >= start + DAY_MS) return 1;
  if (now.getTime() <= start) return 0;
  return Math.max(0.04, (now.getTime() - start) / DAY_MS);
}

// --- What the agency's AI costs ---------------------------------------------

type Feature =
  | "fast-reply" | "improve-draft" | "help-me" | "fan-summary" | "chat-review" | "scan" | "ping"
  | "hi-greeting" | "coach-chat" | "voice-script" | "fan-notes-fill";
type LedgerFeature = Feature | "media-describe" | "fan-facts";

/** Share of a person's AI money per feature, and the price of one call in dollars. */
const FEATURE_MIX: ReadonlyArray<{ feature: Feature; share: number; perCall: number }> = [
  { feature: "fast-reply", share: 0.34, perCall: 0.031 },
  { feature: "coach-chat", share: 0.17, perCall: 0.104 },
  { feature: "ping", share: 0.1, perCall: 0.057 },
  { feature: "improve-draft", share: 0.07, perCall: 0.024 },
  { feature: "hi-greeting", share: 0.07, perCall: 0.029 },
  { feature: "fan-summary", share: 0.07, perCall: 0.081 },
  { feature: "fan-notes-fill", share: 0.06, perCall: 0.092 },
  { feature: "help-me", share: 0.05, perCall: 0.046 },
  { feature: "chat-review", share: 0.04, perCall: 0.139 },
  { feature: "scan", share: 0.015, perCall: 0.038 },
  { feature: "voice-script", share: 0.015, perCall: 0.019 },
];

const LEAD_MIX: ReadonlyArray<{ feature: Feature; share: number; perCall: number }> = [
  { feature: "chat-review", share: 0.45, perCall: 0.139 },
  { feature: "fan-summary", share: 0.3, perCall: 0.081 },
  { feature: "coach-chat", share: 0.25, perCall: 0.104 },
];

/** Dollars a person's AI costs on a usual day, and how often they ask again. */
const PEOPLE_AI: Readonly<Record<number, { daily: number; regen: number; lead?: boolean }>> = {
  1: { daily: 0.18, regen: 0.05, lead: true },
  2: { daily: 0.55, regen: 0.06, lead: true },
  3: { daily: 0.28, regen: 0.04, lead: true },
  4: { daily: 4.6, regen: 0.12 },
  5: { daily: 4.1, regen: 0.18 },
  6: { daily: 4.7, regen: 0.11 },
  7: { daily: 1.6, regen: 0.14 },
  8: { daily: 0.9, regen: 0.42 },
};

export const MODEL_OPUS = "claude-opus-5-5";
export const MODEL_SONNET = "claude-sonnet-5";

/** Days ago (Moscow) the owner turned every feature's effort down: the dearer days lie before. */
const EFFORT_SWITCH_DAYS_AGO = 6;
const CONTEXT_CHANGE_DAYS_AGO = 2;

const WINDOW_OF: Readonly<Record<LedgerFeature, string>> = {
  "fast-reply": "1–25",
  "improve-draft": "1–25",
  "hi-greeting": "1–25",
  "voice-script": "1–25",
  "help-me": "26–50",
  "coach-chat": "26–50",
  scan: "26–50",
  ping: "51–100",
  "fan-facts": "51–100",
  "fan-summary": "101–200",
  "fan-notes-fill": "101–200",
  "chat-review": "200+",
  "media-describe": "—",
};

/** Share of a call's price by token type. */
const PARTS_OF: Partial<Record<LedgerFeature, readonly [number, number, number, number, number]>> = {
  "fast-reply": [0.12, 0.3, 0.18, 0.38, 0.02],
  "coach-chat": [0.08, 0.35, 0.22, 0.33, 0.02],
  ping: [0.15, 0.28, 0.25, 0.3, 0.02],
  "chat-review": [0.1, 0.38, 0.24, 0.27, 0.01],
  "media-describe": [0.58, 0, 0, 0.42, 0],
  "fan-facts": [0.1, 0.42, 0.2, 0.28, 0],
};
const DEFAULT_PARTS = [0.14, 0.3, 0.2, 0.34, 0.02] as const;

/** Micro-USD per token at the model's list rate. */
const PRICE = {
  [MODEL_OPUS]: { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  [MODEL_SONNET]: { input: 3, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
} as const;

export interface AiCell {
  day: string;
  userId: number | null;
  feature: LedgerFeature;
  page: string | null;
  account: number | null;
  model: string;
  effort: string;
  window: string;
  calls: number;
  cost: number;
  completedCalls: number;
  failedCalls: number;
  cancelledCalls: number;
  failedCost: number;
  regenCalls: number;
  regenCost: number;
  approxCost: number;
  parts: { input: number; cacheRead: number; cacheWrite: number; output: number; other: number };
  tokens: { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number };
}

/** Which Anthropic account paid on a Moscow day `ago` days before today; null: before accounts were tracked. */
export function accountOfDay(ago: number): number | null {
  if (ago >= 29) return null;
  if (ago >= 25) return 3;
  if (ago >= 10 && ago <= 12) return 2;
  return 1;
}

function makeCell(
  base: Omit<AiCell, "calls" | "cost" | "completedCalls" | "failedCalls" | "cancelledCalls" | "failedCost" | "regenCalls" | "regenCost" | "approxCost" | "parts" | "tokens">,
  dollars: number,
  perCall: number,
  regenRate: number,
  random: () => number,
): AiCell | null {
  const calls = Math.round(dollars / perCall);
  if (calls <= 0) return null;
  const cost = microUsd(calls * perCall * between(random, 0.9, 1.1));
  const failedCalls = random() < calls * 0.015 ? Math.max(1, Math.round(calls * 0.012)) : 0;
  const cancelledCalls = random() < calls * 0.01 ? 1 : 0;
  const regenCalls = Math.round(calls * regenRate * between(random, 0.8, 1.2));
  const share = PARTS_OF[base.feature] ?? DEFAULT_PARTS;
  const parts = {
    input: Math.round(cost * share[0]),
    cacheRead: Math.round(cost * share[1]),
    cacheWrite: Math.round(cost * share[2]),
    output: Math.round(cost * share[3]),
    other: 0,
  };
  parts.other = cost - parts.input - parts.cacheRead - parts.cacheWrite - parts.output;
  const price = base.model === MODEL_SONNET ? PRICE[MODEL_SONNET] : PRICE[MODEL_OPUS];
  return {
    ...base,
    calls,
    cost,
    completedCalls: calls - failedCalls - cancelledCalls,
    failedCalls,
    cancelledCalls,
    failedCost: Math.round((failedCalls * 0.45 + cancelledCalls * 0.3) * (cost / calls)),
    regenCalls,
    regenCost: Math.round(regenCalls * (cost / calls)),
    approxCost: Math.round(cancelledCalls * 0.3 * (cost / calls)),
    parts,
    tokens: {
      input: Math.round(parts.input / price.input),
      cacheRead: Math.round(parts.cacheRead / price.cacheRead),
      cacheWrite5m: Math.round((parts.cacheWrite * 0.3) / price.cacheWrite5m),
      cacheWrite1h: Math.round((parts.cacheWrite * 0.7) / price.cacheWrite1h),
      output: Math.round(parts.output / price.output),
    },
  };
}

function scaleCell(cell: AiCell, fraction: number): AiCell | null {
  if (fraction >= 1) return cell;
  const calls = Math.round(cell.calls * fraction);
  if (calls <= 0) return null;
  const k = calls / cell.calls;
  const scale = (value: number) => Math.round(value * k);
  const parts = {
    input: scale(cell.parts.input),
    cacheRead: scale(cell.parts.cacheRead),
    cacheWrite: scale(cell.parts.cacheWrite),
    output: scale(cell.parts.output),
    other: scale(cell.parts.other),
  };
  const failedCalls = Math.min(calls, Math.round(cell.failedCalls * k));
  const cancelledCalls = Math.min(calls - failedCalls, Math.round(cell.cancelledCalls * k));
  return {
    ...cell,
    calls,
    cost: parts.input + parts.cacheRead + parts.cacheWrite + parts.output + parts.other,
    completedCalls: calls - failedCalls - cancelledCalls,
    failedCalls,
    cancelledCalls,
    failedCost: scale(cell.failedCost),
    regenCalls: Math.round(cell.regenCalls * k),
    regenCost: scale(cell.regenCost),
    approxCost: scale(cell.approxCost),
    parts,
    tokens: {
      input: scale(cell.tokens.input),
      cacheRead: scale(cell.tokens.cacheRead),
      cacheWrite5m: scale(cell.tokens.cacheWrite5m),
      cacheWrite1h: scale(cell.tokens.cacheWrite1h),
      output: scale(cell.tokens.output),
    },
  };
}

const fullDayCache = new Map<string, AiCell[]>();

/** Every AI cell of a whole Moscow day (`ago` days before today). */
function fullDayCells(day: string, ago: number): AiCell[] {
  const key = `${day}:${ago}`;
  const cached = fullDayCache.get(key);
  if (cached) return cached;
  const cells: AiCell[] = [];
  const account = accountOfDay(ago);
  const before = ago > EFFORT_SWITCH_DAYS_AGO;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 1.12 : 1;

  for (const user of DEMO_USERS) {
    const profile = PEOPLE_AI[user.id];
    if (!profile || !user.active) continue;
    const random = rng(`ai:${day}:${user.id}`);
    // A chatter has a day off about once a week; the owner looks in now and then.
    const off = profile.lead ? random() < (user.role === "owner" ? 0.55 : 0.25) : hashString(`off:${day}:${user.id}`) % 7 === 0;
    if (off) continue;
    const dollars = profile.daily * weekend * between(random, 0.7, 1.3) * (before ? 1.45 : 1);
    const pages = user.pages.length > 3 ? ["mia-1", "nova-1", "mia-2"] : user.pages;
    const weights = pages.map((label) => Math.max(5, demoPage(label)?.dailyNet ?? 5));
    const weightSum = weights.reduce((sum, value) => sum + value, 0);
    for (const mix of profile.lead ? LEAD_MIX : FEATURE_MIX) {
      pages.forEach((label, index) => {
        const share = (weights[index] ?? 0) / weightSum;
        const cell = makeCell(
          {
            day,
            userId: user.id,
            feature: mix.feature,
            page: label,
            account,
            model: MODEL_OPUS,
            effort: before ? "high" : "low",
            window: mix.feature === "coach-chat" && ago > CONTEXT_CHANGE_DAYS_AGO ? "51–100" : WINDOW_OF[mix.feature],
          },
          dollars * mix.share * share,
          mix.perCall * (before ? 1.45 : 1),
          profile.regen,
          random,
        );
        if (cell) cells.push(cell);
      });
    }
  }

  // Hub's own lanes: Chat Memory facts and the picture describer, on the Fansly pages.
  const random = rng(`ai-bg:${day}`);
  const fansly = DEMO_PAGES.filter((page) => page.platform === "fansly");
  const netSum = fansly.reduce((sum, page) => sum + Math.max(4, page.dailyNet), 0);
  for (const page of fansly) {
    const share = Math.max(4, page.dailyNet) / netSum;
    const facts = makeCell(
      { day, userId: null, feature: "fan-facts", page: page.label, account, model: MODEL_OPUS, effort: "low", window: WINDOW_OF["fan-facts"] },
      2.8 * share * between(random, 0.75, 1.25),
      0.021,
      0,
      random,
    );
    if (facts) cells.push(facts);
    const pictures = makeCell(
      { day, userId: null, feature: "media-describe", page: page.label, account, model: MODEL_SONNET, effort: "off", window: "—" },
      0.85 * share * between(random, 0.6, 1.4),
      0.0042,
      0,
      random,
    );
    if (pictures) cells.push(pictures);
  }
  fullDayCache.set(key, cells);
  return cells;
}

/** The AI cells of a Moscow day as `now` sees them: today only so far, a future day none. */
export function aiDayCells(day: string, now: Date): AiCell[] {
  const today = moscowDay(now);
  if (day > today) return [];
  const ago = daysBetween(day, today);
  const fraction = dayFraction(day, now);
  const cells = fullDayCells(day, ago);
  if (fraction >= 1) return cells;
  return cells.flatMap((cell) => {
    const scaled = scaleCell(cell, fraction);
    return scaled ? [scaled] : [];
  });
}

export function aiRangeCells(from: string, to: string, now: Date): AiCell[] {
  return dayList(from, to).flatMap((day) => aiDayCells(day, now));
}

function sumCost(cells: readonly AiCell[]): number {
  return cells.reduce((sum, cell) => sum + cell.cost, 0);
}

/** AI spend of the hours [from, to): whole days summed, the edge days prorated. */
export function aiSpendBetween(from: Date, to: Date, now: Date, filter: (cell: AiCell) => boolean = () => true) {
  let cost = 0;
  let calls = 0;
  for (let day = moscowDay(from); day <= moscowDay(to); day = shiftDay(day, 1)) {
    const start = moscowDayStart(day).getTime();
    const lived = Math.min(now.getTime(), start + DAY_MS) - start;
    if (lived <= 0) continue;
    const overlap = Math.min(to.getTime(), start + DAY_MS, now.getTime()) - Math.max(from.getTime(), start);
    if (overlap <= 0) continue;
    const share = Math.min(1, overlap / lived);
    const cells = aiDayCells(day, now).filter(filter);
    cost += sumCost(cells) * share;
    calls += cells.reduce((sum, cell) => sum + cell.calls, 0) * share;
  }
  return { cost: Math.round(cost), calls: Math.round(calls) };
}

// --- «Траты на ИИ» (adminAiSpend) ---------------------------------------------

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

function addCell(row: AiSpendRow, cell: AiCell, share = 1): void {
  const take = (value: number) => (share === 1 ? value : Math.round(value * share));
  row.calls += take(cell.calls);
  row.costMicroUsd += take(cell.cost);
  row.approximateMicroUsd += take(cell.approxCost);
  row.regenerationCalls += take(cell.regenCalls);
  row.regenerationMicroUsd += take(cell.regenCost);
  row.failedCalls += take(cell.failedCalls + cell.cancelledCalls);
  row.failedMicroUsd += take(cell.failedCost);
  row.tokens.input += take(cell.tokens.input);
  row.tokens.cacheRead += take(cell.tokens.cacheRead);
  row.tokens.cacheWrite5m += take(cell.tokens.cacheWrite5m);
  row.tokens.cacheWrite1h += take(cell.tokens.cacheWrite1h);
  row.tokens.output += take(cell.tokens.output);
  row.parts.inputMicroUsd += take(cell.parts.input);
  row.parts.cacheReadMicroUsd += take(cell.parts.cacheRead);
  row.parts.cacheWriteMicroUsd += take(cell.parts.cacheWrite);
  row.parts.outputMicroUsd += take(cell.parts.output);
  row.parts.otherMicroUsd += take(cell.parts.other);
}

function cut(
  cells: readonly AiCell[],
  keyOf: (cell: AiCell) => string,
  labelOf: (cell: AiCell) => string,
  order: "cost" | "key" = "cost",
): AiSpendRow[] {
  const rows = new Map<string, AiSpendRow>();
  for (const cell of cells) {
    const key = keyOf(cell);
    const row = rows.get(key) ?? emptyRow(key, labelOf(cell));
    addCell(row, cell);
    rows.set(key, row);
  }
  const list = [...rows.values()];
  return order === "key"
    ? list.sort((left, right) => left.key.localeCompare(right.key))
    : list.sort((left, right) => right.costMicroUsd - left.costMicroUsd);
}

/** The outcome cut: one cell is several outcomes at once. */
function outcomeRows(cells: readonly AiCell[]): AiSpendRow[] {
  const rows = new Map<string, AiSpendRow>();
  const add = (key: string, cell: AiCell, calls: number) => {
    if (calls <= 0) return;
    const row = rows.get(key) ?? emptyRow(key, key);
    addCell(row, cell, calls / cell.calls);
    rows.set(key, row);
  };
  for (const cell of cells) {
    add("completed", cell, cell.completedCalls);
    add("failed", cell, cell.failedCalls);
    add("cancelled", cell, cell.cancelledCalls);
  }
  return [...rows.values()].sort((left, right) => right.costMicroUsd - left.costMicroUsd);
}

/** When a chatter's AI is asked for, Moscow time: nights (the US evening) and evenings. */
const HOUR_WEIGHTS = [
  7, 7, 8, 9, 9, 8, 7, 5, 3, 2, 1.5, 1.5, 2, 2.5, 3, 3.5, 4, 5, 5.5, 6, 6.5, 7, 7, 7,
];

function hourRows(cells: readonly AiCell[], now: Date): AiSpendRow[] {
  const today = moscowDay(now);
  const currentHour = new Date(now.getTime() + MSK_OFFSET_MS).getUTCHours();
  const rows = Array.from({ length: 24 }, (_, hour) => emptyRow(String(hour).padStart(2, "0"), String(hour).padStart(2, "0")));
  for (const cell of cells) {
    const lastHour = cell.day === today ? currentHour : 23;
    const weights = HOUR_WEIGHTS.map((weight, hour) => (hour > lastHour ? 0 : cell.userId === null ? 4 : weight));
    const total = weights.reduce((sum, value) => sum + value, 0);
    weights.forEach((weight, hour) => {
      if (weight > 0) addCell(rows[hour]!, cell, weight / total);
    });
  }
  return rows.filter((row) => row.calls > 0);
}

const USER_NAME = new Map(DEMO_USERS.map((user) => [user.id, user.username]));

function conversationId(label: string, index: number): string {
  const fans = demoFans(label);
  const fan = fans[index % Math.max(1, fans.length)];
  return fan ? (demoPage(label)?.platform === "fansly" ? String(BigInt(fan.platformUserId) + 1n) : fan.platformUserId) : String(700000 + index);
}

const TRACKED: ReadonlySet<string> = new Set(["fast-reply", "improve-draft", "help-me", "hi-greeting", "coach-chat", "ping", "voice-script"]);

type Spend = KernelOperationResponse<"adminAiSpend">;

function dayCost(day: string, now: Date, features: readonly string[] | null): number {
  return sumCost(aiDayCells(day, now).filter((cell) => features === null || features.includes(cell.feature)));
}

function settingChanges(now: Date, from: string, to: string): Spend["settingChanges"] {
  const today = moscowDay(now);
  const changes = [
    {
      at: new Date(moscowDayStart(shiftDay(today, -EFFORT_SWITCH_DAYS_AGO)).getTime() + 13.5 * HOUR_MS),
      key: "aiReasoningEffort",
      username: "owner",
      oldValue: "high",
      newValue: "low",
      features: null,
    },
    {
      at: new Date(moscowDayStart(shiftDay(today, -CONTEXT_CHANGE_DAYS_AGO)).getTime() + 11.25 * HOUR_MS),
      key: "aiFeatureWindows",
      username: "owner",
      oldValue: { "coach-chat": 80 },
      newValue: { "coach-chat": 50 },
      features: ["coach-chat"],
    },
  ];
  return changes
    .filter((change) => {
      const day = moscowDay(change.at);
      return day >= from && day <= to;
    })
    .map((change) => {
      const changeDay = moscowDay(change.at);
      const beforeMicro = [1, 2, 3].reduce((sum, back) => sum + dayCost(shiftDay(changeDay, -back), now, change.features), 0);
      const afterHours = Math.min(72, (now.getTime() - change.at.getTime()) / HOUR_MS);
      const afterMicro = aiSpendBetween(change.at, new Date(change.at.getTime() + afterHours * HOUR_MS), now, (cell) => change.features === null || change.features.includes(cell.feature)).cost;
      return {
        at: iso(change.at),
        key: change.key,
        username: change.username,
        oldValue: change.oldValue,
        newValue: change.newValue,
        features: change.features,
        before: { hours: 72, microUsd: beforeMicro, perDayMicroUsd: Math.round(beforeMicro / 3) },
        after: {
          hours: Math.round(afterHours),
          microUsd: afterMicro,
          perDayMicroUsd: afterHours >= 1 ? Math.round((afterMicro / afterHours) * 24) : null,
        },
      };
    });
}

function topCalls(cells: readonly AiCell[], now: Date): Spend["topCalls"] {
  // The dearest calls of each long-context feature, so the list shows what is dear and why.
  const candidates = cells.filter((cell) => cell.userId !== null && ["chat-review", "fan-notes-fill", "coach-chat", "fan-summary"].includes(cell.feature));
  const dear = ["chat-review", "fan-notes-fill", "coach-chat", "fan-summary"].flatMap((feature, rank) =>
    candidates
      .filter((cell) => cell.feature === feature)
      .sort((left, right) => right.cost / right.calls - left.cost / left.calls)
      .slice(0, [4, 3, 2, 1][rank]));
  return dear
    .map((cell, index) => {
      const random = rng(`top-call:${cell.day}:${cell.userId}:${cell.feature}:${cell.page}`);
      const multiplier = between(random, 2.8, 5.5);
      const cost = Math.round((cell.cost / cell.calls) * multiplier);
      const price = PRICE[MODEL_OPUS];
      const start = moscowDayStart(cell.day).getTime();
      const end = Math.min(now.getTime(), start + DAY_MS) - 60_000;
      const completedAt = new Date(start + (end - start) * between(random, 0.1, 0.98));
      const window = cell.feature === "chat-review" ? intBetween(random, 210, 400) : cell.feature === "coach-chat" ? intBetween(random, 30, 50) : intBetween(random, 101, 200);
      return {
        id: 1_842_000 + (hashString(`${cell.day}:${index}:${cell.feature}`) % 90_000),
        completedAt: iso(completedAt),
        feature: cell.feature,
        model: cell.model,
        reasoningEffort: cell.effort,
        contextMessages: window,
        username: cell.userId === null ? null : USER_NAME.get(cell.userId) ?? null,
        pageLabel: cell.page,
        accountLabel: cell.account === null ? null : ACCOUNT_LABELS[cell.account] ?? null,
        conversationId: cell.page ? conversationId(cell.page, intBetween(random, 0, 12)) : null,
        inputTokens: Math.round((cost * 0.1) / price.input),
        cacheReadTokens: Math.round((cost * 0.36) / price.cacheRead),
        cacheWriteTokens: Math.round((cost * 0.22) / price.cacheWrite1h),
        outputTokens: Math.round((cost * 0.32) / price.output),
        costMicroUsd: cost,
        costApproximate: index === 6,
        outcome: index === 6 ? "cancelled" : "completed",
        isRegeneration: index === 3,
      };
    })
    .sort((left, right) => right.costMicroUsd - left.costMicroUsd);
}

function conversations(cells: readonly AiCell[]): Spend["conversations"] {
  const human = cells.filter((cell) => cell.userId !== null);
  const calls = human.reduce((sum, cell) => sum + cell.calls, 0);
  const cost = sumCost(human);
  const count = Math.max(1, Math.round(calls * 0.31));
  const byPage = new Map<string, { cost: number; features: Set<string> }>();
  for (const cell of human) {
    if (!cell.page) continue;
    const entry = byPage.get(cell.page) ?? { cost: 0, features: new Set<string>() };
    entry.cost += cell.cost;
    entry.features.add(cell.feature);
    byPage.set(cell.page, entry);
  }
  const top: Spend["conversations"]["top"] = [];
  const pages = [...byPage.entries()].sort((left, right) => right[1].cost - left[1].cost);
  pages.slice(0, 4).forEach(([label, entry], pageIndex) => {
    const random = rng(`top-chat:${label}:${cells.length}`);
    const perPage = pageIndex === 0 ? 4 : pageIndex === 1 ? 3 : 2;
    const features = [...entry.features];
    for (let index = 0; index < perPage; index += 1) {
      const periodDays = new Set(human.map((cell) => cell.day)).size;
      const chatCost = Math.min(
        Math.round(entry.cost * 0.08),
        Math.round(microUsd(between(random, 0.45, 1.6) * Math.sqrt(Math.max(1, periodDays))) / (1 + index * 0.4 + pageIndex * 0.25)),
      );
      top.push({
        pageLabel: label,
        conversationId: conversationId(label, index * 3 + pageIndex),
        calls: Math.max(3, Math.round(chatCost / between(random, 36_000, 68_000))),
        costMicroUsd: chatCost,
        features: features.filter((_, featureIndex) => (featureIndex + index) % 3 !== 2).slice(0, 4),
      });
    }
  });
  top.sort((left, right) => right.costMicroUsd - left.costMicroUsd);
  return { count, costMicroUsd: cost, perConversationMicroUsd: Math.round(cost / count), top: top.slice(0, 10) };
}

function shifts(from: string, to: string, now: Date): Spend["shifts"] {
  const today = moscowDay(now);
  const last = to < today ? to : today;
  const first = [shiftDay(last, -6), from].sort().reverse()[0]!;
  const windowFrom = moscowDayStart(first);
  const windowTo = new Date(Math.min(moscowDayStart(shiftDay(last, 1)).getTime(), now.getTime()));
  const cells = aiRangeCells(first, last, now).filter((cell) => cell.userId !== null);
  const byChatter: Spend["shifts"]["byChatter"] = [];
  let inShifts = 0;
  let shiftCount = 0;
  let minutes = 0;
  for (const user of DEMO_USERS) {
    if (user.role !== "chatter") continue;
    const mine = cells.filter((cell) => cell.userId === user.id);
    if (mine.length === 0) continue;
    const days = new Set(mine.map((cell) => cell.day)).size;
    const random = rng(`shifts:${user.id}:${first}:${last}`);
    const worked = Math.round(days * between(random, 5.6, 7.4) * 60);
    const spent = Math.round(sumCost(mine) * between(random, 0.9, 0.97));
    byChatter.push({
      userId: user.id,
      username: user.username,
      shifts: days,
      workedMinutes: worked,
      inShiftsMicroUsd: spent,
      perShiftMicroUsd: Math.round(spent / days),
      perWorkedHourMicroUsd: Math.round(spent / (worked / 60)),
    });
    inShifts += spent;
    shiftCount += days;
    minutes += worked;
  }
  const outside = Math.max(0, sumCost(cells) - inShifts);
  return {
    from: iso(windowFrom),
    to: iso(windowTo),
    shifts: shiftCount,
    workedMinutes: minutes,
    inShiftsMicroUsd: inShifts,
    outsideShiftsMicroUsd: outside,
    perShiftMicroUsd: shiftCount > 0 ? Math.round(inShifts / shiftCount) : null,
    perWorkedHourMicroUsd: minutes > 0 ? Math.round(inShifts / (minutes / 60)) : null,
    byChatter: byChatter.sort((left, right) => right.inShiftsMicroUsd - left.inShiftsMicroUsd),
  };
}

export const ACCOUNT_LABELS: Readonly<Record<number, string>> = { 1: "main", 2: "reserve", 3: "legacy" };

export function adminAiSpend(request: DemoRequest): Spend {
  const today = moscowDay(request.now);
  const from = queryString(request, "from") ?? shiftDay(today, -6);
  const to = queryString(request, "to") ?? today;
  const cells = aiRangeCells(from, to, request.now);
  const total = emptyRow("total", "Всего");
  for (const cell of cells) addCell(total, cell);
  const human = cells.filter((cell) => cell.userId !== null);
  const features: Spend["features"] = cut(human, (cell) => cell.feature, (cell) => cell.feature).map((row) => {
    const tracksUse = TRACKED.has(row.key);
    const random = rng(`use:${row.key}:${from}:${to}`);
    const usedCalls = tracksUse ? Math.round(row.calls * between(random, 0.62, 0.8)) : 0;
    const sentCalls = tracksUse ? Math.round(usedCalls * between(random, 0.78, 0.92)) : 0;
    const sentMessages = tracksUse ? Math.round(sentCalls * (row.key === "hi-greeting" ? 1 : between(random, 1.05, 1.3))) : 0;
    const unusedCalls = tracksUse ? row.calls - usedCalls : 0;
    return {
      feature: row.key,
      calls: row.calls,
      costMicroUsd: row.costMicroUsd,
      perCallMicroUsd: row.calls > 0 ? Math.round(row.costMicroUsd / row.calls) : null,
      tracksUse,
      usedCalls,
      sentCalls,
      sentMessages,
      perSentMessageMicroUsd: tracksUse && sentMessages > 0 ? Math.round(row.costMicroUsd / sentMessages) : null,
      unusedCalls,
      unusedMicroUsd: row.calls > 0 ? Math.round((row.costMicroUsd * unusedCalls) / row.calls) : 0,
    };
  });
  return {
    generatedAt: iso(request.now),
    from,
    to,
    timeZone: "Europe/Moscow",
    total,
    breakdowns: {
      feature: cut(cells, (cell) => cell.feature, (cell) => cell.feature),
      model: cut(cells, (cell) => cell.model, (cell) => cell.model),
      effort: cut(cells, (cell) => cell.effort, (cell) => cell.effort),
      window: cut(cells, (cell) => cell.window, (cell) => cell.window),
      chatter: cut(cells, (cell) => (cell.userId === null ? "background" : String(cell.userId)), (cell) => (cell.userId === null ? "background" : USER_NAME.get(cell.userId) ?? "—")),
      page: cut(cells, (cell) => String(demoPage(cell.page ?? "")?.id ?? "—"), (cell) => cell.page ?? "—"),
      account: cut(cells, (cell) => (cell.account === null ? "—" : String(cell.account)), (cell) => (cell.account === null ? "—" : ACCOUNT_LABELS[cell.account] ?? "—")),
      branch: cut(cells, (cell) => (cell.userId === null ? "background" : "human"), (cell) => (cell.userId === null ? "background" : "human")),
      outcome: outcomeRows(cells),
      day: cut(cells, (cell) => cell.day, (cell) => cell.day, "key"),
      hour: hourRows(cells, request.now),
      dayFeature: cut(cells, (cell) => `${cell.day}|${cell.feature}`, (cell) => cell.feature, "key"),
    },
    features,
    conversations: conversations(cells),
    topCalls: topCalls(cells, request.now),
    shifts: shifts(from, to, request.now),
    settingChanges: settingChanges(request.now, from, to),
  };
}

// --- Personal daily limits (adminAiChatterLimits) ---------------------------------

/** Dollars a day; null: no personal limit. */
const DAILY_LIMITS: Readonly<Record<number, number | null>> = {
  1: null,
  2: null,
  3: null,
  4: 6,
  5: 5,
  6: 5.5,
  7: 3,
  8: 2,
};

function personDayCost(userId: number, day: string, now: Date): number {
  return sumCost(aiDayCells(day, now).filter((cell) => cell.userId === userId));
}

export function adminAiChatterLimits(request: DemoRequest): KernelOperationResponse<"adminAiChatterLimits"> {
  const today = moscowDay(request.now);
  const day = queryString(request, "day") ?? today;
  const before = shiftDay(day, -1);
  const living = DEMO_USERS.filter((user) => user.active);
  let pool = 0;
  const rows = living.map((user) => {
    const limitDollars = DAILY_LIMITS[user.id] ?? null;
    const limit = limitDollars === null ? null : microUsd(limitDollars);
    let spent = personDayCost(user.id, day, request.now);
    const dayBefore = personDayCost(user.id, before, request.now);
    // Денис works past his limit today: the pool carries him.
    if (user.id === 6 && limit !== null && day === today) spent = Math.max(spent, Math.round(limit * 1.12));
    const intoPool = limit === null ? null : Math.max(0, limit - dayBefore);
    if (intoPool !== null) pool += intoPool;
    return { user, limit, spent, dayBefore, intoPool };
  });
  let used = 0;
  const chatters = rows.map(({ user, limit, spent, dayBefore, intoPool }) => {
    const fromPool = limit === null ? null : Math.max(0, spent - limit);
    if (fromPool !== null) used += fromPool;
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      dailyLimitMicroUsd: limit,
      dayLimitMicroUsd: limit,
      spentMicroUsd: spent,
      dayBeforeMicroUsd: dayBefore,
      intoPoolMicroUsd: intoPool,
      fromPoolMicroUsd: fromPool,
      blocked: false,
    };
  });
  const usedClamped = Math.min(used, pool);
  // Yesterday olya.m went past her limit, took the rest of the reserve and her AI stopped
  // («ИИ выключался», «Запас кончился»; settings §9.4).
  if (day === shiftDay(today, -1)) {
    const olya = chatters.find((row) => row.userId === 7);
    if (olya && olya.dayLimitMicroUsd !== null) {
      const others = used - (olya.fromPoolMicroUsd ?? 0);
      olya.fromPoolMicroUsd = Math.max(0, pool - others);
      olya.spentMicroUsd = olya.dayLimitMicroUsd + olya.fromPoolMicroUsd;
      olya.blocked = true;
    }
    return {
      generatedAt: iso(request.now),
      day,
      resetsAt: iso(moscowDayStart(shiftDay(day, 1))),
      pool: { microUsd: pool, usedMicroUsd: pool, remainingMicroUsd: 0 },
      chatters: chatters.sort((left, right) => right.spentMicroUsd - left.spentMicroUsd),
    };
  }
  return {
    generatedAt: iso(request.now),
    day,
    resetsAt: iso(moscowDayStart(shiftDay(day, 1))),
    pool: { microUsd: pool, usedMicroUsd: usedClamped, remainingMicroUsd: pool - usedClamped },
    chatters: chatters.sort((left, right) => right.spentMicroUsd - left.spentMicroUsd),
  };
}

// --- «Расходы на AI» по сотрудникам (adminChatterUsage) ---------------------------

const USAGE_FEATURES: ReadonlySet<string> = new Set(FEATURE_MIX.map((mix) => mix.feature));

export function adminChatterUsage(request: DemoRequest): KernelOperationResponse<"adminChatterUsage"> {
  const today = moscowDay(request.now);
  const from = queryString(request, "from") ?? today;
  const to = queryString(request, "to") ?? today;
  const cells = aiRangeCells(from, to, request.now);
  const rows = DEMO_USERS.map((user) => {
    const mine = cells.filter((cell) => cell.userId === user.id && USAGE_FEATURES.has(cell.feature));
    const calls = mine.reduce((sum, cell) => sum + cell.calls, 0);
    const byFeature = cut(mine, (cell) => cell.feature, (cell) => cell.feature);
    const tokens = (list: readonly AiCell[]) => {
      const input = list.reduce((sum, cell) => sum + cell.tokens.input, 0);
      const output = list.reduce((sum, cell) => sum + cell.tokens.output, 0);
      const cacheWrite = list.reduce((sum, cell) => sum + cell.tokens.cacheWrite5m + cell.tokens.cacheWrite1h, 0);
      const cacheRead = list.reduce((sum, cell) => sum + cell.tokens.cacheRead, 0);
      return { input, output, cacheWrite, cacheRead, cacheTotal: cacheWrite + cacheRead };
    };
    const regen = mine.reduce((sum, cell) => sum + cell.regenCalls, 0);
    const failed = mine.reduce((sum, cell) => sum + cell.failedCalls, 0);
    const cancelled = mine.reduce((sum, cell) => sum + cell.cancelledCalls, 0);
    const cost = sumCost(mine);
    const regenerateRatePct = calls > 0 ? Math.round((regen / calls) * 1000) / 10 : 0;
    const quotaDenied = user.id === 6 && to >= today ? 3 : 0;
    const featureBreakdown = byFeature.map((row) => {
      const featureCells = mine.filter((cell) => cell.feature === row.key);
      return {
        feature: row.key as Feature,
        requestCount: row.calls,
        sharePct: calls > 0 ? Math.round((row.calls / calls) * 1000) / 10 : 0,
        tokenCounts: tokens(featureCells),
        costMicroUsd: row.costMicroUsd,
        costApproximate: row.approximateMicroUsd > 0,
        regenerateRatePct: row.calls > 0 ? Math.round((row.regenerationCalls / row.calls) * 1000) / 10 : 0,
      };
    }).sort((left, right) => right.requestCount - left.requestCount);
    const top = featureBreakdown[0];
    return {
      userId: user.id,
      username: user.username,
      totalGenerations: calls,
      tokenCounts: tokens(mine),
      cost: { microUsd: cost, approximate: mine.some((cell) => cell.approxCost > 0) },
      gateway: {
        requestCount: calls + quotaDenied,
        completedCount: calls - failed - cancelled,
        failedCount: failed,
        cancelledCount: cancelled,
        quotaDeniedCount: quotaDenied,
        openReservationCount: user.id === 4 && to >= today && calls > 0 ? 1 : 0,
        providerBreakdown: calls > 0 ? [{ provider: "anthropic" as const, requestCount: calls, costMicroUsd: cost }] : [],
      },
      topFeature: top ? { feature: top.feature, requestCount: top.requestCount, sharePct: top.sharePct } : null,
      featureBreakdown,
      regenerateRatePct,
      warning: regenerateRatePct > 30,
    };
  }).sort((left, right) => right.cost.microUsd - left.cost.microUsd);
  const lanes = ["fan-facts", "media-describe"].map((feature) => {
    const lane = cells.filter((cell) => cell.feature === feature);
    return {
      feature,
      requestCount: lane.reduce((sum, cell) => sum + cell.calls, 0),
      costMicroUsd: sumCost(lane),
      costApproximate: false,
    };
  }).filter((lane) => lane.requestCount > 0);
  return { range: { from, to, timeZone: "Europe/Moscow" }, rows, systemLanes: lanes };
}
