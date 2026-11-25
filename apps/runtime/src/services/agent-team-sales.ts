import {
  AGENT_TEAM_SALES_WORK_AFTER_DAYS,
  AGENT_TEAM_SALES_WORK_BEFORE_DAYS,
  type AgentTeamSale,
  type AgentTeamSalesResponse,
  type AgentTeamWork,
} from "@agency_hub_core/contracts";
import {
  listActiveSaleDecisions,
  listCurrentHandinVersions,
  listCurrentReportsOfSales,
  listHandinsOfShifts,
  listLoginPeople,
  listSaleClaims,
  listSaleFacts,
  listSaleLastWriters,
  listShiftRows,
  listShiftSales,
  listUserRoles,
  versionReportDate,
  type Database,
  type ShiftRowRecord,
  type ShiftSale,
} from "@agency_hub_core/db";

import { SALE_LAST_WRITER_HOURS, dayOfWork, lastWriterQuery, readPeopleWork, workHoldsSale, type ComputedWork } from "./chatter-shifts.ts";
import { ruleMarksOf, type ClaimView, type ReportView } from "./sale-claim-rules.ts";
import { saleKindOf } from "./sale-kinds.ts";
import { reportDateOfShift } from "./shift-rows.ts";

/**
 * `agentTeamSales`: the team's work (with each work's `personCode` and `reportDate`) and the facts of every sale on
 * the key's pages in [from, to). Facts only, the same facts «Заработок» and «Разбор смены» read: a shift holds a sale
 * by `workHoldsSale`, a look-in only one to a fan its person wrote to last; the bought PPV's sender, a post tip and a
 * Campaign contribution by `listSaleFacts`; the last writer within SALE_LAST_WRITER_HOURS; the owner's decision of the
 * sale (`resolution`, `decision`). `marks` is always empty and stays for backwards compatibility with the ledger's
 * parser. Hub computes whose a sale is in `sale_homes` (`GET /api/v1/agent/sale-homes/feed`); what anyone is paid
 * stays the ledger's. Database only, read-only.
 */

const DAY_MS = 86_400_000;
const ROLES = new Set(["owner", "team_lead", "chatter"]);

function roleOf(value: string | undefined): AgentTeamWork["role"] {
  return value !== undefined && ROLES.has(value) ? value as AgentTeamWork["role"] : "chatter";
}

/** A work's name in a sale's `holders`. Pure. */
export function workRef(userId: number, work: Pick<ComputedWork, "startedAt">): string {
  return `${userId}:${new Date(work.startedAt).toISOString()}`;
}

/**
 * Which of `works` hold `sale`: every shift that `workHoldsSale`, and a look-in that does when its person last wrote to
 * the fan (`lastWriter`). Pure.
 */
export function holdersOf(
  works: ReadonlyArray<{ userId: number; work: ComputedWork }>,
  sale: { pageLabel: string; at: number },
  lastWriter: number | null,
): string[] {
  return works
    .filter(({ userId, work }) => workHoldsSale(work, sale) && (work.kind === "shift" || userId === lastWriter))
    .map(({ userId, work }) => workRef(userId, work));
}

/** The Moscow report date of one computed work: handed-in version's date, else `shifts.report_date`, else `reportDateOfShift`/`dayOfWork`. Pure. */
export function workReportDateOf(input: {
  userId: number;
  work: Pick<ComputedWork, "kind" | "startedAt" | "endedAt">;
  shiftRows: readonly ShiftRowRecord[];
  handedInDates: ReadonlyMap<number, string>;
}): string {
  if (input.work.kind === "visit") return dayOfWork(input.work);
  const row = input.shiftRows.find((one) => one.userId === input.userId && (one.state === "going" || one.state === "closed")
    && one.startedAt.getTime() <= input.work.startedAt && input.work.startedAt <= one.endedAt.getTime());
  if (row !== undefined) return input.handedInDates.get(row.id) ?? row.reportDate;
  return reportDateOfShift(input.work);
}

