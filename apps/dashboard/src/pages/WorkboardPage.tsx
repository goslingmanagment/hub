import { useEffect, useMemo, useState } from "react";
import { useParams, Navigate } from "react-router";
import { useWorkboard, useWorkboardSnooze, useWorkboardUnsnooze } from "@/api/queries";
import { ApiError } from "@/api/client";
import { WorkboardCard } from "@/components/page/workboard/WorkboardCard";
import { SnoozedSection } from "@/components/page/workboard/SnoozedSection";
import { StatusPanel } from "@/components/shared/StatusPanel";
import {
  mapSubscriberVm,
  mapSpenderVm,
  mapSnoozedVm,
} from "./workboard/viewModel.js";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";

type Tab = "subscribers" | "activeSpenders" | "inactiveSpenders";
type SectionConfig = {
  key: Tab;
  label: string;
  total: number;
  hiddenCount: number;
  items: Array<ReturnType<typeof mapSubscriberVm> | ReturnType<typeof mapSpenderVm>>;
};

const TAB_LABELS: Record<Tab, string> = {
  subscribers: "Subscribers",
  activeSpenders: "Active spenders",
  inactiveSpenders: "Inactive spenders",
};

const TABS: Tab[] = ["subscribers", "activeSpenders", "inactiveSpenders"];

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

