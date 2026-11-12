import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { formatCount } from "@agency_hub_core/ui/format";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { pendingChangesOf, postOnPage, reportQuestionsWindow, unparsedPostsToDecide } from "@agency_hub_core/ui/shiftReports";
import { kernel } from "./hub.js";
import { carryParams } from "./links.js";
import { mattersWaitingQuery, useMattersActive } from "./matters.js";
import { useMe } from "./useMe.js";

/**
 * What waits for the owner's decision (spec §4.6), from the operations Hub has
 * today: the questions «whose is this sale» the chat agent asked him, the shift
 * reports' questions, customs paid and not delivered, held sends. One set of
 * query keys for the sidebar's count, the «Ждут решения» line on Смены and the
 * Решения screen itself: a decision made there moves the count at once. Read at
 * most once a minute (the ledger's, every five) and only while the tab is
 * visible.
 *
 * A queue that did not answer is not a zero (spec r3, D17): the counts say which
 * failed (`failed`), and the words for it are here (`decisionsFailedText`).
 */

const MINUTE = 60_000;
/** The ledger's reads are heavier and change with the posts' collection: every five minutes is enough. */
const LEDGER_EVERY = 5 * MINUTE;

/**
 * The shift reports' questions, the owner's only (the agency ledger's, through Hub): the posts in «Отчётность» the
 * ledger could not use (`teamLedgerReports`) of the days it accrues from the posts (`reportsFrom` of
 * `teamLedgerPayouts`, `unparsedPostsToDecide`) and the paid days whose report changed since (`teamLedgerPayouts`), of
 * the last month (`reportQuestionsWindow`) — the same window and rule the console's «Ждут вас» counts.
 */
export function reportPostsQuery(today: string = moscowToday()) {
  const window = reportQuestionsWindow(today);
  return queryOptions({
    queryKey: ["decisions", "report-posts", window] as const,
    queryFn: () => kernel.teamLedgerReports({ query: window }),
    staleTime: MINUTE,
  });
}

export function reportChangesQuery(today: string = moscowToday()) {
  const window = reportQuestionsWindow(today);
  return queryOptions({
    queryKey: ["decisions", "report-changes", window] as const,
    queryFn: () => kernel.teamLedgerPayouts({ query: window }),
    staleTime: MINUTE,
  });
}

/**
 * The open questions «whose is this sale» the team's chat agent asked (`teamLedgerQuestions`, the owner's only, the
 * agency ledger's through Hub): those that wait for the owner are decisions, the chatters' own are information.
 */
export const saleQuestionsQuery = queryOptions({
  queryKey: ["decisions", "sale-questions"] as const,
  queryFn: () => kernel.teamLedgerQuestions(),
  staleTime: MINUTE,
});

/** A question's page: one with no page known is every page's (as a report post of no known page). */
export function questionOnPage(question: { pageLabel: string }, page: string | null): boolean {
  return page === null || question.pageLabel === "" || question.pageLabel === page;
}

/** Open customs of the viewer's pages (`teamCustoms`). */
export const customsQuery = queryOptions({
  queryKey: ["decisions", "customs"] as const,
  queryFn: () => kernel.teamCustoms(),
  staleTime: MINUTE,
});

/** Held sends of the chat extension (`clientSendCustodyList`, state `held`). */
export function heldSendsQuery(params: { limit: number; offset: number; pageLabel?: string } = { limit: 1, offset: 0 }) {
  return queryOptions({
    queryKey: ["decisions", "held", params] as const,
    queryFn: () => kernel.clientSendCustodyList({ query: { state: "held", ...params } }),
    staleTime: 30_000,
  });
}

/**
 * The queues of Решения, in the screen's order; each is a section there (`#questions`, `#reports`, `#customs`,
 * `#held`). The questions come first: the oldest kind of waiting.
 */
export const DECISION_QUEUES = ["questions", "reports", "customs", "held"] as const;
export type DecisionQueue = (typeof DECISION_QUEUES)[number];

