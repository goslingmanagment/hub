/**
 * «Выплаты → Отчёты» — what the journal shows, worked out from `teamLedgerReports`; pure, no React.
 * One row per person and report day, the newest first: the pay base's
 * pages (posted and drafted), the agent's draft, and the posts of that day the ledger could not use. A post whose
 * person or day the ledger could not tell is a row of its own. The page filter narrows the rows to the page's lines,
 * and their sums to that page.
 */
import type { AccountReport, TeamLedgerReportDay, TeamLedgerReportPage, TeamLedgerReportPerson, TeamLedgerReportPost, TeamLedgerReportsResponse } from "@agency_hub_core/contracts";
import { moscowDayOf } from "@agency_hub_core/ui/moscow";
import { postOnPage } from "@agency_hub_core/ui/shiftReports";

/**
 * The state of a row, in words on the screen:
 * - `unparsed` «Пост не разобран» — a post of the day is out of the pay base (a blocking flag): the owner's to act on;
 * - `changed` «Сумма изменена» — posted, the chatter changed the amount after the draft (the outlier the owner looks for);
 * - `draft` «Собран, не отправлен» — the agent composed it, the chatter has not posted it yet;
 * - `post_only` «Без черновика» — posted, written without the agent;
 * - `posted` «Отправлен» — posted as drafted.
 */
export type ReportRowState = "unparsed" | "changed" | "draft" | "post_only" | "posted";

export interface ReportRow {
  key: string;
  person: TeamLedgerReportPerson;
  reportDate: string;
  /** The shift's window from the draft; null — no draft (the day alone is known). */
  window: { from: string; to: string } | null;
  /** The pay base's pages shown (the page filter's page only, when it is on). */
  pages: TeamLedgerReportPage[];
  /** The shown pages' posted amounts; null — nothing posted. */
  postedMills: number | null;
  /** posted − draft over the shown pages, when the chatter changed it; null — not changed. */
  diffMills: number | null;
  state: ReportRowState;
  draft: AccountReport | null;
  /** The day's posts the ledger could not use in full. */
  posts: TeamLedgerReportPost[];
  /** The first post that keeps the day out of the pay base; null — none. */
  blocking: TeamLedgerReportPost | null;
  /** Pages of a posted day that are not in the post (and no flag says why). */
  missing: string[];
}

const sum = (values: ReadonlyArray<number | null>): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
};

function stateOf(pages: readonly TeamLedgerReportPage[], draft: AccountReport | null, blocking: TeamLedgerReportPost | null): ReportRowState {
  if (blocking !== null) return "unparsed";
  if (pages.some((page) => page.state === "posted_changed" || page.diffMills !== null)) return "changed";
  const posted = pages.some((page) => page.postedMills !== null);
  if (draft === null) return posted && pages.every((page) => page.draftMills === null) ? "post_only" : "posted";
  return posted ? "posted" : "draft";
}

function rowOfDay(day: TeamLedgerReportDay, posts: ReadonlyMap<number, TeamLedgerReportPost>, page: string | null): ReportRow | null {
  const pages = page === null ? day.pages : day.pages.filter((one) => one.pageLabel === page);
  const own = day.postIds.map((id) => posts.get(id)).filter((post): post is TeamLedgerReportPost => post !== undefined && postOnPage(post, page));
  const draftOnPage = day.draft !== null && (page === null || day.draft.pages.some((one) => one.pageLabel === page) || day.draft.lines.some((line) => line.pageLabel === page));
  if (page !== null && pages.length === 0 && own.length === 0 && !draftOnPage) return null;
  const blocking = own.find((post) => post.blocking) ?? null;
  const diffs = pages.map((one) => one.diffMills).filter((value): value is number => value !== null);
  const anyPosted = pages.some((one) => one.postedMills !== null);
  return {
    key: day.key,
    person: day.person,
    reportDate: day.reportDate,
    window: day.draft === null ? null : { from: day.draft.windowFrom, to: day.draft.windowTo },
    pages,
    postedMills: sum(pages.map((one) => one.postedMills)),
    diffMills: diffs.length === 0 ? null : diffs.reduce((total, value) => total + value, 0),
    state: stateOf(pages, day.draft, blocking),
    draft: day.draft,
    posts: own,
    blocking,
    // A flag on the day's post says why a page is out; without one the page is simply not in the post.
    missing: anyPosted && own.length === 0 ? pages.filter((one) => one.postedMills === null && one.state === "draft_only").map((one) => one.pageLabel) : [],
  };
}

/** A post that belongs to no day (its person or its day not known): a row of its own, out of the pay base. */
function rowOfPost(post: TeamLedgerReportPost): ReportRow {
  return {
    key: `post:${post.id}`,
    person: post.person,
    reportDate: post.reportDate ?? moscowDayOf(post.postedAt),
    window: null,
    pages: [],
    postedMills: null,
    diffMills: null,
    state: post.blocking ? "unparsed" : "posted",
    draft: null,
    posts: [post],
    blocking: post.blocking ? post : null,
    missing: [],
  };
}

/** One person's report day as a journal row (a payouts day opens to it): every page, the day's posts. */
export function reportRowOf(day: TeamLedgerReportDay, answer: Pick<TeamLedgerReportsResponse, "posts">): ReportRow {
  return rowOfDay(day, new Map(answer.posts.map((post) => [post.id, post])), null)!;
}

/** The journal's rows, the newest day first; within a day by person. */
export function reportRows(answer: Pick<TeamLedgerReportsResponse, "reports" | "posts">, page: string | null): ReportRow[] {
  const posts = new Map(answer.posts.map((post) => [post.id, post]));
  const onDays = new Set(answer.reports.flatMap((day) => day.postIds));
  const rows = [
    ...answer.reports.map((day) => rowOfDay(day, posts, page)).filter((row): row is ReportRow => row !== null),
    ...answer.posts.filter((post) => !onDays.has(post.id) && postOnPage(post, page)).map(rowOfPost),
  ];
  return rows.sort((left, right) => right.reportDate.localeCompare(left.reportDate)
    || left.person.name.localeCompare(right.person.name, "ru")
    || left.key.localeCompare(right.key));
}

/** A row worth the owner's look: a sum the chatter changed, or a post the ledger could not use in full. */
export function hasQuestion(row: ReportRow): boolean {
  return row.state === "unparsed" || row.state === "changed" || row.posts.length > 0;
}

export interface ReportFacts {
  reports: number;
  /** The rows' posted amounts; null — nothing posted. */
  postedMills: number | null;
  changed: number;
  unparsed: number;
}

export function reportFacts(rows: readonly ReportRow[]): ReportFacts {
  return {
    reports: rows.filter((row) => !row.key.startsWith("post:")).length,
    postedMills: sum(rows.map((row) => row.postedMills)),
    changed: rows.filter((row) => row.state === "changed").length,
    unparsed: rows.filter((row) => row.state === "unparsed").length,
  };
}

/** Where a payouts day came from, in one quiet word; an unknown source as the ledger wrote it. */
export function sourceWord(source: string): string {
  switch (source) {
    case "sheet":
      return "таблица";
    case "reports":
    case "report":
      return "отчёт";
    case "facts":
      return "факты";
    default:
      return source;
  }
}
