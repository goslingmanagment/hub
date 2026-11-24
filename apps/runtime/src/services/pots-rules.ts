import { millsFromInteger, millsToNumber, sumMills } from "@agency_hub_core/shared";

import { POT_OBSHAK, type RuleSlot } from "./sale-rule.ts";
import { slotOccurrencesOf } from "./schedule-slots.ts";

/**
 * Workboard pots (H11) — pure rules:
 *  - distribution formulas (`equal`, `weights`, `manual`) with exact BigInt mills math and deterministic remainder
 *    distribution by sorted `personCode`;
 *  - participant resolution (`listed` dated periods and `page_workers` via `person_working_pages` union active schedule
 *    slots/swaps on the pot's pages, matching H8's `suggestSoloPagePerson`);
 *  - routing of `sale_homes` (`home === 'pot'`, Moscow day >= `pots_from`) to pots or unrouted («Без общака»);
 *  - left-pot detection for day reconciliation (`reconcilePotsOfDay`).
 * Zero database calls.
 */

const DAY_MS = 86_400_000;
const WEIGHT_SCALE = 1_000_000n;

export type PurePotFormulaKind = "equal" | "weights" | "manual";

export interface PurePotFormula {
  kind: PurePotFormulaKind;
  params: Record<string, unknown>;
}

export interface PurePotDistributionLine {
  personCode: string;
  baseMills: number;
  basis: string;
}

export type FormulaComputeResult =
  | { ok: true; lines: PurePotDistributionLine[]; normalizedFormula: PurePotFormula }
  | { ok: false; reason: string; message: string };

const compareCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function uniqueSortedCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => code.trim()).filter((code) => code !== ""))].sort(compareCode);
}

