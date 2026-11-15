import {
  TEAM_SALES_LIST_MAX_DAYS,
  TEAM_SALES_LIST_PAGE,
  type SaleChainLink,
  type TeamSalesListQuery,
  type TeamSalesListResponse,
  type TeamSalesListSale,
  type TeamLedgerReportsResponse,
} from "@agency_hub_core/contracts";
import {
  findHandinShift,
  listActiveSaleDecisions,
  listCurrentReportsOfSales,
  listHandinNames,
  listHandinPeopleOfUsers,
  listSaleClaims,
  listTeamSalesWithHomes,
  type HandinSaleRow,
  type HandinShift,
} from "@agency_hub_core/db";
import { moscowDayOf } from "@agency_hub_core/look";

import type { AppContext } from "../bootstrap.ts";
import type { AuthPrincipal } from "./auth.ts";
import { teamReadPages } from "./chatter-shifts.ts";
import { BadRequestError } from "./errors.ts";
import { readTeamLedgerReports } from "./ledger-team-reports.ts";
import { homeLinkOf, hubReportLinkOf, postReportLinkOf, type ChainSums } from "./sale-chain.ts";
import { requireTeamReader } from "./teams.ts";

/**
 * «Продажи → Список продаж» (products plan §2.3): every sale of the viewer's teams in a window, the newest first —
 * whose it is and why, the report it is in, and whether the viewer may open its chain (sale-chain.ts). Nothing is
 * computed anew and nothing is said in other words than the chain's: «Чья» is `homeLinkOf` over the home `sale_homes`
 * keeps (a sale the hourly job has not reached yet says so, as its chain does), the report is the handed-in version
 * holding the sale (`hubReportLinkOf`), else the ledger's report of the person's day (`postReportLinkOf`, read once for
 * the page's days). The pages are the viewer's teams' (`teamPagesFor`, by the caller). No pay of anyone: a report's
 * page sums only for the owner; accruals and payouts stay in the chain, which decides them for its reader.
 *
 * A chatter's row of a colleague's sale has its home and its report as states, never a chain to open: the chain is the
 * chatter's only for a sale of theirs.
 */

type ListApp = Pick<AppContext, "db" | "config" | "logger">;

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function windowOf(query: Pick<TeamSalesListQuery, "from" | "to">): { from: Date; to: Date } {
  if (!DAY.test(query.from) || !DAY.test(query.to) || query.to < query.from) throw new BadRequestError("from and to: Moscow days, from first");
  const from = new Date(`${query.from}T00:00:00+03:00`);
  const to = new Date(Date.parse(`${query.to}T00:00:00+03:00`) + DAY_MS);
  if ((to.getTime() - from.getTime()) / DAY_MS > TEAM_SALES_LIST_MAX_DAYS) throw new BadRequestError(`at most ${TEAM_SALES_LIST_MAX_DAYS} days`);
  return { from, to };
}

/** Who reads: the owner (every sum of a report), anyone else (the chain's words, a chain only of their own sale). */
interface ListViewer {
  owner: boolean;
  /** Every login of the viewer's person (their own login first): a share of any of them is theirs. */
  logins: readonly number[];
}

/** The report of one person's share: Hub's handed-in version holding it, else the day's report in the ledger. Pure. */
export function reportOfShare(input: {
  sale: Pick<HandinSaleRow, "transactionId" | "pageLabel">;
  handedIn: Parameters<typeof hubReportLinkOf>[0]["report"] | null;
  person: { code: string } | null;
  reportDate: string;
  ledger: TeamLedgerReportsResponse | Error | null;
  sums: ChainSums;
  postLink: string | null;
}): SaleChainLink {
  if (input.handedIn !== null) return hubReportLinkOf({ report: input.handedIn, transactionId: input.sale.transactionId, own: false, sums: input.sums });
  if (input.person === null) return { state: "unknown", words: "неизвестно: вход не связан с человеком в реестре", link: null, amountMills: null };
  if (input.ledger === null || input.ledger instanceof Error) {
    return { state: "unknown", words: "неизвестно: ledger не ответил", link: input.postLink, amountMills: null };
  }
  const day = input.ledger.reports.find((one) => one.person.slug === input.person!.code && one.reportDate === input.reportDate) ?? null;
  return postReportLinkOf({ day, posts: input.ledger.posts, pageLabel: input.sale.pageLabel, reportDate: input.reportDate, sums: input.sums, link: input.postLink });
}

