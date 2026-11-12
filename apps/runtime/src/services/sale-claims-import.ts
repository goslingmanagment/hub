import {
  insertSaleClaim,
  insertSaleDecision,
  listLoginsByPersonCode,
  listSaleCandidates,
  listSaleDecisions,
  listVisiblePages,
  type Database,
  type SaleCandidate,
} from "@agency_hub_core/db";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import { millsOf } from "./ledger-payouts.ts";

/**
 * The one-off carry-over of the ledger's «чья продажа» records (package G): its
 * `sale_decisions` become the owner's decisions in Hub (`sale_owner_decisions`,
 * source ledger) and its `sale_questions` disputes (`sale_claims`, kind
 * imported: an open question the owner's, an answered one history), each tied
 * to `transactions.id` where the ledger's words allow it — its own transaction
 * reference, else exactly one sale of the page at that minute (the fan and the
 * net when written), else exactly one sale of the fan with that net in the ten
 * days before it was said — and else marked «привязать» for the owner. The
 * ledger's tables stay as they are: nothing is deleted or changed there.
 *
 * The input is the ledger's own answer of `ledger sql -json "SELECT * FROM
 * sale_decisions"` (and of sale_questions) as files: the agent's read, no
 * second door into the ledger. A dry run reads Hub only and writes nothing;
 * the import is idempotent by the ledger's ids.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** `ledger sql -json`'s answer: columns and rows. */
export interface LedgerSqlAnswer {
  columns: string[];
  rows: unknown[][];
}

export function rowsOf(answer: unknown): Array<Record<string, unknown>> {
  const parsed = answer as Partial<LedgerSqlAnswer>;
  if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) throw new Error("not an answer of `ledger sql -json`: columns and rows expected");
  return parsed.rows.map((row) => Object.fromEntries(parsed.columns!.map((column, at) => [column, row[at] ?? null])));
}

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const int = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : null);

/** A ledger record's words about its sale. */
export interface LedgerSaleRef {
  pageLabel: string | null;
  fanRef: string | null;
  fanName: string | null;
  transactionRef: string | null;
  /** The net in mills (the ledger keeps micro-dollars). */
  netMills: number | null;
  occurredAt: string | null;
  saidAt: string | null;
  note: string | null;
}

export function saleRefOf(row: Record<string, unknown>, saidAtColumn: string): LedgerSaleRef {
  const micros = int(row.net_micros);
  return {
    pageLabel: str(row.page_label),
    fanRef: str(row.fan_ref),
    fanName: str(row.fan_name),
    transactionRef: str(row.transaction_ref),
    netMills: micros === null ? null : millsOf(micros),
    occurredAt: str(row.occurred_at),
    saidAt: str(row[saidAtColumn]),
    note: str(row.note),
  };
}

