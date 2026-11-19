import {
  CHATTER_SALE_KINDS,
  ownShiftsWindow,
  type ChatterSaleKind,
  type TeamShiftReport,
  type TeamShiftReportParts,
  type TeamShiftReportsQuery,
  type TeamShiftReportsResponse,
} from "@agency_hub_core/contracts";
import {
  countHandinProposals,
  listCurrentHandinVersions,
  listHandinNames,
  listHandinPeopleOfUsers,
  listHandinSaleFans,
  listHandinsOfShifts,
  listLatestHandinCandidates,
  listShiftReportReviewerPages,
  listTeamHandinShifts,
  type CandidateRow,
  type HandinPerson,
  type HandinRow,
  type HandinVersionLine,
  type HandinVersionRow,
  type ShiftSale,
  type TeamHandinShift,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { AuthPrincipal } from "./auth.ts";
import { teamReadPages } from "./chatter-shifts.ts";
import { realmOf } from "./sandbox/realm.ts";
import { saleKindOf } from "./sale-kinds.ts";
import { modelComment } from "./shift-handin-rules.ts";
import { ownDraftTotals, reportSeenBy } from "./shift-handins.ts";
import { boardOn, hubOf, phaseOf } from "./shift-report-board-view.ts";
import { modelsOfPages, pageCatalog, reportDateOf, shiftPageLabels, type PageCatalog } from "./shift-report-draft.ts";
import { gengarState } from "./shift-report-phases.ts";
import { teamShiftSalesRead, type ShiftMoney } from "./team-shift-sales.ts";
import { requireTeamReader } from "./teams.ts";

/**
 * «Смены → Отчёты» (`teamShiftReports`, owner 2026-11-19): every shift's report of the people the reader sees, newest
 * first, in ONE set of queries for the window (never a query per shift): the shift rows reported in it (`shifts`, the
 * reader's realm), their reports, the newest version and the newest candidate of each, Gengar's proposals counted, the
 * keys that review, the fans of the sales; and the shifts' sales by the rule, as «Команда» counts them
 * (`teamShiftSalesRead`, the same read and the same cut as `teamShiftSales`).
 *
 * Who sees what is the reads' own rule (shift-handins.ts): the shifts are those on the pages of the reader's teams and
 * their own (`teamPagesFor`, as every team read); the owner and the person read a report whole, anyone else cut to
 * their pages by the one projection (`reportSeenBy`, what `shiftReportsList` totals). Nobody's draft is computed (a
 * draft is its person's): a shift with nothing handed in carries its sales by the rule. Sales only: no rate, accrual,
 * payout or terms is read here.
 */

type Item = TeamShiftReport;
type Tally = TeamShiftReportsResponse["totals"];

/** A stored line's kind as the screens name it: the rule's word (`ppv`, `post`…) or Hub's canonical type. Pure. */
function kindOfLine(kind: string): ChatterSaleKind {
  return (CHATTER_SALE_KINDS as readonly string[]).includes(kind) ? kind as ChatterSaleKind : saleKindOf(kind);
}

const noKinds = (): TeamShiftReportParts["byKind"] => ({ ppv: 0, tip: 0, subscription: 0, post: 0 });

/** What some sales are made of: the count, the whole, the parts by kind, each sale at its minute (oldest first). Pure. */
export function partsOf(sales: ReadonlyArray<{ at: string; netMills: number; kind: ChatterSaleKind; pageLabel: string; fanName: string | null }>): TeamShiftReportParts {
  const counted = sales.filter((sale) => sale.netMills > 0).sort((a, b) => a.at.localeCompare(b.at));
  const byKind = noKinds();
  let mills = 0;
  for (const sale of counted) {
    byKind[sale.kind] += sale.netMills;
    mills += sale.netMills;
  }
  return { count: counted.length, mills, byKind, sales: counted };
}

/** A handed-in report's sales as the reader sees them (`reportSeenBy`'s lines): the lines that count, at their minute. Pure. */
function reportParts(lines: readonly HandinVersionLine[], fans: ReadonlyMap<number, { name: string | null }>): TeamShiftReportParts {
  return partsOf(lines.flatMap((line) => (line.transactionId === null || line.pageLabel === null || line.occurredAt === null ? [] : [{
    at: line.occurredAt, netMills: line.amountMills, kind: kindOfLine(line.kind), pageLabel: line.pageLabel, fanName: fans.get(line.transactionId)?.name ?? null,
  }])));
}

/** A shift's sales by the rule (`teamShiftSales`' money of the same shift): each its share. Pure. */
function ruleParts(money: ShiftMoney): TeamShiftReportParts {
  return partsOf(money.own.map((sale: ShiftSale) => ({
    at: sale.occurredAt.toISOString(), netMills: sale.netMills, kind: saleKindOf(sale.kind), pageLabel: sale.pageLabel, fanName: sale.fanName,
  })));
}

/**
 * Which of `teamShiftSales`' shifts is each row's: of the same login, the one that ran with it the longest — every pair
 * once, the longest overlaps first (a row and a computed shift are the same work; with a page cut the computed one is
 * that cut's piece). Pure.
 */
export function pairRowsWithMoney<R extends { id: number; userId: number; startedAt: Date; endedAt: Date }, M extends { userId: number; work: { startedAt: number; endedAt: number } }>(
  rows: readonly R[],
  money: readonly M[],
): Map<number, M> {
  const pairs: Array<{ row: R; money: M; overlap: number }> = [];
  for (const row of rows) {
    const from = row.startedAt.getTime();
    const to = Math.max(from + 1, row.endedAt.getTime());
    for (const one of money) {
      if (one.userId !== row.userId) continue;
      const overlap = Math.min(to, Math.max(one.work.startedAt + 1, one.work.endedAt)) - Math.max(from, one.work.startedAt);
      if (overlap > 0) pairs.push({ row, money: one, overlap });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap);
  const out = new Map<number, M>();
  const used = new Set<M>();
  for (const pair of pairs) {
    if (out.has(pair.row.id) || used.has(pair.money)) continue;
    out.set(pair.row.id, pair.money);
    used.add(pair.money);
  }
  return out;
}

/** The comment the next shift reads (the report's own, as written now), each model of the reader's pages with words. Pure. */
function commentsOf(handin: HandinRow | null, pages: readonly string[], catalog: Pick<PageCatalog, "info">): Item["comments"] {
  if (handin === null) return [];
  const models = modelsOfPages(catalog, pages);
  const written = models
    .map((model) => ({ modelName: model.name, comment: modelComment(handin, model.slug).trim() }))
    .filter((one) => one.comment !== "");
  // One text for every model: said once, without a model's name.
  if (written.length > 1 && written.every((one) => one.comment === written[0]!.comment)) return [{ modelName: "", comment: written[0]!.comment }];
  if (written.length === 1 && models.length === 1) return [{ modelName: "", comment: written[0]!.comment }];
  return written;
}

/** A tally of the cards (a day's, the window's). Pure. */
export function tallyOf(items: readonly Pick<Item, "report" | "ongoing" | "board" | "phase">[]): Tally {
  const tally: Tally = { shifts: 0, handedIn: 0, expected: 0, reportedMills: 0, notHandedIn: 0, waitingConfirm: 0, ongoing: 0, oldWay: 0 };
  for (const item of items) {
    tally.shifts += 1;
    if (item.report !== null) {
      tally.handedIn += 1;
      tally.expected += 1;
      tally.reportedMills += item.report.totalMills;
      if (item.phase === "confirm") tally.waitingConfirm += 1;
    } else if (item.ongoing) {
      tally.ongoing += 1;
    } else if (item.board) {
      tally.notHandedIn += 1;
      tally.expected += 1;
    } else {
      tally.oldWay += 1;
    }
  }
  return tally;
}

interface Built {
  row: TeamHandinShift;
  handin: HandinRow | null;
  version: HandinVersionRow | null;
  candidate: CandidateRow | null;
  person: HandinPerson | null;
}

/** `teamShiftReports`: the window's reports of the reader's teams' shifts. */
export async function readTeamShiftReports(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamShiftReportsQuery; pageScope: readonly number[] | undefined },
  now: Date = new Date(),
): Promise<TeamShiftReportsResponse> {
  // A cookie session of any role (the narrow one too), cut to the reader's teams (`teamPagesFor`, services/teams.ts).
  requireTeamReader(principal);
  const { db } = app;
  const { days, until, pageLabel, userId } = input.query;
  const window = ownShiftsWindow({ days, until, now: now.getTime() });
  const pages = await teamReadPages(app, principal, { pageLabel, pageScope: input.pageScope });
  const catalog = await pageCatalog(db);
  const labels = pages === "all" ? null : new Set(pages.map((id) => catalog.labelOf.get(id)).filter((label): label is string => label !== undefined));
  // The owner reads a report whole (as `shiftReport`), and so does the person; anyone else — their pages. A narrow
  // session reads as a chatter whatever the role. A page asked for is that page's part, for everyone.
  const ownerReader = principal.user.role === "owner" && principal.narrowDeviceTokenId === undefined;
  const asked = pageLabel === undefined ? null : new Set([pageLabel]);
  const readerCut = ownerReader ? null : labels ?? new Set<string>();

  const [rowsRead, rule, reader] = await Promise.all([
    listTeamHandinShifts(db, { from: window.from, to: window.to, realm: realmOf(principal) }),
    teamShiftSalesRead(db, { days, until, now, pages }),
    listHandinPeopleOfUsers(db, [principal.user.id]),
  ]);
  const own = new Set([principal.user.id, ...(reader.get(principal.user.id)?.userIds ?? [])]);
  // The rows on the reader's pages (the page asked for), the realm's (the query's).
  const onPages = rowsRead.filter((row) => labels === null || shiftPageLabels(row).some((label) => labels.has(label)));
  const people = await listHandinPeopleOfUsers(db, [...new Set(onPages.map((row) => row.userId))]);
  const handins = await listHandinsOfShifts(db, onPages.map((row) => row.id));
  // Of the window by the report's own date (a report handed in keeps its day).
  const inWindow = onPages.filter((row) => {
    const day = reportDateOf(row, handins.get(row.id) ?? null);
    return day >= window.from && day <= window.to;
  });
  const names = await listHandinNames(db, inWindow.map((row) => row.userId));
  const nameOf = (row: TeamHandinShift) => people.get(row.userId)?.displayName ?? names.get(row.userId) ?? `#${row.userId}`;

  // The filter's choices: one a person (every login of theirs one line), by name — whatever person is asked.
  const choices = new Map<string, { userId: number; name: string }>();
  for (const row of inWindow) {
    const key = people.get(row.userId) ? `p${people.get(row.userId)!.personId}` : `u${row.userId}`;
    if (!choices.has(key)) choices.set(key, { userId: row.userId, name: nameOf(row) });
  }
  let rows = inWindow;
  if (userId !== undefined) {
    const person = (await listHandinPeopleOfUsers(db, [userId])).get(userId) ?? null;
    const logins = new Set([userId, ...(person?.userIds ?? [])]);
    rows = rows.filter((row) => logins.has(row.userId));
  }

  const handinIds = rows.flatMap((row) => (handins.has(row.id) ? [handins.get(row.id)!.id] : []));
  const [versions, candidates] = await Promise.all([listCurrentHandinVersions(db, handinIds), listLatestHandinCandidates(db, handinIds)]);
  const built: Built[] = rows.map((row) => {
    const handin = handins.get(row.id) ?? null;
    return {
      row,
      handin,
      version: handin === null ? null : versions.get(handin.id) ?? null,
      candidate: handin === null ? null : candidates.get(handin.id) ?? null,
      person: people.get(row.userId) ?? null,
    };
  });
  const lineIds = built.flatMap((one) => [...(one.version?.lines ?? []), ...(one.candidate?.lines ?? [])])
    .flatMap((line) => (line.transactionId === null ? [] : [line.transactionId]));
  const [fans, proposals, reviewers] = await Promise.all([
    listHandinSaleFans(db, lineIds),
    countHandinProposals(db, built.flatMap((one) => (one.candidate === null ? [] : [one.candidate.id]))),
    built.some((one) => one.candidate !== null && one.candidate.gengarAnsweredAt === null) ? listShiftReportReviewerPages(db) : Promise.resolve([]),
  ]);
  const money = pairRowsWithMoney(rows, rule.money);
  // The reader's own shifts not handed in: their draft's total, as «Мои» shows it (a draft is its person's alone).
  const me = reader.get(principal.user.id) ?? null;
  const drafts = me === null ? new Map<number, number>() : await ownDraftTotals(db, {
    person: me,
    userIds: [...own],
    shifts: rows.filter((row) => own.has(row.userId) && boardOn({ person: me, shift: row }) && phaseOf(handins.get(row.id) ?? null) === "draft"),
    handins,
    catalog,
    now,
  });

  const reports: Item[] = built.map(({ row, handin, version, candidate, person }) => {
    const mine = own.has(row.userId);
    const cutTo = asked ?? (mine ? null : readerCut);
    const visible = (label: string) => cutTo === null || cutTo.has(label);
    const shiftPages = shiftPageLabels(row).filter(visible);
    const board = boardOn({ person, shift: row });
    const phase = board || (handin !== null && (handin.state === "submitted" || handin.phase !== "draft")) ? phaseOf(handin) : null;
    // What the card's money is: before a version, the candidate on the check; once counted (or reopened), the version.
    const onCheck = (phase === "checking" || phase === "confirm") && candidate !== null && candidate.confirmedVersion === null;
    const handed = onCheck ? candidate : version;
    const seen = handed === null ? null : reportSeenBy(handed, cutTo);
    let report: Item["report"] = null;
    if (handed !== null && seen !== null) {
      report = {
        source: onCheck ? "candidate" : "version",
        number: onCheck ? candidate!.number : version!.version,
        at: (onCheck ? candidate!.madeAt : version!.submittedAt).toISOString(),
        door: handed.door,
        totalMills: seen.totalMills,
        pages: seen.pages.filter((page) => visible(page.pageLabel)),
        cut: seen.cut,
        parts: reportParts(seen.lines, fans),
      };
    }
    let check: Item["check"] = null;
    if (candidate !== null) {
      const hub = hubOf({ hubCheck: candidate.hubCheck.filter((page) => visible(page.pageLabel)) });
      const ids = shiftPages.map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined);
      const reviewed = ids.length > 0 && reviewers.some((keyPages) => ids.every((id) => keyPages.includes(id)));
      check = {
        hub: hub.state,
        foundCount: hub.foundCount,
        foundMills: hub.foundMills,
        gengar: gengarState({ reviewed, answeredAt: candidate.gengarAnsweredAt, clean: candidate.gengarClean, handedInAt: candidate.madeAt, now }),
        proposals: proposals.get(candidate.id)?.ownerChange ?? 0,
      };
    }
    const ruled = money.get(row.id);
    return {
      shiftId: row.id,
      userId: row.userId,
      personName: person?.displayName ?? names.get(row.userId) ?? `#${row.userId}`,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt.toISOString(),
      ongoing: row.state === "going",
      workedMinutes: row.workedMinutes,
      pauses: row.pauses,
      pages: shiftPages,
      reportDate: reportDateOf(row, handin),
      own: mine,
      board,
      phase,
      report,
      counted: version === null ? null : { version: version.version, at: version.submittedAt.toISOString() },
      check,
      waitsConfirm: phase === "confirm" && report !== null,
      comments: commentsOf(handin, report?.pages.map((page) => page.pageLabel) ?? shiftPages, catalog),
      rule: ruled === undefined ? null : ruleParts(ruled),
      draftTotalMills: report === null && mine && asked === null ? drafts.get(row.id) ?? null : null,
      postCopied: mine && board && phase === "counted" ? handin?.postCopiedAt != null : null,
    };
  });
  reports.sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.startedAt.localeCompare(a.startedAt) || b.shiftId - a.shiftId);

  const dates = [...new Set(reports.map((item) => item.reportDate))];
  return {
    from: window.from,
    to: window.to,
    days: dates.map((date) => ({ date, ...tallyOf(reports.filter((item) => item.reportDate === date)) })),
    totals: tallyOf(reports),
    reports,
    people: [...choices.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")),
    serverNow: now.toISOString(),
  };
}
