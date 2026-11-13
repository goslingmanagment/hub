import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentTeamSale, AgentTeamSalesResponse, AgentTeamWork } from "@agency_hub_core/contracts";
import { listSalePlatformRefs, listVisiblePages, type Database } from "@agency_hub_core/db";
import { formatUsdFromMills, millsToNumber, sumMills } from "@agency_hub_core/shared";

import { readAgentTeamSales } from "./agent-team-sales.ts";
import { dayOfWork, moscowDayOf } from "./chatter-shifts.ts";
import { REPORTS_AFTER_DAYS, REPORTS_BEFORE_DAYS, pairReportLines, type PairLine, type PairSale } from "./report-line-pairs.ts";
import { ruleNowOf, ruleSalesOf, ruleWorksOf, saleRuleInputs, sendersOf, usersLeftAt, type SaleRuleInput, type SaleSlotProvider } from "./sale-homes.ts";
import {
  LEDGER_GO_RULE,
  SALE_HOME_REASON_TEXT,
  SALE_RULE,
  homesOfSales,
  type RuleSlot,
  type SaleHome,
  type SaleHomeReason,
} from "./sale-rule.ts";
import { reportDateOfShift } from "./shift-rows.ts";
import { teamShiftSalesOf } from "./team-shift-sales.ts";

/**
 * The comparison of the one rule with what the agency ledger and Gengar say, for the orchestrator and the owner
 * («было и стало»). Read-only on both sides: Hub through a read-only session, the ledger through `ledger sql`
 * (SELECT). For a range of Moscow days:
 *
 *  (a) every sale: Hub's home by the rule (sale-rule.ts, on Hub's facts now), the ledger's `fact_homes`, and the
 *      person Gengar's saved layout counted it for (`shift_report_lines`, source agent) — with the cause of every
 *      difference: the owner's newer answer (a left sender, the slot), facts that differ between Hub now and the
 *      ledger's last read (which, named), the ledger's claim, a sale one side lacks. The port run on the ledger's own
 *      stored facts must give `fact_homes` exactly: a «port ≠ Go» line is a bug of the port. A sale whose home
 *      depends on a schedule slot is marked.
 *  (b) every person and day: today's Workboard («Смены», `teamShiftMoney`), the rule, the ledger's facts, Gengar's
 *      layout, the posted report.
 *  (c) every person over the range: the sales by the rule no line of their layouts pays, and what their layouts count
 *      that is none of their sales («по словам») — by the one pairing «Смены» reads (report-line-pairs.ts), so a sale
 *      paid in a later layout as «долёт» is paid, not «not in the layout».
 *
 * A work is whole in the range its day is in, as Workboard counts it: the sales of the day on each side of the range
 * that a work of the range holds, or that a home dates into it (the night past the last midnight), are compared too.
 *
 * Real names stay in the output: run it where the output is private.
 */

const DAY_MS = 86_400_000;
const execFileAsync = promisify(execFile);

// ─── the ledger's side ───────────────────────────────────────────────────────

export interface LedgerWindow {
  from: string;
  to: string;
  status: string;
  workTo: string;
  readAt: string;
}

export interface LedgerFactHome {
  ref: string;
  seq: number;
  window: string;
  at: string;
  page: string;
  kind: string;
  netMicros: number;
  home: string;
  reason: string;
  userId: number | null;
  username: string | null;
  person: string | null;
  workRef: string | null;
  shareMicros: number;
  day: string;
}

export interface LedgerLayout {
  id: number;
  person: string | null;
  userId: number | null;
  username: string;
  reportDate: string;
  totalMicros: number;
  status: string;
}

export interface LedgerExport {
  windows: LedgerWindow[];
  /** Each window's works and sales, as the ledger stored Hub's answer. */
  works: Map<string, AgentTeamWork[]>;
  sales: Map<string, AgentTeamSale[]>;
  pages: string[];
  homes: LedgerFactHome[];
  claims: Array<{ ref: string; person: string }>;
  /**
   * The latest saved layout of each person and report date (not superseded): the range's, and those of
   * REPORTS_BEFORE_DAYS before it to REPORTS_AFTER_DAYS after it — a sale of the range may be paid in a later layout
   * (as «Смены» reads the reports, shift-report-notes.ts).
   */
  layouts: LedgerLayout[];
  /** Their counted lines, each layout's in its own order. `what` — the words of an amount added by hand. */
  layoutLines: Array<{ reportId: number; ref: string | null; page: string; netMicros: number; what?: string }>;
  posted: Array<{ person: string; reportDate: string; page: string; postedMicros: number }>;
}

type Rows = Array<Record<string, unknown>>;
export type LedgerSql = (query: string) => Promise<Rows>;

/** `ledger sql --json <query>` through the ledger CLI at `bin` (its own credentials). */
export function ledgerCli(bin: string): LedgerSql {
  return async (query) => {
    const { stdout } = await execFileAsync(bin, ["sql", "--json", query], { maxBuffer: 512 * 1024 * 1024 });
    const answer = JSON.parse(stdout) as { ok: boolean; columns: string[]; rows: unknown[][]; error?: string };
    if (!answer.ok) throw new Error(`ledger sql: ${answer.error ?? "not ok"}`);
    return answer.rows.map((row) => Object.fromEntries(answer.columns.map((column, at) => [column, row[at]])));
  };
}

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const int = (value: unknown) => Number(value);

