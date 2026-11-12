import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { LinkButton, Tooltip } from "@agency_hub_core/ui";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import { addDays, moscowDayOf } from "@agency_hub_core/ui/moscow";
import { kernel } from "@/shared/hub";
import { useBackState } from "@/shared/links";

/**
 * «Отчёт смены» beside the review (ecosystem package F): the shift's report in
 * Hub and its state, one press away — read, never changed, from here. Shown only
 * when the person hands shifts in in Hub (their switch is on) and this shift
 * began after it; otherwise nothing, as before.
 */
export function ReportLink({ userId, start, end, label }: { userId: number; start: number; end: number; label: string }) {
  const day = moscowDayOf(start);
  const read = useQuery({
    queryKey: ["review", "report", userId, day],
    queryFn: () => kernel.shiftReportsList({ query: { userId, from: addDays(day, -1), to: day } }),
    staleTime: 60_000,
  });
  const back = useBackState(label);
  const list = read.data;
  if (!list?.enabled || list.enabledSince === null) return null;
  const since = Date.parse(list.enabledSince);
  const row = list.shifts
    .filter((one) => Date.parse(one.startedAt) >= since)
    .map((one) => ({ one, overlap: Math.min(end, Math.max(Date.parse(one.endedAt), Date.parse(one.startedAt) + 1)) - Math.max(start, Date.parse(one.startedAt)) }))
    .filter((pair) => pair.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)[0]?.one;
  if (row === undefined) return null;
  const state = row.state === "submitted" && row.submittedAt !== null ? `сдан в ${formatTimeOfDay(row.submittedAt)}` : row.ongoing ? "смена идёт" : "не сдан";
  return (
    <Tooltip content={`Отчёт смены: ${state}`}>
      <LinkButton to={`/shifts/report/${row.shiftId}`} state={back} size="md" variant="secondary" icon={FileText}>
        Отчёт: {state}
      </LinkButton>
    </Tooltip>
  );
}
