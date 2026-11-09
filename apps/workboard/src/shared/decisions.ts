import { queryOptions, useQueries } from "@tanstack/react-query";
import { formatCount } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { kernel } from "./hub.js";
import { carryParams } from "./links.js";
import { useMe } from "./useMe.js";

/**
 * What waits for the owner's decision (spec §4.6), from the operations Hub has
 * today. One set of query keys for the sidebar's count, the «Ждут решения» line
 * on Смены and the Решения screen itself: a decision made there moves the count
 * at once. Read at most once a minute and only while the tab is visible.
 *
 * A queue that did not answer is not a zero (spec r3, D17): the counts say which
 * failed (`failed`), and the words for it are here (`decisionsFailedText`).
 */

const MINUTE = 60_000;

/** The longest window `teamShiftDisputes` takes (the console says «за 31 день»). */
export const DISPUTE_DAYS = 31;

/** Disputed sales of the shift reports (`teamShiftDisputes`); the owner's only. */
export const disputesQuery = queryOptions({
  queryKey: ["decisions", "disputes", DISPUTE_DAYS] as const,
  queryFn: () => kernel.teamShiftDisputes({ query: { days: DISPUTE_DAYS } }),
  staleTime: MINUTE,
});

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

/** The three queues of Решения, in the screen's order; each is a section there (`#disputes`, `#customs`, `#held`). */
export const DECISION_QUEUES = ["disputes", "customs", "held"] as const;
export type DecisionQueue = (typeof DECISION_QUEUES)[number];

export interface DecisionCounts {
  /**
   * Disputes without a resolution — on the chosen page (`page`), on every page
   * without one. null: not read (failed, still loading, or not the owner's to see).
   */
  disputes: number | null;
  /** Customs paid and not delivered, the same way. */
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
   * then all three are null and `total` is 0, so the sidebar's badge and the
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
  const signedIn = user !== undefined;
  const [disputes, customs, held, heldOnPage] = useQueries({
    queries: [
      { ...disputesQuery, enabled: isOwner, refetchInterval: MINUTE },
      { ...customsQuery, enabled: signedIn, refetchInterval: MINUTE },
      { ...heldSendsQuery(), enabled: signedIn, refetchInterval: MINUTE },
      // The page's own count of held sends: Hub cuts it (the list of every page above says what the others hold).
      { ...heldSendsQuery({ limit: 1, offset: 0, pageLabel: page ?? "" }), enabled: signedIn && page !== null, refetchInterval: MINUTE },
    ],
  });
  const reads = { disputes, customs, held: page === null ? held : heldOnPage };
  const loading = disputes.isLoading || customs.isLoading || held.isLoading || (page !== null && heldOnPage.isLoading);
  const retry = () => {
    for (const query of [disputes, customs, held, heldOnPage]) if (query.isError) void query.refetch();
  };
  // Not signed in yet: the queues are not even asked, nothing is settled.
  const settled = signedIn && !loading;
  if (!settled) {
    return { disputes: null, customs: null, held: null, total: 0, page, elsewhere: 0, loading, settled: false, failed: [], complete: false, retry };
  }
  const onPage = (label: string) => page === null || label === page;
  const openDisputes = disputes.data?.disputes.filter((dispute) => dispute.resolution === null);
  const paidCustoms = customs.data?.customs.filter((custom) => custom.state === "paid");
  const counts = {
    disputes: openDisputes ? openDisputes.filter((dispute) => onPage(dispute.pageLabel)).length : null,
    customs: paidCustoms ? paidCustoms.filter((custom) => onPage(custom.pageLabel)).length : null,
    held: reads.held.data ? reads.held.data.total : null,
  };
  const elsewhere = page === null ? 0 : (openDisputes ? openDisputes.length - (counts.disputes ?? 0) : 0)
    + (paidCustoms ? paidCustoms.length - (counts.customs ?? 0) : 0)
    + (held.data && counts.held !== null ? Math.max(0, held.data.total - counts.held) : 0);
  // Only a read that was asked and broke is a failure: a team lead's disputes are simply not theirs.
  const failed = DECISION_QUEUES.filter((queue) => reads[queue].isError && counts[queue] === null);
  return {
    ...counts,
    total: (counts.disputes ?? 0) + (counts.customs ?? 0) + (counts.held ?? 0),
    page,
    elsewhere,
    loading,
    settled,
    failed,
    complete: failed.length === 0,
    retry,
  };
}

/** One queue that waits, as the «Ждут решения» line says it: «2 спора по продажам», with its section on Решения. */
export interface DecisionPart {
  queue: DecisionQueue;
  count: number;
  /** «1 спор по продажам» · «2 кастома оплачены и не отданы» · «3 отправки зависли». */
  text: string;
  /** `/decisions?week=…&page=…#customs`: Решения with this period and page, at the section. */
  to: string;
}

/** The queues that wait (zero ones left out), in the screen's order, each with its words and its link. */
export function decisionParts(counts: Pick<DecisionCounts, "disputes" | "customs" | "held">, search: URLSearchParams | string): DecisionPart[] {
  const carried = carryParams(search).toString();
  const to = (queue: DecisionQueue) => `/decisions${carried ? `?${carried}` : ""}#${queue}`;
  const parts: DecisionPart[] = [];
  const add = (queue: DecisionQueue, count: number | null, words: (n: number) => string) => {
    if (count) parts.push({ queue, count, text: `${formatCount(count)} ${words(count)}`, to: to(queue) });
  };
  add("disputes", counts.disputes, (n) => `${ruPlural(n, "спор", "спора", "споров")} по продажам`);
  add("customs", counts.customs, (n) => ruPlural(n, "кастом оплачен и не отдан", "кастома оплачены и не отданы", "кастомов оплачены и не отданы"));
  add("held", counts.held, (n) => ruPlural(n, "отправка зависла", "отправки зависли", "отправок зависли"));
  return parts;
}

const FAILED_WORD: Record<DecisionQueue, string> = { disputes: "споры", customs: "кастомы", held: "зависшие отправки" };

/**
 * «Не удалось проверить решения» when nothing answered; «Не удалось проверить
 * споры и кастомы» when only some did. null when nothing failed.
 */
export function decisionsFailedText(counts: Pick<DecisionCounts, "failed" | "disputes" | "customs" | "held">): string | null {
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