export function WorkboardPage() {
  const { pageLabel } = useParams();
  const { findPageByLabel, pageCatalogState } = useDashboardShell();
  const page = findPageByLabel(pageLabel);
  const resolvedPageLabel = pageLabel ?? "";
  const isFanslyPage = page?.platform === "fansly";
  const canLoad = resolvedPageLabel.length > 0 && (pageCatalogState !== "ready" || isFanslyPage);

  const {
    data,
    isLoading,
    isError,
    error,
  } = useWorkboard(resolvedPageLabel, { enabled: canLoad });
  const snoozeMutation = useWorkboardSnooze(resolvedPageLabel);
  const unsnoozeMutation = useWorkboardUnsnooze(resolvedPageLabel);

  const [tab, setTab] = useState<Tab>("subscribers");
  const [expandedFanId, setExpandedFanId] = useState<number | null>(null);
  const [pendingSnoozeFanId, setPendingSnoozeFanId] = useState<number | null>(null);
  const [pendingUnsnoozeFanId, setPendingUnsnoozeFanId] = useState<number | null>(null);

  const subscriberVms = useMemo(
    () => data?.subscribers.items
      .map((item) => mapSubscriberVm(resolvedPageLabel, item))
      .filter(isPresent) ?? [],
    [data?.subscribers.items, resolvedPageLabel],
  );

  const activeSpenderVms = useMemo(
    () => data?.activeSpenders.items
      .map((item) => mapSpenderVm(resolvedPageLabel, item, "activeSpenders"))
      .filter(isPresent) ?? [],
    [data?.activeSpenders.items, resolvedPageLabel],
  );

  const inactiveSpenderVms = useMemo(
    () => data?.inactiveSpenders.items
      .map((item) => mapSpenderVm(resolvedPageLabel, item, "inactiveSpenders"))
      .filter(isPresent) ?? [],
    [data?.inactiveSpenders.items, resolvedPageLabel],
  );

  const snoozedVms = useMemo(
    () => data?.snoozed.items.map(mapSnoozedVm).filter(isPresent) ?? [],
    [data?.snoozed.items],
  );

  const tabCounts: Record<Tab, number> = {
    subscribers: data?.subscribers.total ?? 0,
    activeSpenders: data?.activeSpenders.total ?? 0,
    inactiveSpenders: data?.inactiveSpenders.total ?? 0,
  };

  const totalOverdue = tabCounts.subscribers + tabCounts.activeSpenders + tabCounts.inactiveSpenders;
  const hiddenCounts: Record<Tab, number> = {
    subscribers: Math.max(0, (data?.subscribers.items.length ?? 0) - subscriberVms.length),
    activeSpenders: Math.max(0, (data?.activeSpenders.items.length ?? 0) - activeSpenderVms.length),
    inactiveSpenders: Math.max(0, (data?.inactiveSpenders.items.length ?? 0) - inactiveSpenderVms.length),
  };
  const totalHidden = hiddenCounts.subscribers + hiddenCounts.activeSpenders + hiddenCounts.inactiveSpenders;

  const sections: SectionConfig[] = [
    {
      key: "subscribers",
      label: TAB_LABELS.subscribers,
      total: tabCounts.subscribers,
      hiddenCount: hiddenCounts.subscribers,
      items: subscriberVms,
    },
    {
      key: "activeSpenders",
      label: TAB_LABELS.activeSpenders,
      total: tabCounts.activeSpenders,
      hiddenCount: hiddenCounts.activeSpenders,
      items: activeSpenderVms,
    },
    {
      key: "inactiveSpenders",
      label: TAB_LABELS.inactiveSpenders,
      total: tabCounts.inactiveSpenders,
      hiddenCount: hiddenCounts.inactiveSpenders,
      items: inactiveSpenderVms,
    },
  ];
  const activeSection = sections.find((section) => section.key === tab) ?? sections[0];

  useEffect(() => {
    setExpandedFanId(null);
  }, [tab]);

  async function handleSnooze(fanId: number, days: number) {
    setPendingSnoozeFanId(fanId);
    try {
      await snoozeMutation.mutateAsync({ fanId, days });
    } finally {
      setPendingSnoozeFanId((current) => (current === fanId ? null : current));
    }
  }

  async function handleUnsnooze(fanId: number) {
    setPendingUnsnoozeFanId(fanId);
    try {
      await unsnoozeMutation.mutateAsync(fanId);
    } finally {
      setPendingUnsnoozeFanId((current) => (current === fanId ? null : current));
    }
  }

  function toggleExpand(fanId: number) {
    setExpandedFanId((prev) => (prev === fanId ? null : fanId));
  }

  if (!resolvedPageLabel) {
    return (
      <StatusPanel
        title="Workboard page is missing"
        description="Open the workboard from a valid page route."
        tone="error"
      />
    );
  }

  if (pageCatalogState === "ready" && !page && (!isLoading || isError)) {
    return (
      <StatusPanel
        title="Page not found"
        description="The requested page does not exist in the dashboard catalog."
        tone="error"
      />
    );
  }

  if (pageCatalogState === "ready" && page && !isFanslyPage) {
    return <Navigate to={`/pages/${page.label}`} replace />;
  }

  if (isLoading && !data && pageCatalogState !== "ready") {
    return (
      <StatusPanel
        title="Loading workboard"
        description="Resolving page details and fetching the workboard snapshot."
      />
    );
  }

  if (isLoading && !data) {
    return (
      <StatusPanel
        title="Loading workboard"
        description="Fetching the current queue snapshot."
      />
    );
  }

  if (isError && !data) {
    const isNotFound = error instanceof ApiError && error.status === 404;
    return (
      <StatusPanel
        title={isNotFound ? "Workboard unavailable" : "Workboard failed to load"}
        description={isNotFound
          ? "The current page does not expose a workboard snapshot."
          : "The queue snapshot could not be loaded. Try again in a moment."}
        tone="error"
      />
    );
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Workboard &mdash; {page?.label ?? resolvedPageLabel}
        </h1>
        {data && (
          <div className="mt-1 text-sm text-text-muted">
            {totalOverdue} need attention
            {totalHidden > 0 && (
              <span> &middot; {totalHidden} hidden</span>
            )}
            {snoozedVms.length > 0 && (
              <span> &middot; {snoozedVms.length} snoozed</span>
            )}
          </div>
        )}
      </div>

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
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

      {activeSection.hiddenCount > 0 && (
        <div className="mb-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-text-secondary">
          {activeSection.hiddenCount} {activeSection.hiddenCount === 1 ? "row is" : "rows are"} hidden because the profile label is unavailable.
        </div>
      )}

      {activeSection.items.length === 0 ? (
        activeSection.total > 0 && activeSection.hiddenCount > 0 ? (
          <StatusPanel
            title="No visible fans in this tab"
            description="The API returned workboard items, but every row in this tab is currently hidden because the profile label is unavailable."
          />
        ) : (
          <EmptyState label={activeSection.label} />
        )
      ) : (
        <div className="space-y-2">
          {activeSection.items.map((vm) => vm && (
            <WorkboardCard
              key={vm.fanId}
              vm={vm}
              pageLabel={resolvedPageLabel}
              isExpanded={expandedFanId === vm.fanId}
              onToggle={() => toggleExpand(vm.fanId)}
              onSnooze={(days) => handleSnooze(vm.fanId, days)}
              isSnoozePending={pendingSnoozeFanId === vm.fanId}
            />
          ))}
        </div>
      )}

      {data && (
        <SnoozedSection
          items={snoozedVms}
          onUnsnooze={handleUnsnooze}
          pendingFanId={pendingUnsnoozeFanId}
        />
      )}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <StatusPanel
      title="All caught up"
      description={`No overdue fans are waiting in ${label.toLowerCase()}.`}
    />
  );
}
