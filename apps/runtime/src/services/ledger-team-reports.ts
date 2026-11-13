import { z } from "zod";

import {
  TEAM_LEDGER_REPORTS_MAX_DAYS,
  businessDate,
  type TeamLedgerReportDay,
  type TeamLedgerReportPage,
  type TeamLedgerReportPerson,
  type TeamLedgerReportPost,
  type TeamLedgerReportsQuery,
  type TeamLedgerReportsResponse,
} from "@agency_hub_core/contracts";
import { listUsers } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { checkWindow, hubUsersOf, ledgerGet, list, micros, millsOf } from "./ledger-payouts.ts";
import { accountReportOf, draftPages, parseLedgerReportDays, parseLedgerReports, reportPageOf, type LedgerReport } from "./ledger-reports.ts";

/**
 * Workboard «Выплаты → Отчёты» and the reports' part of «Решения» (the owner's): every chatter's shift reports of
 * a window, from three reads of the agency ledger with Hub's payouts key —
 *   - GET /v1/reports: the agent's current draft of each report (the breakdown the chatter sees);
 *   - GET /v1/report-days: the pay base, page by page — posted and drafted, and how they compare;
 *   - GET /v1/report-posts?flagged=1: the posts in «Отчётность» the ledger could not use in full.
 * One answer per person and report day, in mills; each person joined to the Hub user they are (the report's Hub
 * user id first, the name after). Read-only, nothing is written anywhere, and no post's text reaches Hub. A changed
 * shape of any read is a 503, never a wrong sum. Only the posts may be closed to Hub's key yet: their 403 or 404 is
 * «none read», said once in the log.
 */

/** A text the ledger may leave out or null. */
const text = z.string().nullish().transform((value) => value ?? "");
const nullable = <T extends z.ZodTypeAny>(item: T) => item.nullish().transform((value): z.output<T> | null => value ?? null);

const ledgerPostsSchema = z.object({
  from: z.string(),
  to: z.string(),
  posts: list(z.object({
    id: z.number().int().positive(),
    // A chat id; the collector's config may write it as a number.
    peer: z.union([z.string(), z.number()]).transform((value) => String(value)),
    topic: z.number().int(),
    msg_id: z.number().int(),
    posted_at: z.string(),
    sender: text,
    tag: text,
    person: nullable(z.string()),
    model: text,
    report_date: nullable(businessDate),
    total_micros: micros,
    pages_micros: micros,
    flags: z.array(z.string()).nullish().transform((value): string[] => value ?? []),
    current: z.boolean().optional(),
    pages: list(z.object({
      name: text,
      page_label: nullable(z.string()),
      page: nullable(z.string()),
      in_shift: z.boolean(),
      amount_micros: micros,
    })),
  })),
});

/** The flags that keep a whole post out of the pay base (the ledger's `Blocking`). */
export const BLOCKING_POST_FLAGS: ReadonlySet<string> = new Set(["unknown_author", "no_date", "sum_mismatch", "date_mismatch"]);

/**
 * A post's place in Telegram: `https://t.me/c/<chat>/<message>`, the chat's id without its «-100»; a message in a
 * forum topic is `…/c/<chat>/<topic>/<message>` (core.telegram.org/api/links — the General topic, 1, has no thread in
 * its links). null — the id is not a supergroup's, so it makes no link.
 */
export function telegramPostLink(peer: string, topic: number, msgId: number): string | null {
  const match = /^-100(\d+)$/.exec(peer.trim());
  if (!match || msgId <= 0) return null;
  return topic > 1 ? `https://t.me/c/${match[1]}/${topic}/${msgId}` : `https://t.me/c/${match[1]}/${msgId}`;
}

function checked<T extends z.ZodTypeAny>(app: Pick<AppContext, "logger">, schema: T, body: unknown, path: string, what: string): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, `${what}: unexpected answer`);
    throw new ServiceUnavailableError(`The ledger's GET ${path} answered in a shape Hub does not know`);
  }
  return parsed.data as z.output<T>;
}

/** The posts' refusal is said in the log once per process: it stays until the ledger opens them to Hub. */
let postsClosedSaid = false;

const sum = (values: ReadonlyArray<number | null>): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
};

interface Group {
  key: string;
  slug: string | null;
  reportDate: string;
  pages: TeamLedgerReportPage[];
  draftId: number | null;
  postIds: number[];
}

