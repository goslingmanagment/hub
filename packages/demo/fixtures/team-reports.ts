import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { millsRoundedTo, millsToNumber } from "@agency_hub_core/shared";

import { demoError, iso, queryString, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_CHATTERS, type DemoUser } from "../world.ts";
import { MINUTE_MS, chatterWorld, mskDay, type DemoShift } from "./account-model.ts";
import { shiftReportsOf } from "./account-reports.ts";

/**
 * Every chatter's shift reports as the agency ledger keeps them (`teamLedgerReports`, the owner's «Выплаты → Отчёты»
 * and the reports' part of «Решения»). Made from the same working lives as a chatter's «Мои смены»
 * (account-model.ts, account-reports.ts): alex.k's reports here are the ones alex.k sees. Most days are posted as the
 * agent composed them; the twists below walk every state of the screen:
 *
 * - the newest ended shift of alex.k and den.s: composed, not posted yet;
 * - kate.v changed an amount by hand (+$12.50 on her newest day), and once after the day was paid — that change waits
 *   for the owner in «Решения»; one of her posts says a total its pages do not add up to (not parsed);
 * - den.s lowered a page (−$8.00) and wrote one report without the agent; alex.k raised a page (+$15.00), once wrote a
 *   page name the ledger does not know (that line is out: the day is posted in part), and once wrote a report by hand
 *   though the agent had composed one (the post alone counts, the draft is not in the pay base);
 * - olya.m's post carries a date days off the day it was sent (not parsed);
 * - a post from someone the ledger does not know.
 *
 * Invented names, amounts and chat only.
 */

type Answer = KernelOperationResponse<"teamLedgerReports">;
type Day = Answer["reports"][number];
type WirePage = Day["pages"][number];
/** A page as the fixture makes it: the report handed in in Hub is added at the answer (HUB_TWISTS). */
type Page = Omit<WirePage, "hubMills" | "hubState" | "basis"> & Partial<Pick<WirePage, "hubMills" | "hubState" | "basis">>;
type Post = Answer["posts"][number];
type Draft = NonNullable<Day["draft"]>;

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;
/** The «Отчётность» topic of the invented team chat. */
const PEER = "-1000000000417";
const TOPIC = 4;

type Twist =
  | { kind: "draft" }
  | { kind: "changed"; deltaMills: number; paid?: boolean }
  | { kind: "post_only" }
  | { kind: "unknown_page" }
  | { kind: "blocked"; flag: "sum_mismatch" | "date_mismatch" };

/** Whose report day (by the index of the ended shift, the newest from 0) shows what. Every other day is posted as drafted. */
const TWISTS: Readonly<Record<string, Readonly<Record<number, Twist>>>> = {
  "alex.k": { 0: { kind: "draft" }, 1: { kind: "changed", deltaMills: 15_000 }, 4: { kind: "unknown_page" }, 5: { kind: "post_only" } },
  "den.s": { 0: { kind: "draft" }, 2: { kind: "changed", deltaMills: -8_000 }, 3: { kind: "post_only" } },
  "kate.v": { 0: { kind: "changed", deltaMills: 12_500 }, 4: { kind: "blocked", flag: "sum_mismatch" }, 6: { kind: "changed", deltaMills: 20_000, paid: true } },
  "olya.m": { 5: { kind: "blocked", flag: "date_mismatch" } },
};

/**
 * Days handed in in Hub too (package G, the ledger's v_report_pages.hub_*): kate.v's equals her post to the cent;
 * alex.k's is his draft, while his post raised the first page by hand (+$15.00): the post and Hub differ.
 */
const HUB_TWISTS: Readonly<Record<string, Readonly<Record<number, number>>>> = { "alex.k": { 1: -15_000 }, "kate.v": { 1: 0 } };

function withHub(pages: readonly Page[], delta: number | undefined): WirePage[] {
  return pages.map((page, position): WirePage => {
    if (delta === undefined) return { ...page, hubMills: null, hubState: null, basis: "post" };
    const hubMills = Math.max(0, (page.postedMills ?? page.draftMills ?? 0) + (position === 0 ? delta : 0));
    const hubState = page.postedMills === null ? "hub_only" : hubMills === page.postedMills ? "hub_equal" : "hub_changed";
    return { ...page, hubMills, hubState, basis: "post" };
  });
}

