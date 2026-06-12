import { useEffect, useMemo, useState } from "react";
import { useParams, Navigate } from "react-router";
import type { WorkboardResponse } from "@agency_hub_core/contracts";
import {
  useWorkboard,
  useWorkboardPresence,
  useWorkboardSnooze,
  useWorkboardUnsnooze,
} from "@/api/queries";
import { ApiError } from "@/api/client";
import { PresencePanel } from "@/components/page/workboard/PresencePanel";
import { WorkboardCard } from "@/components/page/workboard/WorkboardCard";
import { WorkboardCompactRow } from "@/components/page/workboard/WorkboardCompactRow";
import { SnoozedSection } from "@/components/page/workboard/SnoozedSection";
import { StatusPanel } from "@/components/shared/StatusPanel";
import {
  mapPresenceVm,
  mapSubscriberVm,
  mapSpenderVm,
  mapSnoozedVm,
  type WorkboardSubscriberVm,
  type WorkboardSpenderVm,
  type WorkboardCardVm,
} from "./workboard/viewModel.js";
import { formatMills } from "@/lib/format";
import { buildPageRoute } from "@/lib/navigation";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { toast } from "sonner";

type Tab = "subscribers" | "activeSpenders" | "inactiveSpenders";
type ViewMode = "cards" | "compact";

const TAB_LABELS: Record<Tab, string> = {
  subscribers: "Подписчики",
  activeSpenders: "Активные спендеры",
  inactiveSpenders: "Все спендеры",
};

const TABS: Tab[] = ["subscribers", "activeSpenders", "inactiveSpenders"];

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

function isActionableSpender(item: WorkboardResponse["activeSpenders"]["items"][number]) {
  if (item.subscription.status === "active") {
    return false;
  }
  return item.segment === "active" ? item.silenceDays >= 7 : item.silenceDays >= 14;
}

/* ── Priority lane helpers ──────────────────────────────────────── */

interface PriorityLane<T extends WorkboardCardVm> {
  key: string;
  title: string;
  subtitle: string | null;
  items: T[];
}

function buildSubscriberLanes(vms: WorkboardSubscriberVm[]): PriorityLane<WorkboardSubscriberVm>[] {
  const atRisk: WorkboardSubscriberVm[] = [];
  const followUp: WorkboardSubscriberVm[] = [];

  for (const vm of vms) {
    if (vm.autoRenew === true) {
      followUp.push(vm);
    } else {
      atRisk.push(vm);
    }
  }

  // Sort each lane by LTV descending
  const byLtvDesc = (a: WorkboardCardVm, b: WorkboardCardVm) => b.ltvMills - a.ltvMills;
  atRisk.sort(byLtvDesc);
  followUp.sort(byLtvDesc);

  const lanes: PriorityLane<WorkboardSubscriberVm>[] = [];

  if (atRisk.length > 0) {
    const totalAtRiskMills = atRisk.reduce((sum, vm) => sum + vm.ltvMills, 0);
    lanes.push({
      key: "at-risk",
      title: `Могут уйти (${atRisk.length})`,
      subtitle: `Под угрозой: ${formatMills(totalAtRiskMills)}`,
      items: atRisk,
    });
  }

  if (followUp.length > 0) {
    lanes.push({
      key: "follow-up",
      title: `Поддержать (${followUp.length})`,
      subtitle: "Автопродление включено — меньше риска",
      items: followUp,
    });
  }

  return lanes;
}

function buildSpenderLanes(vms: WorkboardSpenderVm[]): PriorityLane<WorkboardSpenderVm>[] {
  if (vms.length === 0) return [];

  // Single lane sorted by LTV desc
  const sorted = [...vms].sort((a, b) => b.ltvMills - a.ltvMills);
  const totalMills = sorted.reduce((sum, vm) => sum + vm.ltvMills, 0);

  return [{
    key: "spenders",
    title: `Фаны (${sorted.length})`,
    subtitle: `Общий LTV: ${formatMills(totalMills)}`,
    items: sorted,
  }];
}

