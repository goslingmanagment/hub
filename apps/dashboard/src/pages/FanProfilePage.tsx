import { useLocation, useNavigate, useParams } from "react-router";
import { useState } from "react";
import { ArrowLeft, ChevronDown, CalendarDays, RefreshCw, Clock } from "lucide-react";
import {
  usePageFanDetail,
  usePageFanProfile,
  usePageFanProfileVersion,
  usePageFanProfileVersions,
  usePageFanTransactions,
  useCreateFanNote,
  useSpenderDetail,
} from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { Pagination } from "@/components/shared/Pagination";
import { FanIntelligenceMarkdown } from "@/components/page/FanIntelligenceMarkdown";
import { formatUsdFromMills, resolveFanLabelForScope } from "@agency_hub_core/shared";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDate, formatDateTime, transactionTypeLabel, daysRemaining } from "@/lib/format";
import { usePeriodStore } from "@/stores/periodStore";
import { toast } from "sonner";
import { TRANSACTION_STATE_COLORS } from "@/lib/constants";
import { resolveFanProfileBackTarget } from "@/lib/navigation";
import type {
  FanProfileDocument,
  FanProfileVersionListResponse,
  FanTransactionListResponse,
  PageFanDetailResponse,
} from "@agency_hub_core/contracts";

const PAGE_SIZE = 50;
type TimelineEvent = {
  id: number | string;
  date: string;
  label: string;
  amount: number;
  type: string;
};

