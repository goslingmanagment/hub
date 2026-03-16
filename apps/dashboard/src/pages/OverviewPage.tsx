import { useNavigate } from "react-router";
import { useOverview, useOverviewRevenue } from "@/api/queries";
import { CONNECTION_STATUS_COLORS, PLATFORM_COLORS } from "@/lib/constants";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import { usePeriodStore } from "@/stores/periodStore";
import type { OverviewResponse } from "@agency_hub_core/contracts";

type OverviewPageItem = OverviewResponse["pages"][number];

const PERIOD_LABELS: Record<string, string> = {
  today: "Today",
  "7d": "7 Days",
  "30d": "30 Days",
  all: "All Time",
};

interface ModelGroup {
  modelSlug: string;
  modelName: string;
  pages: OverviewPageItem[];
}

function groupByModel(pages: OverviewPageItem[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const page of pages) {
    let group = map.get(page.modelSlug);
    if (!group) {
      group = { modelSlug: page.modelSlug, modelName: page.modelName, pages: [] };
      map.set(page.modelSlug, group);
    }
    group.pages.push(page);
  }
  return Array.from(map.values());
}

export function OverviewPage() {
  const navigate = useNavigate();
  const { period } = usePeriodStore();
  const selectedPeriod = period === "today" || period === "7d" || period === "30d" || period === "all" ? period : "30d";

  const { data, isLoading } = useOverview();
  const { data: revenueData } = useOverviewRevenue(selectedPeriod);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-text-muted text-sm">Loading...</span>
      </div>
    );
  }

  const pages = (data.pages ?? []) as OverviewPageItem[];
  const groups = groupByModel(pages);

  const revenueByPageId = new Map<number, number>();
  if (revenueData?.pages) {
    for (const rp of revenueData.pages) {
      revenueByPageId.set(rp.pageId, rp.netEarningsMills);
    }
  }

  const totalRevenue = revenueData?.netEarningsMills ?? 0;
  const totalSubs = pages.reduce((sum, p) => sum + (p.subscriberCount ?? 0), 0);
  const totalNewSubs = pages.reduce((sum, p) => sum + (p.newSubscribersToday ?? 0), 0);
  const totalNewFollowers = pages.reduce((sum, p) => sum + (p.newFollowersToday ?? 0), 0);

  const periodLabel = PERIOD_LABELS[selectedPeriod] ?? "30 Days";

  return (
    <div>
      <table className="w-full border-collapse overflow-hidden rounded-xl border border-border bg-card">
        <thead>
          <tr className="bg-hover-alt">
            <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted">
              Page
            </th>
            <th className="px-4 py-3 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
              {periodLabel}
            </th>
            <th className="px-4 py-3 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
              Subs
            </th>
            <th className="px-4 py-3 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
              Subs Today
            </th>
            <th className="px-4 py-3 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
              Followers Today
            </th>
            <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <ModelGroupRows
              key={group.modelSlug}
              group={group}
              navigate={navigate}
              revenueByPageId={revenueByPageId}
            />
          ))}
          <tr className="border-t-2 border-border bg-hover-alt">
            <td className="px-4 py-3 text-[15px] font-bold text-text-primary">Agency Total</td>
            <td className="px-4 py-3 text-right tabular-nums text-lg font-bold text-text-primary">
              {formatUsdFromMills(totalRevenue)}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[15px] font-bold text-text-primary">
              {totalSubs.toLocaleString()}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[15px] font-bold text-green">
              +{totalNewSubs}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[15px] font-bold text-green">
              +{totalNewFollowers}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ModelGroupRows({
  group,
  navigate,
  revenueByPageId,
}: {
  group: ModelGroup;
  navigate: ReturnType<typeof useNavigate>;
  revenueByPageId: Map<number, number>;
}) {
  const modelName = group.modelName;
  const groupRevenue = group.pages.reduce((sum, p) => sum + (revenueByPageId.get(p.id) ?? 0), 0);
  const groupSubs = group.pages.reduce((sum, p) => sum + (p.subscriberCount ?? 0), 0);
  const groupNewSubs = group.pages.reduce((sum, p) => sum + (p.newSubscribersToday ?? 0), 0);
  const groupNewFollowers = group.pages.reduce((sum, p) => sum + (p.newFollowersToday ?? 0), 0);

  return (
    <>
      <tr className="bg-hover-alt/50">
        <td className="px-4 pt-4 pb-2">
          <span className="text-accent font-bold">{modelName}</span>
          <span className="ml-2 text-text-muted text-xs">
            {group.pages.length} {group.pages.length === 1 ? "page" : "pages"}
          </span>
        </td>
        <td className="px-4 pt-4 pb-2 text-right tabular-nums text-[15px] font-semibold text-text-primary">
          {formatUsdFromMills(groupRevenue)}
        </td>
        <td className="px-4 pt-4 pb-2 text-right tabular-nums font-semibold">
          {groupSubs.toLocaleString()}
        </td>
        <td className="px-4 pt-4 pb-2 text-right tabular-nums font-semibold text-green">
          +{groupNewSubs}
        </td>
        <td className="px-4 pt-4 pb-2 text-right tabular-nums font-semibold text-green">
          +{groupNewFollowers}
        </td>
        <td />
      </tr>
      {group.pages.map((page) => {
        const platform = page.platform as keyof typeof PLATFORM_COLORS;
        const platformCfg = PLATFORM_COLORS[platform];
        const statusCfg = CONNECTION_STATUS_COLORS[page.connectionStatus] ?? {
          dot: "#a8a29e",
          label: page.connectionStatus,
        };
        const pageRevenue = revenueByPageId.get(page.id) ?? 0;
        const isFansly = page.platform === "fansly";

        return (
          <tr
            key={page.id}
            onClick={() => navigate(`/pages/${page.label}`)}
            className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
          >
            <td className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold text-text-primary">{page.label}</span>
                {platformCfg && (
                  <span
                    className="inline-block rounded-md px-2 py-0.5 font-semibold"
                    style={{ fontSize: 11, backgroundColor: platformCfg.bg, color: platformCfg.text }}
                  >
                    {platformCfg.label}
                  </span>
                )}
              </div>
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[15px] font-medium text-text-secondary">
              {formatUsdFromMills(pageRevenue)}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[15px] font-medium text-text-secondary">
              {(page.subscriberCount ?? 0).toLocaleString()}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[14px] font-bold text-green">
              +{page.newSubscribersToday ?? 0}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[14px]">
              {isFansly ? (
                <span className="font-bold text-green">+{page.newFollowersToday ?? 0}</span>
              ) : (
                <span className="text-text-muted">&mdash;</span>
              )}
            </td>
            <td className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: statusCfg.dot }}
                />
                <span className="text-sm text-text-secondary">{statusCfg.label}</span>
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
