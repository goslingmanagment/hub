import type { AgentSaleDecision, AgentSaleQuestion } from "@agency_hub_core/contracts";
import {
  cancelSaleDecision,
  findSaleClaim,
  findSaleIdByPlatformRef,
  insertSaleClaim,
  insertSaleDecision,
  listActiveSaleDecisions,
  listCurrentReportsOfSales,
  listHandinNames,
  listHandinPeopleOfUsers,
  listHandinSaleFans,
  listHandinSalesByIds,
  listLoginsByPersonCode,
  listMatterPageLabels,
  listSaleClaims,
  listSaleDecisions,
  markSaleDecisionApplied,
  supersedeSaleDecision,
  updateSaleClaim,
  type Database,
  type HandinSaleRow,
  type SaleClaimRow,
  type SaleDecisionKind,
  type SaleDecisionRow,
} from "@agency_hub_core/db";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { settledShareOf } from "./sale-claim-rules.ts";
import { applySaleDecision, runSaleClaims } from "./sale-claims.ts";
import { refreshSaleHomes } from "./sale-homes.ts";

/**
 * «Чья продажа» «со слов» (review R2b-3): the agent's door for what the team's chat agent records — a decision about a
 * sale and a question about one. Hub is their only home: the same `sale_owner_decisions` and `sale_claims` the owner's
 * disputes and the records carried over from the ledger use, so a decision made anywhere is seen everywhere. A decision
 * on a sale Hub knows goes through `applySaleDecision`, the owner's own path. The lists render as the agent's memory file
 * has them (`decisionsMarkdown`, `questionsMarkdown`): the information `ledger decision list --md` gave, nothing of a
 * fan's name but what Hub's own fan rows hold.
 */

type DoorApp = Pick<AppContext, "db" | "config" | "logger">;

export interface DoorActor {
  agentKeyId: number;
  pageIds: readonly number[];
  telegramUserId: number;
  sourceRef: string;
}

type LedgerKind = AgentSaleDecision["kind"];

const DAY_MS = 86_400_000;
const money = (mills: number) => formatUsdFromMills(mills);
const notFound = () => new NotFoundError("Not found");