/** A sale's decision as the facts carry it: a split's shares are the owner's `resolution`; any kind is `decision`. */
function decided(
  decision: { kind: string; shares: ReadonlyArray<{ userId: number; percent: number }>; pot: string | null } | undefined,
  normalizeUser: (userId: number) => number,
): Pick<AgentTeamSale, "resolution" | "decision"> {
  if (decision === undefined || (decision.kind !== "split" && decision.kind !== "nobody" && decision.kind !== "pot")) return { resolution: null, decision: null };
  let resolution: AgentTeamSale["resolution"] = null;
  if (decision.kind === "split") {
    const merged = new Map<number, number>();
    for (const share of decision.shares) {
      if (share.percent <= 0) continue;
      const userId = normalizeUser(share.userId);
      merged.set(userId, (merged.get(userId) ?? 0) + share.percent);
    }
    resolution = [...merged.entries()].map(([userId, percent]) => ({ userId, percent }));
  }
  return { resolution, decision: { kind: decision.kind, pot: decision.kind === "pot" ? decision.pot : null } };
}

export async function readAgentTeamSales(
  db: Database,
  input: {
    from: Date; to: Date; now: Date; pages: ReadonlyArray<{ id: number; label: string }>;
    /** Whose work (sandbox/realm.ts): the live agency's by default; a test key's, the test team's; the homes job, both. */
    realm?: "live" | "test" | "both";
  },
): Promise<AgentTeamSalesResponse> {
  const { from, to, now } = input;
  const workFrom = new Date(from.getTime() - AGENT_TEAM_SALES_WORK_BEFORE_DAYS * DAY_MS);
  const workTo = new Date(Math.min(now.getTime(), to.getTime() + AGENT_TEAM_SALES_WORK_AFTER_DAYS * DAY_MS));
  const pageIds = input.pages.map((page) => page.id);

  // In turn, not Promise.all: `db` is the caller's transaction, one connection.
  const people = await readPeopleWork(db, { from: workFrom, to: workTo, now, pages: "all", realm: input.realm ?? "live" }, { inTurn: true });
  const sales: ShiftSale[] = pageIds.length === 0 ? [] : await listShiftSales(db, { pageIds, from, to });
  const ids = sales.map((sale) => sale.transactionId);
  const facts = await listSaleFacts(db, { transactionIds: ids });
  const lastWriters = await listSaleLastWriters(db, { hours: SALE_LAST_WRITER_HOURS, sales: lastWriterQuery(sales) });
  // Hub's own decisions of the sales (review R2b-5): the one home of «чья продажа» — the owner's disputes, the ones
  // carried over from the ledger and the ones recorded «со слов» — reach the ledger's rule here.
  const decisions = await listActiveSaleDecisions(db, ids);
  const reports = await listCurrentReportsOfSales(db, ids);
  const claims = await listSaleClaims(db, { transactionIds: ids });
  const reportViews: ReportView[] = reports.map((report) => ({
    handinId: report.handinId, shiftId: report.shiftId, userId: report.userId, version: report.version, submittedAt: report.submittedAt.getTime(), lines: report.lines,
  }));
  const marksBySale = ruleMarksOf({ reports: reportViews, claims: claims as readonly ClaimView[] });
  const factOf = new Map(facts.map((fact) => [fact.transactionId, fact]));

  const allWorks = [...people].flatMap(([userId, person]) => person.work.map((work) => ({ userId, username: person.username, work })));
  const senders = facts.flatMap((fact) => (fact.ppvSender === null ? [] : [fact.ppvSender.userId]));
  const roles = await listUserRoles(db, [...new Set([...allWorks.map((one) => one.userId), ...senders])]);
  const loginPeople = await listLoginPeople(db, input.realm ?? "live");
  const personCodeOf = new Map(loginPeople.map((row) => [row.userId, row.personCode]));
  // Normalize deactivated logins in exported decisions/marks to the person's active login (OA-004).
  const activeLoginOfPerson = new Map<number, number>();
  for (const row of loginPeople) {
    if (row.personId !== null && row.live && !activeLoginOfPerson.has(row.personId)) activeLoginOfPerson.set(row.personId, row.userId);
  }
  const loginRowOf = new Map(loginPeople.map((row) => [row.userId, row]));
  const normalizeUser = (userId: number): number => {
    const row = loginRowOf.get(userId);
    if (row === undefined || row.live || row.personId === null) return userId;
    return activeLoginOfPerson.get(row.personId) ?? userId;
  };
  const shiftRows = allWorks.some((one) => one.work.kind === "shift")
    ? await listShiftRows(db, { from: new Date(workFrom.getTime() - DAY_MS), to: new Date(workTo.getTime() + DAY_MS) })
    : [];
  const livingShiftIds = shiftRows.filter((row) => row.state === "going" || row.state === "closed").map((row) => row.id);
  const handins = await listHandinsOfShifts(db, livingShiftIds);
  const submittedHandins = [...handins.values()].filter((handin) => handin.state === "submitted");
  const currentVersions = await listCurrentHandinVersions(db, submittedHandins.map((handin) => handin.id));
  const handedInDates = new Map<number, string>();
  for (const handin of submittedHandins) {
    const version = currentVersions.get(handin.id);
    handedInDates.set(handin.shiftId, version === undefined ? handin.reportDate : versionReportDate(version, handin));
  }

  const works: AgentTeamWork[] = allWorks.map(({ userId, username, work }) => ({
    ref: workRef(userId, work),
    userId,
    username,
    role: roleOf(roles.get(userId)),
    personCode: personCodeOf.get(userId) ?? null,
    reportDate: workReportDateOf({ userId, work, shiftRows, handedInDates }),
    kind: work.kind,
    startedAt: new Date(work.startedAt).toISOString(),
    endedAt: new Date(work.endedAt).toISOString(),
    ongoing: work.ongoing,
    workedMinutes: work.workedMinutes,
    pages: [...new Set([...work.pages.keys(), ...work.messages.keys()])].sort().map((pageLabel) => {
      const since = work.salesSince.get(pageLabel);
      return { pageLabel, messages: work.messages.get(pageLabel) ?? 0, salesFrom: since === undefined ? null : new Date(since).toISOString() };
    }),
  })).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.userId - b.userId);

  const out: AgentTeamSale[] = sales.map((sale) => {
    const fact = factOf.get(sale.transactionId);
    const lastWriter = lastWriters.get(sale.transactionId) ?? null;
    const sender = fact?.ppvSender ?? null;
    return {
      transactionRef: String(sale.transactionId),
      pageLabel: sale.pageLabel,
      platform: sale.platform,
      fanRef: sale.fanRef,
      kind: saleKindOf(sale.kind),
      netMills: sale.netMills,
      occurredAt: sale.occurredAt.toISOString(),
      holders: holdersOf(allWorks, { pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() }, lastWriter),
      ppvSender: sender === null ? null : { userId: sender.userId, username: sender.username, role: roleOf(roles.get(sender.userId)) },
      ppvSentAt: fact?.ppvSentAt?.toISOString() ?? null,
      ppvWithoutAuthor: fact?.ppvWithoutAuthor ?? false,
      postTip: fact?.postTip ?? false,
      campaign: fact?.campaign ?? false,
      lastWriterUserId: lastWriter,
      writers: fact?.writers ?? [],
      // Export confirmed chatter statements and mutual agreements (`not_mine` + `agreed`, OA-005).
      marks: (marksBySale.get(sale.transactionId) ?? [])
        .filter((mark) => mark.confirmed)
        .map((mark) => ({
          userId: normalizeUser(mark.userId),
          mark: mark.mark,
          shareWithUserId: mark.shareWith === null ? null : normalizeUser(mark.shareWith),
          amountMills: mark.ownAmountMills,
          confirmed: true,
        })),
      ...decided(decisions.get(sale.transactionId), normalizeUser),
    };
  });

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    workFrom: workFrom.toISOString(),
    workTo: workTo.toISOString(),
    pages: input.pages.map((page) => page.label).sort(),
    works,
    sales: out,
    serverNow: now.toISOString(),
  };
}