/** A ledger day or moment («2026-11-01» or «2026-11-01T10:13:00+03:00») as an instant; a day is its Moscow noon. */
function instantOf(value: string | null): Date | null {
  if (value === null) return null;
  const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T12:00:00+03:00`) : Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

export type SaleMatch = { kind: "found"; sale: SaleCandidate; how: string } | { kind: "link"; why: string };

/** Which Hub sale a ledger record means, by its words; else why it waits for the owner («привязать»). */
export async function matchSale(db: Database, ref: LedgerSaleRef): Promise<SaleMatch> {
  if (ref.transactionRef !== null && /^\d+$/.test(ref.transactionRef)) {
    const rows = await db.execute<Record<string, unknown>>(sql`
      select t.id, t.platform_account_id as page_id, p.label, p.platform, t.occurred_at, t.creator_net_amount_mills as net, t.canonical_type::text as kind,
        f.platform_user_id as fan_ref, coalesce(f.display_name, f.username) as fan_name, f.username as fan_username
      from transactions t join pages p on p.id = t.platform_account_id left join fans f on f.id = t.fan_id
      where t.id = ${Number(ref.transactionRef)}`);
    const row = rows.rows[0];
    if (row !== undefined) {
      return {
        kind: "found", how: "по ссылке ledger на продажу",
        sale: {
          transactionId: Number(row.id), pageId: Number(row.page_id), pageLabel: String(row.label), platform: String(row.platform), occurredAt: new Date(String(row.occurred_at)),
          netMills: Number(row.net), kind: String(row.kind), fanRef: row.fan_ref === null ? null : String(row.fan_ref),
          fanName: row.fan_name === null ? null : String(row.fan_name), fanUsername: row.fan_username === null ? null : String(row.fan_username),
        },
      };
    }
  }
  if (ref.pageLabel === null) return { kind: "link", why: "страница не названа" };
  const at = instantOf(ref.occurredAt);
  if (at !== null) {
    // The ledger writes the minute: the sale within it (two minutes either side), of the fan and the net when written.
    const near = await listSaleCandidates(db, {
      pageLabel: ref.pageLabel, fan: ref.fanRef, netMills: ref.netMills, from: new Date(at.getTime() - 2 * MINUTE_MS), to: new Date(at.getTime() + 3 * MINUTE_MS), around: at, limit: 5,
    });
    if (near.length === 1) return { kind: "found", sale: near[0]!, how: "по странице, минуте, фану и сумме" };
    if (near.length > 1) return { kind: "link", why: `в эту минуту ${near.length} подходящих продаж` };
  }
  if (ref.fanRef !== null && ref.netMills !== null) {
    const said = instantOf(ref.saidAt) ?? at;
    if (said !== null) {
      const around = await listSaleCandidates(db, {
        pageLabel: ref.pageLabel, fan: ref.fanRef, netMills: ref.netMills, from: new Date(said.getTime() - 10 * DAY_MS), to: new Date(said.getTime() + DAY_MS), around: said, limit: 5,
      });
      if (around.length === 1) return { kind: "found", sale: around[0]!, how: "по фану и сумме за 10 дней до слова" };
      if (around.length > 1) return { kind: "link", why: `у фана ${around.length} продаж на эту сумму за 10 дней` };
    }
  }
  if (at === null && ref.netMills === null) return { kind: "link", why: "ни времени, ни суммы" };
  return { kind: "link", why: at === null ? "нет времени продажи, по фану и сумме не нашлась" : "в эту минуту такой продажи нет" };
}

// ── The plan ─────────────────────────────────────────────────────────────────

export interface DecisionPlan {
  ledgerId: number;
  ref: LedgerSaleRef;
  status: string;
  kind: "split" | "nobody" | "pot" | null;
  shares: Array<{ userId: number; percent: number; person: string }>;
  pot: string | null;
  saidBy: string | null;
  match: SaleMatch;
  /** The sale's home in Hub now (sale_homes), when found. */
  homeNow: { home: string; reason: string } | null;
  /** Why it is not carried over; null — it is. */
  skip: string | null;
  known: boolean;
}

export interface QuestionPlan {
  ledgerId: number;
  ref: LedgerSaleRef;
  status: string;
  question: string;
  askedOf: string | null;
  who: string | null;
  people: Array<{ userId: number; name: string }>;
  decisionLedgerId: number | null;
  answer: string | null;
  match: SaleMatch;
  known: boolean;
}

export interface ImportPlan {
  decisions: DecisionPlan[];
  questions: QuestionPlan[];
}

/** Every record of the files, each with the sale found or «привязать», read from Hub only. */
export async function planImport(db: Database, input: { decisions: unknown; questions: unknown }): Promise<ImportPlan> {
  const decisionRows = rowsOf(input.decisions);
  const questionRows = rowsOf(input.questions);
  const codes = new Set<string>();
  for (const row of decisionRows) {
    try {
      for (const share of JSON.parse(String(row.shares ?? "[]")) as Array<{ person?: unknown }>) if (typeof share.person === "string") codes.add(share.person);
    } catch {
      // a broken shares cell is said below
    }
  }
  const logins = await listLoginsByPersonCode(db, [...codes]);
  const known = new Set((await listSaleDecisions(db, { limit: 5000 })).flatMap((one) => (one.ledgerDecisionId === null ? [] : [one.ledgerDecisionId])));
  const knownQuestions = new Set((await db.execute<{ id: number | string }>(sql`select ledger_question_id as id from sale_claims where ledger_question_id is not null`)).rows.map((row) => Number(row.id)));
  const people = (await db.execute<{ code: string; name: string; user_id: number | string }>(sql`
    select p.code, p.display_name as name, min(l.user_id) as user_id from people p join person_logins l on l.person_id = p.id group by p.code, p.display_name`)).rows;

  const homeOf = async (transactionId: number) => {
    const found = await db.execute<{ home: string; reason: string }>(sql`select home, reason from sale_homes where transaction_id = ${transactionId}`);
    return found.rows[0] ?? null;
  };

  const decisions: DecisionPlan[] = [];
  for (const row of decisionRows) {
    const ledgerId = int(row.id) ?? 0;
    const ref = saleRefOf(row, "said_at");
    const status = String(row.status ?? "");
    const kindWord = String(row.kind ?? "");
    let shares: Array<{ person?: unknown; percent?: unknown }> = [];
    let skip: string | null = null;
    try {
      shares = JSON.parse(String(row.shares ?? "[]")) as typeof shares;
    } catch {
      skip = "доли не читаются";
    }
    const mapped = shares.map((share) => {
      const person = String(share.person ?? "");
      return { person, percent: int(share.percent) ?? 0, userId: logins.get(person)?.[0] ?? null };
    });
    if (status === "cancelled") skip = "отменено в ledger";
    const missing = mapped.filter((share) => share.userId === null).map((share) => share.person);
    if (missing.length > 0) skip = `в Hub нет человека: ${missing.join(", ")}`;
    const kind = kindWord === "owner" || kindWord === "split" ? "split" as const : kindWord === "exclude" ? "nobody" as const : kindWord === "pot" ? "pot" as const : null;
    if (kind === null && skip === null) skip = kindWord === "off_platform" ? "мимо площадки: это не решение о продаже" : `вид «${kindWord}» неизвестен`;
    if (kind === "split" && skip === null && mapped.reduce((sum, share) => sum + share.percent, 0) !== 100) skip = "доли не дают 100%";
    const match = await matchSale(db, ref);
    decisions.push({
      ledgerId, ref, status, kind, shares: mapped.filter((share) => share.userId !== null).map((share) => ({ userId: share.userId!, percent: share.percent, person: share.person })),
      pot: str(row.pot), saidBy: str(row.said_by), match, homeNow: match.kind === "found" ? await homeOf(match.sale.transactionId) : null, skip,
      known: known.has(ledgerId),
    });
  }

  const questions: QuestionPlan[] = [];
  for (const row of questionRows) {
    const ledgerId = int(row.id) ?? 0;
    const ref = saleRefOf(row, "asked_at");
    const who = str(row.who);
    // «Аня и Боря»: the people a question names, in the order named, by the registry's name or code, or the one name a
    // short form begins (Саша → Александра).
    const named = who === null ? [] : who.split(/\s+и\s+|\s*,\s*/u).map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
    const found = named.flatMap((part) => {
      const exact = people.filter((one) => one.name.toLowerCase() === part || one.code.toLowerCase() === part);
      const prefix = part.length >= 3 ? people.filter((one) => one.name.toLowerCase().startsWith(part)) : [];
      const one = exact[0] ?? (prefix.length === 1 ? prefix[0] : undefined);
      return one === undefined ? [] : [{ userId: Number(one.user_id), name: one.name }];
    });
    questions.push({
      ledgerId, ref, status: String(row.status ?? ""), question: str(row.question) ?? "", askedOf: str(row.asked_of), who, people: found,
      decisionLedgerId: int(row.decision_id), answer: str(row.answer), match: await matchSale(db, ref), known: knownQuestions.has(ledgerId),
    });
  }
  return { decisions, questions };
}

// ── The dry run's words ──────────────────────────────────────────────────────

function refWords(ref: LedgerSaleRef): string {
  return [ref.pageLabel ?? "?", ref.fanRef ?? ref.fanName ?? "фан?", ref.netMills === null ? "сумма?" : formatUsdFromMills(ref.netMills), ref.occurredAt ?? "время?"].join(" · ");
}

function matchWords(match: SaleMatch): string {
  return match.kind === "found" ? `продажа ${match.sale.transactionId} (${match.how})` : `ПРИВЯЗАТЬ: ${match.why}`;
}

/** The plan as the dry run prints it: every record, the sale found or «привязать», what is carried over. */
export function formatImportPlan(plan: ImportPlan): string {
  const out: string[] = [];
  const found = plan.decisions.filter((one) => one.skip === null && one.match.kind === "found").length;
  out.push(`Решения ledger (sale_decisions): ${plan.decisions.length}; с продажей ${found}, привязать ${plan.decisions.filter((one) => one.skip === null && one.match.kind === "link").length}, не переносятся ${plan.decisions.filter((one) => one.skip !== null).length}`);
  for (const one of plan.decisions) {
    const what = one.kind === "nobody" ? "никому" : one.kind === "pot" ? `в общак ${one.pot ?? ""}` : one.shares.map((share) => `${share.person} ${share.percent}%`).join(" + ");
    const home = one.homeNow === null ? "" : ` · сейчас: ${one.homeNow.home}/${one.homeNow.reason}`;
    out.push(`  №${one.ledgerId} [${one.status}] ${refWords(one.ref)} → ${what || "?"} · сказал ${one.saidBy ?? "?"}`);
    out.push(`      ${one.skip !== null ? `НЕ ПЕРЕНОСИТСЯ: ${one.skip}` : matchWords(one.match)}${home}${one.known ? " · уже перенесено" : ""}`);
  }
  const open = plan.questions.filter((one) => one.status === "open");
  out.push("");
  out.push(`Вопросы ledger (sale_questions): ${plan.questions.length}; открытых ${open.length} (станут спорами у владельца), остальные — история`);
  for (const one of plan.questions) {
    const whom = one.people.length > 0 ? `люди: ${one.people.map((person) => person.name).join(" и ")}` : one.who === null ? "люди не названы" : `люди не найдены: «${one.who}»`;
    out.push(`  №${one.ledgerId} [${one.status}${one.decisionLedgerId === null ? "" : `, решение №${one.decisionLedgerId}`}] ${refWords(one.ref)} · ${whom}`);
    out.push(`      ${matchWords(one.match)}${one.known ? " · уже перенесено" : ""}`);
  }
  return out.join("\n");
}

// ── The import ───────────────────────────────────────────────────────────────

/**
 * What Hub keeps of a ledger record's words about its sale: enough to find it (page, fan reference, the ledger's own
 * reference, net, moment, when said), never the fan's name; the ledger's note goes to the decision's own note, the
 * ledger's ids to their columns (review R2b-3c).
 */
function keptRef(ref: LedgerSaleRef): Record<string, unknown> {
  return { pageLabel: ref.pageLabel, fanRef: ref.fanRef, transactionRef: ref.transactionRef, netMills: ref.netMills, occurredAt: ref.occurredAt, saidAt: ref.saidAt };
}

/** Writes the plan: decisions first (the questions answered by one point to it), then the questions. Idempotent. */
export async function applyImport(db: Database, plan: ImportPlan, now: Date): Promise<{ decisions: number; questions: number; days: string[] }> {
  const pages = new Map((await listVisiblePages(db)).map((page) => [page.label, page.id]));
  const hubDecisionOf = new Map<number, number>();
  const days = new Set<string>();
  let decisions = 0;
  let questions = 0;
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    for (const one of plan.decisions) {
      if (one.skip !== null || one.kind === null) continue;
      const sale = one.match.kind === "found" ? one.match.sale : null;
      const saved = await insertSaleDecision(txDb, {
        transactionId: sale?.transactionId ?? null,
        pageId: sale?.pageId ?? (one.ref.pageLabel === null ? null : pages.get(one.ref.pageLabel) ?? null),
        kind: one.kind,
        shares: one.kind === "split" ? one.shares.map((share) => ({ userId: share.userId, percent: share.percent })) : [],
        pot: one.kind === "pot" ? one.pot ?? "pot" : null,
        outcome: "imported",
        ruleHome: one.homeNow?.home ?? null,
        note: one.ref.note === null ? null : one.ref.note.slice(0, 4000),
        decidedByUserId: null,
        decidedAt: instantOf(one.ref.saidAt) ?? now,
        saidBy: one.saidBy,
        source: "ledger",
        ledgerDecisionId: one.ledgerId,
        ledgerRef: { ...keptRef(one.ref), status: one.status, ...(sale === null && one.match.kind === "link" ? { why: one.match.why } : {}) },
      }, now);
      if (saved !== null) {
        decisions += 1;
        hubDecisionOf.set(one.ledgerId, saved.id);
        if (sale !== null) days.add(new Date(sale.occurredAt.getTime() + 3 * 3_600_000).toISOString().slice(0, 10));
      }
    }
    const existing = await listSaleDecisions(txDb, { limit: 5000 });
    for (const decision of existing) if (decision.ledgerDecisionId !== null && !hubDecisionOf.has(decision.ledgerDecisionId)) hubDecisionOf.set(decision.ledgerDecisionId, decision.id);
    for (const one of plan.questions) {
      const sale = one.match.kind === "found" ? one.match.sale : null;
      const open = one.status === "open";
      const at = instantOf(one.ref.saidAt) ?? now;
      const inserted = await insertSaleClaim(txDb, {
        transactionId: sale?.transactionId ?? null,
        pageId: sale?.pageId ?? (one.ref.pageLabel === null ? null : pages.get(one.ref.pageLabel) ?? null),
        kind: "imported",
        claimantUserId: one.people[0]?.userId ?? null,
        claimantHandinId: null,
        claimantVersion: null,
        statement: null,
        shareWithUserId: null,
        claimantNote: null,
        claimedAt: at,
        sideUserId: one.people[1]?.userId ?? null,
        sideShiftId: null,
        state: open ? "owner" : "decided",
        escalatedAt: open ? now : null,
        escalatedWhy: open ? "imported" : null,
        ledgerQuestionId: one.ledgerId,
        question: one.question.slice(0, 2000),
        whoText: one.who,
        ledgerRef: { ...keptRef(one.ref), askedOf: one.askedOf, ...(one.answer === null ? {} : { answer: one.answer }), ...(sale === null && one.match.kind === "link" ? { why: one.match.why } : {}) },
        decisionId: one.decisionLedgerId === null ? null : hubDecisionOf.get(one.decisionLedgerId) ?? null,
        closedAt: open ? null : now,
      }, now);
      if (inserted !== null) questions += 1;
    }
  });
  return { decisions, questions, days: [...days].sort() };
}