/** A day or a moment («2026-11-01» or an ISO time) as an instant; a day is its Moscow noon. */
function instantOf(value: string): Date {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T12:00:00+03:00`) : Date.parse(value);
  if (Number.isNaN(at)) throw new BadRequestError("A day ГГГГ-ММ-ДД or a time ISO 8601", { reason: "bad_time" });
  return new Date(at);
}

const moscow = (at: Date) => new Date(at.getTime() + 3 * 3_600_000).toISOString();
const moscowDay = (at: Date) => moscow(at).slice(0, 10);
/** «2026-11-11 18:41» by Moscow time. */
const moscowMinute = (at: Date) => moscow(at).slice(0, 16).replace("T", " ");

/** The ledger's kind as Hub keeps it. */
function hubKindOf(kind: LedgerKind): SaleDecisionKind {
  return kind === "owner" || kind === "split" ? "split" : kind === "exclude" ? "nobody" : kind;
}

/** Hub's kind in the ledger's words: whole to one is `owner`. */
function ledgerKindOf(decision: Pick<SaleDecisionRow, "kind" | "shares">): LedgerKind {
  if (decision.kind === "nobody") return "exclude";
  if (decision.kind === "split") return decision.shares.length === 1 && decision.shares[0]!.percent === 100 ? "owner" : "split";
  return decision.kind;
}

/** The kind's rules, as the ledger kept them. */
function checkShares(kind: LedgerKind, shares: ReadonlyArray<{ person: string; percent: number }>, pot: string | undefined): void {
  const refuse = (message: string) => new BadRequestError(message, { reason: "bad_decision" });
  if (kind === "pot") {
    if (shares.length > 0) throw refuse("A pot's decision has no shares: the pot shares it");
    if (pot === undefined) throw refuse("A pot's decision names the pot");
    return;
  }
  if (pot !== undefined) throw refuse("Only a pot's decision names a pot");
  if (kind === "exclude") {
    if (shares.length > 0) throw refuse("«Не считается никому» has no shares");
    return;
  }
  if (shares.length === 0) throw refuse(`A decision of kind ${kind} needs shares`);
  if (kind === "owner" && (shares.length !== 1 || shares[0]!.percent !== 100)) throw refuse("owner: one share of 100%");
  if (kind === "split" && shares.length < 2) throw refuse("split: two shares or more; a sale of one person is owner");
  if (new Set(shares.map((share) => share.person)).size !== shares.length) throw refuse("A person is in the shares twice");
  if (shares.reduce((sum, share) => sum + share.percent, 0) !== 100) throw refuse("The shares make 100%");
}

/** The sale the words name, on the key's pages: a known one, or the words that will find it. */
async function saleOf(
  db: Database,
  pageIds: readonly number[],
  words: { transactionId?: number | undefined; pageLabel?: string | undefined; transactionRef?: string | undefined; fanRef?: string | undefined; occurredAt?: string | undefined; netMills?: number | undefined },
): Promise<{ sale: HandinSaleRow | null; pageId: number | null; pageLabel: string | null; ref: Record<string, unknown> | null }> {
  const pages = await listMatterPageLabels(db);
  let id = words.transactionId ?? null;
  if (id === null && words.pageLabel !== undefined && words.transactionRef !== undefined) {
    id = await findSaleIdByPlatformRef(db, { pageLabel: words.pageLabel, transactionRef: words.transactionRef });
  }
  if (id !== null) {
    const sale = (await listHandinSalesByIds(db, [id]))[0];
    if (sale === undefined || !pageIds.includes(sale.pageId)) throw notFound();
    return { sale, pageId: sale.pageId, pageLabel: sale.pageLabel, ref: null };
  }
  if (words.transactionId !== undefined || words.transactionRef !== undefined) throw notFound();
  if (words.pageLabel === undefined) throw new BadRequestError("Name the sale, or at least its page", { reason: "no_sale" });
  const pageId = pages.idOf.get(words.pageLabel);
  if (pageId === undefined || !pageIds.includes(pageId)) throw notFound();
  // The words that will find it — never a fan's name.
  const ref = {
    pageLabel: words.pageLabel,
    ...(words.fanRef !== undefined ? { fanRef: words.fanRef } : {}),
    ...(words.occurredAt !== undefined ? { occurredAt: words.occurredAt } : {}),
    ...(words.netMills !== undefined ? { netMills: words.netMills } : {}),
  };
  return { sale: null, pageId, pageLabel: words.pageLabel, ref };
}

// ── Decisions ────────────────────────────────────────────────────────────────

/** `agentSaleDecisionAdd`: a decision «со слов»; a known sale's follows the owner's own path. */
export async function recordSaleDecision(
  app: DoorApp,
  actor: DoorActor,
  input: {
    transactionId?: number | undefined; pageLabel?: string | undefined; transactionRef?: string | undefined; fanRef?: string | undefined;
    occurredAt?: string | undefined; netMills?: number | undefined; kind: LedgerKind; shares: ReadonlyArray<{ person: string; percent: number }>;
    pot?: string | undefined; saidBy: string; saidAt: string; note?: string | undefined; supersedes?: number | undefined; answers?: number | undefined;
  },
  now: Date = new Date(),
): Promise<{ decision: AgentSaleDecision; versions: Array<{ shiftId: number; version: number }>; savedAt: string }> {
  const { db } = app;
  checkShares(input.kind, input.shares, input.pot);
  const logins = await listLoginsByPersonCode(db, input.shares.map((share) => share.person));
  const unknown = input.shares.filter((share) => (logins.get(share.person) ?? []).length === 0).map((share) => share.person);
  if (unknown.length > 0) throw new BadRequestError(`No person with the code: ${unknown.join(", ")}`, { reason: "person_unknown" });
  const shares = input.shares.map((share) => ({ userId: logins.get(share.person)![0]!, percent: share.percent }));
  const saidAt = instantOf(input.saidAt);

  // Money outside the platform names no sale: only its page.
  const found = input.kind === "off_platform"
    ? await saleOf(db, actor.pageIds, { pageLabel: input.pageLabel, fanRef: input.fanRef, occurredAt: input.occurredAt, netMills: input.netMills })
    : await saleOf(db, actor.pageIds, input);
  const sale = found.sale;

  // A sale with an active decision: the new one names it.
  const active = sale === null ? null : (await listActiveSaleDecisions(db, [sale.transactionId])).get(sale.transactionId) ?? null;
  if (active !== null && input.supersedes !== active.id) {
    throw new ConflictError(`The sale has an active decision ${active.id}: name it in supersedes (--supersedes ${active.id})`, { reason: "decision_exists" });
  }
  let replaced: SaleDecisionRow | null = null;
  if (input.supersedes !== undefined && active?.id !== input.supersedes) {
    replaced = (await listSaleDecisions(db, { ids: [input.supersedes] }))[0] ?? null;
    if (replaced === null || replaced.state !== "active") throw new ConflictError("The decision it replaces is not active", { reason: "not_active" });
  }
  let question: SaleClaimRow | null = null;
  if (input.answers !== undefined) {
    question = await findSaleClaim(db, input.answers);
    if (question === null || (question.kind !== "question" && question.kind !== "imported") || (question.state !== "owner" && question.state !== "asked")) {
      throw new ConflictError("No open question with this number", { reason: "question_closed" });
    }
  }

  const insert = {
    kind: hubKindOf(input.kind), shares: input.kind === "pot" || input.kind === "exclude" ? [] : shares, pot: input.pot ?? null,
    outcome: "said" as const, note: input.note ?? null, decidedByUserId: null, decidedAt: now, saidBy: input.saidBy, source: "agent" as const,
    ledgerDecisionId: null, ledgerRef: found.ref, saidAt, sourceLink: actor.sourceRef, agentKeyId: actor.agentKeyId,
  };
  let decisionId: number | null = null;
  let versions: Array<{ shiftId: number; version: number }> = [];
  if (sale !== null && input.kind !== "off_platform") {
    // A known sale: exactly the owner's decision of a dispute — reports, claims, home, matters.
    const open = (await listSaleClaims(db, { transactionIds: [sale.transactionId], states: ["owner", "asked", "agreed"] }))
      .filter((claim) => question === null || claim.id !== question.id);
    const people = await listHandinPeopleOfUsers(db, (await listCurrentReportsOfSales(db, [sale.transactionId])).map((report) => report.userId));
    const applied = await applySaleDecision(app, {
      transactionId: sale.transactionId,
      insert,
      open: question === null ? open : [...open, question],
      madeFor: (id) => ({ kind: "decision", decisionId: id ?? 0, transactionId: sale.transactionId, outcome: "said" }),
      amountFor: (report, net) => settledShareOf({
        netMills: net, userIds: new Set(people.get(report.userId)?.userIds ?? [report.userId]),
        decision: { kind: insert.kind, shares: insert.shares }, agreed: [],
      })?.amountMills ?? 0,
      by: { door: "telegram", actorUserId: null, agentKeyId: actor.agentKeyId, telegramMessageRef: actor.sourceRef, telegramSenderId: actor.telegramUserId },
    }, sale, now);
    decisionId = applied.decisionId;
    versions = applied.versions.map((one) => ({ shiftId: one.shiftId, version: one.version }));
    if (replaced !== null) await supersedeSaleDecision(db, { id: replaced.id, at: now });
  } else {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      const saved = await insertSaleDecision(txDb, { ...insert, transactionId: null, pageId: found.pageId, ruleHome: null }, now);
      decisionId = saved?.id ?? null;
      if (replaced !== null) await supersedeSaleDecision(txDb, { id: replaced.id, at: now });
      if (question !== null) await updateSaleClaim(txDb, question.id, { state: "decided", decisionId, closedAt: now }, now);
    });
    await runSaleClaims(app, now).catch(() => undefined);
  }
  const [wire] = await decisionWires(app, decisionId === null ? [] : [decisionId]);
  return { decision: wire!, versions, savedAt: now.toISOString() };
}

/** `agentSaleDecisionCancel`: cancelled with why; the sale's home computed again without it. */
export async function cancelSaleDecisionSaid(app: DoorApp, actor: DoorActor, input: { decisionId: number; note: string }, now: Date = new Date()) {
  const { db } = app;
  const decision = (await listSaleDecisions(db, { ids: [input.decisionId] }))[0];
  if (decision === undefined || (decision.pageId !== null && !actor.pageIds.includes(decision.pageId))) throw notFound();
  if (!(await cancelSaleDecision(db, { id: decision.id, note: input.note, at: now }))) {
    throw new ConflictError("Only an active decision is cancelled", { reason: "not_active" });
  }
  if (decision.transactionId !== null) {
    const sale = (await listHandinSalesByIds(db, [decision.transactionId]))[0];
    if (sale !== undefined) {
      const day = moscowDay(sale.occurredAt);
      const from = new Date(`${day}T00:00:00+03:00`);
      await refreshSaleHomes(db, { from, to: new Date(Math.min(now.getTime(), from.getTime() + DAY_MS)), now }).catch((error: unknown) => {
        app.logger.warn({ day, err: error instanceof Error ? error.message : String(error) }, "sale decisions: the home was not computed again; the hourly job will");
      });
    }
  }
  const [wire] = await decisionWires(app, [decision.id]);
  return { decision: wire!, versions: [], savedAt: now.toISOString() };
}

/** `agentSaleDecisionApplied`: taken into a person's post of a date. */
export async function markSaleDecisionTaken(app: DoorApp, actor: DoorActor | Pick<DoorActor, "pageIds">, input: { decisionId: number; person: string; reportDate: string }, now: Date = new Date()) {
  const { db } = app;
  const decision = (await listSaleDecisions(db, { ids: [input.decisionId] }))[0];
  if (decision === undefined || (decision.pageId !== null && !actor.pageIds.includes(decision.pageId))) throw notFound();
  const userId = (await listLoginsByPersonCode(db, [input.person])).get(input.person)?.[0];
  if (userId === undefined) throw new BadRequestError(`No person with the code: ${input.person}`, { reason: "person_unknown" });
  if (!(await markSaleDecisionApplied(db, { id: decision.id, userId, reportDate: input.reportDate, at: now }))) {
    throw new ConflictError("Only an active decision not taken in yet", { reason: "not_open" });
  }
  const [wire] = await decisionWires(app, [decision.id]);
  return { decision: wire!, versions: [], savedAt: now.toISOString() };
}

/** The decisions as the door serves them, in the order named. */
async function decisionWires(app: DoorApp, ids: readonly number[]): Promise<AgentSaleDecision[]> {
  if (ids.length === 0) return [];
  const rows = await listSaleDecisions(app.db, { ids });
  return decisionWiresOf(app, ids.map((id) => rows.find((row) => row.id === id)!).filter((row) => row !== undefined));
}

async function decisionWiresOf(app: DoorApp, decisions: readonly SaleDecisionRow[]): Promise<AgentSaleDecision[]> {
  const { db } = app;
  const userIds = decisions.flatMap((one) => [...one.shares.map((share) => share.userId), ...(one.appliedUserId === null ? [] : [one.appliedUserId])]);
  const codes = await listHandinPeopleOfUsers(db, userIds);
  const names = await listHandinNames(db, userIds);
  const pages = await listMatterPageLabels(db);
  const saleIds = decisions.flatMap((one) => (one.transactionId === null ? [] : [one.transactionId]));
  const sales = new Map((await listHandinSalesByIds(db, saleIds)).map((sale) => [sale.transactionId, sale]));
  const fans = await listHandinSaleFans(db, saleIds);
  const held = new Map<number, Array<{ userId: number; reportDate: string }>>();
  for (const report of await listCurrentReportsOfSales(db, saleIds)) {
    for (const line of report.lines) {
      if (line.transactionId === null || !saleIds.includes(line.transactionId) || (line.amountMills <= 0 && (line.claimedMills ?? 0) <= 0 && line.settled === undefined)) continue;
      held.set(line.transactionId, [...(held.get(line.transactionId) ?? []), { userId: report.userId, reportDate: report.reportDate }]);
    }
  }
  const heldCodes = await listHandinPeopleOfUsers(db, [...held.values()].flat().map((one) => one.userId));
  const successors = new Map<number, number>();
  for (const one of decisions) if (one.transactionId !== null) successors.set(one.transactionId, Math.max(successors.get(one.transactionId) ?? 0, one.id));
  const codeOf = (userId: number) => codes.get(userId)?.code ?? heldCodes.get(userId)?.code ?? null;
  return decisions.map((decision): AgentSaleDecision => {
    const ref = decision.ledgerRef ?? {};
    const sale = decision.transactionId === null ? undefined : sales.get(decision.transactionId);
    const fan = decision.transactionId === null ? undefined : fans.get(decision.transactionId);
    const holders = decision.transactionId === null ? [] : held.get(decision.transactionId) ?? [];
    let status: AgentSaleDecision["status"];
    let statusWords: string;
    if (decision.state === "cancelled") [status, statusWords] = ["cancelled", `отменено: ${decision.cancelNote ?? ""}`];
    else if (decision.state === "superseded") [status, statusWords] = ["superseded", "заменено новым решением"];
    else if (decision.appliedAt !== null) {
      status = "applied";
      statusWords = `учтено в отчёте ${decision.appliedUserId === null ? "?" : codeOf(decision.appliedUserId) ?? `#${decision.appliedUserId}`} за ${decision.appliedReportDate ?? "?"}`;
    } else if (holders.length > 0) {
      status = "held";
      statusWords = `в отчёте, сданном в системе: ${holders.map((one) => `${codeOf(one.userId) ?? `#${one.userId}`} за ${one.reportDate}`).join(", ")}`;
    } else [status, statusWords] = ["open", "открыто, ждёт отчёта"];
    const pageLabel = decision.pageId === null ? (typeof ref.pageLabel === "string" ? ref.pageLabel : null) : pages.labelOf.get(decision.pageId) ?? null;
    return {
      id: decision.id,
      transactionId: decision.transactionId,
      pageLabel,
      fan: fan === undefined
        ? { fanRef: typeof ref.fanRef === "string" ? ref.fanRef : null, name: null, username: null }
        : { fanRef: fan.fanRef, name: fan.name, username: fan.username },
      netMills: sale?.netMills ?? (typeof ref.netMills === "number" ? ref.netMills : null),
      occurredAt: sale?.occurredAt.toISOString() ?? (typeof ref.occurredAt === "string" && !Number.isNaN(Date.parse(ref.occurredAt)) ? new Date(ref.occurredAt).toISOString() : null),
      kind: ledgerKindOf(decision),
      shares: decision.shares.map((share) => ({ person: codeOf(share.userId), name: names.get(share.userId) ?? `#${share.userId}`, percent: share.percent })),
      pot: decision.pot,
      saidBy: decision.saidBy ?? (decision.source === "dispute" ? "владелец" : null),
      saidAt: (decision.saidAt ?? decision.decidedAt).toISOString(),
      sourceLink: decision.sourceLink,
      note: decision.note,
      source: decision.source,
      status,
      statusWords,
      supersededBy: decision.state === "superseded" && decision.transactionId !== null && (successors.get(decision.transactionId) ?? 0) > decision.id
        ? successors.get(decision.transactionId)! : null,
    };
  });
}

