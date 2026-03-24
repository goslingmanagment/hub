import { useEffect, useMemo, useState } from "react";
import { useParams, Navigate } from "react-router";
import { useOverview, useCrmSummary, useCrmRetention, useCrmReactivation } from "@/api/queries";
import { CrmSummaryHeader } from "@/components/page/crm/CrmSummaryHeader";
import { RetentionTable } from "@/components/page/crm/RetentionTable";
import { ReactivationTable } from "@/components/page/crm/ReactivationTable";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { mapRetentionRowVm, mapReactivationRowVm } from "./crm/viewModel.js";

const LIMIT = 25;

type Tab = "retention" | "reactivation";

export function CrmPage() {
  const { pageLabel } = useParams();
  const { data: overview } = useOverview();
  const page = overview?.pages.find((p) => p.label === pageLabel);
  const resolvedPageLabel = page?.label ?? pageLabel ?? "";
  const isFanslyPage = page?.platform === "fansly";
  const canLoadCrm = isFanslyPage && resolvedPageLabel.length > 0;

  const [tab, setTab] = useState<Tab>("retention");
  const [expandedConversationId, setExpandedConversationId] = useState<string | null>(null);

  // Retention filters
  const [retTouchpoint, setRetTouchpoint] = useState<string[]>([]);
  const [retAutoRenew, setRetAutoRenew] = useState("all");
  const [retShowHandled, setRetShowHandled] = useState(false);
  const [retUnreadOnly, setRetUnreadOnly] = useState(false);
  const [retSearch, setRetSearch] = useState("");
  const [retSortBy, setRetSortBy] = useState("touchpoint");
  const [retSortDir, setRetSortDir] = useState("asc");
  const [retOffset, setRetOffset] = useState(0);

  // Reactivation filters
  const [reactSilence, setReactSilence] = useState("all");
  const [reactMinSpend, setReactMinSpend] = useState("");
  const [reactNoDmHistory, setReactNoDmHistory] = useState(false);
  const [reactUnreadOnly, setReactUnreadOnly] = useState(false);
  const [reactHideDeleted, setReactHideDeleted] = useState(true);
  const [reactSubState, setReactSubState] = useState("");
  const [reactSearch, setReactSearch] = useState("");
  const [reactSortBy, setReactSortBy] = useState("reactivationScore");
  const [reactSortDir, setReactSortDir] = useState("desc");
  const [reactOffset, setReactOffset] = useState(0);

  // Reset offset on filter change
  useEffect(() => {
    setRetOffset(0);
  }, [retTouchpoint, retAutoRenew, retShowHandled, retUnreadOnly, retSearch, retSortBy, retSortDir]);

  useEffect(() => {
    setReactOffset(0);
  }, [reactSilence, reactMinSpend, reactNoDmHistory, reactUnreadOnly, reactHideDeleted, reactSubState, reactSearch, reactSortBy, reactSortDir]);

  // Reset expand on tab switch
  useEffect(() => {
    setExpandedConversationId(null);
  }, [tab]);

  const retentionParams = useMemo(() => ({
    limit: LIMIT,
    offset: retOffset,
    query: retSearch || undefined,
    touchpoint: retTouchpoint.length > 0 ? retTouchpoint : undefined,
    autoRenew: retAutoRenew === "on" ? true : retAutoRenew === "off" ? false : undefined,
    unreadOnly: retUnreadOnly || undefined,
    showHandled: retShowHandled || undefined,
    sortBy: retSortBy,
    sortDir: retSortDir,
  }), [retOffset, retSearch, retTouchpoint, retAutoRenew, retUnreadOnly, retShowHandled, retSortBy, retSortDir]);

  const reactivationParams = useMemo(() => ({
    limit: LIMIT,
    offset: reactOffset,
    query: reactSearch || undefined,
    minSpendUsd: reactMinSpend ? Number(reactMinSpend) : undefined,
    minSilenceDays: reactSilence !== "all" ? Number(reactSilence) : undefined,
    unreadOnly: reactUnreadOnly || undefined,
    noDmHistoryOnly: reactNoDmHistory || undefined,
    hideDeleted: reactHideDeleted,
    subscriberState: reactSubState || undefined,
    sortBy: reactSortBy,
    sortDir: reactSortDir,
  }), [reactOffset, reactSearch, reactMinSpend, reactSilence, reactUnreadOnly, reactNoDmHistory, reactHideDeleted, reactSubState, reactSortBy, reactSortDir]);

  const { data: summary } = useCrmSummary(resolvedPageLabel, {
    enabled: canLoadCrm,
  });
  const { data: retention, isLoading: retLoading } = useCrmRetention(
    resolvedPageLabel,
    retentionParams,
    { enabled: canLoadCrm },
  );
  const { data: reactivation, isLoading: reactLoading } = useCrmReactivation(
    resolvedPageLabel,
    reactivationParams,
    { enabled: canLoadCrm },
  );

  const retentionVm = useMemo(
    () => retention?.items.map((item) => mapRetentionRowVm(resolvedPageLabel, item)) ?? [],
    [resolvedPageLabel, retention],
  );

  const reactivationVm = useMemo(
    () => reactivation?.items.map((item) => mapReactivationRowVm(resolvedPageLabel, item)) ?? [],
    [reactivation, resolvedPageLabel],
  );

  function handleRetSortChange(field: string) {
    if (field === retSortBy) {
      setRetSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setRetSortBy(field);
      setRetSortDir(field === "touchpoint" ? "asc" : "desc");
    }
  }

  function handleReactSortChange(field: string) {
    if (field === reactSortBy) {
      setReactSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setReactSortBy(field);
      setReactSortDir("desc");
    }
  }

  if (!overview) {
    return <TableSkeleton rows={6} columns={6} />;
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
          CRM &mdash; {page.label}
        </h1>
        {summary && (
          <div className="mt-2">
            <CrmSummaryHeader summary={summary} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 mb-5">
        <button
          type="button"
          onClick={() => setTab("retention")}
          className={`rounded-button px-4 py-2 text-sm font-medium transition-colors ${
            tab === "retention"
              ? "bg-[#1a1a1a] text-white"
              : "border border-border bg-card text-text-secondary hover:bg-hover"
          }`}
        >
          Retention
          {summary && (
            <span className={`ml-1.5 ${tab === "retention" ? "text-white/60" : "text-text-muted"}`}>
              {summary.retention.total}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("reactivation")}
          className={`rounded-button px-4 py-2 text-sm font-medium transition-colors ${
            tab === "reactivation"
              ? "bg-[#1a1a1a] text-white"
              : "border border-border bg-card text-text-secondary hover:bg-hover"
          }`}
        >
          Reactivation
          {summary && (
            <span className={`ml-1.5 ${tab === "reactivation" ? "text-white/60" : "text-text-muted"}`}>
              {summary.reactivation.total}
            </span>
          )}
        </button>
      </div>

      {tab === "retention" ? (
        retLoading && !retention ? (
          <TableSkeleton rows={6} columns={6} />
        ) : (
          <RetentionTable
            items={retentionVm}
            total={retention?.total ?? 0}
            limit={LIMIT}
            offset={retOffset}
            expandedConversationId={expandedConversationId}
            touchpointFilter={retTouchpoint}
            autoRenewFilter={retAutoRenew}
            showHandled={retShowHandled}
            unreadOnly={retUnreadOnly}
            searchQuery={retSearch}
            sortBy={retSortBy}
            sortDir={retSortDir}
            summary={summary}
            pageLabel={page.label}
            onTouchpointChange={setRetTouchpoint}
            onAutoRenewChange={setRetAutoRenew}
            onShowHandledChange={setRetShowHandled}
            onUnreadOnlyChange={setRetUnreadOnly}
            onSearchChange={setRetSearch}
            onSortChange={handleRetSortChange}
            onExpand={setExpandedConversationId}
            onPageChange={setRetOffset}
          />
        )
      ) : (
        reactLoading && !reactivation ? (
          <TableSkeleton rows={6} columns={6} />
        ) : (
          <ReactivationTable
            items={reactivationVm}
            total={reactivation?.total ?? 0}
            limit={LIMIT}
            offset={reactOffset}
            expandedConversationId={expandedConversationId}
            silenceFilter={reactSilence}
            minSpendUsd={reactMinSpend}
            noDmHistoryOnly={reactNoDmHistory}
            unreadOnly={reactUnreadOnly}
            hideDeleted={reactHideDeleted}
            subscriberState={reactSubState}
            searchQuery={reactSearch}
            sortBy={reactSortBy}
            sortDir={reactSortDir}
            pageLabel={page.label}
            onSilenceChange={setReactSilence}
            onMinSpendChange={setReactMinSpend}
            onNoDmHistoryChange={setReactNoDmHistory}
            onUnreadOnlyChange={setReactUnreadOnly}
            onHideDeletedChange={setReactHideDeleted}
            onSubscriberStateChange={setReactSubState}
            onSearchChange={setReactSearch}
            onSortChange={handleReactSortChange}
            onExpand={setExpandedConversationId}
            onPageChange={setReactOffset}
          />
        )
      )}
    </div>
  );
}
