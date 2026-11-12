import { listSalesOwnerWroteTo, type Database, type ShiftSale } from "@agency_hub_core/db";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import { SALE_LAST_WRITER_HOURS, lastWriterQuery, moscowDayOf } from "./chatter-shifts.ts";
import { computeSaleHomes, registrySlots } from "./sale-homes.ts";
import { SALE_HOME_REASON_TEXT, type SaleHome, type SaleHomeReason } from "./sale-rule.ts";
import type { ScreenHome } from "./sale-rule-screens.ts";
import { reportDateOfSale, reportDateOfShift } from "./shift-rows.ts";
import { teamShiftSalesRead, type TeamShiftSalesRead } from "./team-shift-sales.ts";

/**
 * «Было и стало» of the screens' switch (sale-rule-compare's mode `--before-after`), for the orchestrator to show the
 * owner before setting the date. Read-only. For a range of Moscow days, «Смены» read twice the way the screen reads
 * it — the switch off, and on from `screensFrom` — and the rule on its own:
 *
 *  - per person and day: today's number («было»), the number after the switch («стало», exactly what «Смены» will
 *    show), and the rule's own (its homes computed now, each share on the report date of its shift);
 *  - every sale that moves, with where it was, where it goes and why (the rule's reason in the owner's words);
 *  - the lines outside the shifts before and after (look-ins, the pot, a PPV waiting, the owner's decision, nobody);
 *  - what the screen after the switch counts nowhere though the rule gives it to a person (the switch's first days:
 *    a sale an old shift counts, or one the rule gives to a shift before the switch);
 *  - a stored home older than the rule computed now (the job writes it again within the hour after a deploy);
 *  - the sales whose fan one of the owner's logins wrote to before the sale: there «было» is already the new count
 *    of 2026-11-12 (the owner's logins take none), not today's screens before that, whatever the switch.
 *
 * Real names stay in the output: run it where the output is private.
 */

const DAY_MS = 86_400_000;

export interface Credit {
  userId: number;
  person: string;
  day: string;
  mills: number;
  /** Counted by the rule (a ruled shift's credit), else by the old count. */
  ruled: boolean;
  /** The rule gives it the person with no work to hold it: their row's on the sale's day, no shift's (not the team's). */
  withoutShift?: boolean;
}

export interface BeforeAfterSale {
  ref: string;
  at: string;
  page: string;
  kind: string;
  netMills: number;
  before: Credit[];
  /** Outside the shifts: its line, or null. */
  beforeLine: string | null;
  after: Credit[];
  afterLine: string | null;
  /** Why it is where it is after the switch: the rule's reason, or the old count's. */
  reason: string;
  /** The home the screen read was stored before the rule computed now changed it. */
  staleHome: boolean;
  ownerWrote: boolean;
}

export interface BeforeAfterDay {
  person: string;
  userId: number;
  day: string;
  beforeMills: number;
  afterMills: number;
  ruleMills: number;
}

export interface BeforeAfterReport {
  first: string;
  last: string;
  screensFrom: string;
  homes: "stored" | "live";
  hubNow: string;
  team: { beforeMills: number; afterMills: number; ruleMills: number };
  outside: { before: Record<string, number>; after: Record<string, number> };
  days: BeforeAfterDay[];
  moved: BeforeAfterSale[];
  /** The rule gives these to a person on a day of the range; the screen after the switch counts them nowhere. */
  unplaced: BeforeAfterSale[];
  staleHomes: number;
  ownerWrote: number;
}

const LINE_TEXT: Readonly<Record<string, string>> = {
  visit: "заход", person: "без смены", pot: "общак", waiting: "ждёт смены отправителя", decide: "ждёт решения", nobody: "ничья",
};

const mskStart = (day: string) => Date.parse(`${day}T00:00:00+03:00`);
const dayAfter = (day: string, by = 1) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
const keyOf = (credits: readonly Credit[]) => credits.map((one) => `${one.userId}|${one.day}|${one.mills}`).sort().join(",");