export interface DecisionCounts {
  /**
   * The questions «whose is this sale» that wait for the owner's word, on the
   * chosen page (a question of no known page is every page's); the chatters' own
   * never count. null: not read (failed, still loading, or not the owner's to see).
   */
  questions: number | null;
  /**
   * The reports' questions — posts the ledger could not use on the chosen page
   * (`page`; a post of no known page is every page's), of the days it accrues
   * from the posts (none while the payout sheets pay: `unparsedPostsToDecide`),
   * and paid days whose report changed (a person's pay, not a page's: on every
   * page). null: not read (failed, still loading, or not the owner's to see).
   */
  reports: number | null;
  /** The same, in its two kinds, for the words. */
  reportParts: { posts: number; changes: number } | null;
  /** Customs paid and not delivered, on the chosen page (every page without one); null — not read. */
  customs: number | null;
  /** Sends waiting for a manual resolve, the same way. */
  held: number | null;
  /** The sum of what answered: the sidebar's number. 0 until `settled`. */
  total: number;
  /** The page the counts are cut to; null — every page. */
  page: string | null;
  /** With a page: what waits on the other pages (of the queues that answered) — «ещё 4 на других страницах». 0 without one. */
  elsewhere: number;
  /** A queue is still being read for the first time. */
  loading: boolean;
  /**
   * Every queue has answered (or failed): only then are the numbers shown. Until
   * then all of them are null and `total` is 0, so the sidebar's badge and the
   * «Ждут решения» line never show a partial sum that grows a moment later.
   */
  settled: boolean;
  /** The queues that did not answer (D17: «Не удалось проверить…», never a silent zero). Empty while loading. */
  failed: DecisionQueue[];
  /** Settled and nothing failed: `total` is the whole truth. */
  complete: boolean;
  /** Reads the failed queues again. */
  retry: () => void;
}

/**
 * The counts of Решения for the sidebar and the «Ждут решения» line. With
 * `page` (the header's filter) they are that page's — what Решения itself shows
 * after the click — and `elsewhere` says what waits on the others.
 */
export function useDecisionCounts(options: { page?: string | null } = {}): DecisionCounts {
  const page = options.page ?? null;
  const { isOwner, user } = useMe();
  // The owner's switch (package K): on, the four queues are counted from matters in one read; off, as before.
  const { active } = useMattersActive();
  const signedIn = user !== undefined && active === false;
  const fromMatters = useQuery({ ...mattersWaitingQuery(page), enabled: user !== undefined && active === true, refetchInterval: MINUTE });
  const [questions, posts, changes, customs, held, heldOnPage] = useQueries({
    queries: [
      { ...saleQuestionsQuery, enabled: isOwner && signedIn, refetchInterval: LEDGER_EVERY },
      { ...reportPostsQuery(), enabled: isOwner && signedIn, refetchInterval: LEDGER_EVERY },
      { ...reportChangesQuery(), enabled: isOwner && signedIn, refetchInterval: LEDGER_EVERY },
      { ...customsQuery, enabled: signedIn, refetchInterval: MINUTE },
      { ...heldSendsQuery(), enabled: signedIn, refetchInterval: MINUTE },
      // The page's own count of held sends: Hub cuts it (the list of every page above says what the others hold).
      { ...heldSendsQuery({ limit: 1, offset: 0, pageLabel: page ?? "" }), enabled: signedIn && page !== null, refetchInterval: MINUTE },
    ],
  });
  if (active === true) {
    const retryMatters = () => void fromMatters.refetch();
    const data = fromMatters.data?.decisions;
    if (!data) {
      const failed = fromMatters.isError ? [...DECISION_QUEUES] : [];
      return { questions: null, reports: null, reportParts: null, customs: null, held: null, total: 0, page, elsewhere: 0, loading: fromMatters.isLoading, settled: fromMatters.isError, failed, complete: false, retry: retryMatters };
    }
    return { ...data, page, loading: false, settled: true, failed: [...data.failed], complete: data.failed.length === 0, retry: retryMatters };
  }
  const heldRead = page === null ? held : heldOnPage;
  const loading = questions.isLoading || posts.isLoading || changes.isLoading || customs.isLoading || held.isLoading || (page !== null && heldOnPage.isLoading);
  const retry = () => {
    for (const query of [questions, posts, changes, customs, held, heldOnPage]) if (query.isError) void query.refetch();
  };
  // Not signed in yet: the queues are not even asked, nothing is settled.
  const settled = signedIn && !loading;
  if (!settled) {
    return { questions: null, reports: null, reportParts: null, customs: null, held: null, total: 0, page, elsewhere: 0, loading, settled: false, failed: [], complete: false, retry };
  }
  const onPage = (label: string) => page === null || label === page;
  // Whether a post waits depends on the payouts' answer too (`reportsFrom`): without both, no count.
  const unparsed = posts.data && changes.data ? unparsedPostsToDecide(posts.data, changes.data) : undefined;
  const pending = changes.data ? pendingChangesOf(changes.data) : undefined;
  const paidCustoms = customs.data?.customs.filter((custom) => custom.state === "paid");
  const reportParts = unparsed && pending ? { posts: unparsed.filter((post) => postOnPage(post, page)).length, changes: pending.length } : null;
  // Only the questions that wait for the owner: the chatters' own are not his decision.
  const ownerQuestions = questions.data?.owner;
  const counts = {
    questions: ownerQuestions ? ownerQuestions.filter((question) => questionOnPage(question, page)).length : null,
    reports: reportParts === null ? null : reportParts.posts + reportParts.changes,
    customs: paidCustoms ? paidCustoms.filter((custom) => onPage(custom.pageLabel)).length : null,
    held: heldRead.data ? heldRead.data.total : null,
  };
  const elsewhere = page === null ? 0 : (ownerQuestions ? ownerQuestions.length - (counts.questions ?? 0) : 0)
    + (unparsed && reportParts ? unparsed.length - reportParts.posts : 0)
    + (paidCustoms ? paidCustoms.length - (counts.customs ?? 0) : 0)
    + (held.data && counts.held !== null ? Math.max(0, held.data.total - counts.held) : 0);
  // Only a read that was asked and broke is a failure: a team lead's questions and reports are simply not theirs.
  const broke = { questions: questions.isError, reports: posts.isError || changes.isError, customs: customs.isError, held: heldRead.isError };
  const failed = DECISION_QUEUES.filter((queue) => broke[queue] && counts[queue] === null);
  return {
    ...counts,
    reportParts,
    total: (counts.questions ?? 0) + (counts.reports ?? 0) + (counts.customs ?? 0) + (counts.held ?? 0),
    page,
    elsewhere,
    loading,
    settled,
    failed,
    complete: failed.length === 0,
    retry,
  };
}

