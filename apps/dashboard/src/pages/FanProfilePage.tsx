import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useEffect, useReducer, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  useAuthMe,
  usePageFanDetail,
  usePageFanProfile,
  usePageFanProfileVersion,
  usePageFanProfileVersions,
  usePageFanTransactions,
  useCreateFanNote,
  useSpenderDetail,
} from "@/api/queries";
import { ReadSection, type SectionQuery } from "./daily/ReadSection.js";
import { fanNoteDraftsReducer } from "./daily/fanNoteDrafts.js";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { Pagination } from "@/components/shared/Pagination";
import { FanIntelligenceMarkdown } from "@/components/page/FanIntelligenceMarkdown";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatUsdFromMills, resolveFanLabelForScope } from "@agency_hub_core/shared";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDate, formatDateTime, transactionStateLabel, transactionTypeLabel, daysRemaining } from "@/lib/format";
import { usePeriodStore, type SpenderPeriodOption } from "@/stores/periodStore";
import { toast } from "sonner";
import { isSafeInAppPath, resolveFanProfileBackTarget, resolveSpenderPeriod } from "@/lib/navigation";
import type {
  FanProfileDocument,
  FanProfileVersionListResponse,
  FanTransactionListResponse,
  PageFanDetailResponse,
} from "@agency_hub_core/contracts";

const PAGE_SIZE = 50;

const SPENT_LABEL: Record<SpenderPeriodOption, string> = {
  today: "Потратил сегодня",
  "7d": "Потратил за 7 дней",
  "30d": "Потратил за 30 дней",
  "90d": "Потратил за 90 дней",
  "180d": "Потратил за 180 дней",
  all: "Потратил за всё время",
};

/** Whether the fan was opened from a list that remembered where to return. */
function hasRememberedReturn(state: unknown): boolean {
  return typeof state === "object"
    && state !== null
    && "backTo" in state
    && typeof state.backTo === "string"
    && isSafeInAppPath(state.backTo);
}

function stateClass(state: string): string {
  if (state === "posted") return "text-green";
  if (state === "pending") return "text-warning-dark";
  return "text-text-muted";
}