/** Moscow midnight of a YYYY-MM-DD day, as the ledger writes instants. */
const mskStart = (day: string) => `${day}T00:00:00+03:00`;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const previousDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Reads what the ledger holds of [first, last] (Moscow days) and the day on each side (a work the range's edge cuts). */
export async function readLedgerExport(run: LedgerSql, range: { first: string; last: string }): Promise<LedgerExport> {
  const from = mskStart(previousDay(range.first));
  const to = mskStart(nextDay(nextDay(range.last)));
  // The windows a sale of the range is in, and the week before (a work at a window's edge is whole in the window it began in).
  const before = mskStart(new Date(Date.parse(`${range.first}T00:00:00Z`) - 8 * DAY_MS).toISOString().slice(0, 10));
  const windows = (await run(`SELECT window_from, window_to, status, COALESCE(work_to, '') work_to, read_at FROM hub_team_sync
    WHERE window_to > '${before}' AND window_from < '${to}' ORDER BY window_from`)).map((row) => ({
    from: String(row.window_from), to: String(row.window_to), status: String(row.status), workTo: String(row.work_to), readAt: String(row.read_at),
  }));
  const keys = windows.map((window) => `'${window.from}'`).join(", ") || "''";
  const works = new Map<string, AgentTeamWork[]>();
  for (const row of await run(`SELECT window_from, payload FROM hub_works WHERE window_from IN (${keys})`)) {
    const list = works.get(String(row.window_from)) ?? [];
    list.push(JSON.parse(String(row.payload)) as AgentTeamWork);
    works.set(String(row.window_from), list);
  }
  const sales = new Map<string, AgentTeamSale[]>();
  for (const row of await run(`SELECT window_from, payload FROM hub_sales WHERE window_from IN (${keys}) ORDER BY occurred_at, transaction_ref`)) {
    const list = sales.get(String(row.window_from)) ?? [];
    list.push(JSON.parse(String(row.payload)) as AgentTeamSale);
    sales.set(String(row.window_from), list);
  }
  const pages = (await run("SELECT page_label FROM hub_pages ORDER BY page_label")).map((row) => String(row.page_label));
  const homes = (await run(`SELECT transaction_ref, seq, window_from, occurred_at, page_label, sale_kind, net_micros, home, reason, hub_user_id,
      username, person, work_ref, share_micros, day FROM fact_homes WHERE occurred_at >= '${from}' AND occurred_at < '${to}'
    ORDER BY occurred_at, transaction_ref, seq`)).map((row): LedgerFactHome => ({
    ref: String(row.transaction_ref), seq: int(row.seq), window: String(row.window_from), at: String(row.occurred_at), page: String(row.page_label),
    kind: String(row.sale_kind), netMicros: int(row.net_micros), home: String(row.home), reason: String(row.reason),
    userId: row.hub_user_id === null ? null : int(row.hub_user_id), username: text(row.username), person: text(row.person),
    workRef: text(row.work_ref), shareMicros: int(row.share_micros), day: String(row.day),
  }));
  const claims = (await run("SELECT transaction_ref, person FROM v_sale_claims")).map((row) => ({ ref: String(row.transaction_ref), person: String(row.person) }));
  const layouts = (await run(`SELECT id, person, hub_user_id, hub_username, report_date, total_micros, status FROM (
      SELECT r.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(person, hub_username), report_date ORDER BY created_at DESC, id DESC) rn
      FROM shift_reports r WHERE source = 'agent' AND status <> 'superseded'
        AND report_date BETWEEN '${shiftDay(range.first, -REPORTS_BEFORE_DAYS)}' AND '${shiftDay(range.last, REPORTS_AFTER_DAYS)}')
    WHERE rn = 1 ORDER BY report_date, id`)).map((row): LedgerLayout => ({
    id: int(row.id), person: text(row.person), userId: row.hub_user_id === null ? null : int(row.hub_user_id), username: String(row.hub_username),
    reportDate: String(row.report_date), totalMicros: int(row.total_micros), status: String(row.status),
  }));
  const ids = layouts.map((layout) => layout.id).join(", ") || "0";
  const layoutLines = (await run(`SELECT report_id, transaction_ref, page_label, net_micros, what FROM shift_report_lines
    WHERE report_id IN (${ids}) AND counted = 1 ORDER BY report_id, seq`)).map((row) => ({
    reportId: int(row.report_id), ref: text(row.transaction_ref), page: String(row.page_label), netMicros: int(row.net_micros),
    what: text(row.what) ?? "",
  }));
  const posted = (await run(`SELECT person, report_date, page, posted_micros FROM v_report_pages
    WHERE report_date BETWEEN '${range.first}' AND '${range.last}' AND posted_micros IS NOT NULL`)).map((row) => ({
    person: String(row.person), reportDate: String(row.report_date), page: String(row.page), postedMicros: int(row.posted_micros),
  }));
  return { windows, works, sales, pages, homes, claims, layouts, layoutLines, posted };
}

// ─── the comparison ──────────────────────────────────────────────────────────

/** A home as the comparison reads it: its kind, reason and who gets how much. */
export interface HomeView {
  kind: string;
  reason: string;
  /** `day` — of the work's middle (the screens', the ledger's facts'); `reportDate` — the work's report date. */
  shares: Array<{ userId: number; mills: number; day: string; reportDate: string }>;
  slotJunction?: boolean;
}

export interface SaleComparison {
  ref: string;
  at: string;
  page: string;
  kind: string;
  netMills: number;
  hub: HomeView | null;
  /** Hub's facts by ledger's Go (the owner's newer answers off). */
  hubGo: HomeView | null;
  ledger: HomeView | null;
  /** The port, ledger's Go rule, on the ledger's own stored facts: must be `ledger`. */
  portOnLedger: HomeView | null;
  /**
   * Who Gengar's latest saved layouts counted it for, net mills each: a line that names it (by the platform's reference
   * or Hub's id), in the range's layouts or a later one («долёт»), and an amount added in words that pays it for the
   * person it is by the rule (report-line-pairs.ts).
   */
  gengar: Array<{ person: string; mills: number }>;
  /** The people the rule gives it to whose layout of that report date does not count it — and no line of the layouts read pays it. */
  missingFromLayout: string[];
  same: boolean;
  slot: boolean;
  causes: string[];
}

export interface PersonDay {
  person: string;
  userId: number | null;
  day: string;
  workboardMills: number | null;
  ruleMills: number;
  factsMills: number;
  layoutMills: number | null;
  postedMills: number | null;
}

/** A person over the range, by the one pairing of report lines with sales (report-line-pairs.ts). */
export interface PersonReported {
  person: string;
  userId: number | null;
  /** Their sales by the rule dated in the range, on a day they have a layout of, that no counted line of their layouts read pays. */
  unreported: { count: number; mills: number };
  /** Counted lines of their layouts of the range that pay none of their sales by the rule: «по словам». */
  byWordsMills: number;
}

export interface SaleRuleComparison {
  first: string;
  last: string;
  hubNow: string;
  ruleVersion: string;
  slotsGiven: number;
  /** Where the slots came from: the people registry (as the job), none, a file. */
  slotsSource: SlotsSource;
  ledgerWindows: LedgerWindow[];
  sales: SaleComparison[];
  days: PersonDay[];
  /** Everyone with a layout of the range. */
  people: PersonReported[];
  /** Shifts whose report date is not the day the screens and the ledger's facts date them by. */
  datedApart: Array<{ person: string; startedAt: string; endedAt: string; dayOfWork: string; reportDate: string }>;
  notes: string[];
}

export type SlotsSource = "registry" | "none" | "file";

type DayOf = (ref: string | null, saleAt: string) => { day: string; reportDate: string };

/** The days of a share: its work's, or the sale's when no work holds it. */
function dayOfIn(works: ReadonlyMap<string, AgentTeamWork>): DayOf {
  return (ref, saleAt) => {
    const work = ref === null ? undefined : works.get(ref);
    if (work === undefined) {
      const day = moscowDayOf(Date.parse(saleAt));
      return { day, reportDate: day };
    }
    const span = { startedAt: Date.parse(work.startedAt), endedAt: Date.parse(work.endedAt) };
    return { day: dayOfWork(span), reportDate: reportDateOfShift(span) };
  };
}

const viewOf = (home: SaleHome, dayOf: DayOf, saleAt: string): HomeView => ({
  kind: home.kind,
  reason: home.reason,
  shares: home.shares.map((share) => ({ userId: share.userId, mills: share.mills, ...dayOf(share.workRef, saleAt) })),
  slotJunction: home.slotJunction,
});

function ledgerViewOf(rows: readonly LedgerFactHome[]): HomeView {
  const first = rows[0]!;
  return {
    kind: first.home,
    reason: first.reason,
    shares: rows.filter((row) => row.userId !== null && (row.home === "shift" || row.home === "visit"))
      .map((row) => ({ userId: row.userId!, mills: row.shareMicros / 1000, day: row.day, reportDate: row.day })),
  };
}

/** The same home: kind, reason and who gets how much (the day aside). */
export function sameHome(a: HomeView | null, b: HomeView | null): boolean {
  if (a === null || b === null) return a === b;
  const key = (view: HomeView) => view.shares.map((share) => `${share.userId}:${share.mills}`).sort().join(",");
  return a.kind === b.kind && a.reason === b.reason && key(a) === key(b);
}

/** The facts a sale's home is read from that differ between Hub now and the ledger's read. Pure. */
export function factsApart(input: {
  hub: AgentTeamSale;
  ledger: AgentTeamSale;
  hubWorks: ReadonlyMap<string, AgentTeamWork>;
  ledgerWorks: ReadonlyMap<string, AgentTeamWork>;
  name: (userId: number | null) => string;
}): string[] {
  const { hub, ledger, name } = input;
  const out: string[] = [];
  if (hub.netMills !== ledger.netMills) out.push(`net ${formatUsdFromMills(hub.netMills)} в хабе, ${formatUsdFromMills(ledger.netMills)} в ledger`);
  if (hub.kind !== ledger.kind) out.push(`вид ${hub.kind} в хабе, ${ledger.kind} в ledger`);
  if ((hub.ppvSender?.userId ?? null) !== (ledger.ppvSender?.userId ?? null) || hub.ppvSender?.role !== ledger.ppvSender?.role) {
    out.push(`отправитель PPV: хаб ${hub.ppvSender === null ? "нет" : `${name(hub.ppvSender.userId)} (${hub.ppvSender.role})`}, ledger ${ledger.ppvSender === null ? "нет" : `${name(ledger.ppvSender.userId)} (${ledger.ppvSender.role})`}`);
  }
  if (hub.lastWriterUserId !== ledger.lastWriterUserId) {
    out.push(`последний писавший: хаб ${name(hub.lastWriterUserId)}, ledger ${name(ledger.lastWriterUserId)}`);
  }
  if (hub.postTip !== ledger.postTip) out.push(`чаевые под постом: хаб ${hub.postTip}, ledger ${ledger.postTip}`);
  if (hub.campaign !== ledger.campaign) out.push(`Campaign: хаб ${hub.campaign}, ledger ${ledger.campaign}`);
  if (JSON.stringify(hub.marks) !== JSON.stringify(ledger.marks) || JSON.stringify(hub.resolution) !== JSON.stringify(ledger.resolution)) {
    out.push("метки или раздел владельца");
  }
  const holder = (works: ReadonlyMap<string, AgentTeamWork>, ref: string) => {
    const work = works.get(ref);
    return work === undefined ? `${ref} (нет в сменах)` : `${name(work.userId)} ${work.kind} ${shortTime(work.startedAt)}–${shortTime(work.endedAt)}`;
  };
  const hubHolders = [...hub.holders].sort();
  const ledgerHolders = [...ledger.holders].sort();
  if (hubHolders.join() !== ledgerHolders.join()) {
    out.push(`держали: хаб [${hubHolders.map((ref) => holder(input.hubWorks, ref)).join("; ")}], ledger [${ledgerHolders.map((ref) => holder(input.ledgerWorks, ref)).join("; ")}]`);
  } else {
    for (const ref of hubHolders) {
      const a = input.hubWorks.get(ref);
      const b = input.ledgerWorks.get(ref);
      if (a !== undefined && b !== undefined && (a.endedAt !== b.endedAt || a.kind !== b.kind)) {
        out.push(`смена держателя: хаб ${holder(input.hubWorks, ref)}, ledger ${holder(input.ledgerWorks, ref)}`);
      }
    }
  }
  if (hub.ppvSender !== null && hub.ppvSender.userId === ledger.ppvSender?.userId) {
    const at = Date.parse(hub.occurredAt);
    const theirs = (works: ReadonlyMap<string, AgentTeamWork>) => [...works.values()]
      .filter((work) => work.userId === hub.ppvSender!.userId && work.kind === "shift"
        && Date.parse(work.endedAt) > at && Date.parse(work.startedAt) <= at + SALE_RULE.ppvWaitMs)
      .map((work) => `${shortTime(work.startedAt)}–${shortTime(work.endedAt)}`).sort();
    const a = theirs(input.hubWorks);
    const b = theirs(input.ledgerWorks);
    if (a.join() !== b.join()) out.push(`смены отправителя в 7 дней: хаб [${a.join("; ")}], ledger [${b.join("; ")}]`);
  }
  return out;
}

const shortTime = (iso: string) => {
  const at = new Date(Date.parse(iso) + 3 * 3_600_000).toISOString();
  return `${at.slice(8, 10)}.${at.slice(5, 7)} ${at.slice(11, 16)}`;
};

/**
 * The whole version of each ledger work: a work at a window's edge is cut, and the ledger takes the one of the
 * proven window its start falls in (ledger internal/accruals/rebuild.go). Pure.
 */
export function ledgerWholeWorks(exported: Pick<LedgerExport, "windows" | "works">): Map<string, AgentTeamWork> {
  const whole = new Map<string, AgentTeamWork>();
  for (const window of exported.windows) {
    if (window.status !== "ok") continue;
    for (const work of exported.works.get(window.from) ?? []) {
      const start = Date.parse(work.startedAt);
      if (start >= Date.parse(window.from) && start < Date.parse(window.to)) whole.set(work.ref, work);
    }
  }
  return whole;
}

export interface HubWindow {
  window: LedgerWindow | null;
  answer: AgentTeamSalesResponse;
}

/** Compares the homes (a) and the people's days (b). Pure. */
export function compareSaleRule(input: {
  first: string;
  last: string;
  hubNow: Date;
  hub: readonly HubWindow[];
  ledger: LedgerExport;
  leftAt: ReadonlyMap<number, number>;
  pageIds: ReadonlyMap<string, number>;
  slots: readonly RuleSlot[];
  slotsSource: SlotsSource;
  workboard: ReadonlyArray<{ userId: number; username: string; daily: ReadonlyArray<{ date: string; salesNetMills: number }> }>;
  /** The platform's reference of each Hub sale: Gengar's layouts name a sale by it. */
  platformRefOf: ReadonlyMap<string, string>;
  /** What people said and the owner decided (package G), as `sale_homes` reads them; absent — the answer's own (old) marks. */
  inputs?: ReadonlyMap<string, SaleRuleInput>;
  /**
   * Hub's facts of the days before the range's own read, with their slots: only for whose those sales are by the rule,
   * so a «долёт» of last week in a layout of the range pays its sale instead of reading as «по словам». Absent — none.
   */
  lead?: { windows: readonly HubWindow[]; slots: readonly RuleSlot[] };
}): SaleRuleComparison {
  const { ledger } = input;
  const notes: string[] = [];
  const usernames = new Map<number, string>();
  const personOf = new Map<number, string>();
  const userOfPerson = new Map<string, number>();
  for (const row of ledger.homes) {
    if (row.userId !== null && row.username !== null) usernames.set(row.userId, row.username);
    if (row.userId !== null && row.person !== null) personOf.set(row.userId, row.person);
  }
  for (const layout of ledger.layouts) if (layout.userId !== null && layout.person !== null) personOf.set(layout.userId, layout.person);
  for (const { answer } of input.hub) for (const work of answer.works) usernames.set(work.userId, work.username);
  for (const [userId, person] of personOf) userOfPerson.set(person, userId);
  const name = (userId: number | null) => (userId === null ? "никто" : personOf.get(userId) ?? usernames.get(userId) ?? `hub:${userId}`);

  // The rule on Hub's facts now, and ledger's Go on the same facts.
  const hubSales = new Map<string, { sale: AgentTeamSale; hub: HomeView; hubGo: HomeView; works: Map<string, AgentTeamWork> }>();
  const hubWorksAll = new Map<string, AgentTeamWork>();
  for (const { answer } of input.hub) {
    const works = new Map(answer.works.map((work) => [work.ref, work]));
    for (const work of answer.works) hubWorksAll.set(work.ref, work);
    const dayOf = dayOfIn(works);
    const ruleSales = ruleSalesOf(answer.sales, { pageIds: input.pageIds, leftAt: input.leftAt, ...(input.inputs === undefined ? {} : { inputs: input.inputs }) });
    const ruleWorks = ruleWorksOf(answer.works);
    const now = ruleNowOf(answer);
    const homes = homesOfSales(ruleSales, ruleWorks, input.slots, now, SALE_RULE);
    const goHomes = homesOfSales(ruleSales, ruleWorks, [], now, LEDGER_GO_RULE);
    answer.sales.forEach((sale, at) => {
      hubSales.set(sale.transactionRef, { sale, hub: viewOf(homes[at]!, dayOf, sale.occurredAt), hubGo: viewOf(goHomes[at]!, dayOf, sale.occurredAt), works });
    });
  }

  // The same rule on the days before the range's read: whose those sales are, for the pairing alone.
  const leadSales: Array<{ sale: AgentTeamSale; hub: HomeView }> = [];
  for (const { answer } of input.lead?.windows ?? []) {
    for (const work of answer.works) if (!usernames.has(work.userId)) usernames.set(work.userId, work.username);
    const dayOf = dayOfIn(new Map(answer.works.map((work) => [work.ref, work])));
    const ruleSales = ruleSalesOf(answer.sales, { pageIds: input.pageIds, leftAt: input.leftAt, ...(input.inputs === undefined ? {} : { inputs: input.inputs }) });
    const homes = homesOfSales(ruleSales, ruleWorksOf(answer.works), input.lead!.slots, ruleNowOf(answer), SALE_RULE);
    answer.sales.forEach((sale, at) => {
      if (!hubSales.has(sale.transactionRef)) leadSales.push({ sale, hub: viewOf(homes[at]!, dayOf, sale.occurredAt) });
    });
  }

  // The port, ledger's Go, on the ledger's own facts and claims.
  const whole = ledgerWholeWorks(ledger);
  const claimedBy = new Map<string, number>();
  for (const claim of ledger.claims) {
    const userId = userOfPerson.get(claim.person);
    if (userId !== undefined) claimedBy.set(claim.ref, userId);
    else notes.push(`заявка ledger на ${claim.ref} (${claim.person}): человек без логина хаба, порт её не применил`);
  }
  const ledgerSales = new Map<string, { sale: AgentTeamSale; port: HomeView; works: Map<string, AgentTeamWork>; window: LedgerWindow }>();
  for (const window of ledger.windows) {
    if (window.status !== "ok") continue;
    const list = (ledger.works.get(window.from) ?? []).map((work) => whole.get(work.ref) ?? work);
    const works = new Map(list.map((work) => [work.ref, work]));
    const sales = ledger.sales.get(window.from) ?? [];
    const dayOf = dayOfIn(works);
    const homes = homesOfSales(ruleSalesOf(sales, { pageIds: input.pageIds, leftAt: new Map(), claimedBy }), ruleWorksOf(list), [], Date.parse(window.workTo), LEDGER_GO_RULE);
    sales.forEach((sale, at) => ledgerSales.set(sale.transactionRef, { sale, port: viewOf(homes[at]!, dayOf, sale.occurredAt), works, window }));
  }

  const factRows = new Map<string, LedgerFactHome[]>();
  for (const row of ledger.homes) factRows.set(row.ref, [...(factRows.get(row.ref) ?? []), row]);

  const fromAt = Date.parse(mskStart(input.first));
  const toAt = Date.parse(mskStart(nextDay(input.last)));
  const inRange = (day: string) => day >= input.first && day <= input.last;

  // Gengar's latest layouts: who counted each sale. A line names its sale by the platform's reference, or by Hub's id.
  const layoutOf = new Map(ledger.layouts.map((layout) => [layout.id, layout]));
  const personOfLayout = (layout: LedgerLayout) => layout.person ?? layout.username;
  const gengarOf = new Map<string, Array<{ person: string; mills: number }>>();
  for (const line of ledger.layoutLines) {
    if (line.ref === null) continue;
    const layout = layoutOf.get(line.reportId)!;
    gengarOf.set(line.ref, [...(gengarOf.get(line.ref) ?? []), { person: personOfLayout(layout), mills: line.netMicros / 1000 }]);
  }
  // The layouts of the range itself: a day row and «not in the layout» are theirs; the ones around it only pay sales.
  const layoutDays = new Set(ledger.layouts.filter((layout) => inRange(layout.reportDate)).map((layout) => `${personOfLayout(layout)}|${layout.reportDate}`));

  // Which line of a person's layouts pays which of their sales by the rule (report-line-pairs.ts), person by person.
  interface OwnSale extends PairSale { reportDate: string }
  interface LayoutLine extends PairLine { reportDate: string }
  const ownSales = new Map<string, Map<string, OwnSale>>();
  for (const { sale, hub } of [...leadSales, ...[...hubSales.values()].map((one) => ({ sale: one.sale, hub: one.hub }))]) {
    if (hub.kind !== "shift" && hub.kind !== "visit") continue;
    for (const share of hub.shares) {
      const person = name(share.userId);
      const sales = ownSales.get(person) ?? new Map<string, OwnSale>();
      const known = sales.get(sale.transactionRef);
      sales.set(sale.transactionRef, known !== undefined ? { ...known, netMills: known.netMills + share.mills } : {
        hubRef: sale.transactionRef, platformRef: input.platformRefOf.get(sale.transactionRef) ?? null, pageLabel: sale.pageLabel,
        netMills: share.mills, occurredAt: Date.parse(sale.occurredAt), reportDate: share.reportDate,
      });
      ownSales.set(person, sales);
    }
  }
  // A person's lines, the oldest layout first: a sale two layouts count is paid by the first.
  const linesOfLayout = new Map<number, LedgerExport["layoutLines"]>();
  for (const line of ledger.layoutLines) linesOfLayout.set(line.reportId, [...(linesOfLayout.get(line.reportId) ?? []), line]);
  const ownLines = new Map<string, LayoutLine[]>();
  for (const layout of [...ledger.layouts].sort((a, b) => a.reportDate.localeCompare(b.reportDate) || a.id - b.id)) {
    const lines = ownLines.get(personOfLayout(layout)) ?? [];
    for (const line of linesOfLayout.get(layout.id) ?? []) {
      lines.push({ ref: line.ref, pageLabel: line.page, netMills: line.netMicros / 1000, counted: true, what: line.what ?? "", reportDate: layout.reportDate });
    }
    ownLines.set(personOfLayout(layout), lines);
  }
  /** Who an amount added in words pays a sale for: by Hub's reference of the sale. */
  const paidInWords = new Map<string, Array<{ person: string; mills: number }>>();
  const reported = new Map<string, PersonReported>();
  for (const person of new Set([...ownSales.keys(), ...ownLines.keys()])) {
    const pairs = pairReportLines([...(ownSales.get(person)?.values() ?? [])], ownLines.get(person) ?? []);
    for (const [sale, line] of pairs.paidBy) {
      if (line.ref === null) paidInWords.set(sale.hubRef, [...(paidInWords.get(sale.hubRef) ?? []), { person, mills: line.netMills }]);
    }
    // Someone with no layout of the range has nothing to be missing from, and nothing counted by word.
    if (!ledger.layouts.some((layout) => inRange(layout.reportDate) && personOfLayout(layout) === person)) continue;
    const unpaid = pairs.unpaid.filter((sale) => inRange(sale.reportDate) && layoutDays.has(`${person}|${sale.reportDate}`));
    const byWords = pairs.loose.filter((line) => inRange(line.reportDate));
    reported.set(person, {
      person,
      userId: userOfPerson.get(person) ?? null,
      unreported: { count: unpaid.length, mills: unpaid.reduce((sum, sale) => sum + sale.netMills, 0) },
      byWordsMills: byWords.reduce((sum, line) => sum + line.netMills, 0),
    });
  }
  /** Who the layouts count a sale for: the lines that name it by either reference, and the amounts in words that pay it. */
  const gengarFor = (ref: string) => {
    const platform = input.platformRefOf.get(ref);
    return [...(platform === undefined || platform === ref ? [] : gengarOf.get(platform) ?? []), ...(gengarOf.get(ref) ?? []), ...(paidInWords.get(ref) ?? [])];
  };

  const lastRead = ledger.windows.reduce((latest, window) => (window.to > latest ? window.to : latest), "");
  // The range's sales, and those of the day on each side that a work of the range holds or a home dates into it.
  const refs = new Set<string>();
  for (const [ref, one] of hubSales) {
    const at = Date.parse(one.sale.occurredAt);
    const held = one.sale.holders.some((holder) => {
      const work = one.works.get(holder);
      return work !== undefined && inRange(dayOfWork({ startedAt: Date.parse(work.startedAt), endedAt: Date.parse(work.endedAt) }));
    });
    const dated = [...one.hub.shares, ...one.hubGo.shares].some((share) => inRange(share.day));
    if ((at >= fromAt && at < toAt) || held || dated) refs.add(ref);
  }
  for (const [ref, rows] of factRows) {
    if (rows.some((row) => (Date.parse(row.at) >= fromAt && Date.parse(row.at) < toAt) || inRange(row.day))) refs.add(ref);
  }

  const sales: SaleComparison[] = [...refs].map((ref) => {
    const hubOne = hubSales.get(ref);
    const ledgerOne = ledgerSales.get(ref);
    const rows = factRows.get(ref);
    const fact = rows === undefined ? null : ledgerViewOf(rows);
    const sale = hubOne?.sale ?? ledgerOne?.sale;
    const at = sale?.occurredAt ?? rows![0]!.at;
    const causes: string[] = [];
    const hub = hubOne?.hub ?? null;
    const hubGo = hubOne?.hubGo ?? null;
    const port = ledgerOne?.port ?? null;
    const same = sameHome(hub, fact);
    if (fact !== null && port !== null && !sameHome(port, fact)) causes.push("ПОРТ ≠ Go на фактах ledger");
    if (!same) {
      if (hubOne === undefined) causes.push("в хабе сейчас этой продажи нет (возврат, другая страница)");
      else if (fact === null) {
        causes.push(Date.parse(at) >= Date.parse(lastRead || "1970-01-01T00:00:00Z")
          ? `после последнего чтения ledger (${shortTime(lastRead)})`
          : ledger.pages.includes(hubOne.sale.pageLabel) ? "в фактах ledger её нет" : `страница ${hubOne.sale.pageLabel} ledger не читает`);
      } else {
        if (!sameHome(hub, hubGo)) causes.push(`новое слово владельца: ${SALE_HOME_REASON_TEXT[hub!.reason as SaleHomeReason]}`);
        if (!sameHome(hubGo, fact)) {
          const apart = ledgerOne === undefined ? [] : factsApart({ hub: hubOne.sale, ledger: ledgerOne.sale, hubWorks: hubOne.works, ledgerWorks: ledgerOne.works, name });
          if (fact.reason === "owner_claim") causes.push("заявка ledger (sale_claims): в хабе заявок нет");
          causes.push(...(apart.length > 0 ? apart.map((one) => `факты: ${one}`)
            : [`факты те же; ledger читал их ${ledgerOne === undefined ? "?" : shortTime(ledgerOne.window.readAt)}, хаб — сейчас`]));
        }
      }
    }
    return {
      ref,
      at,
      page: sale?.pageLabel ?? rows![0]!.page,
      kind: sale?.kind ?? rows![0]!.kind,
      netMills: sale?.netMills ?? rows![0]!.netMicros / 1000,
      hub,
      hubGo,
      ledger: fact,
      portOnLedger: port,
      gengar: gengarFor(ref),
      missingFromLayout: (gengarFor(ref).length > 0 ? [] : hub?.kind === "shift" || hub?.kind === "visit" ? hub.shares : [])
        .map((share) => ({ person: name(share.userId), reportDate: share.reportDate }))
        .filter((one) => layoutDays.has(`${one.person}|${one.reportDate}`))
        .map((one) => `${one.person} ${one.reportDate}`),
      same,
      slot: hub?.slotJunction === true || hubGo?.slotJunction === true,
      causes,
    };
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.ref.localeCompare(b.ref));

  // (b) every person and day.
  const days = new Map<string, PersonDay>();
  const keyOf = (userId: number | null, person: string | null, day: string) => {
    const who = person ?? (userId === null ? "?" : name(userId));
    const key = `${who}|${day}`;
    let row = days.get(key);
    if (row === undefined) {
      row = { person: who, userId: userId ?? userOfPerson.get(who) ?? null, day, workboardMills: null, ruleMills: 0, factsMills: 0, layoutMills: null, postedMills: null };
      days.set(key, row);
    }
    return row;
  };
  for (const one of sales) {
    for (const share of one.hub?.kind === "shift" || one.hub?.kind === "visit" ? one.hub.shares : []) {
      if (inRange(share.day)) keyOf(share.userId, personOf.get(share.userId) ?? null, share.day).ruleMills += share.mills;
    }
  }
  for (const row of ledger.homes) {
    if (row.userId === null || (row.home !== "shift" && row.home !== "visit") || !inRange(row.day)) continue;
    keyOf(row.userId, row.person ?? personOf.get(row.userId) ?? null, row.day).factsMills += row.shareMicros / 1000;
  }
  for (const person of input.workboard) {
    for (const day of person.daily) {
      if (day.salesNetMills === 0 || !inRange(day.date)) continue;
      const row = keyOf(person.userId, personOf.get(person.userId) ?? null, day.date);
      row.workboardMills = (row.workboardMills ?? 0) + day.salesNetMills;
    }
  }
  for (const layout of ledger.layouts) {
    if (!inRange(layout.reportDate)) continue;
    const row = keyOf(layout.userId, layout.person, layout.reportDate);
    row.layoutMills = (row.layoutMills ?? 0) + layout.totalMicros / 1000;
  }
  for (const post of ledger.posted) {
    const row = keyOf(userOfPerson.get(post.person) ?? null, post.person, post.reportDate);
    row.postedMills = (row.postedMills ?? 0) + post.postedMicros / 1000;
  }

  const datedApart = [...hubWorksAll.values()]
    .filter((work) => work.kind === "shift")
    .map((work) => {
      const span = { startedAt: Date.parse(work.startedAt), endedAt: Date.parse(work.endedAt) };
      return { person: name(work.userId), startedAt: work.startedAt, endedAt: work.endedAt, dayOfWork: dayOfWork(span), reportDate: reportDateOfShift(span) };
    })
    .filter((one) => one.dayOfWork !== one.reportDate && (inRange(one.dayOfWork) || inRange(one.reportDate)))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  return {
    first: input.first,
    last: input.last,
    hubNow: input.hubNow.toISOString(),
    ruleVersion: SALE_RULE.version,
    slotsGiven: input.slots.length,
    slotsSource: input.slotsSource,
    ledgerWindows: ledger.windows,
    sales,
    days: [...days.values()].sort((a, b) => a.person.localeCompare(b.person) || a.day.localeCompare(b.day)),
    people: [...reported.values()].sort((a, b) => a.person.localeCompare(b.person)),
    datedApart,
    notes,
  };
}

// ─── reading both sides ──────────────────────────────────────────────────────

/** Reads Hub (through `db`, read-only) and the ledger (`ledger`) for [first, last] and compares. */
export async function runSaleRuleComparison(db: Database, input: {
  first: string;
  last: string;
  now: Date;
  ledger: LedgerSql;
  slots: SaleSlotProvider;
  slotsSource: SlotsSource;
}): Promise<SaleRuleComparison> {
  const exported = await readLedgerExport(input.ledger, { first: input.first, last: input.last });
  const pages = (await listVisiblePages(db)).filter((page) => exported.pages.includes(page.label)).map((page) => ({ id: page.id, label: page.label }));
  const pageIds = new Map(pages.map((page) => [page.label, page.id]));
  // A day on each side, so a work the range's edge cuts is whole (as Workboard reads it).
  const fromAt = Date.parse(mskStart(previousDay(input.first)));
  const toAt = Math.min(Date.parse(mskStart(nextDay(nextDay(input.last)))), input.now.getTime());
  // Hub's facts by the ledger's windows, so a work is cut where the ledger's is; where the ledger has no window, one more.
  const hub: HubWindow[] = [];
  const read = (from: number, to: number) => readAgentTeamSales(db, { from: new Date(from), to: new Date(to), now: input.now, pages });
  const ruled = exported.windows
    .filter((window) => window.status === "ok" && Date.parse(window.to) > fromAt && Date.parse(window.from) < toAt)
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  let covered = fromAt;
  for (const window of ruled) {
    if (Date.parse(window.from) > covered) hub.push({ window: null, answer: await read(covered, Date.parse(window.from)) });
    hub.push({ window, answer: await read(Date.parse(window.from), Date.parse(window.to)) });
    covered = Math.max(covered, Date.parse(window.to));
  }
  if (covered < toAt) hub.push({ window: null, answer: await read(covered, toAt) });
  // The days before: a layout of the range pays the sales of up to REPORTS_AFTER_DAYS days before its own (a «долёт»).
  const leadFrom = Date.parse(mskStart(shiftDay(input.first, -REPORTS_AFTER_DAYS)));
  const lead: HubWindow[] = leadFrom < fromAt ? [{ window: null, answer: await read(leadFrom, fromAt) }] : [];
  const every = [...hub, ...lead];
  const leftAt = await usersLeftAt(db, [...new Set(every.flatMap(({ answer }) => sendersOf(answer)))]);
  const slots = await input.slots.slotsFor({ from: new Date(fromAt), to: new Date(toAt) });
  const leadSlots = lead.length === 0 ? [] : await input.slots.slotsFor({ from: new Date(leadFrom), to: new Date(fromAt) });
  const days = Math.round((Date.parse(mskStart(nextDay(input.last))) - Date.parse(mskStart(input.first))) / DAY_MS);
  const workboard = await teamShiftSalesOf(db, { days, until: input.last, now: input.now, pages: "all" });
  const saleIds = [...new Set(every.flatMap(({ answer }) => answer.sales.map((sale) => Number(sale.transactionRef))))];
  return compareSaleRule({
    first: input.first,
    last: input.last,
    hubNow: input.now,
    hub,
    ledger: exported,
    leftAt,
    pageIds,
    slots,
    slotsSource: input.slotsSource,
    workboard: workboard.chatters,
    platformRefOf: new Map([...await listSalePlatformRefs(db, saleIds)].map(([id, ref]) => [String(id), ref])),
    inputs: await saleRuleInputs(db, saleIds),
    lead: { windows: lead, slots: leadSlots },
  });
}

// ─── the text ────────────────────────────────────────────────────────────────

const usd = (mills: number | null) => (mills === null ? "—" : formatUsdFromMills(mills));

function describe(view: HomeView | null, name: (userId: number) => string): string {
  if (view === null) return "—";
  const who = view.shares.map((share) => `${name(share.userId)} ${usd(share.mills)}${share.day === "" ? "" : ` (${share.day.slice(8, 10)}.${share.day.slice(5, 7)})`}`).join(" + ");
  const reason = SALE_HOME_REASON_TEXT[view.reason as SaleHomeReason] ?? view.reason;
  return `${who === "" ? view.kind : who} — ${reason}`;
}

/** The comparison as the owner reads it (Russian, Markdown tables). */
export function formatSaleRuleComparison(report: SaleRuleComparison): string {
  const personOf = new Map<number, string>();
  for (const day of report.days) if (day.userId !== null) personOf.set(day.userId, day.person);
  const name = (userId: number) => personOf.get(userId) ?? `hub:${userId}`;
  const lines: string[] = [];
  const range = report.first === report.last ? report.first : `${report.first} … ${report.last}`;
  lines.push(`# Чья продажа: правило хаба, факты ledger, расклады Генгара — ${range}`, "");
  const source = { registry: "из реестра людей, как у задачи", none: "без слотов", file: "из файла" }[report.slotsSource];
  lines.push(`Хаб прочитан ${report.hubNow} (только чтение); правило ${report.ruleVersion}; слотов графика дано: ${report.slotsGiven} (${source}).`);
  lines.push("Смена целиком в дне своей середины: продажи дня по обе стороны периода, которые держит смена периода или дом датирует периодом, тоже сравниваются.");
  for (const window of report.ledgerWindows) {
    lines.push(`Окно ledger ${window.from} … ${window.to}: ${window.status}, прочитано ${window.readAt}, смены до ${window.workTo}.`);
  }
  for (const note of report.notes) lines.push(`Заметка: ${note}`);
  lines.push("");

  const differ = report.sales.filter((one) => !one.same);
  const portBugs = report.sales.filter((one) => one.causes.includes("ПОРТ ≠ Go на фактах ledger"));
  const sum = (list: readonly SaleComparison[]) => usd(millsToNumber(sumMills(list.map((one) => one.netMills))));
  lines.push("## Итог", "");
  lines.push(`Продаж: ${report.sales.length} на ${sum(report.sales)}. Дом в хабе равен fact_homes: ${report.sales.length - differ.length}; `
    + `расходятся: ${differ.length} на ${sum(differ)}. Порт на фактах ledger ≠ Go: ${portBugs.length}. `
    + `Дом зависит от слота графика: ${report.sales.filter((one) => one.slot).length}.`, "");
  const causeKinds = new Map<string, number>();
  for (const one of differ) for (const cause of one.causes) {
    const kind = cause.replace(/:.*$/, "");
    causeKinds.set(kind, (causeKinds.get(kind) ?? 0) + 1);
  }
  for (const [kind, count] of [...causeKinds].sort((a, b) => b[1] - a[1])) lines.push(`- ${kind}: ${count}`);
  lines.push("");

  const people = new Map<string, PersonDay[]>();
  for (const day of report.days) people.set(day.person, [...(people.get(day.person) ?? []), day]);
  const total = (list: readonly PersonDay[], pick: (day: PersonDay) => number | null) => {
    const values = list.map(pick).filter((value): value is number => value !== null);
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
  };
  lines.push("## По людям за период", "", "| Человек | Workboard сейчас | Правило хаба | Факты ledger | Расклад Генгара | Пост |", "|---|---|---|---|---|---|");
  for (const [person, list] of [...people].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${person} | ${usd(total(list, (d) => d.workboardMills))} | ${usd(total(list, (d) => d.ruleMills))} | ${usd(total(list, (d) => d.factsMills))} | ${usd(total(list, (d) => d.layoutMills))} | ${usd(total(list, (d) => d.postedMills))} |`);
  }
  const all = [...people.values()].flat();
  lines.push(`| **все** | ${usd(total(all, (d) => d.workboardMills))} | ${usd(total(all, (d) => d.ruleMills))} | ${usd(total(all, (d) => d.factsMills))} | ${usd(total(all, (d) => d.layoutMills))} | ${usd(total(all, (d) => d.postedMills))} |`, "");
  lines.push("Workboard, правило и факты датируют смену днём её середины; расклад и пост — датой отчёта (день начала смены по правилу ledger).", "");

  lines.push("## Где дом в хабе не равен fact_homes", "", "| Когда (МСК) | Страница | Вид | Net | Ref | Хаб (правило) | ledger fact_homes | Генгар | Слот | Почему |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const one of differ) {
    const gengar = one.gengar.map((g) => `${g.person} ${usd(g.mills)}`).join(" + ") || "—";
    lines.push(`| ${shortTime(one.at)} | ${one.page} | ${one.kind} | ${usd(one.netMills)} | ${one.ref} | ${describe(one.hub, name)} | ${describe(one.ledger, name)} | ${gengar} | ${one.slot ? "да" : ""} | ${one.causes.join("; ")} |`);
  }
  lines.push("");

  const bySlot = report.sales.filter((one) => one.slot);
  lines.push("## Продажи, чей дом зависит от слота графика", "", "Стык смен, никто из державших не писал фану за 48 ч: дом — смена, чей слот идёт (один), иначе решение владельца.", "");
  lines.push("| Когда (МСК) | Страница | Вид | Net | Ref | Хаб | ledger | Генгар |", "|---|---|---|---|---|---|---|---|");
  for (const one of bySlot) {
    lines.push(`| ${shortTime(one.at)} | ${one.page} | ${one.kind} | ${usd(one.netMills)} | ${one.ref} | ${describe(one.hub, name)} | ${describe(one.ledger, name)} | ${one.gengar.map((g) => `${g.person} ${usd(g.mills)}`).join(" + ") || "—"} |`);
  }
  lines.push("");

  const gengarApart = report.sales.filter((one) => {
    const hubWho = (one.hub?.shares ?? []).map((share) => name(share.userId)).sort().join(",");
    const gengarWho = one.gengar.map((g) => g.person).sort().join(",");
    return (one.gengar.length > 0 && hubWho !== gengarWho) || one.missingFromLayout.length > 0;
  });
  lines.push("## Где расклад Генгара считает продажу не тому, кому правило хаба", "",
    "Расклад — последний сохранённый (не заменённый) за дату отчёта; «нет в раскладе» — правило даёт продажу человеку, у которого есть расклад за эту дату, а ни один расклад её не считает.", "",
    "| Когда (МСК) | Страница | Вид | Net | Ref | Хаб | Генгар |", "|---|---|---|---|---|---|---|");
  for (const one of gengarApart) {
    const gengar = one.gengar.length > 0 ? one.gengar.map((g) => `${g.person} ${usd(g.mills)}`).join(" + ") : `нет в раскладе ${one.missingFromLayout.join(", ")}`;
    lines.push(`| ${shortTime(one.at)} | ${one.page} | ${one.kind} | ${usd(one.netMills)} | ${one.ref} | ${describe(one.hub, name)} | ${gengar} |`);
  }
  lines.push("");

  lines.push("## По людям и дням", "", "| Человек | День | Workboard | Правило | Факты ledger | Расклад | Пост |", "|---|---|---|---|---|---|---|");
  for (const day of report.days) {
    lines.push(`| ${day.person} | ${day.day} | ${usd(day.workboardMills)} | ${usd(day.ruleMills)} | ${usd(day.factsMills)} | ${usd(day.layoutMills)} | ${usd(day.postedMills)} |`);
  }
  lines.push("");

  lines.push("## Смены, у которых дата отчёта не день середины", "", "| Человек | Начало | Конец | День середины | Дата отчёта |", "|---|---|---|---|---|");
  for (const one of report.datedApart) lines.push(`| ${one.person} | ${shortTime(one.startedAt)} | ${shortTime(one.endedAt)} | ${one.dayOfWork} | ${one.reportDate} |`);
  lines.push("");
  return lines.join("\n");
}