/* ── View mode toggle ───────────────────────────────────────────── */

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="flex items-center rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => onChange("cards")}
        className={`px-3 py-1 text-[11px] font-medium transition-colors ${
          mode === "cards"
            ? "bg-accent text-white"
            : "text-text-muted hover:text-text-secondary hover:bg-hover"
        }`}
      >
        Карточки
      </button>
      <button
        type="button"
        onClick={() => onChange("compact")}
        className={`px-3 py-1 text-[11px] font-medium transition-colors ${
          mode === "compact"
            ? "bg-accent text-white"
            : "text-text-muted hover:text-text-secondary hover:bg-hover"
        }`}
      >
        Таблица
      </button>
    </div>
  );
}

/* ── Lane header ────────────────────────────────────────────────── */

function LaneHeader({ title, subtitle, isAtRisk }: { title: string; subtitle: string | null; isAtRisk: boolean }) {
  return (
    <div className={`flex items-center justify-between px-3 py-2 rounded-lg mb-2 ${
      isAtRisk ? "bg-warning/8 border border-warning/20" : "bg-hover/50 border border-border"
    }`}>
      <span className={`text-[13px] font-bold ${isAtRisk ? "text-warning" : "text-text-secondary"}`}>
        {title}
      </span>
      {subtitle && (
        <span className={`text-[12px] ${isAtRisk ? "text-warning/80 font-semibold" : "text-text-muted"}`}>
          {subtitle}
        </span>
      )}
    </div>
  );
}

/* ── Compact table wrapper ──────────────────────────────────────── */

