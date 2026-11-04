import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { statsDays, type CreatorStatsDays } from "@/api/creator-stats";
import type { PeriodKey } from "@/lib/period";

export interface StatsPage {
  /** The Fansly page shown. The frame (PageScopeGate) renders a screen only once
   *  it has one: substituted when the filter says every page, never another
   *  platform's (design/screens/stats.md §1.2). */
  pageLabel: string;
  days: CreatorStatsDays;
  periodKey: PeriodKey;
  /** The frame says «Статистика только по одной странице. Показана …»: one notice taken. */
  substituted: boolean;
}

/**
 * The page and the period of a «Статистика» screen. Reads only: these screens
 * write nothing, so taking the page from the filter is allowed here and nowhere
 * else (ia.md §0, п. 8). A choice by hand goes through the chip or the panel.
 */
export function useStatsPage(): StatsPage {
  const filter = usePageFilter();
  const { days, key } = useScreenPeriod();
  return {
    pageLabel: filter.page ?? "",
    days: statsDays(days),
    periodKey: key,
    substituted: filter.page !== null && filter.remembered === null && !filter.outOfScope,
  };
}