/**
 * The decisions as the agent's memory file has them, one bullet each — the information `ledger decision list --md` gave:
 *   - **<fan> / <ref>** (<page>). <the sale, net, when>. <whose>: <why>. Источник: <who>, <when>, <link>. Статус: <…>.
 * Pure.
 */
export function decisionsMarkdown(decisions: readonly AgentSaleDecision[]): string {
  const lines = decisions.map((one) => {
    const fan = [one.fan.name, one.fan.username ?? one.fan.fanRef].filter((part, at, all) => part !== null && all.indexOf(part) === at).join(" / ") || "фан?";
    const what = [
      one.transactionId === null ? "Продажи ещё нет" : `Продажа ${one.transactionId}`,
      one.netMills === null ? null : `нетто ${money(one.netMills)}`,
      one.occurredAt === null ? null : moscowMinute(new Date(one.occurredAt)),
    ].filter((part): part is string => part !== null).join(", ");
    const shares = one.shares.map((share) => `${share.person ?? share.name} ${share.percent}%`).join(", ");
    const whose = one.kind === "owner" ? `Вся продажа — ${one.shares[0]?.person ?? one.shares[0]?.name ?? "?"}`
      : one.kind === "split" ? `Делится: ${shares}`
        : one.kind === "pot" ? `В общак ${one.pot ?? ""}`.trim()
          : one.kind === "off_platform" ? `Мимо платформы, в отчёт: ${shares}`
            : "Не считается никому";
    const note = one.note === null ? "" : `: ${one.note.split(/\s+/u).join(" ").replace(/\.$/u, "")}`;
    const source = [one.saidBy ?? "?", one.saidAt === null ? "?" : moscowDay(new Date(one.saidAt)), ...(one.sourceLink === null ? [] : [one.sourceLink])].join(", ");
    return `- **${fan}** (${one.pageLabel ?? "?"}). ${what}. ${whose}${note}. Источник: ${source}. Статус: ${one.statusWords}. (№${one.id})`;
  });
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** `agentSaleDecisions`: the decisions on the key's pages, every source, the oldest first. */
export async function listSaleDecisionsSaid(app: DoorApp, input: { pageIds: readonly number[]; open: boolean; since?: string | undefined; format: "json" | "md" }, now: Date = new Date()) {
  const rows = (await listSaleDecisions(app.db, {
    ...(input.since !== undefined ? { since: new Date(`${input.since}T00:00:00+03:00`) } : {}),
    ...(input.open ? { open: true } : {}),
    limit: 2000,
  })).filter((one) => {
    if (one.pageId !== null) return input.pageIds.includes(one.pageId);
    return false;
  }).reverse();
  let decisions = await decisionWiresOf(app, rows);
  if (input.open) decisions = decisions.filter((one) => one.status === "open");
  return { decisions, markdown: input.format === "md" ? decisionsMarkdown(decisions) : null, serverNow: now.toISOString() };
}

// ── Questions ────────────────────────────────────────────────────────────────

/** `agentSaleQuestionAsk`: a question about whose a sale is, of the owner or of the chatters. */
export async function askSaleQuestion(
  app: DoorApp,
  actor: DoorActor,
  input: {
    transactionId?: number | undefined; pageLabel?: string | undefined; transactionRef?: string | undefined; fanRef?: string | undefined;
    occurredAt?: string | undefined; netMills?: number | undefined; askedOf: "owner" | "chatters"; who?: string | undefined;
    people: readonly string[]; question: string; note?: string | undefined; askedAt: string;
  },
  now: Date = new Date(),
): Promise<{ question: AgentSaleQuestion; savedAt: string }> {
  const { db } = app;
  const found = await saleOf(db, actor.pageIds, input);
  const logins = await listLoginsByPersonCode(db, input.people);
  const unknown = input.people.filter((code) => (logins.get(code) ?? []).length === 0);
  if (unknown.length > 0) throw new BadRequestError(`No person with the code: ${unknown.join(", ")}`, { reason: "person_unknown" });
  const people = input.people.map((code) => logins.get(code)![0]!);
  const askedAt = instantOf(input.askedAt);
  const owner = input.askedOf === "owner";
  const inserted = await insertSaleClaim(db, {
    transactionId: found.sale?.transactionId ?? null,
    pageId: found.pageId,
    kind: "question",
    claimantUserId: people[0] ?? null,
    claimantHandinId: null,
    claimantVersion: null,
    statement: null,
    shareWithUserId: null,
    claimantNote: null,
    claimedAt: askedAt,
    sideUserId: people[1] ?? null,
    sideShiftId: null,
    // Asked of the owner: the owner's dispute at once; of the chatters: theirs to settle, no matter.
    state: owner ? "owner" : "asked",
    escalatedAt: owner ? now : null,
    escalatedWhy: owner ? "question" : null,
    question: input.note === undefined ? input.question : `${input.question}\n${input.note}`,
    whoText: input.who ?? null,
    ledgerRef: found.ref,
    askedOf: input.askedOf,
    sourceLink: actor.sourceRef,
    askedByAgentKeyId: actor.agentKeyId,
  }, now);
  if (inserted === null) throw new ConflictError("The question was not written", { reason: "not_written" });
  await runSaleClaims(app, now).catch(() => undefined);
  const [wire] = await questionWires(app, [inserted.id]);
  return { question: wire!, savedAt: now.toISOString() };
}

async function openQuestion(app: DoorApp, actor: Pick<DoorActor, "pageIds">, questionId: number): Promise<SaleClaimRow> {
  const question = await findSaleClaim(app.db, questionId);
  if (question === null || (question.kind !== "question" && question.kind !== "imported") || (question.pageId !== null && !actor.pageIds.includes(question.pageId))) throw notFound();
  if (question.state !== "owner" && question.state !== "asked") throw new ConflictError("This question is already closed", { reason: "question_closed" });
  return question;
}

/** `agentSaleQuestionAnswer`: closed with an answer in words (an answer that decides the sale is a decision). */
export async function answerSaleQuestion(app: DoorApp, actor: DoorActor, input: { questionId: number; answer: string }, now: Date = new Date()) {
  const question = await openQuestion(app, actor, input.questionId);
  await updateSaleClaim(app.db, question.id, {
    state: "decided", answerText: input.answer, closedAt: now, answeredByAgentKeyId: actor.agentKeyId, answerDoor: "telegram", answerRef: actor.sourceRef,
  }, now);
  await runSaleClaims(app, now).catch(() => undefined);
  const [wire] = await questionWires(app, [question.id]);
  return { question: wire!, savedAt: now.toISOString() };
}

/** `agentSaleQuestionClose`: closed without an answer, with why. */
export async function closeSaleQuestion(app: DoorApp, actor: DoorActor, input: { questionId: number; note: string }, now: Date = new Date()) {
  const question = await openQuestion(app, actor, input.questionId);
  await updateSaleClaim(app.db, question.id, { state: "decided", closeNote: input.note, closedAt: now }, now);
  await runSaleClaims(app, now).catch(() => undefined);
  const [wire] = await questionWires(app, [question.id]);
  return { question: wire!, savedAt: now.toISOString() };
}

async function questionWires(app: DoorApp, ids: readonly number[]): Promise<AgentSaleQuestion[]> {
  if (ids.length === 0) return [];
  const rows = await listSaleClaims(app.db, { ids: [...ids] });
  return questionWiresOf(app, ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is SaleClaimRow => row !== undefined));
}