/** One kind of what waits, as the «Ждут решения» line says it: «2 поста не разобраны», with its section on Решения. */
export interface DecisionPart {
  /** Unique within the parts: the queue, or the queue and its kind. */
  key: string;
  queue: DecisionQueue;
  count: number;
  /** «2 вопроса чья продажа» · «1 пост не разобран» · «1 выплаченный день изменён» · «2 кастома оплачены и не отданы» · «3 отправки зависли». */
  text: string;
  /** `/decisions?week=…&page=…#customs`: Решения with this period and page, at the section. */
  to: string;
}

/** The queues that wait (zero ones left out), in the screen's order, each with its words and its link. */
export function decisionParts(counts: Pick<DecisionCounts, "questions" | "reportParts" | "customs" | "held">, search: URLSearchParams | string): DecisionPart[] {
  const carried = carryParams(search).toString();
  const to = (queue: DecisionQueue) => `/decisions${carried ? `?${carried}` : ""}#${queue}`;
  const parts: DecisionPart[] = [];
  const add = (queue: DecisionQueue, count: number | null, words: (n: number) => string, kind = "") => {
    if (count) parts.push({ key: kind ? `${queue}:${kind}` : queue, queue, count, text: `${formatCount(count)} ${words(count)}`, to: to(queue) });
  };
  add("questions", counts.questions, (n) => ruPlural(n, "вопрос чья\u00a0продажа", "вопроса чья\u00a0продажа", "вопросов чья\u00a0продажа"));
  add("reports", counts.reportParts?.posts ?? null, (n) => ruPlural(n, "пост не разобран", "поста не разобраны", "постов не разобраны"), "posts");
  add("reports", counts.reportParts?.changes ?? null, (n) => ruPlural(n, "выплаченный день изменён", "выплаченных дня изменены", "выплаченных дней изменены"), "changes");
  add("customs", counts.customs, (n) => ruPlural(n, "кастом оплачен и не отдан", "кастома оплачены и не отданы", "кастомов оплачены и не отданы"));
  add("held", counts.held, (n) => ruPlural(n, "отправка зависла", "отправки зависли", "отправок зависли"));
  return parts;
}

const FAILED_WORD: Record<DecisionQueue, string> = { questions: "вопросы «чья\u00a0продажа»", reports: "отчёты", customs: "кастомы", held: "зависшие отправки" };

/**
 * «Не удалось проверить решения» when nothing answered; «Не удалось проверить
 * споры и кастомы» when only some did. null when nothing failed.
 */
export function decisionsFailedText(counts: Pick<DecisionCounts, "failed" | "questions" | "reports" | "customs" | "held">): string | null {
  if (counts.failed.length === 0) return null;
  const answered = DECISION_QUEUES.filter((queue) => counts[queue] !== null).length;
  if (answered === 0) return "Не удалось проверить решения";
  const words = counts.failed.map((queue) => FAILED_WORD[queue]);
  return `Не удалось проверить ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} и ${words.at(-1)}`}`;
}

/** «ещё 4 на других страницах» — the tail of a page's counts; null at zero. */
export function decisionsElsewhereText(elsewhere: number): string | null {
  return elsewhere > 0 ? `ещё ${formatCount(elsewhere)} на других страницах` : null;
}