/**
 * The current window's credits and lines of one read, by sale: a shift's, and a person's with no work to hold it (in
 * their row on the sale's day); a split's parts outside the shifts each on its line, joined. Pure.
 */
export function creditsOfRead(read: Pick<TeamShiftSalesRead, "money" | "outside" | "withoutShift"> & { response: Pick<TeamShiftSalesRead["response"], "chatters"> }): {
  credits: Map<number, Credit[]>;
  lines: Map<number, string>;
  /** Each line's mills, by sale. */
  parts: Map<number, Array<{ home: string; mills: number }>>;
  sales: Map<number, ShiftSale>;
} {
  const credits = new Map<number, Credit[]>();
  const sales = new Map<number, ShiftSale>();
  const credit = (id: number, one: Credit) => credits.set(id, [...(credits.get(id) ?? []), one]);
  for (const one of read.money) {
    if (!one.current) continue;
    for (const sale of one.own) {
      credit(sale.transactionId, { userId: one.userId, person: one.username, day: one.date, mills: sale.netMills, ruled: one.ruled });
      if (!sales.has(sale.transactionId)) sales.set(sale.transactionId, sale);
    }
  }
  const names = new Map(read.response.chatters.map((one) => [one.userId, one.username]));
  for (const one of read.withoutShift) {
    credit(one.sale.transactionId, {
      userId: one.userId, person: names.get(one.userId) ?? `hub:${one.userId}`, day: one.day, mills: one.sale.netMills, ruled: true, withoutShift: true,
    });
  }
  const lines = new Map<number, string>();
  const parts = new Map<number, Array<{ home: string; mills: number }>>();
  for (const one of read.outside) {
    const id = one.sale.transactionId;
    const line = one.visitBy === null ? one.home : `${one.home}:${one.visitBy}`;
    lines.set(id, lines.has(id) ? `${lines.get(id)!} + ${line}` : line);
    parts.set(id, [...(parts.get(id) ?? []), { home: one.home, mills: one.sale.netMills }]);
    if (!sales.has(id)) sales.set(id, one.sale);
  }
  return { credits, lines, parts, sales };
}

const sameHome = (a: ScreenHome | undefined, b: SaleHome | undefined) => a !== undefined && b !== undefined && a.kind === b.kind && a.reason === b.reason
  && a.shares.map((share) => `${share.userId}:${share.workRef}:${share.mills}`).sort().join() === b.shares.map((share) => `${share.userId}:${share.workRef}:${share.mills}`).sort().join();