async function questionWiresOf(app: DoorApp, questions: readonly SaleClaimRow[]): Promise<AgentSaleQuestion[]> {
  const { db } = app;
  const pages = await listMatterPageLabels(db);
  const saleIds = questions.flatMap((one) => (one.transactionId === null ? [] : [one.transactionId]));
  const sales = new Map((await listHandinSalesByIds(db, saleIds)).map((sale) => [sale.transactionId, sale]));
  const fans = await listHandinSaleFans(db, saleIds);
  return questions.map((question): AgentSaleQuestion => {
    const ref = question.ledgerRef ?? {};
    const sale = question.transactionId === null ? undefined : sales.get(question.transactionId);
    const fan = question.transactionId === null ? undefined : fans.get(question.transactionId);
    const open = question.state === "owner" || question.state === "asked";
    return {
      id: question.id,
      transactionId: question.transactionId,
      pageLabel: question.pageId === null ? (typeof ref.pageLabel === "string" ? ref.pageLabel : null) : pages.labelOf.get(question.pageId) ?? null,
      fan: fan === undefined ? { fanRef: typeof ref.fanRef === "string" ? ref.fanRef : null, name: null, username: null } : { fanRef: fan.fanRef, name: fan.name, username: fan.username },
      netMills: sale?.netMills ?? (typeof ref.netMills === "number" ? ref.netMills : null),
      askedOf: question.askedOf ?? (typeof ref.askedOf === "string" && ref.askedOf === "chatters" ? "chatters" : "owner"),
      who: question.whoText,
      question: question.question ?? "",
      askedAt: question.claimedAt.toISOString(),
      sourceLink: question.sourceLink,
      status: open ? "open" : question.decisionId !== null ? "decided" : question.answerText !== null || typeof ref.answer === "string" ? "answered" : "closed",
      decisionId: question.decisionId,
      answer: question.answerText ?? (typeof ref.answer === "string" ? ref.answer : null),
      ledgerQuestionId: question.ledgerQuestionId,
    };
  });
}