export async function readTeamLedgerReports(
  app: Pick<AppContext, "db" | "config" | "logger">,
  query: TeamLedgerReportsQuery,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TeamLedgerReportsResponse> {
  return (await readTeamLedgerReportsWithBreakdowns(app, query, options)).answer;
}

/**
 * `readTeamLedgerReports` and, beside it, each report day's saved breakdown as the ledger serves it, by the day's
 * `key`: its lines name their sales (`transaction_ref`), which no answer to a browser carries. For the server's own
 * reads (shift-report-notes.ts); a day without a breakdown — a post written by hand — has none.
 */
export async function readTeamLedgerReportsWithBreakdowns(
  app: Pick<AppContext, "db" | "config" | "logger">,
  query: TeamLedgerReportsQuery,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<{ answer: TeamLedgerReportsResponse; breakdowns: Map<string, LedgerReport> }> {
  checkWindow(query.from, query.to, TEAM_LEDGER_REPORTS_MAX_DAYS);
  const window = { from: query.from, to: query.to };
  const read = { client: "workboard-reports", ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
  const [reportsBody, daysBody, postsBody] = await Promise.all([
    ledgerGet(app, "/v1/reports", window, read),
    ledgerGet(app, "/v1/report-days", window, read),
    ledgerGet(app, "/v1/report-posts", { ...window, flagged: "1" }, { ...read, absentOn: [403, 404] }),
  ]);
  const drafts = parseLedgerReports(app, reportsBody).reports;
  const days = parseLedgerReportDays(app, daysBody);
  const postsRead = postsBody !== undefined;
  if (!postsRead && !postsClosedSaid) {
    postsClosedSaid = true;
    app.logger.info({}, "ledger report posts: GET /v1/report-posts is not open to Hub's key yet; no unparsed posts are shown");
  }
  const posts = postsRead ? checked(app, ledgerPostsSchema, postsBody, "/v1/report-posts", "ledger report posts").posts.filter((post) => post.current !== false) : [];

  // Who is who: a person's Hub user id from their drafts (the agent saves it), the name match after.
  const hubUserOf = hubUsersOf(await listUsers(app.db));
  const idOfSlug = new Map<string, number>();
  for (const draft of drafts) if (draft.person !== null && draft.hub_user_id !== null && !idOfSlug.has(draft.person)) idOfSlug.set(draft.person, draft.hub_user_id);
  /** `names` are matched against Hub's users; `shown` only names someone nobody knows (a post's Telegram sender). */
  const personOf = (slug: string | null, hubUserId: number | null, names: readonly string[], shown = ""): TeamLedgerReportPerson => {
    const id = hubUserId ?? (slug === null ? null : idOfSlug.get(slug) ?? null);
    const known = names.map((name) => name.trim()).filter((name) => name !== "");
    const hubUser = hubUserOf(id, [...(slug === null ? [] : [slug]), ...known]);
    return { slug, hubUser, name: hubUser?.username ?? known[0] ?? slug ?? (shown.trim() || "—") };
  };

  const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
  const groups = new Map<string, Group>();
  const groupOf = (key: string, slug: string | null, reportDate: string): Group => {
    let group = groups.get(key);
    if (!group) {
      group = { key, slug, reportDate, pages: [], draftId: null, postIds: [] };
      groups.set(key, group);
    }
    return group;
  };
  const dayKey = (slug: string, reportDate: string) => `person:${slug}:${reportDate}`;

  // The pay base, page by page.
  for (const day of days) {
    const group = groupOf(dayKey(day.person, day.report_date), day.person, day.report_date);
    group.pages.push(reportPageOf(day));
    if (group.draftId === null && day.report_id !== null && draftById.has(day.report_id)) group.draftId = day.report_id;
  }
  // Each draft on its day: by the pay base's report id, else by its person and day; a draft of nobody the ledger
  // knows is a day of its own, its pages its own.
  const attached = new Set([...groups.values()].flatMap((group) => (group.draftId === null ? [] : [group.draftId])));
  for (const draft of drafts) {
    if (attached.has(draft.id)) continue;
    const key = draft.person === null ? `report:${draft.id}` : dayKey(draft.person, draft.report_date);
    const known = groups.has(key);
    const group = groupOf(key, draft.person, draft.report_date);
    if (group.draftId !== null) continue;
    group.draftId = draft.id;
    if (!known || group.pages.length === 0) group.pages = draftPages(draft);
  }
  // The posts the ledger could not use, on their day when the person and the day are known.
  for (const post of posts) {
    if (post.person === null || post.report_date === null) continue;
    groupOf(dayKey(post.person, post.report_date), post.person, post.report_date).postIds.push(post.id);
  }

  const breakdowns = new Map<string, LedgerReport>();
  const reports: TeamLedgerReportDay[] = [...groups.values()].map((group) => {
    const draft = group.draftId === null ? null : draftById.get(group.draftId) ?? null;
    if (draft !== null) breakdowns.set(group.key, draft);
    const postedAt = group.pages.map((page) => page.postedAt).filter((at): at is string => at !== null).sort().at(-1) ?? draft?.posted_at ?? null;
    return {
      key: group.key,
      person: personOf(group.slug, draft?.hub_user_id ?? null, draft === null ? [] : [draft.hub_username, draft.chatter]),
      reportDate: group.reportDate,
      pages: group.pages,
      postedMills: sum(group.pages.map((page) => page.postedMills)),
      draftMills: sum(group.pages.map((page) => page.draftMills)),
      hubMills: sum(group.pages.map((page) => page.hubMills)),
      postedAt,
      draft: draft === null ? null : accountReportOf(draft),
      postIds: group.postIds,
    };
  }).sort((left, right) => right.reportDate.localeCompare(left.reportDate) || left.person.name.localeCompare(right.person.name) || left.key.localeCompare(right.key));

  const flagged: TeamLedgerReportPost[] = posts.map((post) => ({
    id: post.id,
    postedAt: post.posted_at,
    sender: post.sender,
    tag: post.tag,
    // An author the ledger did not recognise stays unknown: the sender's name is shown, never matched to a login.
    person: personOf(post.person, null, [], post.sender),
    model: post.model,
    reportDate: post.report_date,
    totalMills: millsOf(post.total_micros),
    pagesMills: millsOf(post.pages_micros),
    flags: post.flags,
    blocking: post.flags.some((flag) => BLOCKING_POST_FLAGS.has(flag)),
    pages: post.pages.map((page) => ({ name: page.name, pageLabel: page.page_label ?? page.page, inShift: page.in_shift, amountMills: millsOf(page.amount_micros) })),
    link: telegramPostLink(post.peer, post.topic, post.msg_id),
  })).sort((left, right) => right.postedAt.localeCompare(left.postedAt) || right.id - left.id);

  return {
    answer: { from: window.from, to: window.to, reports, posts: flagged, postsRead, serverNow: (options.now ?? new Date()).toISOString() },
    breakdowns,
  };
}
