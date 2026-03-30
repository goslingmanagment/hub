import { useMemo, useState } from "react";
import { useParams, Navigate } from "react-router";
import { useOverview, useWorkboard, useWorkboardSnooze, useWorkboardUnsnooze } from "@/api/queries";
import { SubscriberCard, SpenderCard } from "@/components/page/workboard/WorkboardCard";
import { SnoozedSection } from "@/components/page/workboard/SnoozedSection";
import {
  mapSubscriberVm,
  mapSpenderVm,
  mapSnoozedVm,
} from "./workboard/viewModel.js";

type Tab = "subscribers" | "activeSpenders" | "inactiveSpenders";

const TAB_LABELS: Record<Tab, string> = {
  subscribers: "Subscribers",
  activeSpenders: "Active spenders",
  inactiveSpenders: "Inactive spenders",
};

const TABS: Tab[] = ["subscribers", "activeSpenders", "inactiveSpenders"];

export function WorkboardPage() {
  const { pageLabel } = useParams();
  const { data: overview } = useOverview();
  const page = overview?.pages.find((p) => p.label === pageLabel);
  const resolvedPageLabel = page?.label ?? pageLabel ?? "";
  const isFanslyPage = page?.platform === "fansly";
  const canLoad = isFanslyPage && resolvedPageLabel.length > 0;

  const { data, isLoading } = useWorkboard(resolvedPageLabel, { enabled: canLoad });
  const snoozeMutation = useWorkboardSnooze(resolvedPageLabel);
  const unsnoozeMutation = useWorkboardUnsnooze(resolvedPageLabel);

  const [tab, setTab] = useState<Tab>("subscribers");
  const [expandedFanId, setExpandedFanId] = useState<number | null>(null);

  const subscriberVms = useMemo(
    () => data?.subscribers.items.map((item) => mapSubscriberVm(resolvedPageLabel, item)) ?? [],
    [data?.subscribers.items, resolvedPageLabel],
  );

  const activeSpenderVms = useMemo(
    () => data?.activeSpenders.items.map((item) => mapSpenderVm(resolvedPageLabel, item)) ?? [],
    [data?.activeSpenders.items, resolvedPageLabel],
  );

  const inactiveSpenderVms = useMemo(
    () => data?.inactiveSpenders.items.map((item) => mapSpenderVm(resolvedPageLabel, item)) ?? [],
    [data?.inactiveSpenders.items, resolvedPageLabel],
  );

  const snoozedVms = useMemo(
    () => data?.snoozed.items.map(mapSnoozedVm) ?? [],
    [data?.snoozed.items],
  );

  const tabCounts: Record<Tab, number> = {
    subscribers: data?.subscribers.total ?? 0,
    activeSpenders: data?.activeSpenders.total ?? 0,
    inactiveSpenders: data?.inactiveSpenders.total ?? 0,
  };

  const totalOverdue = tabCounts.subscribers + tabCounts.activeSpenders + tabCounts.inactiveSpenders;

  function handleSnooze(fanId: number, days: number) {
    snoozeMutation.mutate({ fanId, days });
  }

  function handleUnsnooze(fanId: number) {
    unsnoozeMutation.mutate(fanId);
  }

  function toggleExpand(fanId: number) {
    setExpandedFanId((prev) => (prev === fanId ? null : fanId));
  }

  if (!page) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-text-muted text-sm">Page not found</span>
      </div>
    );
  }

  if (!isFanslyPage) {
    return <Navigate to={`/pages/${page.label}`} replace />;
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Workboard &mdash; {page.label}
        </h1>
        {data && (
          <div className="mt-1 text-sm text-text-muted">
            {totalOverdue} need attention
            {(data.snoozed.total ?? 0) > 0 && (
              <span> &middot; {data.snoozed.total} snoozed</span>
            )}
          </div>
        )}
      </div>

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { setTab(t); setExpandedFanId(null); }}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
          >
            {TAB_LABELS[t]}
            {data && (
              <span className="ml-1.5 text-[11px] tabular-nums">
                {tabCounts[t]}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <span className="text-sm text-text-muted">Loading workboard...</span>
        </div>
      )}

      {data && tab === "subscribers" && (
        subscriberVms.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-2">
            {subscriberVms.map((vm) => (
              <SubscriberCard
                key={vm.fanId}
                vm={vm}
                pageLabel={resolvedPageLabel}
                isExpanded={expandedFanId === vm.fanId}
                onToggle={() => toggleExpand(vm.fanId)}
                onSnooze={(days) => handleSnooze(vm.fanId, days)}
                isSnoozePending={snoozeMutation.isPending}
              />
            ))}
          </div>
        )
      )}

      {data && tab === "activeSpenders" && (
        activeSpenderVms.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-2">
            {activeSpenderVms.map((vm) => (
              <SpenderCard
                key={vm.fanId}
                vm={vm}
                pageLabel={resolvedPageLabel}
                isExpanded={expandedFanId === vm.fanId}
                onToggle={() => toggleExpand(vm.fanId)}
                onSnooze={(days) => handleSnooze(vm.fanId, days)}
                isSnoozePending={snoozeMutation.isPending}
              />
            ))}
          </div>
        )
      )}

      {data && tab === "inactiveSpenders" && (
        inactiveSpenderVms.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-2">
            {inactiveSpenderVms.map((vm) => (
              <SpenderCard
                key={vm.fanId}
                vm={vm}
                pageLabel={resolvedPageLabel}
                isExpanded={expandedFanId === vm.fanId}
                onToggle={() => toggleExpand(vm.fanId)}
                onSnooze={(days) => handleSnooze(vm.fanId, days)}
                isSnoozePending={snoozeMutation.isPending}
              />
            ))}
          </div>
        )
      )}

      {data && (
        <SnoozedSection
          items={snoozedVms}
          onUnsnooze={handleUnsnooze}
          isUnsnoozePending={unsnoozeMutation.isPending}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-lg font-semibold text-text-primary">All caught up</div>
      <div className="mt-1 text-sm text-text-muted">No overdue fans in this tab</div>
    </div>
  );
}
