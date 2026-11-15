import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { ErrorState, Skeleton } from "@agency_hub_core/ui";
import { groupOfAnchor } from "@agency_hub_core/ui/waiting/kinds";
import { WaitingList, waitingSummary, type WaitingContext, type WaitingListProps } from "@agency_hub_core/ui/waiting/WaitingList";
import { kernel } from "@/api/sdk";
import { PageHeader } from "@/components/ui/PageHeader";
import { usePageFilter } from "@/components/layout/usePageFilter";

const MINUTE = 60_000;

/** Workboard's list, where its windows open (a dispute, «мимо площадки», a held send): one step, signed in. */
const WORKBOARD_WAITING = "/workboard/waiting";

/**
 * A matter's link from Hub: Hub's own paths open here; a Workboard address is a page load on Hub's name, which Hub's
 * server hands to the team's name signed in (signin-handoff.ts); ContentOps' is its own site.
 */
function hubLink(link: string, children: ReactNode): ReactNode {
  return <a href={link} className="wt-go">{children}</a>;
}

/**
 * The owner's «Ждут вас» in Hub (products plan §2.2, §4.4): the whole list, grouped «Hub · Workboard · ContentOps» —
 * the same list Workboard draws (packages/ui waiting/WaitingList.tsx) over the same reads, never a second count. A Hub
 * matter is decided from here; a line of another product opens that product on the matter: Workboard's windows by
 * Workboard's address with the window's parameter, ContentOps' at its place. The menu's number is the same read's.
 */
export function WaitingPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { page, select } = usePageFilter();
  const list = useQuery({
    queryKey: ["matters", "list", "open"],
    queryFn: () => kernel.mattersList({ query: { state: "open", limit: 500 } }),
    refetchInterval: MINUTE,
  });
  const waitingRead = useQuery({ queryKey: ["matters", "waiting", ""], queryFn: () => kernel.mattersWaiting({ query: {} }), refetchInterval: MINUTE });
  const matters = list.data?.matters ?? [];
  const has = (kind: string) => matters.some((matter) => matter.kind === kind);
  // The question's words and the held send's parts make the line say what it is about.
  const questions = useQuery({ queryKey: ["decisions", "sale-questions"], queryFn: () => kernel.teamLedgerQuestions(), enabled: has("ledger.sale_question"), refetchInterval: 5 * MINUTE });
  const held = useQuery({
    queryKey: ["decisions", "held", { limit: 100, offset: 0 }],
    queryFn: () => kernel.clientSendCustodyList({ query: { state: "held", limit: 100, offset: 0 } }),
    enabled: has("send.held"),
    refetchInterval: MINUTE,
  });
  const toWorkboard = (param: string, value: string, group: string) => {
    window.location.assign(`${WORKBOARD_WAITING}?${new URLSearchParams({ [param]: value }).toString()}#${group}`);
  };
  const context: WaitingContext = {
    question: (id) => questions.data?.owner.find((one) => one.id === id),
    held: (id) => held.data?.items.find((one) => one.attemptId === id),
    fanOf: () => undefined,
    openSend: (id) => toWorkboard("send", id, "held"),
    open: (param, value) => toWorkboard(param, value, param === "offPlatform" ? "reports" : "questions"),
    link: hubLink,
  };
  const now = list.data ? Date.parse(list.data.serverNow) : Date.now();
  const props: WaitingListProps = {
    matters, kinds: list.data?.kinds ?? [], now, customOrders: waitingRead.data?.customOrders ?? 0,
    page, only: groupOfAnchor(location.hash), context, byProduct: true,
  };
  const { waiting, info, elsewhere, onlyTitle } = waitingSummary(props);
  const description = list.isLoading ? <Skeleton width={260} /> : (
    <>
      {onlyTitle !== null ? (
        <>
          Только «{onlyTitle}» ·{" "}
          <button type="button" className="wt-link" onClick={() => navigate({ search: location.search, hash: "" }, { replace: true })}>показать всё</button>
        </>
      ) : waiting + info > 0 ? "Всё, что ждёт вас, по продуктам. Сначала то, что ждёт дольше. Время московское" : null}
      {elsewhere > 0 && (
        <>
          {" · "}
          <button type="button" className="wt-link" onClick={() => select(null)}>ещё {elsewhere} на других страницах</button>
        </>
      )}
    </>
  );
  return (
    <div className="wt-content">
      <PageHeader
        description={description}
        fresh={list.dataUpdatedAt ? { at: list.dataUpdatedAt, onRefresh: () => void list.refetch(), refreshing: list.isFetching } : undefined}
      />
      {list.isLoading ? (
        <div className="wt-sheet" aria-busy>
          {[0, 1, 2].map((key) => <div key={key} className="wt-line wt-line--skeleton"><Skeleton width="60%" /><Skeleton width={48} /><span /></div>)}
        </div>
      ) : list.isError && !list.data ? (
        <ErrorState onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <WaitingList {...props} />
      )}
    </div>
  );
}
