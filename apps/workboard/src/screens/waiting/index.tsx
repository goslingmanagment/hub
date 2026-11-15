import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, ErrorState, Skeleton } from "@agency_hub_core/ui";
import { groupOfAnchor } from "@agency_hub_core/ui/waiting/kinds";
import { WaitingList, waitingSummary, type WaitingContext, type WaitingListProps } from "@agency_hub_core/ui/waiting/WaitingList";
import { heldSendsQuery, saleQuestionsQuery } from "@/shared/decisions";
import { mattersListQuery, mattersWaitingQuery } from "@/shared/matters";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePages } from "@/shared/usePages";
import { ResolveSendModal } from "../decisions/HeldSends";
import { DisputeModal, NobodyModal, OffPlatformModal, UnlinkedModal } from "./Disputes";
import { goLink } from "./links";
import { ClaimAnswer } from "./MyMatters";
import { AskModal, MyOpenQuestions, QuestionModal, useMyOpenQuestions } from "./Questions";
import { useFanNames, type FanRefOnPage, type HeldSend } from "../decisions/data";

/**
 * Workboard's «Ждут вас»: the one list (packages/ui waiting/WaitingList.tsx) over the viewer's matters, with
 * Workboard's windows (a dispute, «мимо площадки», a held send) opened in place by the address. The owner's list here
 * is Workboard's part; everything else waits in Hub's «Ждут вас». The address is `/waiting` (`/decisions` leads
 * here): its anchors open one group alone; `?send=` opens a held send's resolve, as before.
 */

const MINUTE = 60_000;