export function FanProfilePage() {
  const { pageLabel, platform, platformUserId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [txOffset, setTxOffset] = useState(0);
  const [noteBody, setNoteBody] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);
  const [selectedProfileVersion, setSelectedProfileVersion] = useState<number | null>(null);
  const { period } = usePeriodStore();
  const selectedPeriod = period;
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;

  const { data, isLoading, isError } = usePageFanDetail(pageLabel!, platformUserId!);
  const { data: latestProfileData, isLoading: latestProfileLoading } = usePageFanProfile(pageLabel!, platformUserId!);
  const { data: profileVersionsData, isLoading: profileVersionsLoading } = usePageFanProfileVersions(
    pageLabel!,
    platformUserId!,
    { enabled: historyOpen },
  );
  const { data: selectedProfileData, isLoading: selectedProfileLoading } = usePageFanProfileVersion(
    pageLabel!,
    platformUserId!,
    selectedProfileVersion,
    { enabled: selectedProfileVersion !== null },
  );
  const { data: spenderDetail } = useSpenderDetail(platform!, platformUserId!, {
    scope: "page",
    pageLabel,
    period: spenderPeriod,
  });
  const { data: txData } = usePageFanTransactions(pageLabel!, platformUserId!, {
    limit: PAGE_SIZE,
    offset: txOffset,
  });
  const createNote = useCreateFanNote(pageLabel!, platformUserId!);

  if (isLoading || !data) {
    if (isLoading) {
      return <FanProfileSkeleton />;
    }
    if (isError) {
      return (
        <StatusPanel
          title="Fan profile failed to load"
          description="The fan details could not be fetched for this page."
          tone="error"
        />
      );
    }
    return <FanProfileSkeleton />;
  }

  const { fan, page } = data;
  const fanLabel = resolveFanLabelForScope(fan, "page");
  const backTo = resolveFanProfileBackTarget(location.state, pageLabel);

  // Type breakdown from spender detail
  const typeBreakdown = spenderDetail?.typeBreakdown ?? [];
  function amountForType(canonicalType: string): number {
    const entry = typeBreakdown.find(
      (t: { canonicalType: string }) => t.canonicalType === canonicalType,
    );
    return entry?.creatorNetAmountMills ?? 0;
  }

  const txItems = txData?.items ?? [];
  const txTotal = txData?.total ?? 0;
  const latestProfile = latestProfileData?.profile ?? null;
  const profileVersions = profileVersionsData?.items ?? [];
  const viewingHistoricalVersion = selectedProfileVersion !== null;
  const displayedProfile = viewingHistoricalVersion
    ? selectedProfileData ?? null
    : latestProfile;
  const profileLoading = viewingHistoricalVersion
    ? selectedProfileLoading
    : latestProfileLoading;
  const selectedVersionIsCurrent = selectedProfileVersion !== null
    && latestProfile?.version === selectedProfileVersion;

  async function handleAddNote() {
    const body = noteBody.trim();
    if (!body) return;
    try {
      await createNote.mutateAsync({ body });
      setNoteBody("");
      toast.success("Note added");
    } catch {
      toast.error("Failed to add note");
    }
  }

  const stats = [
    {
      label: "Total Spent",
      value: formatUsdFromMills(page?.totalCreatorNetMills ?? 0),
      accent: true,
    },
    {
      label: "Subscriptions",
      value: formatUsdFromMills(amountForType("subscription")),
      accent: false,
    },
    {
      label: "Tips",
      value: formatUsdFromMills(amountForType("tip")),
      accent: false,
    },
    {
      label: "Messages",
      value: formatUsdFromMills(amountForType("message_purchase")),
      accent: false,
    },
  ];
  const subscriptionRemainingDays = page.subscriptionExpiresAt
    ? daysRemaining(page.subscriptionExpiresAt)
    : null;

  // Build timeline from transactions
  const timelineEvents = txItems.slice(0, 10).map((tx) => ({
    id: tx.transactionId,
    date: tx.occurredAt,
    label: transactionTypeLabel(tx.canonicalType),
    amount: tx.netAmountMills,
    type: tx.canonicalType,
  }));

  function timelineDotColor(type: string): string {
    if (type === "subscription") return "bg-accent";
    if (type === "tip") return "bg-green";
    if (type === "chargeback" || type === "refund") return "bg-danger";
    return "bg-text-muted";
  }

  function handleSelectProfileVersion(version: number) {
    setSelectedProfileVersion(version);
  }

  return (
    <div>
      {/* Back button */}
      <button
        type="button"
        onClick={() => navigate(backTo)}
        className="mb-4 flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      {/* Header */}
      <div className="mb-6 flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-hover text-2xl font-bold text-text-secondary">
          {fanLabel.label[0]?.toUpperCase() ?? "?"}
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-text-primary">
            {fanLabel.label}
          </h1>
          {fanLabel.secondaryPlatformHandle && (
            <div className="mt-1 text-sm text-text-muted">@{fanLabel.secondaryPlatformHandle}</div>
          )}
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            {page?.isSubscriber && <Badge variant="subscriber">Subscriber</Badge>}
            {page?.isFollower && <Badge variant="follower">Follower</Badge>}
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Platform ID: {platformUserId}
            {fan?.createdAtExternal && (
              <> &middot; Joined: {formatDate(fan.createdAtExternal)}</>
            )}
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="mb-6 grid grid-cols-4 gap-3.5">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-[10px] border border-border bg-card p-4"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              {stat.label}
            </div>
            <div
              className={`mt-1 text-2xl font-extrabold tabular-nums ${
                stat.accent ? "text-accent" : "text-text-primary"
              }`}
            >
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {/* Subscription Status */}
      {page.isSubscriber && (
        <div className="mb-6 rounded-[10px] border border-border bg-card p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-3">
            Subscription Status
          </div>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <CalendarDays size={14} className="text-text-muted" />
              <div>
                <div className="text-xs text-text-muted">Expires</div>
                <div className="text-sm font-medium text-text-primary">
                  {page.subscriptionExpiresAt ? formatDate(page.subscriptionExpiresAt) : "—"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-text-muted" />
              <div>
                <div className="text-xs text-text-muted">Remaining</div>
                {subscriptionRemainingDays !== null ? (
                  <div className="w-24"><RemainingBar days={subscriptionRemainingDays} /></div>
                ) : (
                  <div className="text-sm font-medium text-text-muted">—</div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <RefreshCw size={14} className="text-text-muted" />
              <div>
                <div className="text-xs text-text-muted">Auto-Renew</div>
                <div className={`text-sm font-medium ${
                  page.autoRenew === true
                    ? "text-green"
                    : page.autoRenew === false
                      ? "text-danger"
                      : "text-text-muted"
                }`}>
                  {page.autoRenew === true ? "On" : page.autoRenew === false ? "Off" : "Unknown"}
                </div>
              </div>
            </div>
            {page.subscriberSince && (
              <div>
                <div className="text-xs text-text-muted">Since</div>
                <div className="text-sm font-medium text-text-primary">{formatDate(page.subscriberSince)}</div>
              </div>
            )}
          </div>
        </div>
      )}

      <FanIntelligenceSection
        pageLabel={page.pageLabel}
        latestProfile={latestProfile}
        latestProfileLoading={latestProfileLoading}
        intelligenceOpen={intelligenceOpen}
        onOpen={() => setIntelligenceOpen(true)}
        viewingHistoricalVersion={viewingHistoricalVersion}
        selectedProfileVersion={selectedProfileVersion}
        selectedVersionIsCurrent={selectedVersionIsCurrent}
        onBackToLatest={() => setSelectedProfileVersion(null)}
        profileLoading={profileLoading}
        displayedProfile={displayedProfile}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((value) => !value)}
        profileVersionsLoading={profileVersionsLoading}
        profileVersions={profileVersions}
        onSelectProfileVersion={handleSelectProfileVersion}
      />

      <FanProfileActivityGrid
        notes={page.notes}
        noteBody={noteBody}
        onNoteBodyChange={setNoteBody}
        onAddNote={handleAddNote}
        isAddingNote={createNote.isPending}
        timelineEvents={timelineEvents}
        timelineDotColor={timelineDotColor}
      />

      <FanTransactionHistorySection
        txItems={txItems}
        txTotal={txTotal}
        txOffset={txOffset}
        onPageChange={setTxOffset}
      />
    </div>
  );
}

function FanIntelligenceSection({
  pageLabel,
  latestProfile,
  latestProfileLoading,
  intelligenceOpen,
  onOpen,
  viewingHistoricalVersion,
  selectedProfileVersion,
  selectedVersionIsCurrent,
  onBackToLatest,
  profileLoading,
  displayedProfile,
  historyOpen,
  onToggleHistory,
  profileVersionsLoading,
  profileVersions,
  onSelectProfileVersion,
}: {
  pageLabel: string;
  latestProfile: FanProfileDocument | null;
  latestProfileLoading: boolean;
  intelligenceOpen: boolean;
  onOpen: () => void;
  viewingHistoricalVersion: boolean;
  selectedProfileVersion: number | null;
  selectedVersionIsCurrent: boolean;
  onBackToLatest: () => void;
  profileLoading: boolean;
  displayedProfile: FanProfileDocument | null;
  historyOpen: boolean;
  onToggleHistory: () => void;
  profileVersionsLoading: boolean;
  profileVersions: FanProfileVersionListResponse["items"];
  onSelectProfileVersion: (version: number) => void;
}) {
  if (!latestProfile && !latestProfileLoading && !intelligenceOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="mb-6 flex w-full items-center justify-between rounded-xl border border-border bg-card px-5 py-4 text-left transition-colors hover:bg-hover-alt"
      >
        <span className="text-sm font-bold text-text-primary">Fan Intelligence</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">No profile available</span>
          <ChevronDown size={16} className="text-text-muted" />
        </div>
      </button>
    );
  }

  return (
    <section className="mb-6 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-text-primary">Fan Intelligence</h2>
          <p className="mt-1 text-xs text-text-muted">
            Latest ChatMuse profile for this fan on {pageLabel}.
          </p>
        </div>
        {viewingHistoricalVersion && (
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-border bg-hover px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Viewing version {selectedProfileVersion}
            </span>
            {selectedVersionIsCurrent && (
              <span className="rounded-full border border-border bg-hover-alt px-2 py-1 text-[11px] text-text-muted">
                Current
              </span>
            )}
            <button
              type="button"
              onClick={onBackToLatest}
              className="text-xs font-medium text-accent transition-colors hover:opacity-80"
            >
              Back to latest
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-border bg-hover-alt/40 p-5">
        {profileLoading ? (
          <p className="text-sm text-text-muted">
            {viewingHistoricalVersion ? "Loading selected version..." : "Loading intelligence profile..."}
          </p>
        ) : viewingHistoricalVersion && !displayedProfile ? (
          <p className="text-sm text-text-muted">Unable to load the selected version.</p>
        ) : displayedProfile ? (
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
              <span>Version {displayedProfile.version}</span>
              <span>&middot;</span>
              <span>{formatDateTime(displayedProfile.createdAt)}</span>
            </div>
            <FanIntelligenceMarkdown body={displayedProfile.body} />
          </div>
        ) : (
          <p className="text-sm text-text-muted">No intelligence profile yet</p>
        )}
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={onToggleHistory}
          className="flex w-full items-center justify-between rounded-lg border border-border bg-hover-alt/30 px-4 py-2.5 text-left transition-colors hover:bg-hover-alt"
          aria-expanded={historyOpen}
        >
          <span className="text-[13px] font-medium text-text-secondary">Version History</span>
          <ChevronDown
            size={16}
            className={`text-text-muted transition-transform ${historyOpen ? "rotate-180" : ""}`}
          />
        </button>

        {historyOpen && (
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
            {profileVersionsLoading ? (
              <div className="px-4 py-4 text-sm text-text-muted">Loading versions...</div>
            ) : profileVersions.length === 0 ? (
              <div className="px-4 py-4 text-sm text-text-muted">No saved versions yet.</div>
            ) : (
              <div>
                {profileVersions.map((item) => {
                  const selected = selectedProfileVersion === item.version;
                  return (
                    <button
                      key={item.version}
                      type="button"
                      onClick={() => onSelectProfileVersion(item.version)}
                      className={`flex w-full items-center justify-between border-t border-border px-4 py-3 text-left transition-colors first:border-t-0 ${
                        selected ? "bg-hover" : "hover:bg-hover-alt"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">
                          Version {item.version}
                        </span>
                        {item.isCurrent && (
                          <span className="rounded-full border border-border bg-hover px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                            Current
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-text-muted">
                        {formatDateTime(item.createdAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function FanProfileActivityGrid({
  notes,
  noteBody,
  onNoteBodyChange,
  onAddNote,
  isAddingNote,
  timelineEvents,
  timelineDotColor,
}: {
  notes: PageFanDetailResponse["page"]["notes"];
  noteBody: string;
  onNoteBodyChange: (value: string) => void;
  onAddNote: () => void;
  isAddingNote: boolean;
  timelineEvents: TimelineEvent[];
  timelineDotColor: (type: string) => string;
}) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-4">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-text-primary">Notes</h2>
          <button
            onClick={onAddNote}
            disabled={!noteBody.trim() || isAddingNote}
            className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add Note
          </button>
        </div>

        <div className="space-y-2 mb-3">
          {notes.length === 0 && (
            <p className="text-xs text-text-muted">No notes yet.</p>
          )}
          {notes.map((note) => (
            <div
              key={note.id}
              className="rounded-md border-l-[3px] border-border bg-hover-alt p-2.5"
            >
              <div className="text-[11px] text-text-muted">
                Note &middot; {formatDateTime(note.createdAt)}
              </div>
              <div className="mt-1 text-sm text-text-primary">{note.body}</div>
            </div>
          ))}
        </div>

        <textarea
          value={noteBody}
          onChange={(event) => onNoteBodyChange(event.target.value)}
          placeholder="Write a note..."
          rows={3}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none"
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-bold text-text-primary">Timeline</h2>
        {timelineEvents.length === 0 && (
          <p className="text-xs text-text-muted">No activity yet.</p>
        )}
        <div className="relative">
          {timelineEvents.length > 0 && (
            <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border" />
          )}
          <div className="space-y-3">
            {timelineEvents.map((event) => (
              <div key={event.id} className="flex items-start gap-3 pl-0">
                <div
                  className={`mt-1.5 h-[11px] w-[11px] flex-shrink-0 rounded-full ${timelineDotColor(event.type)}`}
                />
                <div>
                  <div className="text-[11px] text-text-muted">
                    {formatDateTime(event.date)}
                  </div>
                  <div className="text-sm text-text-primary">
                    {event.label}{" "}
                    <span className="font-semibold tabular-nums">
                      {formatUsdFromMills(event.amount)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FanTransactionHistorySection({
  txItems,
  txTotal,
  txOffset,
  onPageChange,
}: {
  txItems: FanTransactionListResponse["items"];
  txTotal: number;
  txOffset: number;
  onPageChange: (offset: number) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold text-text-primary">
          Transaction History
          <span className="ml-2 text-xs font-normal text-text-muted">{txTotal} total</span>
        </h2>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-hover-alt">
            {["Date", "Type", "Status", "Amount"].map((col) => (
              <th
                key={col}
                className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted ${
                  col === "Amount" ? "text-right" : "text-left"
                }`}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {txItems.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-sm text-text-muted">
                No transactions found.
              </td>
            </tr>
          )}
          {txItems.map((tx) => {
            const stateColor =
              TRANSACTION_STATE_COLORS[tx.transactionState] ?? "#a8a29e";
            return (
              <tr
                key={tx.transactionId}
                className="border-t border-border transition-colors hover:bg-hover"
              >
                <td className="px-4 py-3 text-sm text-text-secondary">
                  {formatDateTime(tx.occurredAt)}
                </td>
                <td className="px-4 py-3 text-sm text-text-primary font-medium">
                  {transactionTypeLabel(tx.canonicalType)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: stateColor }}
                    />
                    <span className="text-sm text-text-secondary capitalize">
                      {tx.transactionState}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                  {formatUsdFromMills(tx.netAmountMills)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Pagination
        offset={txOffset}
        limit={PAGE_SIZE}
        total={txTotal}
        onPageChange={onPageChange}
      />
    </section>
  );
}

function FanProfileSkeleton() {
  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <div className="h-14 w-14 rounded-full bg-hover animate-pulse" />
        <div>
          <div className="h-6 w-40 rounded bg-hover-alt animate-pulse" />
          <div className="mt-2 h-3 w-24 rounded bg-hover-alt animate-pulse" />
        </div>
      </div>
      <div className="mb-6 grid grid-cols-4 gap-3.5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-[10px] border border-border bg-card p-4">
            <div className="h-3 w-16 rounded bg-hover-alt animate-pulse" />
            <div className="mt-3 h-7 w-24 rounded bg-hover-alt animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