export function FanProfilePage() {
  const { pageLabel, platform, platformUserId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [txOffset, setTxOffset] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedProfileVersion, setSelectedProfileVersion] = useState<number | null>(null);
  const routeKey = `${pageLabel ?? ""}\0${platform ?? ""}\0${platformUserId ?? ""}`;
  const auth = useAuthMe();
  const principalId = auth.data?.user.id ?? null;
  const [noteDrafts, dispatchNoteDraft] = useReducer(fanNoteDraftsReducer, { principalId, drafts: {} });
  const noteBody = noteDrafts.principalId === principalId ? noteDrafts.drafts[routeKey] ?? "" : "";
  const setNoteBody = (text: string) => dispatchNoteDraft({ type: "edit", principalId, routeKey, text });
  useEffect(() => { dispatchNoteDraft({ type: "principal", principalId }); }, [principalId]);
  const { period } = usePeriodStore();
  const selectedPeriod = resolveSpenderPeriod(search.get("period"), period);
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;

  useEffect(() => {
    setTxOffset(0);
    setHistoryOpen(false);
    setSelectedProfileVersion(null);
  }, [routeKey]);

  const { data, isLoading, isError, refetch } = usePageFanDetail(pageLabel!, platformUserId!);
  const latestProfileQuery = usePageFanProfile(pageLabel!, platformUserId!);
  const versionsQuery = usePageFanProfileVersions(
    pageLabel!,
    platformUserId!,
    { enabled: historyOpen },
  );
  const selectedProfileQuery = usePageFanProfileVersion(
    pageLabel!,
    platformUserId!,
    selectedProfileVersion,
    { enabled: selectedProfileVersion !== null },
  );
  const spenderQuery = useSpenderDetail(platform!, platformUserId!, {
    scope: "page",
    pageLabel,
    period: spenderPeriod,
  });
  const transactionsQuery = usePageFanTransactions(pageLabel!, platformUserId!, {
    limit: PAGE_SIZE,
    offset: txOffset,
  });
  const createNote = useCreateFanNote();
  const backTo = resolveFanProfileBackTarget(location.state, pageLabel);

  if (isLoading || !data) {
    if (isLoading) {
      return <FanProfileSkeleton />;
    }
    if (isError) {
      return (
        <StatusPanel
          title="Не удалось загрузить профиль фана"
          description="Данные фана на этой странице сейчас недоступны."
          tone="error"
          action={<><button type="button" onClick={() => void refetch()}>Повторить</button><button type="button" onClick={() => navigate(backTo)}>Назад к списку</button></>}
        />
      );
    }
    return <FanProfileSkeleton />;
  }

  const { fan, page } = data;
  const fanLabel = resolveFanLabelForScope(fan, "page");
  const spenderDetail = spenderQuery.data;
  const txData = transactionsQuery.data;
  const latestProfileData = latestProfileQuery.data;
  const profileVersionsData = versionsQuery.data;
  const selectedProfileData = selectedProfileQuery.data;

  // Type breakdown from spender detail
  const typeBreakdown = spenderDetail?.typeBreakdown ?? [];
  function amountForType(canonicalType: string): number {
    const entry = typeBreakdown.find(
      (t: { canonicalType: string }) => t.canonicalType === canonicalType,
    );
    return entry?.creatorNetAmountMills ?? 0;
  }
  const totalSpent = spenderPeriod === "lifetime"
    ? (spenderDetail?.metrics.lifetime.scopeCreatorNetAmountMills ?? null)
    : (spenderDetail?.metrics.window?.creatorNetAmountMills ?? null);

  const txItems = txData?.items ?? [];
  const txTotal = txData?.total ?? 0;
  const latestProfile = latestProfileData?.profile ?? null;
  const profileVersions = profileVersionsData?.items ?? [];
  const viewingHistoricalVersion = selectedProfileVersion !== null;
  const displayedProfile = viewingHistoricalVersion
    ? selectedProfileData ?? null
    : latestProfile;
  const profileQuery = viewingHistoricalVersion ? selectedProfileQuery : latestProfileQuery;
  const profileLoading = profileQuery.isLoading;
  const selectedVersionIsCurrent = selectedProfileVersion !== null
    && latestProfile?.version === selectedProfileVersion;

  async function handleAddNote() {
    const body = noteBody.trim();
    if (!body || createNote.isPending) return;
    const submittedRoute = routeKey;
    const submittedText = noteBody;
    const submittedPrincipalId = principalId;
    try {
      await createNote.mutateAsync({ pageLabel: pageLabel!, platformUserId: platformUserId!, body });
      dispatchNoteDraft({ type: "saved", principalId: submittedPrincipalId, routeKey: submittedRoute, submittedText });
      toast.success("Заметка добавлена");
    } catch {
      toast.error("Не удалось добавить заметку");
    }
  }

  const stats = [
    {
      label: SPENT_LABEL[selectedPeriod],
      value: totalSpent === null ? "—" : formatUsdFromMills(totalSpent),
      accent: true,
    },
    {
      label: "Подписки",
      value: formatUsdFromMills(amountForType("subscription")),
      accent: false,
    },
    {
      label: "Чаевые",
      value: formatUsdFromMills(amountForType("tip")),
      accent: false,
    },
    {
      label: "Платные сообщения",
      value: formatUsdFromMills(amountForType("message_purchase")),
      accent: false,
    },
  ];

  const subscriptionRemainingDays = page.subscriptionExpiresAt
    ? daysRemaining(page.subscriptionExpiresAt)
    : null;
  const metaLine = [
    fanLabel.secondaryPlatformHandle ? `@${fanLabel.secondaryPlatformHandle}` : null,
    fan.createdAtExternal ? `на площадке с ${formatDate(fan.createdAtExternal, { includeYear: true })}` : null,
  ].filter(Boolean).join(" · ");
  const statusBadges: ReactNode[] = [];
  if (page.isSubscriber) {
    statusBadges.push(
      <span
        key="subscriber"
        className="badge badge-success"
        title={subscriptionRemainingDays !== null ? `Осталось ${subscriptionRemainingDays} дн` : undefined}
      >
        Подписчик{page.subscriptionExpiresAt ? ` · до ${formatDate(page.subscriptionExpiresAt, { includeYear: true })}` : ""}
      </span>,
    );
    if (page.autoRenew === false) {
      statusBadges.push(
        <span key="renew" className="badge badge-warning">
          Без автопродления
          {page.autoRenewOffDetectedAt ? ` с ${formatDate(page.autoRenewOffDetectedAt, { includeYear: true })}` : ""}
        </span>,
      );
    } else if (page.autoRenew === true) {
      statusBadges.push(<span key="renew" className="badge">Автопродление вкл.</span>);
    }
  }
  if (page.isFollower) {
    statusBadges.push(<span key="follower" className="badge">Фолловер</span>);
  }
  if (page.isSubscriber && page.subscriberSince) {
    statusBadges.push(
      <span key="since" className="text-[13px] text-text-secondary">подписан с {formatDate(page.subscriberSince, { includeYear: true })}</span>,
    );
  }

  return (
    <div className="space-y-6">
      <div>
        {hasRememberedReturn(location.state) && (
          <Link to={backTo} className="link mb-3 inline-flex text-sm">← Назад</Link>
        )}
        <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />
        <PageHeader
          title={fanLabel.label}
          description={metaLine || statusBadges.length > 0 ? (
            <>
              {metaLine}
              {statusBadges.length > 0 && (
                <span className={`flex flex-wrap items-center gap-2 ${metaLine ? "mt-2" : ""}`}>{statusBadges}</span>
              )}
            </>
          ) : undefined}
        />
      </div>

      <ReadSection title="Доход от фана" query={spenderQuery} skeleton="stats">
        <div>
          <div className="stat-grid max-sm:grid-cols-2">
            {stats.map((stat) => (
              <div key={stat.label} className="stat">
                <div className="stat-label">{stat.label}</div>
                <div className={`stat-value ${stat.accent ? "text-accent" : ""}`}>{stat.value}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[13px] text-text-secondary">После комиссии платформы, по операциям этой страницы. История ниже — за всё время.</p>
        </div>
      </ReadSection>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <FanDossierCard
          viewingHistoricalVersion={viewingHistoricalVersion}
          selectedProfileVersion={selectedProfileVersion}
          selectedVersionIsCurrent={selectedVersionIsCurrent}
          onBackToLatest={() => setSelectedProfileVersion(null)}
          profileLoading={profileLoading}
          profileQuery={profileQuery}
          displayedProfile={displayedProfile}
          historyOpen={historyOpen}
          onToggleHistory={() => setHistoryOpen((value) => !value)}
          profileVersionsLoading={versionsQuery.isLoading}
          versionsQuery={versionsQuery}
          profileVersions={profileVersions}
          onSelectProfileVersion={setSelectedProfileVersion}
        />

        <FanNotesCard
          notes={page.notes}
          noteBody={noteBody}
          onNoteBodyChange={setNoteBody}
          onAddNote={handleAddNote}
          isAddingNote={createNote.isPending}
        />
      </div>

      <ReadSection title="История операций" query={transactionsQuery}>
        <FanTransactionHistorySection
          txItems={txItems}
          txTotal={txTotal}
          txOffset={txOffset}
          onPageChange={setTxOffset}
        />
      </ReadSection>

      <details className="help">
        <summary>Технические детали</summary>
        <div className="help-body">
          <p>ID фана на площадке: <span className="font-medium text-text-primary tabular-nums">{platformUserId}</span></p>
        </div>
      </details>
    </div>
  );
}

function FanDossierCard({
  viewingHistoricalVersion,
  selectedProfileVersion,
  selectedVersionIsCurrent,
  onBackToLatest,
  profileLoading,
  profileQuery,
  displayedProfile,
  historyOpen,
  onToggleHistory,
  profileVersionsLoading,
  versionsQuery,
  profileVersions,
  onSelectProfileVersion,
}: {
  viewingHistoricalVersion: boolean;
  selectedProfileVersion: number | null;
  selectedVersionIsCurrent: boolean;
  onBackToLatest: () => void;
  profileLoading: boolean;
  profileQuery: SectionQuery;
  displayedProfile: FanProfileDocument | null;
  historyOpen: boolean;
  onToggleHistory: () => void;
  profileVersionsLoading: boolean;
  versionsQuery: SectionQuery;
  profileVersions: FanProfileVersionListResponse["items"];
  onSelectProfileVersion: (version: number) => void;
}) {
  return (
    <section className="card" aria-labelledby="fan-dossier-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="fan-dossier-title" className="card-title">Досье фана</h2>
          {displayedProfile && !profileLoading && (
            <p className="card-description">
              Версия {displayedProfile.version} · {formatDateTime(displayedProfile.createdAt)}
            </p>
          )}
        </div>
        {viewingHistoricalVersion && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge">
              Версия {selectedProfileVersion}{selectedVersionIsCurrent ? " · текущая" : ""}
            </span>
            <button type="button" onClick={onBackToLatest} className="link text-sm">
              К последней версии
            </button>
          </div>
        )}
      </div>

      <div className="card-body">
        <ReadSection title="Досье фана" query={profileQuery} skeleton="text">
          {profileLoading ? (
            <p className="text-sm text-text-secondary">
              {viewingHistoricalVersion ? "Загружаем выбранную версию…" : "Загружаем досье…"}
            </p>
          ) : viewingHistoricalVersion && !displayedProfile ? (
            <p className="text-sm text-text-secondary">Не удалось загрузить выбранную версию.</p>
          ) : displayedProfile ? (
            <FanIntelligenceMarkdown body={displayedProfile.body} />
          ) : (
            <p className="text-sm text-text-secondary">Досье пока нет.</p>
          )}
        </ReadSection>

        <div className="mt-4 border-t border-border-light pt-3">
          <button
            type="button"
            onClick={onToggleHistory}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary"
            aria-expanded={historyOpen}
          >
            История версий
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={`transition-transform ${historyOpen ? "rotate-180" : ""}`}
            />
          </button>

          {historyOpen && (
            <div className="mt-2">
              <ReadSection title="Версии досье" query={versionsQuery} skeleton="text">
                {profileVersionsLoading ? (
                  <p className="text-sm text-text-secondary">Загружаем версии…</p>
                ) : profileVersions.length === 0 ? (
                  <p className="text-sm text-text-secondary">Сохранённых версий пока нет.</p>
                ) : (
                  <ul className="divide-y divide-border-light overflow-hidden rounded-lg border border-border">
                    {profileVersions.map((item) => {
                      const selected = selectedProfileVersion === item.version;
                      return (
                        <li key={item.version}>
                          <button
                            type="button"
                            onClick={() => onSelectProfileVersion(item.version)}
                            aria-pressed={selected}
                            className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                              selected ? "bg-hover" : "hover:bg-hover-alt"
                            }`}
                          >
                            <span className="flex items-center gap-2">
                              <span className="font-medium text-text-primary">Версия {item.version}</span>
                              {item.isCurrent && <span className="badge">текущая</span>}
                            </span>
                            <span className="text-xs text-text-secondary">{formatDateTime(item.createdAt)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </ReadSection>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FanNotesCard({
  notes,
  noteBody,
  onNoteBodyChange,
  onAddNote,
  isAddingNote,
}: {
  notes: PageFanDetailResponse["page"]["notes"];
  noteBody: string;
  onNoteBodyChange: (value: string) => void;
  onAddNote: () => void;
  isAddingNote: boolean;
}) {
  return (
    <section className="card" aria-labelledby="fan-notes-title">
      <div className="card-header">
        <h2 id="fan-notes-title" className="card-title">Заметки</h2>
      </div>
      <div className="card-body space-y-3">
        <textarea
          aria-label="Новая заметка о фане"
          value={noteBody}
          onChange={(event) => onNoteBodyChange(event.target.value)}
          placeholder="Напишите заметку…"
          rows={3}
          className="textarea resize-y"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onAddNote}
            disabled={!noteBody.trim() || isAddingNote}
            className="btn btn-primary btn-sm"
          >
            {isAddingNote ? "Сохраняем…" : "Добавить заметку"}
          </button>
        </div>

        {notes.length === 0 ? (
          <p className="text-sm text-text-secondary">Заметок пока нет.</p>
        ) : (
          <ul className="space-y-2 border-t border-border-light pt-3">
            {notes.map((note) => (
              <li key={note.id} className="rounded-lg bg-hover-alt px-3 py-2">
                <div className="text-xs text-text-secondary">{formatDateTime(note.createdAt)}</div>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-text-primary">{note.body}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
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
    <section className="card overflow-hidden" aria-labelledby="fan-history-title">
      <div className="card-header">
        <div>
          <h2 id="fan-history-title" className="card-title">
            История операций <span className="ml-1 font-normal text-text-secondary tabular-nums">{txTotal}</span>
          </h2>
          <p className="card-description">Все операции фана на этой странице, после комиссии платформы.</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Тип</th>
              <th>Статус</th>
              <th className="num">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {txItems.length === 0 && (
              <tr>
                <td colSpan={4} className="py-8 text-center text-text-secondary">
                  {txOffset > 0 ? "На этой странице списка записей нет." : "Операций пока нет."}
                  {txOffset > 0 && <button type="button" className="link ml-2" onClick={() => onPageChange(0)}>К началу списка</button>}
                </td>
              </tr>
            )}
            {txItems.map((tx) => (
              <tr key={tx.transactionId}>
                <td className="muted">{formatDateTime(tx.occurredAt)}</td>
                <td>{transactionTypeLabel(tx.canonicalType)}</td>
                <td>
                  <span className={stateClass(tx.transactionState)}>
                    {transactionStateLabel(tx.transactionState)}
                  </span>
                </td>
                <td className="num font-medium">{formatUsdFromMills(tx.netAmountMills)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
    <div className="space-y-6" aria-label="Загружаем профиль фана" aria-busy="true">
      <div>
        <div className="h-7 w-48 rounded bg-hover animate-pulse" />
        <div className="mt-2 h-4 w-32 rounded bg-hover animate-pulse" />
      </div>
      <div className="stat-grid max-sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="stat">
            <div className="h-3 w-20 rounded bg-hover animate-pulse" />
            <div className="mt-3 h-7 w-24 rounded bg-hover animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
