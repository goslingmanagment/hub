import { Link, useNavigate } from "react-router";
import { useAuthMe, useOverview, useOverviewRevenue, useOverviewGrowth } from "@/api/queries";
import { getSyncUxTone } from "@/components/shared/SyncUxBadge";
import { getSyncUxDisplayMode, getSyncUxExceptionKind, getSyncUxSettingsTab } from "@/components/shared/syncUxDisplay";
import { buildSettingsRoute } from "@/lib/navigation";
import { PLATFORM_COLORS } from "@/lib/constants";
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

const GROWTH_PLACEHOLDER = "—";

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

function formatGrowthValue(value: number | null) {
  return value === null ? GROWTH_PLACEHOLDER : `+${value.toLocaleString()}`;
}

function getOverviewExceptionMessage(
  kind: NonNullable<ReturnType<typeof getSyncUxExceptionKind>>,
) {
  switch (kind) {
    case "credentials":
      return "Reconnect credentials to keep this page up to date.";
    case "off":
      return "Page updates are paused for this page.";
    case "attention":
      return "Recent page data may be incomplete while updates recover.";
  }
}

export function OverviewPage() {
  const navigate = useNavigate();
  const { data: auth } = useAuthMe();
  const { period } = usePeriodStore();
  const selectedPeriod = period === "today" || period === "7d" || period === "30d" || period === "all" ? period : "30d";

  const { data, isLoading: isOverviewLoading } = useOverview();
  const { data: revenueData } = useOverviewRevenue(selectedPeriod);
  const {
    data: growthData,
    isLoading: isGrowthLoading,
    isFetching: isGrowthFetching,
    isPlaceholderData: isGrowthPlaceholderData,
  } = useOverviewGrowth(selectedPeriod);
  const growthState = growthData && !isGrowthPlaceholderData
    ? "ready"
    : isGrowthLoading || isGrowthFetching
      ? "loading"
      : "idle";
  const growthReady = growthState === "ready";

  if (isOverviewLoading || !data) {
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

  const followersByPageId = new Map<number, number>();
  const subsByPageId = new Map<number, number>();
  if (growthData?.pages) {
    for (const gp of growthData.pages) {
      followersByPageId.set(gp.pageId, gp.newFollowers);
      subsByPageId.set(gp.pageId, gp.newSubscribers);
    }
  }

  const totalRevenue = revenueData?.netEarningsMills ?? 0;
  const totalSubs = pages.reduce((sum, p) => sum + (p.subscriberCount ?? 0), 0);
  const totalNewSubs = growthReady
    ? pages.reduce((sum, p) => sum + (subsByPageId.get(p.id) ?? 0), 0)
    : null;
  const totalNewFollowers = growthReady
    ? pages.reduce((sum, p) => sum + (followersByPageId.get(p.id) ?? 0), 0)
    : null;
  const isOwner = auth?.user.role === "owner";

  const periodLabel = PERIOD_LABELS[selectedPeriod] ?? "30 Days";

  return (
    <div>
      <table className="w-full border-collapse overflow-hidden rounded-xl border border-border bg-card">
        <colgroup>
          <col />
          <col className="w-[120px]" />
          <col className="w-[100px]" />
          <col className="w-[120px]" />
          <col className="w-[100px]" />
        </colgroup>
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
              Followers {periodLabel}
            </th>
            <th className="px-4 py-3 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
              Subs {periodLabel}
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
              followersByPageId={followersByPageId}
              subsByPageId={subsByPageId}
              growthReady={growthReady}
              isOwner={isOwner}
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
            <td
              className={`px-4 py-3 text-right tabular-nums text-[15px] font-bold ${
                totalNewFollowers === null ? "text-text-muted" : "text-green"
              }`}
            >
              {formatGrowthValue(totalNewFollowers)}
            </td>
            <td
              className={`px-4 py-3 text-right tabular-nums text-[15px] font-bold ${
                totalNewSubs === null ? "text-text-muted" : "text-green"
              }`}
            >
              {formatGrowthValue(totalNewSubs)}
            </td>
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
  followersByPageId,
  subsByPageId,
  growthReady,
  isOwner,
}: {
  group: ModelGroup;
  navigate: ReturnType<typeof useNavigate>;
  revenueByPageId: Map<number, number>;
  followersByPageId: Map<number, number>;
  subsByPageId: Map<number, number>;
  growthReady: boolean;
  isOwner: boolean;
}) {
  const modelName = group.modelName;
  const groupRevenue = group.pages.reduce((sum, p) => sum + (revenueByPageId.get(p.id) ?? 0), 0);
  const groupSubs = group.pages.reduce((sum, p) => sum + (p.subscriberCount ?? 0), 0);
  const groupNewSubs = growthReady
    ? group.pages.reduce((sum, p) => sum + (subsByPageId.get(p.id) ?? 0), 0)
    : null;
  const groupNewFollowers = growthReady
    ? group.pages.reduce((sum, p) => sum + (followersByPageId.get(p.id) ?? 0), 0)
    : null;

  return (
    <>
      <tr className="bg-hover-alt/50">
        <td className="px-4 pt-4 pb-2">
          <span className="text-accent font-bold">{modelName}</span>
          <span className="ml-2 text-text-muted text-xs">
            {group.pages.length} {group.pages.length === 1 ? "page" : "pages"}
          </span>
        </td>
        <td className="px-4 pt-4 pb-2 text-right tabular-nums text-[15px] font-semibold text-accent">
          {formatUsdFromMills(groupRevenue)}
        </td>
        <td className="px-4 pt-4 pb-2 text-right tabular-nums font-semibold">
          {groupSubs.toLocaleString()}
        </td>
        <td
          className={`px-4 pt-4 pb-2 text-right tabular-nums font-semibold ${
            groupNewFollowers === null ? "text-text-muted" : "text-green"
          }`}
        >
          {formatGrowthValue(groupNewFollowers)}
        </td>
        <td
          className={`px-4 pt-4 pb-2 text-right tabular-nums font-semibold ${
            groupNewSubs === null ? "text-text-muted" : "text-green"
          }`}
        >
          {formatGrowthValue(groupNewSubs)}
        </td>
      </tr>
      {group.pages.map((page) => {
        const platform = page.platform as keyof typeof PLATFORM_COLORS;
        const platformCfg = PLATFORM_COLORS[platform];
        const pageRevenue = revenueByPageId.get(page.id) ?? 0;
        const isFansly = page.platform === "fansly";
        const pageFollowers = growthReady ? (followersByPageId.get(page.id) ?? 0) : null;
        const pageSubscribers = growthReady ? (subsByPageId.get(page.id) ?? 0) : null;
        const syncMode = getSyncUxDisplayMode(page.syncUx, "overview_row");
        const exceptionKind = getSyncUxExceptionKind(page.syncUx);
        const exceptionTab = getSyncUxSettingsTab(page.syncUx);
        const tone = getSyncUxTone(page.syncUx.state);

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
              {syncMode === "exception" && exceptionKind && (
                <div className={`mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[12px] ${tone.panel}`}>
                  <span className={`font-medium ${tone.text}`}>
                    {getOverviewExceptionMessage(exceptionKind)}
                  </span>
                  {isOwner && exceptionTab && (
                    <Link
                      to={buildSettingsRoute(exceptionTab)}
                      onClick={(event) => event.stopPropagation()}
                      className="font-semibold text-accent hover:underline"
                    >
                      {exceptionTab === "credentials" ? "Open Credentials" : "Open Sync"}
                    </Link>
                  )}
                </div>
              )}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[15px] font-medium text-text-secondary">
              {formatUsdFromMills(pageRevenue)}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[15px] font-medium text-text-secondary">
              {(page.subscriberCount ?? 0).toLocaleString()}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[14px]">
              {isFansly ? (
                <span className={pageFollowers === null ? "text-text-muted" : "font-bold text-green"}>
                  {formatGrowthValue(pageFollowers)}
                </span>
              ) : (
                <span className="text-text-muted">{GROWTH_PLACEHOLDER}</span>
              )}
            </td>
            <td
              className={`px-4 py-3 text-right tabular-nums text-[14px] font-bold ${
                pageSubscribers === null ? "text-text-muted" : "text-green"
              }`}
            >
              {formatGrowthValue(pageSubscribers)}
            </td>
          </tr>
        );
      })}
    </>
  );
}