/**
 * The open questions as the agent's memory file has them, by whom they wait for — what `ledger question list --md` gave:
 *   ## Ждёт владельца / ## Решают сами чаттеры
 *   - **<fan>** (<page>). Нетто <net>. <question> Договориться: <who>. Спросили: <when>, <link>. (№<id>)
 * Pure.
 */
export function questionsMarkdown(questions: readonly AgentSaleQuestion[]): string {
  const sentence = (text: string) => {
    const one = text.split(/\s+/u).join(" ").trim();
    return one === "" || /[.?!…]$/u.test(one) ? one : `${one}.`;
  };
  const groups: string[] = [];
  for (const [of, title] of [["owner", "Ждёт владельца"], ["chatters", "Решают сами чаттеры"]] as const) {
    const lines = questions.filter((one) => one.askedOf === of && one.status === "open").map((one) => {
      const fan = [one.fan.name, one.fan.username ?? one.fan.fanRef].filter((part, at, all) => part !== null && all.indexOf(part) === at).join(" / ") || "фан?";
      const parts = [`- **${fan}** (${one.pageLabel ?? "?"}).`];
      if (one.netMills !== null) parts.push(`Нетто ${money(one.netMills)}.`);
      parts.push(sentence(one.question));
      if (one.who !== null) parts.push(sentence(`Договориться: ${one.who}`));
      parts.push(`Спросили: ${[moscowDay(new Date(one.askedAt)), ...(one.sourceLink === null ? [] : [one.sourceLink])].join(", ")}. (№${one.id})`);
      return parts.join(" ");
    });
    if (lines.length > 0) groups.push(`## ${title}\n\n${lines.join("\n")}\n`);
  }
  return groups.join("\n");
}

/** `agentSaleQuestions`: the questions on the key's pages (carried over and asked here), the oldest first. */
export async function listSaleQuestionsSaid(app: DoorApp, input: { pageIds: readonly number[]; open: boolean; format: "json" | "md" }, now: Date = new Date()) {
  const rows = (await listSaleClaims(app.db, { kinds: ["question", "imported"], ...(input.open ? { states: ["owner", "asked"] as const } : {}), limit: 2000 }))
    .filter((one) => one.pageId !== null && input.pageIds.includes(one.pageId))
    .reverse();
  const questions = await questionWiresOf(app, rows);
  return { questions, markdown: input.format === "md" ? questionsMarkdown(questions) : null, serverNow: now.toISOString() };
}