/** Reads «Смены» off and on for [first, last] and the rule on its own, and compares (read-only). */
export async function runBeforeAfter(db: Database, input: { first: string; last: string; screensFrom: string; live: boolean; now: Date }): Promise<BeforeAfterReport> {
  const { first, last, screensFrom, now } = input;
  const days = Math.round((mskStart(dayAfter(last)) - mskStart(first)) / DAY_MS);
  if (days < 1 || days > 31) throw new Error("--before-after: a range of 1 to 31 days");
  const read = (rule: { from: string; live: boolean } | null) => teamShiftSalesRead(db, { days, until: last, now, pages: "all", rule });
  const before = creditsOfRead(await read(null));
  const afterRead = await read({ from: screensFrom, live: input.live });
  const after = creditsOfRead(afterRead);

  // The rule on its own: every home computed now, each share on the report date of its shift.
  const inRange = (day: string) => day >= first && day <= last && day >= screensFrom;
  const fresh = await computeSaleHomes(db, {
    from: new Date(mskStart(first) - 8 * DAY_MS), to: new Date(Math.min(now.getTime(), mskStart(dayAfter(last, 2)))), now, slots: registrySlots(db),
  });
  const works = new Map(fresh.answer.works.map((work) => [work.ref, work]));
  const freshOf = new Map<number, SaleHome>();
  const ruleCredits = new Map<number, Credit[]>();
  fresh.answer.sales.forEach((sale, at) => {
    const home = fresh.homes[at]!;
    const id = Number(sale.transactionRef);
    freshOf.set(id, home);
    if (home.kind !== "shift") return;
    for (const share of home.shares) {
      // A share on no work (the owner gave it to someone with no shift then): the person's, on the sale's report day.
      if (share.workRef === null) {
        const day = reportDateOfSale(Date.parse(sale.occurredAt));
        if (inRange(day)) ruleCredits.set(id, [...(ruleCredits.get(id) ?? []), { userId: share.userId, person: `hub:${share.userId}`, day, mills: share.mills, ruled: true, withoutShift: true }]);
        continue;
      }
      const work = works.get(share.workRef);
      if (work === undefined || work.kind !== "shift") continue;
      const day = reportDateOfShift({ startedAt: Date.parse(work.startedAt), endedAt: Date.parse(work.endedAt) });
      if (inRange(day)) ruleCredits.set(id, [...(ruleCredits.get(id) ?? []), { userId: share.userId, person: work.username, day, mills: share.mills, ruled: true }]);
    }
  });
  const saleInfo = new Map<number, { at: string; page: string; kind: string; netMills: number }>();
  for (const [id, sale] of [...before.sales, ...after.sales]) {
    saleInfo.set(id, { at: sale.occurredAt.toISOString(), page: sale.pageLabel, kind: sale.kind, netMills: sale.netMills });
  }
  for (const sale of fresh.answer.sales) {
    const id = Number(sale.transactionRef);
    if (!saleInfo.has(id)) saleInfo.set(id, { at: sale.occurredAt, page: sale.pageLabel, kind: sale.kind, netMills: sale.netMills });
  }
  const allSales = [...before.sales.values(), ...after.sales.values()];
  const ownerWrote = await listSalesOwnerWroteTo(db, { hours: SALE_LAST_WRITER_HOURS, sales: lastWriterQuery([...new Map(allSales.map((sale) => [sale.transactionId, sale])).values()]) });

  const ids = new Set([...before.credits.keys(), ...before.lines.keys(), ...after.credits.keys(), ...after.lines.keys(), ...ruleCredits.keys()]);
  const rows: BeforeAfterSale[] = [...ids].flatMap((id) => {
    const info = saleInfo.get(id);
    if (info === undefined) return [];
    const home = freshOf.get(id);
    const stored = afterRead.homes.get(id);
    const was = before.credits.get(id) ?? [];
    const becomes = after.credits.get(id) ?? [];
    // By the rule: a ruled shift's credit, or a line of «вне смен» of a sale of the switch's day or later.
    const placedByRule = becomes.some((one) => one.ruled) || (becomes.length === 0 && moscowDayOf(Date.parse(info.at)) >= screensFrom);
    const reason = placedByRule && stored !== undefined
      ? SALE_HOME_REASON_TEXT[stored.reason as SaleHomeReason] ?? stored.reason
      : was.length > 1 ? "по-старому: держали двое, никто не писал, у обоих" : "по-старому";
    return [{
      ref: String(id), ...info, before: was, beforeLine: before.lines.get(id) ?? null, after: becomes, afterLine: after.lines.get(id) ?? null,
      reason, staleHome: stored !== undefined && home !== undefined && !sameHome(stored, home), ownerWrote: ownerWrote.has(id),
    }];
  }).sort((a, b) => a.at.localeCompare(b.at) || Number(a.ref) - Number(b.ref));

  const moved = rows.filter((one) => keyOf(one.before) !== keyOf(one.after) || one.beforeLine !== one.afterLine);
  const unplaced = rows.filter((one) => (ruleCredits.get(Number(one.ref)) ?? []).length > 0 && one.after.length === 0);

  const dayRows = new Map<string, BeforeAfterDay>();
  const dayRow = (credit: Credit) => {
    const key = `${credit.userId}|${credit.day}`;
    const row = dayRows.get(key) ?? { person: credit.person, userId: credit.userId, day: credit.day, beforeMills: 0, afterMills: 0, ruleMills: 0 };
    dayRows.set(key, row);
    return row;
  };
  for (const credits of before.credits.values()) for (const credit of credits) dayRow(credit).beforeMills += credit.mills;
  for (const credits of after.credits.values()) for (const credit of credits) dayRow(credit).afterMills += credit.mills;
  for (const credits of ruleCredits.values()) for (const credit of credits) dayRow(credit).ruleMills += credit.mills;

  const linesOf = (parts: ReadonlyMap<number, ReadonlyArray<{ home: string; mills: number }>>) => {
    const out: Record<string, number> = {};
    for (const list of parts.values()) for (const part of list) out[part.home] = (out[part.home] ?? 0) + part.mills;
    return out;
  };
  // The team as «Вся команда» counts it: a sale once.
  // A person's money with no work to hold it is in their row and «вне смен», not in the team's shifts.
  const teamOf = (map: ReadonlyMap<number, Credit[]>) => [...map.values()].reduce((total, credits) => {
    const old = credits.filter((one) => !one.ruled);
    return total + credits.filter((one) => one.ruled && one.withoutShift !== true).reduce((sum, one) => sum + one.mills, 0) + (old[0]?.mills ?? 0);
  }, 0);
  return {
    first,
    last,
    screensFrom,
    homes: input.live ? "live" : "stored",
    hubNow: now.toISOString(),
    team: { beforeMills: teamOf(before.credits), afterMills: teamOf(after.credits), ruleMills: teamOf(ruleCredits) },
    outside: { before: linesOf(before.parts), after: linesOf(after.parts) },
    days: [...dayRows.values()].sort((a, b) => a.person.localeCompare(b.person) || a.day.localeCompare(b.day)),
    moved,
    unplaced,
    staleHomes: rows.filter((one) => one.staleHome).length,
    ownerWrote: rows.filter((one) => one.ownerWrote).length,
  };
}

