import {
  AGENT_TEAM_SALES_WORK_AFTER_DAYS,
  AGENT_TEAM_SALES_WORK_BEFORE_DAYS,
  type AgentTeamSale,
  type AgentTeamSalesResponse,
  type AgentTeamWork,
} from "@agency_hub_core/contracts";
import {
  listActiveSaleDecisions,
  listSaleFacts,
  listSaleLastWriters,
  listShiftSales,
  listUserRoles,
  type Database,
  type ShiftSale,
} from "@agency_hub_core/db";

import { SALE_LAST_WRITER_HOURS, lastWriterQuery, readPeopleWork, workHoldsSale, type ComputedWork } from "./chatter-shifts.ts";
import { saleKindOf } from "./chatter-stats.ts";

/**
 * `agentTeamSales` (ledger release 2): the team's work and the facts of every
 * sale on the key's pages in [from, to), for the agency ledger's split rules.
 * Facts only, the same facts «Заработок» and «Разбор смены» read: a shift
 * holds a sale by `workHoldsSale`, a look-in only one to a fan its person wrote
 * to last; the bought PPV's sender, a post tip and a Campaign contribution by
 * `listSaleFacts`; the last writer within SALE_LAST_WRITER_HOURS; the owner's
 * decision of the sale (`resolution`, `decision`). `marks` is always empty: the
 * old shift-report tables that fed it hold nothing and are read no more; the
 * field stays for the ledger's parser. Whose a sale is, and what anyone is
 * paid, the ledger decides (owner, 2026-11-08). Database only, read-only.
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

/** A sale's decision as the facts carry it: a split's shares are the owner's `resolution`; any kind is `decision`. */
function decided(
  decision: { kind: string; shares: ReadonlyArray<{ userId: number; percent: number }>; pot: string | null } | undefined,
): Pick<AgentTeamSale, "resolution" | "decision"> {
  if (decision === undefined || (decision.kind !== "split" && decision.kind !== "nobody" && decision.kind !== "pot")) return { resolution: null, decision: null };
  const resolution = decision.kind === "split" ? decision.shares.filter((share) => share.percent > 0).map((share) => ({ userId: share.userId, percent: share.percent })) : null;
  return { resolution, decision: { kind: decision.kind, pot: decision.kind === "pot" ? decision.pot : null } };
}

export async function readAgentTeamSales(
  db: Database,
  input: { from: Date; to: Date; now: Date; pages: ReadonlyArray<{ id: number; label: string }> },
): Promise<AgentTeamSalesResponse> {
  const { from, to, now } = input;
  const workFrom = new Date(from.getTime() - AGENT_TEAM_SALES_WORK_BEFORE_DAYS * DAY_MS);
  const workTo = new Date(Math.min(now.getTime(), to.getTime() + AGENT_TEAM_SALES_WORK_AFTER_DAYS * DAY_MS));
  const pageIds = input.pages.map((page) => page.id);

  // In turn, not Promise.all: `db` is the caller's transaction, one connection.
  const people = await readPeopleWork(db, { from: workFrom, to: workTo, now, pages: "all" }, { inTurn: true });
  const sales: ShiftSale[] = pageIds.length === 0 ? [] : await listShiftSales(db, { pageIds, from, to });
  const ids = sales.map((sale) => sale.transactionId);
  const facts = await listSaleFacts(db, { transactionIds: ids });
  const lastWriters = await listSaleLastWriters(db, { hours: SALE_LAST_WRITER_HOURS, sales: lastWriterQuery(sales) });
  // Hub's own decisions of the sales (review R2b-5): the one home of «чья продажа» — the owner's disputes, the ones
  // carried over from the ledger and the ones recorded «со слов» — reach the ledger's rule here.
  const decisions = await listActiveSaleDecisions(db, ids);
  const factOf = new Map(facts.map((fact) => [fact.transactionId, fact]));

  const allWorks = [...people].flatMap(([userId, person]) => person.work.map((work) => ({ userId, username: person.username, work })));
  const senders = facts.flatMap((fact) => (fact.ppvSender === null ? [] : [fact.ppvSender.userId]));
  const roles = await listUserRoles(db, [...new Set([...allWorks.map((one) => one.userId), ...senders])]);

  const works: AgentTeamWork[] = allWorks.map(({ userId, username, work }) => ({
    ref: workRef(userId, work),
    userId,
    username,
    role: roleOf(roles.get(userId)),
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
      // Kept for the ledger, which parses it: Hub's marks flow is gone, and the tables that held it are read no more.
      marks: [],
      ...decided(decisions.get(sale.transactionId)),
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