/** The model of a page, as the ledger names it: «Mia» for mia-1. */
export function demoModelOf(page: string): string {
  const name = page.split("-")[0] ?? "mia";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** One person's report day, before the window and the answer's shape. */
export interface DemoReportDay {
  user: DemoUser;
  date: string;
  shift: DemoShift;
  draft: Draft | null;
  pages: Page[];
  posts: Post[];
  /** A paid day whose post changed after the payout: what the day was paid by (the posted sum then). */
  paidAsMills: number | null;
  /** The day handed in in Hub too: how far its first page lies from the post; undefined — not handed in in Hub. */
  hubDelta?: number;
}

const cents = (value: number) => millsToNumber(millsRoundedTo(value, "cent"));
const signed = (millsValue: number) => `${millsValue < 0 ? "−" : "+"}$${(Math.abs(millsValue) / 1000).toFixed(2)}`;
const link = (msgId: number) => `https://t.me/c/${PEER.slice(4)}/${TOPIC}/${msgId}`;

function postOf(input: {
  id: number; at: number; user: DemoUser | null; sender: string; date: string | null; draft: Page[]; flags: string[]; totalShift?: number; unknown?: string;
}): Post {
  const lines = input.draft.map((page) => ({
    name: input.unknown === page.pageLabel ? `${page.pageLabel.split("-")[0]} вип` : page.pageLabel,
    pageLabel: input.unknown === page.pageLabel ? null : page.pageLabel,
    inShift: true,
    amountMills: page.draftMills ?? page.postedMills ?? 0,
  }));
  const pagesMills = lines.reduce((sum, line) => sum + line.amountMills, 0);
  return {
    id: input.id,
    postedAt: iso(new Date(input.at)),
    sender: input.sender,
    tag: input.user === null ? "" : `#${input.user.username.split(".")[0]}`,
    person: input.user === null
      ? { slug: null, hubUser: null, name: input.sender }
      : { slug: input.user.username, hubUser: { userId: input.user.id, username: input.user.username }, name: input.user.username },
    model: demoModelOf(input.draft[0]?.pageLabel ?? "mia-1"),
    reportDate: input.date,
    totalMills: pagesMills + (input.totalShift ?? 0),
    pagesMills,
    flags: input.flags,
    blocking: input.flags.some((flag) => ["unknown_author", "no_date", "sum_mismatch", "date_mismatch"].includes(flag)),
    pages: lines,
    link: link(input.id),
  };
}

/** The last answer: the payouts ask for every person's days of one moment. */
let made: { at: number; days: DemoReportDay[] } | null = null;

/** Every chatter's report days, the newest first, with the posts the ledger could not use in full. */
export function demoReportDays(now: Date): DemoReportDay[] {
  if (made?.at === now.getTime()) return made.days;
  const days: DemoReportDay[] = [];
  for (const user of DEMO_CHATTERS.filter((one) => one.active)) {
    const world = chatterWorld(user, now);
    for (const { shift, index, report } of shiftReportsOf(world)) {
      const twist = TWISTS[user.username]?.[index] ?? null;
      const date = mskDay(shift.start);
      const postedAt = Math.min(now.getTime(), shift.end + 24 * MINUTE_MS);
      const msgId = 4000 + (Math.floor(shift.start / 60_000) % 50_000);
      if (report === null || twist?.kind === "post_only") {
        if (twist?.kind !== "post_only") continue;
        // Written without the agent: the chatter's own sums of the shift's sales, nothing to compare with.
        const pages = user.pages.filter((pageLabel) => shift.sales.some((sale) => sale.pageLabel === pageLabel)).map((pageLabel): Page => ({
          pageLabel,
          model: demoModelOf(pageLabel),
          postedMills: cents(shift.sales.filter((sale) => sale.pageLabel === pageLabel).reduce((sum, sale) => sum + sale.netMills, 0)),
          draftMills: null,
          diffMills: null,
          state: "post_only",
          postedAt: iso(new Date(postedAt)),
        }));
        days.push({ user, date, shift, draft: null, pages, posts: [], paidAsMills: null });
        continue;
      }
      const posted = twist === null || twist.kind === "changed" || twist.kind === "unknown_page";
      const draft: Draft = { ...report, status: posted ? "posted" : "draft" };
      const drafted = draft.pages.map((page): Page => ({
        pageLabel: page.pageLabel,
        model: demoModelOf(page.pageLabel),
        postedMills: null,
        draftMills: page.amountMills,
        diffMills: null,
        state: "draft_only",
        postedAt: null,
      }));
      const posts: Post[] = [];
      let pages = drafted;
      let paidAsMills: number | null = null;
      if (twist?.kind === "blocked") {
        // The post is out of the pay base: the day stands as drafted; the post waits in «Решения» if its day is one the
        // reports accrue (team-ledger.ts, REPORTS_FROM_DAYS), else it is history in «Выплаты → Отчёты».
        posts.push(postOf({
          id: msgId, at: twist.flag === "date_mismatch" ? postedAt + 3 * 24 * 60 * MINUTE_MS : postedAt, user, sender: user.name, date,
          draft: drafted, flags: [twist.flag], ...(twist.flag === "sum_mismatch" ? { totalShift: 10_000 } : {}),
        }));
      } else if (posted) {
        const unknown = twist?.kind === "unknown_page" ? drafted.at(-1)?.pageLabel : undefined;
        pages = drafted.map((page, position) => {
          if (page.pageLabel === unknown) return page;
          const delta = twist?.kind === "changed" && position === 0 ? twist.deltaMills : 0;
          const value = Math.max(0, (page.draftMills ?? 0) + delta);
          return { ...page, postedMills: value, diffMills: value === page.draftMills ? null : value - (page.draftMills ?? 0), state: value === page.draftMills ? "posted_equal" : "posted_changed", postedAt: iso(new Date(postedAt)) };
        });
        if (unknown !== undefined) posts.push(postOf({ id: msgId, at: postedAt, user, sender: user.name, date, draft: drafted, flags: ["unknown_page"], unknown }));
        if (twist?.kind === "changed" && twist.paid) paidAsMills = drafted.reduce((sum, page) => sum + (page.draftMills ?? 0), 0);
      }
      const hubDelta = HUB_TWISTS[user.username]?.[index];
      days.push({ user, date, shift, draft, pages, posts, paidAsMills, ...(hubDelta === undefined ? {} : { hubDelta }) });
    }
  }
  days.sort((left, right) => right.date.localeCompare(left.date) || left.user.username.localeCompare(right.user.username));
  made = { at: now.getTime(), days };
  return days;
}

/** A post from someone the ledger does not know: a new chatter's first report, two days back. */
function strangerPost(now: Date): Post {
  const at = now.getTime() - 2 * 24 * 60 * MINUTE_MS - 5 * 60 * MINUTE_MS;
  const pages: Page[] = [
    { pageLabel: "mia-1", model: "Mia", postedMills: null, draftMills: 84_200, diffMills: null, state: "post_only", postedAt: null },
    { pageLabel: "mia-3", model: "Mia", postedMills: null, draftMills: 40_000, diffMills: null, state: "post_only", postedAt: null },
  ];
  return postOf({ id: 3911, at, user: null, sender: "Маша Н.", date: mskDay(at - 6 * 60 * MINUTE_MS), draft: pages, flags: ["unknown_author"] });
}

/** What a person's report days pay by, for the payouts (team-ledger.ts): the posted sum of each posted day. */
export function demoReportPay(user: DemoUser, now: Date): Map<string, { postedMills: number; paidAsMills: number | null; reason: string | null }> {
  const out = new Map<string, { postedMills: number; paidAsMills: number | null; reason: string | null }>();
  for (const day of demoReportDays(now)) {
    if (day.user.id !== user.id) continue;
    const posted = day.pages.filter((page) => page.postedMills !== null);
    if (posted.length === 0) continue;
    const changed = posted.find((page) => page.diffMills !== null);
    out.set(day.date, {
      postedMills: posted.reduce((sum, page) => sum + (page.postedMills ?? 0), 0),
      paidAsMills: day.paidAsMills,
      reason: day.paidAsMills === null || !changed ? null : `пост поправлен после выплаты: ${changed.pageLabel} ${signed(changed.diffMills ?? 0)}`,
    });
  }
  return out;
}

function teamLedgerReports(request: DemoRequest): Answer | DemoReply {
  if (request.role !== "owner") return demoError(403, "Forbidden", "Отчёты из ledger видит только владелец.");
  const from = queryString(request, "from") ?? "";
  const to = queryString(request, "to") ?? "";
  if (!BUSINESS_DATE.test(from) || !BUSINESS_DATE.test(to) || to < from) return demoError(400, "Bad Request", "from и to — даты YYYY-MM-DD.");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > MAX_DAYS) return demoError(400, "Bad Request", "Окно — до 62 дней.");
  const inWindow = (date: string | null) => date !== null && date >= from && date <= to;
  const days = demoReportDays(request.now).filter((day) => inWindow(day.date));
  const stranger = strangerPost(request.now);
  const sum = (values: ReadonlyArray<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
  };
  return {
    from,
    to,
    reports: days.map((day) => ({
      key: `person:${day.user.username}:${day.date}`,
      person: { slug: day.user.username, hubUser: { userId: day.user.id, username: day.user.username }, name: day.user.username },
      reportDate: day.date,
      pages: withHub(day.pages, day.hubDelta),
      postedMills: sum(day.pages.map((page) => page.postedMills)),
      draftMills: sum(day.pages.map((page) => page.draftMills)),
      hubMills: day.hubDelta === undefined ? null : sum(withHub(day.pages, day.hubDelta).map((page) => page.hubMills)),
      postedAt: day.pages.map((page) => page.postedAt).filter((at): at is string => at !== null).sort().at(-1) ?? null,
      draft: day.draft,
      postIds: day.posts.map((post) => post.id),
    })),
    posts: [...days.flatMap((day) => day.posts), ...(inWindow(stranger.reportDate) ? [stranger] : [])]
      .sort((left, right) => right.postedAt.localeCompare(left.postedAt)),
    postsRead: true,
    serverNow: request.now.toISOString(),
  };
}

export const teamReportsHandlers: DemoHandlers = { teamLedgerReports };