// ─── the text ────────────────────────────────────────────────────────────────

const usd = (mills: number) => formatUsdFromMills(mills);
const shortTime = (iso: string) => {
  const at = new Date(Date.parse(iso) + 3 * 3_600_000).toISOString();
  return `${at.slice(8, 10)}.${at.slice(5, 7)} ${at.slice(11, 16)}`;
};
const shortDay = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const whereText = (credits: readonly Credit[], line: string | null) => {
  if (credits.length > 0) return credits.map((one) => `${one.person} ${usd(one.mills)} (${shortDay(one.day)})`).join(" + ");
  if (line === null) return "нигде в этом периоде";
  return `вне смен: ${line.split(" + ").map((part) => {
    const [kind, who] = part.split(":");
    return `${LINE_TEXT[kind!] ?? kind}${who === undefined ? "" : ` (${who})`}`;
  }).join(" + ")}`;
};

/** «Было и стало» as the owner reads it (Russian, Markdown). */
export function formatBeforeAfter(report: BeforeAfterReport): string {
  const lines: string[] = [];
  lines.push(`# «Смены» по одному правилу: было и стало — ${report.first} … ${report.last}`, "");
  lines.push(`Хаб прочитан ${report.hubNow} (только чтение). Переключатель экранов: с ${report.screensFrom}. `
    + `Дома продаж: ${report.homes === "live" ? "все посчитаны сейчас (как после ближайшего часа работы задания)" : "из sale_homes, открытое окно посчитано сейчас (как покажут экраны)"}.`);
  lines.push("«Было» — «Смены» сейчас, с выключенным переключателем: уже по правилу 12.11, что учётки владельца продаж не берут (#1221). "
    + `Продаж, где фану перед продажей писала учётка владельца: ${report.ownerWrote} (помечены «вл.»): их «было» отличается от снимков до 12:29 12.11 из-за #1221, а не из-за переключателя.`);
  lines.push("«Стало» — «Смены» с переключателем: ровно то, что покажет экран. «Правило» — дома продаж, посчитанные сейчас, каждая доля на дату отчёта своей смены.", "");

  lines.push("## Итог", "");
  lines.push(`| | Было | Стало | Правило |`, "|---|---|---|---|");
  lines.push(`| Вся команда, продажи за смены | ${usd(report.team.beforeMills)} | ${usd(report.team.afterMills)} | ${usd(report.team.ruleMills)} |`);
  for (const kind of ["visit", "person", "pot", "waiting", "decide", "nobody"]) {
    const was = report.outside.before[kind] ?? 0;
    const becomes = report.outside.after[kind] ?? 0;
    if (was !== 0 || becomes !== 0) lines.push(`| вне смен: ${LINE_TEXT[kind]} | ${usd(was)} | ${usd(becomes)} | |`);
  }
  lines.push("", `Продаж, что переезжают: ${report.moved.length}. Стало ≠ правило из-за первых дней переключения: ${report.unplaced.length}. `
    + `Хранимых домов старее правила сейчас: ${report.staleHomes}.`, "");

  const people = new Map<string, BeforeAfterDay[]>();
  for (const day of report.days) people.set(day.person, [...(people.get(day.person) ?? []), day]);
  const total = (list: readonly BeforeAfterDay[], pick: (day: BeforeAfterDay) => number) => list.reduce((sum, day) => sum + pick(day), 0);
  lines.push("## По людям", "", "| Человек | Было | Стало | Разница | Правило |", "|---|---|---|---|---|");
  for (const [person, list] of [...people].sort((a, b) => a[0].localeCompare(b[0]))) {
    const was = total(list, (d) => d.beforeMills);
    const becomes = total(list, (d) => d.afterMills);
    lines.push(`| ${person} | ${usd(was)} | ${usd(becomes)} | ${usd(becomes - was)} | ${usd(total(list, (d) => d.ruleMills))} |`);
  }
  lines.push("", "Сумма строк людей больше «Всей команды», когда продажа «было» засчитана двоим.", "");

  lines.push("## По людям и дням", "", "| Человек | День | Было | Стало | Правило |", "|---|---|---|---|---|");
  for (const day of report.days) {
    if (day.beforeMills === 0 && day.afterMills === 0 && day.ruleMills === 0) continue;
    const mark = day.afterMills !== day.ruleMills ? " ≠" : "";
    lines.push(`| ${day.person} | ${day.day} | ${usd(day.beforeMills)} | ${usd(day.afterMills)} | ${usd(day.ruleMills)}${mark} |`);
  }
  lines.push("");

  lines.push("## Продажи, что переезжают", "", "| Когда (МСК) | Страница | Вид | Net | Ref | Было | Стало | Почему | |", "|---|---|---|---|---|---|---|---|---|");
  for (const one of report.moved) {
    const marks = [one.ownerWrote ? "вл." : "", one.staleHome ? "дом старый" : ""].filter(Boolean).join(", ");
    lines.push(`| ${shortTime(one.at)} | ${one.page} | ${one.kind} | ${usd(one.netMills)} | ${one.ref} | ${whereText(one.before, one.beforeLine)} | ${whereText(one.after, one.afterLine)} | ${one.reason} | ${marks} |`);
  }
  lines.push("");

  lines.push("## Правило даёт человеку, а «стало» не считает нигде (первые дни переключения)", "",
    "Продажу считает смена до переключения (по-старому), или правило отдаёт её смене до переключения.", "",
    "| Когда (МСК) | Страница | Net | Ref | Было | Стало | Почему |", "|---|---|---|---|---|---|---|");
  for (const one of report.unplaced) {
    lines.push(`| ${shortTime(one.at)} | ${one.page} | ${usd(one.netMills)} | ${one.ref} | ${whereText(one.before, one.beforeLine)} | ${whereText(one.after, one.afterLine)} | ${one.reason} |`);
  }
  lines.push("");
  return lines.join("\n");
}
