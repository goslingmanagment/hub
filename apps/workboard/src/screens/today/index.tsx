import { Suspense } from "react";
import { Skeleton } from "@agency_hub_core/ui";
import { formatWeekdayDay } from "@agency_hub_core/ui/format";
import { leadOnly } from "@/shared/leadOnly";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMe } from "@/shared/useMe";
import { OwnToday } from "./Own";
import "./today.css";

/**
 * «Сегодня» — Workboard's home for every role (products plan §2.3, package W): one screen, the role changes what is in
 * it. A chatter: their own day (Own.tsx). Whoever leads a team: the teams first (Team.tsx, behind the lead boundary: a
 * narrow session leads nothing), then their own shifts if they work any.
 */
const TeamToday = leadOnly(() => import("./Team.js").then((module) => ({ default: module.TeamToday })));

export function TodayScreen() {
  const { leadsTeam } = useMe();
  return (
    <>
      <ScreenHeader title="Сегодня" meta={<span>{formatWeekdayDay(new Date())}</span>} />
      <div className="wb-content today">
        {leadsTeam && (
          <Suspense fallback={<Skeleton height={160} radius={12} />}>
            <TeamToday />
          </Suspense>
        )}
        <OwnToday leader={leadsTeam} />
      </div>
    </>
  );
}