export function WaitingScreen() {
  const { isOwner } = useMe();
  const { page, setPage } = usePageFilter();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const pages = usePages();
  const list = useQuery({ ...mattersListQuery, refetchInterval: MINUTE });
  // «Ждут вас» by its groups: the custom orders, a count without matters, are a line here too.
  const waitingRead = useQuery({ ...mattersWaitingQuery(), refetchInterval: MINUTE });
  const matters = list.data?.matters ?? [];
  const has = (kind: string) => matters.some((matter) => matter.kind === kind);
  const attemptId = search.get("send");
  // Вопросы тому, кто решает (products plan §4.6): «Спросить», a question by the address, the asker's open ones.
  const questionParam = Number(search.get("question"));
  const asking = search.get("ask") !== null;
  const myQuestions = useMyOpenQuestions();

  // What a line needs beyond its matter: the question's words, the held send itself.
  const questions = useQuery({ ...saleQuestionsQuery, enabled: isOwner && has("ledger.sale_question"), refetchInterval: 5 * MINUTE });
  const held = useQuery({ ...heldSendsQuery({ limit: 100, offset: 0 }), enabled: has("send.held") || attemptId !== null, refetchInterval: MINUTE });
  const fans: FanRefOnPage[] = [
    ...(questions.data?.owner ?? []).flatMap((question) => (question.fanRef === null || question.pageLabel === "" ? [] : [{ pageLabel: question.pageLabel, fanRef: question.fanRef }])),
    ...(held.data?.items ?? []),
  ];
  const fanOf = useFanNames(fans);

  const setSend = (value: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete("send");
    else next.set("send", value);
    return next;
  });
  const setParam = (param: string, value: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete(param);
    else next.set(param, value);
    return next;
  });
  const context: WaitingContext = {
    question: (id) => questions.data?.owner.find((one) => one.id === id),
    held: (id) => held.data?.items.find((one) => one.attemptId === id),
    fanOf,
    openSend: (id) => setSend(id),
    open: (param, value) => setParam(param, value),
    link: goLink,
    answerClaim: (claimId) => <ClaimAnswer claimId={claimId} />,
  };
  // Package G's windows, by the address (a matter's link lands on its window).
  const disputeParam = Number(search.get("dispute"));
  const claimParam = Number(search.get("claim"));
  const offPlatformParam = Number(search.get("offPlatform"));
  const nobodyParam = search.get("nobody");
  const unlinkedParam = search.get("unlinked") !== null;
  // The open resolve keeps the record it was opened with while Hub answers: a refused write re-reads the held sends,
  // and the send may leave them — the window's words about the refusal stay readable.
  const lastSend = useRef<HeldSend | null>(null);
  const foundSend = attemptId ? held.data?.items.find((one) => one.attemptId === attemptId) : undefined;
  if (foundSend) lastSend.current = foundSend;
  const openSend = foundSend ?? (attemptId && lastSend.current?.attemptId === attemptId ? lastSend.current : undefined);
  const platformOf = (label: string) => pages.data?.find((one) => one.label === label)?.platform;

  const now = list.data ? Date.parse(list.data.serverNow) : Date.now();
  const only = groupOfAnchor(location.hash);
  const listProps: WaitingListProps = {
    matters: list.data?.matters ?? [], kinds: list.data?.kinds ?? [], now, customOrders: waitingRead.data?.customOrders ?? 0,
    page, only, context, ...(isOwner ? { cut: "workboard" as const } : {}),
  };
  const { waiting: waitingCount, info: infoCount, elsewhere, onlyTitle } = waitingSummary(listProps);

  // A link with an anchor lands at its group once the list has answered.
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (list.isLoading || location.hash === "" || jumped.current === location.key) return;
    jumped.current = location.key;
    window.scrollTo({ top: 0 });
  }, [list.isLoading, location.hash, location.key]);

  const meta = list.isLoading ? <Skeleton width={260} /> : (
    <>
      {onlyTitle !== null ? (
        <>
          Только «{onlyTitle}» ·{" "}
          <button type="button" className="wt-link" onClick={() => navigate({ search: location.search, hash: "" }, { replace: true })}>показать всё</button>
        </>
      ) : waitingCount + infoCount > 0 ? "Сначала то, что ждёт дольше. Время московское" : null}
      {elsewhere > 0 && (
        <>
          {" · "}
          <button type="button" className="wt-link" onClick={() => setPage(null)}>
            ещё {elsewhere} на других страницах
          </button>
        </>
      )}
    </>
  );

  return (
    <>
      <ScreenHeader
        title="Ждут вас"
        pageFilter
        // The owner decides, he does not ask: «Спросить» is everyone else's.
        {...(isOwner ? {} : { actions: <Button size="sm" onClick={() => setParam("ask", "1")}>Спросить</Button> })}
        meta={meta}
        updatedAt={list.dataUpdatedAt}
        stale={list.isRefetchError}
        onRefresh={() => void list.refetch()}
        refreshing={list.isFetching}
      />
      <div className="wb-content wt-content">
        {list.isLoading ? (
          <div className="wt-sheet" aria-busy>
            {[0, 1, 2].map((key) => <div key={key} className="wt-line wt-line--skeleton"><Skeleton width="60%" /><Skeleton width={48} /><span /></div>)}
          </div>
        ) : list.isError && !list.data ? (
          <ErrorState onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <>
            <MyOpenQuestions questions={myQuestions} onOpen={(id) => setParam("question", String(id))} />
            <WaitingList {...listProps} />
          </>
        )}
      </div>
      {/* A dispute is its decider's: the owner, or the lead of the sale's team (Hub answers anyone else 403). */}
      {(Number.isSafeInteger(disputeParam) && disputeParam > 0 || Number.isSafeInteger(claimParam) && claimParam > 0) && (
        <DisputeModal
          key={`${disputeParam}:${claimParam}`}
          transactionId={disputeParam > 0 ? disputeParam : null}
          claimId={disputeParam > 0 ? null : claimParam}
          onClose={() => { setParam("dispute", null); setParam("claim", null); }}
        />
      )}
      {isOwner && Number.isSafeInteger(offPlatformParam) && offPlatformParam > 0 && (
        <OffPlatformModal key={offPlatformParam} shiftId={offPlatformParam} onClose={() => setParam("offPlatform", null)} />
      )}
      {isOwner && nobodyParam !== null && /^\d{4}-\d{2}-\d{2}$/.test(nobodyParam) && <NobodyModal key={nobodyParam} week={nobodyParam} onClose={() => setParam("nobody", null)} />}
      {isOwner && unlinkedParam && <UnlinkedModal onClose={() => setParam("unlinked", null)} />}
      {Number.isSafeInteger(questionParam) && questionParam > 0 && (
        <QuestionModal key={questionParam} id={questionParam} onClose={() => setParam("question", null)} />
      )}
      {asking && <AskModal onClose={() => setParam("ask", null)} />}
      {openSend && held.data && (
        <ResolveSendModal
          key={openSend.attemptId}
          item={openSend}
          serverNow={held.data.serverNow}
          platform={platformOf(openSend.pageLabel)}
          fan={fanOf(openSend)}
          onClose={() => setSend(null)}
        />
      )}
    </>
  );
}