/** The report a row shows for a home with no person (the pot, nobody's, waiting, the owner's to decide): none. Pure. */
export function noReportOf(sale: Pick<HandinSaleRow, "home" | "occurredAt">): SaleChainLink {
  switch (sale.home?.home) {
    case "pot": return { state: "none", words: "общак: делится в ledger, ни в чей отчёт по одной не входит", link: null, amountMills: null };
    case "waiting": return { state: "wait", words: "войдёт в отчёт смены отправителя", link: null, amountMills: null };
    case "decide": return { state: "wait", words: "ни в чей отчёт, пока владелец не решит", link: null, amountMills: null };
    case "nobody": return { state: "none", words: "ни в чей отчёт, пока её не заявят", link: null, amountMills: null };
    case "before_rule": return { state: "none", words: "по-старому: в посте за день", link: null, amountMills: null };
    default: return { state: "unknown", words: "неизвестно: правило ещё не посчитало эту продажу", link: null, amountMills: null };
  }
}

export async function readTeamSalesList(
  app: ListApp,
  principal: AuthPrincipal,
  input: { query: TeamSalesListQuery; pageScope: readonly number[] | undefined },
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TeamSalesListResponse> {
  // A cookie session of any role, cut to the viewer's teams by the caller (`teamPagesFor`, services/teams.ts).
  requireTeamReader(principal);
  const { db } = app;
  const now = options.now ?? new Date();
  const { query } = input;
  const window = windowOf(query);
  const pages = await teamReadPages(app as AppContext, principal, { pageLabel: query.pageLabel, pageScope: input.pageScope });
  const owner = principal.user.role === "owner" && principal.narrowDeviceTokenId === undefined;
  const self = (await listHandinPeopleOfUsers(db, [principal.user.id])).get(principal.user.id);
  const viewer: ListViewer = { owner, logins: [...new Set([principal.user.id, ...(self?.userIds ?? [])])] };

  const { sales, counts } = await listTeamSalesWithHomes(db, {
    pageIds: pages, from: window.from, to: window.to, filter: query.home, userIds: viewer.logins,
    limit: TEAM_SALES_LIST_PAGE + 1, offset: query.offset,
  });
  const shown = sales.slice(0, TEAM_SALES_LIST_PAGE);
  const saleIds = shown.map((sale) => sale.transactionId);
  const [reports, claims, decisions] = [
    await listCurrentReportsOfSales(db, saleIds),
    (await listSaleClaims(db, { transactionIds: saleIds })).filter((claim) => claim.state !== "withdrawn"),
    await listActiveSaleDecisions(db, saleIds),
  ];
  const shareUsers = [...new Set(shown.flatMap((sale) => sale.home?.shares.map((share) => share.userId) ?? []))];
  const names = await listHandinNames(db, [
    ...shareUsers,
    ...claims.flatMap((claim) => [claim.claimantUserId, claim.sideUserId].filter((one): one is number => one !== null)),
    ...[...decisions.values()].flatMap((decision) => decision.shares.map((share) => share.userId)),
  ]);
  const people = await listHandinPeopleOfUsers(db, shareUsers);
  const shifts = new Map<number, HandinShift | null>();
  for (const id of new Set(shown.flatMap((sale) => sale.home?.shares.map((share) => share.shiftId) ?? []))) {
    if (id !== null) shifts.set(id, await findHandinShift(db, id));
  }

  // Each row's report person: the viewer's own share first, else the first; their report date as the chain takes it.
  const reportPersonOf = (sale: HandinSaleRow) => {
    const shares = sale.home?.home === "shift" || sale.home?.home === "visit" ? sale.home.shares : [];
    return shares.find((share) => viewer.logins.includes(share.userId)) ?? shares[0] ?? null;
  };
  const handedInOf = (sale: HandinSaleRow, userId: number) => {
    const logins = people.get(userId)?.userIds ?? [userId];
    return reports.filter((report) => logins.includes(report.userId) && report.lines.some((line) => line.transactionId === sale.transactionId)).at(-1) ?? null;
  };
  const reportDateOf = (sale: HandinSaleRow, share: { userId: number; shiftId: number | null }) =>
    handedInOf(sale, share.userId)?.reportDate ?? (share.shiftId === null ? null : shifts.get(share.shiftId)?.reportDate) ?? moscowDayOf(sale.occurredAt);

  // The ledger's reports of the days some row needs (one read; a ledger that does not answer is «неизвестно»).
  const ledgerDays = shown.flatMap((sale) => {
    const share = reportPersonOf(sale);
    return share === null || handedInOf(sale, share.userId) !== null ? [] : [reportDateOf(sale, share)];
  }).sort();
  let ledger: TeamLedgerReportsResponse | Error | null = null;
  if (ledgerDays.length > 0) {
    try {
      ledger = await readTeamLedgerReports(app, { from: ledgerDays[0]!, to: ledgerDays.at(-1)! }, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), now });
    } catch (error) {
      ledger = error instanceof Error ? error : new Error(String(error));
    }
  }

  const out: TeamSalesListSale[] = shown.map((sale) => {
    const own = (sale.home?.shares ?? []).filter((share) => viewer.logins.includes(share.userId));
    const home = homeLinkOf({
      sale,
      names,
      decision: decisions.get(sale.transactionId) ?? null,
      claims: claims.filter((claim) => claim.transactionId === sale.transactionId),
      ownerReads: owner,
      silenceMs: 24 * 3_600_000,
    });
    const share = reportPersonOf(sale);
    let report: SaleChainLink;
    if (share === null) {
      report = noReportOf(sale);
    } else {
      const mine = viewer.logins.includes(share.userId);
      const sums: ChainSums = { share: true, hubLine: true, post: owner || mine, pay: false };
      const postLink = owner ? "/workboard/money/reports" : mine ? "/workboard/my/shifts" : null;
      const person = people.get(share.userId);
      report = reportOfShare({
        sale,
        handedIn: handedInOf(sale, share.userId),
        person: person === undefined ? null : { code: person.code },
        reportDate: reportDateOf(sale, share),
        ledger,
        sums,
        postLink,
      });
      const holders = new Set((sale.home?.shares ?? []).map((one) => one.userId));
      if (holders.size > 1) report = { ...report, words: `${names.get(share.userId) ?? `#${share.userId}`}: ${report.words}` };
    }
    const sharePeople = [...new Set((sale.home?.shares ?? []).map((one) => one.userId))];
    const mineInClaims = claims.some((claim) => claim.transactionId === sale.transactionId
      && ((claim.claimantUserId !== null && viewer.logins.includes(claim.claimantUserId)) || (claim.sideUserId !== null && viewer.logins.includes(claim.sideUserId))));
    const mineInReports = reports.some((one) => viewer.logins.includes(one.userId) && one.lines.some((line) => line.transactionId === sale.transactionId));
    return {
      transactionId: sale.transactionId,
      pageLabel: sale.pageLabel,
      platform: sale.platform,
      kind: sale.kind,
      occurredAt: sale.occurredAt.toISOString(),
      netMills: sale.netMills,
      fan: sale.fan,
      home: { state: home.state, words: home.words, kind: home.kind, reason: home.reason, above: home.above, dispute: home.dispute },
      people: sharePeople.map((userId) => ({ userId, name: names.get(userId) ?? `#${userId}`, mine: viewer.logins.includes(userId) })),
      report,
      // The chain is the owner's and a team's reader's for a sale of their pages; a chatter's for a sale of theirs.
      chain: principal.user.role !== "chatter" && principal.narrowDeviceTokenId === undefined ? true : own.length > 0 || mineInClaims || mineInReports,
    };
  });

  return {
    from: query.from,
    to: query.to,
    sales: out,
    counts,
    nextOffset: sales.length > TEAM_SALES_LIST_PAGE ? query.offset + TEAM_SALES_LIST_PAGE : null,
    serverNow: now.toISOString(),
  };
}
