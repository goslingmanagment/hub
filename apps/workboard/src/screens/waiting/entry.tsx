import { Suspense, useMemo } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ErrorState, Skeleton } from "@agency_hub_core/ui";
import { groupOfAnchor } from "@agency_hub_core/ui/waiting/kinds";
import { WaitingList, type WaitingContext } from "@agency_hub_core/ui/waiting/WaitingList";
import { leadOnly } from "@/shared/leadOnly";
import { mattersListQuery } from "@/shared/myMatters";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMe } from "@/shared/useMe";
import { goLink } from "./links";
import { ClaimAnswer } from "./MyMatters";

/**
 * «Ждут вас» (products plan §2.3, §4.4): one menu item for every role. Whoever leads a team (the owner, a team lead, a
 * chatter who leads by the records) gets the team's list with its windows (disputes, held sends); anyone else, a
 * chatter and every narrow session from the extension, their own list: a colleague's question on their sale answered in
 * the line, a report to confirm, a post to fix, customs to give. The same list component and the same groups.
 */
const TeamWaiting = leadOnly(() => import("./index.js").then((module) => ({ default: module.WaitingScreen })));

const MINUTE = 60_000;

const NOTHING_TO_OPEN = () => undefined;

function OwnWaiting() {
  const location = useLocation();
  const list = useQuery({ ...mattersListQuery, refetchInterval: MINUTE });
  const context: WaitingContext = useMemo(() => ({
    question: NOTHING_TO_OPEN,
    held: NOTHING_TO_OPEN,
    fanOf: NOTHING_TO_OPEN,
    openSend: () => undefined,
    open: () => undefined,
    link: goLink,
    answerClaim: (claimId) => <ClaimAnswer claimId={claimId} />,
  }), []);
  const now = list.data ? Date.parse(list.data.serverNow) : Date.now();
  return (
    <>
      <ScreenHeader
        title="Ждут вас"
        meta={list.isLoading ? <Skeleton width={260} /> : "Сначала то, что ждёт дольше. Время московское"}
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
          <WaitingList
            matters={(list.data?.matters ?? []).filter((matter) => matter.mine)}
            kinds={list.data?.kinds ?? []}
            now={now}
            customOrders={0}
            page={null}
            only={groupOfAnchor(location.hash)}
            context={context}
          />
        )}
      </div>
    </>
  );
}

export function WaitingEntry() {
  const { leadsTeam } = useMe();
  if (!leadsTeam) return <OwnWaiting />;
  return (
    <Suspense fallback={<div className="wb-content"><Skeleton height={320} radius={12} /></div>}>
      <TeamWaiting />
    </Suspense>
  );
}