function formatWeight(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/**
 * Computes exact mills shares for a pot distribution.
 * Invariants guaranteed whenever `ok: true`:
 *  - `lines.length > 0`
 *  - every `personCode` is unique and non-empty
 *  - every `baseMills` is a non-negative safe integer
 *  - `Σ lines.baseMills === baseMills`
 *  - indivisible remainder mills go deterministically to the earliest sorted `personCode`s.
 */
export function computePotDistributionLines(input: {
  baseMills: number;
  formula: PurePotFormula;
  participants: readonly string[];
}): FormulaComputeResult {
  if (!Number.isSafeInteger(input.baseMills) || input.baseMills <= 0) {
    return { ok: false, reason: "invalid_base", message: "База раздачи должна быть больше нуля" };
  }
  const total = millsFromInteger(input.baseMills);
  const participants = uniqueSortedCodes(input.participants);

  switch (input.formula.kind) {
    case "equal": {
      if (participants.length === 0) {
        return { ok: false, reason: "no_participants", message: "Нет участников общака на выбранный день" };
      }
      const count = BigInt(participants.length);
      const each = total / count;
      const remainder = total % count;
      const basis = `поровну на ${participants.length}`;
      const lines: PurePotDistributionLine[] = participants.map((personCode, index) => ({
        personCode,
        baseMills: millsToNumber(each + (BigInt(index) < remainder ? 1n : 0n)),
        basis,
      }));
      return { ok: true, lines, normalizedFormula: { kind: "equal", params: {} } };
    }

    case "weights": {
      const rawWeights = input.formula.params?.weights;
      if (rawWeights === null || rawWeights === undefined || typeof rawWeights !== "object" || Array.isArray(rawWeights)) {
        return { ok: false, reason: "invalid_weights", message: "Укажите положительные веса участников" };
      }
      const weightEntries = Object.entries(rawWeights as Record<string, unknown>);
      const weightMap = new Map<string, number>();
      for (const [rawCode, rawValue] of weightEntries) {
        const code = rawCode.trim();
        if (code === "") continue;
        const weight = typeof rawValue === "number" || (typeof rawValue === "string" && rawValue.trim() !== "") ? Number(rawValue) : NaN;
        if (!Number.isSafeInteger(Math.round(weight * Number(WEIGHT_SCALE))) || weight < 0) {
          return { ok: false, reason: "invalid_weights", message: `Неверный вес для ${code}` };
        }
        if (weight > 0) weightMap.set(code, weight);
      }

      const chosen = participants.filter((code) => weightMap.has(code));

      if (chosen.length === 0) {
        return { ok: false, reason: "no_participants", message: "Нет активных участников с положительным весом" };
      }

      const scaledWeights = chosen.map((code) => {
        const w = weightMap.get(code)!;
        const scaled = BigInt(Math.round(w * Number(WEIGHT_SCALE)));
        return { code, weight: w, scaled: scaled > 0n ? scaled : 1n };
      });
      const totalScaled = scaledWeights.reduce((acc, item) => acc + item.scaled, 0n);
      const totalDisplay = formatWeight(scaledWeights.reduce((acc, item) => acc + item.weight, 0));

      const floors = scaledWeights.map((item) => ({
        code: item.code,
        weight: item.weight,
        share: (total * item.scaled) / totalScaled,
      }));
      const distributed = floors.reduce((acc, item) => acc + item.share, 0n);
      const remainder = total - distributed;

      // Distribute indivisible remainder mills deterministically in sorted personCode order.
      const lines: PurePotDistributionLine[] = floors.map((item, index) => ({
        personCode: item.code,
        baseMills: millsToNumber(item.share + (BigInt(index) < remainder ? 1n : 0n)),
        basis: `по весам (${formatWeight(item.weight)}/${totalDisplay})`,
      }));

      const normalizedWeights: Record<string, number> = {};
      for (const item of scaledWeights) normalizedWeights[item.code] = item.weight;
      return { ok: true, lines, normalizedFormula: { kind: "weights", params: { weights: normalizedWeights } } };
    }

    case "manual": {
      const rawShares = input.formula.params?.shares;
      if (rawShares === null || rawShares === undefined || typeof rawShares !== "object" || Array.isArray(rawShares)) {
        return { ok: false, reason: "invalid_manual_shares", message: "Укажите доли вручную в базе (mills)" };
      }
      const shareEntries = Object.entries(rawShares as Record<string, unknown>);
      const parsed: Array<{ personCode: string; baseMills: number }> = [];
      const seen = new Set<string>();
      for (const [rawCode, rawValue] of shareEntries) {
        const personCode = rawCode.trim();
        if (personCode === "") continue;
        if (seen.has(personCode)) {
          return { ok: false, reason: "duplicate_participant", message: `Участник ${personCode} указан дважды` };
        }
        seen.add(personCode);
        const amount = typeof rawValue === "number" || (typeof rawValue === "string" && rawValue.trim() !== "") ? Number(rawValue) : NaN;
        if (!Number.isSafeInteger(amount) || amount < 0) {
          return { ok: false, reason: "invalid_manual_shares", message: `Неверная доля базы для ${personCode}` };
        }
        if (amount > 0) parsed.push({ personCode, baseMills: amount });
      }
      if (parsed.length === 0) {
        return { ok: false, reason: "no_participants", message: "Укажите хотя бы одного участника с долей больше нуля" };
      }
      parsed.sort((a, b) => compareCode(a.personCode, b.personCode));
      const sum = sumMills(parsed.map((item) => item.baseMills));
      if (sum !== total) {
        return {
          ok: false,
          reason: "manual_sum_mismatch",
          message: `Сумма ручных долей (${sum} mills) не равна базе раздачи (${input.baseMills} mills)`,
        };
      }
      const normalizedShares: Record<string, number> = {};
      const lines: PurePotDistributionLine[] = parsed.map((item) => {
        normalizedShares[item.personCode] = item.baseMills;
        return { personCode: item.personCode, baseMills: item.baseMills, basis: "вручную" };
      });
      return { ok: true, lines, normalizedFormula: { kind: "manual", params: { shares: normalizedShares } } };
    }
  }
}

// ── Participants resolution ──────────────────────────────────────────────────

export interface PotPersonCandidate {
  personId: number;
  code: string;
  kind: string;
  role: string;
  state: string;
  leftOn: string | null;
}

export interface PotParticipantPeriodSpec {
  personCode: string;
  fromDay: string;
  toDay: string | null;
}

/**
 * Resolves sorted unique `personCode`s active in a pot on Moscow `day`:
 *  - `listed`: dated periods where `fromDay <= day && (toDay === null || day <= toDay)`;
 *  - `page_workers`: active (not left on/before `day`) chat-team humans (`chatter` / `team_lead`) linked to ANY page
 *    of `pageIds` via `person_working_pages` union active schedule slot/swap occurrences on those pages on `day`
 *    (exact same pattern as H8's `suggestSoloPagePerson`). Pure.
 */
export function resolvePotParticipants(input: {
  day: string;
  mode: "page_workers" | "listed";
  pageIds: readonly number[];
  listed: readonly PotParticipantPeriodSpec[];
  people: readonly PotPersonCandidate[];
  workingPages: ReadonlyArray<{ personId: number; pageId: number }>;
  slots: readonly RuleSlot[];
}): string[] {
  if (input.mode === "listed") {
    const active = input.listed
      .filter((entry) => entry.fromDay <= input.day && (entry.toDay === null || input.day <= entry.toDay))
      .map((entry) => entry.personCode);
    return uniqueSortedCodes(active);
  }

  const dayStart = Date.parse(`${input.day}T00:00:00+03:00`);
  if (Number.isNaN(dayStart) || input.pageIds.length === 0) return [];
  const dayEnd = dayStart + DAY_MS;
  const targetPages = new Set(input.pageIds);

  const workingByPerson = new Map<number, number[]>();
  for (const row of input.workingPages) {
    const list = workingByPerson.get(row.personId);
    if (list === undefined) workingByPerson.set(row.personId, [row.pageId]);
    else if (!list.includes(row.pageId)) list.push(row.pageId);
  }

  const codes: string[] = [];
  for (const person of input.people) {
    if (person.kind !== "human" || (person.role !== "chatter" && person.role !== "team_lead")) continue;
    const activeOnDay = person.state === "working" || (person.state === "left" && person.leftOn !== null && person.leftOn > input.day);
    if (!activeOnDay) continue;
    const pages = workingByPerson.get(person.personId) ?? [];
    if (pages.some((pageId) => targetPages.has(pageId))) {
      codes.push(person.code);
      continue;
    }
    const runs = slotOccurrencesOf(input.slots, {
      userIds: new Set([person.personId]),
      from: dayStart,
      to: dayEnd,
      pagesOfAll: pages,
    });
    if (runs.some((run) => run.pageId !== null && targetPages.has(run.pageId))) {
      codes.push(person.code);
    }
  }
  return uniqueSortedCodes(codes);
}

// ── Sale routing ─────────────────────────────────────────────────────────────

export interface PotRoutingSpec {
  id: number;
  code: string;
  pageIds: readonly number[];
  intakeReasons: readonly string[];
  opensOn: string;
  closesOn: string | null;
  state: "open" | "closed";
}

export interface PotRoutingSale {
  pageId: number;
  day: string;
  home: string;
  reason: string;
  pot: string | null;
}

export type PotRouteResult =
  | { status: "not_pot" }
  | { status: "before_cutover" }
  | { status: "routed"; potId: number; potCode: string }
  | {
    status: "unrouted";
    why: "unknown_code" | "closed_or_outside" | "no_matching_page_pot" | "ambiguous_page_pot";
    matchingPotCodes: string[];
  };

export function potCoversPageDay(
  pot: Pick<PotRoutingSpec, "pageIds" | "opensOn" | "closesOn">,
  pageId: number,
  day: string,
): boolean {
  return pot.pageIds.includes(pageId) && pot.opensOn <= day && (pot.closesOn === null || day <= pot.closesOn);
}

/**
 * Pure routing of a `sale_homes` row to a Workboard pot on/after `potsFrom`:
 *  - explicit pot code (`pot !== 'obshak'`) -> matching open pot covering `(pageId, day)`;
 *  - `POT_OBSHAK` (`pot === 'obshak'` or null) -> unique open pot covering `(pageId, day)` and `reason`
 *    (`post_tip`/`campaign`, or any page pot with non-empty `intakeReasons` if reason is `owner_pot`);
 *  - 0 or >1 matches -> `unrouted` («Без общака»).
 */
export function routePotOfSale(
  sale: PotRoutingSale,
  pots: readonly PotRoutingSpec[],
  potsFrom: string | null,
): PotRouteResult {
  if (sale.home !== "pot") return { status: "not_pot" };
  if (potsFrom === null || sale.day < potsFrom) return { status: "before_cutover" };

  const explicit = sale.pot !== null && sale.pot.trim() !== "" && sale.pot !== POT_OBSHAK ? sale.pot.trim() : null;
  if (explicit !== null) {
    const found = pots.find((pot) => pot.code === explicit);
    if (found === undefined) {
      return { status: "unrouted", why: "unknown_code", matchingPotCodes: [] };
    }
    if (found.state !== "open" || !potCoversPageDay(found, sale.pageId, sale.day)) {
      return { status: "unrouted", why: "closed_or_outside", matchingPotCodes: [found.code] };
    }
    return { status: "routed", potId: found.id, potCode: found.code };
  }

  const matches = pots.filter((pot) => {
    if (pot.state !== "open" || !potCoversPageDay(pot, sale.pageId, sale.day)) return false;
    if (sale.reason === "post_tip" || sale.reason === "campaign") {
      return pot.intakeReasons.includes(sale.reason);
    }
    return pot.intakeReasons.length > 0;
  });

  if (matches.length === 1) {
    return { status: "routed", potId: matches[0]!.id, potCode: matches[0]!.code };
  }
  if (matches.length === 0) {
    return { status: "unrouted", why: "no_matching_page_pot", matchingPotCodes: [] };
  }
  return {
    status: "unrouted",
    why: "ambiguous_page_pot",
    matchingPotCodes: matches.map((pot) => pot.code).sort(compareCode),
  };
}

/**
 * Whether a sale that already has an active (non-reversed) distribution part in `part.potId` has left that pot.
 * Importantly, closing a pot (`potState === 'closed'`) does NOT cause its past distributed sales to be treated as
 * having left the pot! Pure.
 */
export function hasSaleLeftPot(
  potCode: string,
  currentHome: PotRoutingSale | undefined,
  potsFrom: string | null,
): boolean {
  if (currentHome === undefined || currentHome.home !== "pot") return true;
  if (potsFrom === null || currentHome.day < potsFrom) return true;
  const explicit = currentHome.pot?.trim();
  return Boolean(explicit && explicit !== POT_OBSHAK && explicit !== potCode);
}