function CompactTable({
  lanes,
  tab,
  onContacted,
  onSnooze,
  pendingSnoozeFanId,
}: {
  lanes: PriorityLane<WorkboardCardVm>[];
  tab: Tab;
  onContacted: (fanId: number) => void;
  onSnooze: (fanId: number, days: number) => void;
  pendingSnoozeFanId: number | null;
}) {
  const isSubscribers = tab === "subscribers";

  return (
    <div className="space-y-4">
      {lanes.map((lane) => (
        <div key={lane.key}>
          {(lanes.length > 1 || lane.subtitle) && (
            <LaneHeader title={lane.title} subtitle={lane.subtitle} isAtRisk={lane.key === "at-risk"} />
          )}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-hover/30 text-[11px] text-text-muted font-medium">
                  <th className="py-2 px-3">Фан</th>
                  {isSubscribers && <th className="py-2 px-2">Тир</th>}
                  <th className="py-2 px-2 text-right">LTV</th>
                  <th className="py-2 px-2 text-center">{isSubscribers ? "Продление" : "Статус"}</th>
                  <th className="py-2 px-2">{isSubscribers ? "Истекает" : "Причина"}</th>
                  <th className="py-2 px-2">Срок</th>
                  <th className="py-2 px-2">Контакт</th>
                  <th className="py-2 px-2">Действия</th>
                </tr>
              </thead>
              <tbody>
                {lane.items.map((vm) => (
                  <WorkboardCompactRow
                    key={vm.fanId}
                    vm={vm}
                    showTierColumn={isSubscribers}
                    onContacted={() => onContacted(vm.fanId)}
                    onSnooze={(days) => onSnooze(vm.fanId, days)}
                    isSnoozePending={pendingSnoozeFanId === vm.fanId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────── */

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
  const [isPresenceOpen, setIsPresenceOpen] = useState(false);
  const presenceQuery = useWorkboardPresence(resolvedPageLabel, {
    enabled: canLoad && isPresenceOpen,
  });
  const snoozeMutation = useWorkboardSnooze(resolvedPageLabel);
  const unsnoozeMutation = useWorkboardUnsnooze(resolvedPageLabel);

  const [tab, setTab] = useState<Tab>("subscribers");
  const [viewMode, setViewMode] = useState<ViewMode>("cards");
  const [expandedFanId, setExpandedFanId] = useState<number | null>(null);
  const [pendingSnoozeFanId, setPendingSnoozeFanId] = useState<number | null>(null);
  const [pendingUnsnoozeFanId, setPendingUnsnoozeFanId] = useState<number | null>(null);

  const platform = page?.platform ?? "fansly";
  const subscriberVms = useMemo(
    () => data?.subscribers.items
      .map((item) => mapSubscriberVm(resolvedPageLabel, platform, item))
      .filter(isPresent) ?? [],
    [data?.subscribers.items, resolvedPageLabel, platform],
  );

  const activeSpenderVms = useMemo(
    () => data?.activeSpenders.items
      .map((item) => mapSpenderVm(resolvedPageLabel, platform, item))
      .filter(isPresent) ?? [],
    [data?.activeSpenders.items, resolvedPageLabel, platform],
  );

  const inactiveSpenderVms = useMemo(
    () => data?.inactiveSpenders.items
      .map((item) => mapSpenderVm(resolvedPageLabel, platform, item))
      .filter(isPresent) ?? [],
    [data?.inactiveSpenders.items, resolvedPageLabel, platform],
  );

  const snoozedVms = useMemo(
    () => data?.snoozed.items.map(mapSnoozedVm).filter(isPresent) ?? [],
    [data?.snoozed.items],
  );
  const activeNowPresenceVms = useMemo(
    () => presenceQuery.data?.activeNow.items
      .map((item) => mapPresenceVm(resolvedPageLabel, platform, item))
      .filter(isPresent) ?? [],
    [presenceQuery.data?.activeNow.items, resolvedPageLabel, platform],
  );
  const recentlyActivePresenceVms = useMemo(
    () => presenceQuery.data?.recentlyActive.items
      .map((item) => mapPresenceVm(resolvedPageLabel, platform, item))
      .filter(isPresent) ?? [],
    [presenceQuery.data?.recentlyActive.items, resolvedPageLabel, platform],
  );

  const tabCounts: Record<Tab, number> = {
    subscribers: data?.subscribers.total ?? 0,
    activeSpenders: data?.activeSpenders.total ?? 0,
    inactiveSpenders: data?.inactiveSpenders.total ?? 0,
  };

  const totalOverdue = (data?.subscribers.total ?? 0)
    + (data?.inactiveSpenders.items.filter(isActionableSpender).length ?? 0);
  const hiddenCounts: Record<Tab, number> = {
    subscribers: Math.max(0, (data?.subscribers.items.length ?? 0) - subscriberVms.length),
    activeSpenders: Math.max(0, (data?.activeSpenders.items.length ?? 0) - activeSpenderVms.length),
    inactiveSpenders: Math.max(0, (data?.inactiveSpenders.items.length ?? 0) - inactiveSpenderVms.length),
  };
  const snoozedHiddenCount = Math.max(0, (data?.snoozed.items.length ?? 0) - snoozedVms.length);
  const totalHidden = hiddenCounts.subscribers + hiddenCounts.activeSpenders +
    hiddenCounts.inactiveSpenders + snoozedHiddenCount;

  // Build priority lanes for current tab
  const currentLanes: PriorityLane<WorkboardCardVm>[] = useMemo(() => {
    switch (tab) {
      case "subscribers": return buildSubscriberLanes(subscriberVms);
      case "activeSpenders": return buildSpenderLanes(activeSpenderVms);
      case "inactiveSpenders": return buildSpenderLanes(inactiveSpenderVms);
    }
  }, [tab, subscriberVms, activeSpenderVms, inactiveSpenderVms]);

  const currentHiddenCount = hiddenCounts[tab];
  const currentTotalItems = currentLanes.reduce((sum, lane) => sum + lane.items.length, 0);

  useEffect(() => {
    setExpandedFanId(null);
  }, [tab]);

  async function handleContacted(fanId: number) {
    setPendingSnoozeFanId(fanId);
    try {
      await snoozeMutation.mutateAsync({ fanId, days: 7 });
      toast.success("Отмечен как обработанный");
    } finally {
      setPendingSnoozeFanId((current) => (current === fanId ? null : current));
    }
  }

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
        title="Страница не указана"
        description="Откройте Workboard через меню страницы."
        tone="error"
      />
    );
  }

  if (pageCatalogState === "ready" && !page && (!isLoading || isError)) {
    return (
      <StatusPanel
        title="Страница не найдена"
        description="Запрашиваемая страница не существует."
        tone="error"
      />
    );
  }

  if (pageCatalogState === "ready" && page && !isFanslyPage) {
    return <Navigate to={buildPageRoute(page.label)} replace />;
  }

  if (isLoading && !data && pageCatalogState !== "ready") {
    return (
      <StatusPanel
        title="Загрузка"
        description="Подготовка данных страницы и загрузка очереди."
      />
    );
  }

  if (isLoading && !data) {
    return (
      <StatusPanel
        title="Загрузка"
        description="Загружаем текущую очередь."
      />
    );
  }

  if (isError && !data) {
    const isNotFound = error instanceof ApiError && error.status === 404;
    return (
      <StatusPanel
        title={isNotFound ? "Workboard недоступен" : "Ошибка загрузки"}
        description={isNotFound
          ? "Для этой страницы Workboard недоступен."
          : "Не удалось загрузить очередь. Попробуйте обновить страницу."}
        tone="error"
      />
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">
            Workboard &mdash; {page?.label ?? resolvedPageLabel}
          </h1>
          {data && (
            <div className="mt-1 text-sm text-text-muted">
              Ожидают внимания: {totalOverdue}
              {totalHidden > 0 && (
                <span> &middot; {totalHidden} скрыто</span>
              )}
              {(data.snoozed.total > 0 || snoozedVms.length > 0) && (
                <span> &middot; {data.snoozed.total} отложено</span>
              )}
            </div>
          )}
        </div>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>

      {/* Tabs */}
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

      {/* Hidden rows warning */}
      {currentHiddenCount > 0 && (
        <div className="mb-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-text-secondary">
          {currentHiddenCount} {currentHiddenCount === 1 ? "строка скрыта" : "строк скрыто"} — профиль не найден.
        </div>
      )}

      {/* Content */}
      {currentTotalItems === 0 ? (
        currentHiddenCount > 0 ? (
          <StatusPanel
            title="Нет видимых фанов"
            description="Все записи в этом табе скрыты — профили не найдены."
          />
        ) : (
          <EmptyState label={TAB_LABELS[tab]} />
        )
      ) : viewMode === "compact" ? (
        <CompactTable
          lanes={currentLanes}
          tab={tab}
          onContacted={handleContacted}
          onSnooze={handleSnooze}
          pendingSnoozeFanId={pendingSnoozeFanId}
        />
      ) : (
        <div className="space-y-4">
          {currentLanes.map((lane) => (
            <div key={lane.key}>
              {(currentLanes.length > 1 || lane.subtitle) && (
                <LaneHeader title={lane.title} subtitle={lane.subtitle} isAtRisk={lane.key === "at-risk"} />
              )}
              <div className="space-y-2">
                {lane.items.map((vm) => (
                  <WorkboardCard
                    key={vm.fanId}
                    vm={vm}
                    pageLabel={resolvedPageLabel}
                    isExpanded={expandedFanId === vm.fanId}
                    onToggle={() => toggleExpand(vm.fanId)}
                    onContacted={() => handleContacted(vm.fanId)}
                    onSnooze={(days) => handleSnooze(vm.fanId, days)}
                    isSnoozePending={pendingSnoozeFanId === vm.fanId}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Snoozed section */}
      {data && (
        <SnoozedSection
          items={snoozedVms}
          onUnsnooze={handleUnsnooze}
          pendingFanId={pendingUnsnoozeFanId}
        />
      )}

      <div className="mt-8">
        <PresencePanel
          isOpen={isPresenceOpen}
          onToggle={() => setIsPresenceOpen((current) => !current)}
          updatedAt={presenceQuery.data?.updatedAt ?? null}
          loading={presenceQuery.isLoading}
          unavailable={presenceQuery.isError && !presenceQuery.data}
          activeNow={activeNowPresenceVms}
          activeNowTotal={presenceQuery.data?.activeNow.total ?? 0}
          recentlyActive={recentlyActivePresenceVms}
          recentlyActiveTotal={presenceQuery.data?.recentlyActive.total ?? 0}
        />
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <StatusPanel
      title="Все сделано"
      description={`Нет фанов, которым нужно написать (${label.toLowerCase()}).`}
    />
  );
}
