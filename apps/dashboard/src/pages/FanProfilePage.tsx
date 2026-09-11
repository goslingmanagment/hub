import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
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
import { useSpenderPeriodStore } from "@/stores/spenderPeriodStore";
import { toast } from "sonner";
import { TRANSACTION_STATE_COLORS } from "@/lib/constants";
import { audiencePaginationLabels, audiencePeriod, resolveAudienceBackTarget } from "@/lib/audienceNavigation";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
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

type FanReadState = {
  hasData: boolean;
  error: boolean;
  retry: () => unknown;
};

function fanReadState(query: { data?: unknown; isError?: boolean; refetch: () => unknown }): FanReadState {
  return { hasData: query.data !== undefined, error: Boolean(query.isError), retry: query.refetch };
}

function FanSectionNotice({ state, loadingLabel }: { state: FanReadState; loadingLabel: string }) {
  if (state.error) return <QueryNotice error stale={state.hasData} retry={state.retry} />;
  if (!state.hasData) return <p role="status" className="mb-3 text-sm text-text-muted">{loadingLabel}</p>;
  return null;
}

export function FanProfilePage() {
  const { pageLabel, platform, platformUserId } = useParams();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const txOffset = listOffset(search.get("txOffset"));
  function setTxOffset(offset: number) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      if (offset) next.set("txOffset", String(offset)); else next.delete("txOffset");
      return next;
    });
  }
  const [noteBody, setNoteBody] = useState("");
  const [noteError, setNoteError] = useState("");
  const noteInFlight = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);
  const [selectedProfileVersion, setSelectedProfileVersion] = useState<number | null>(null);
  const routeKey = `${pageLabel ?? ""}\0${platform ?? ""}\0${platformUserId ?? ""}`;
  const currentNote = useRef({ routeKey, noteBody });
  currentNote.current = { routeKey, noteBody };
  const { period } = useSpenderPeriodStore();
  const selectedPeriod = audiencePeriod(search.get("period"), period);
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;

  useEffect(() => {
    setNoteBody("");
    setNoteError("");
    setHistoryOpen(false);
    setIntelligenceOpen(false);
    setSelectedProfileVersion(null);
  }, [routeKey]);

  const { data, isError, refetch } = usePageFanDetail(pageLabel!, platformUserId!);
  const latestProfileQuery = usePageFanProfile(pageLabel!, platformUserId!);
  const profileVersionsQuery = usePageFanProfileVersions(
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
  const txQuery = usePageFanTransactions(pageLabel!, platformUserId!, {
    limit: PAGE_SIZE,
    offset: txOffset,
  });
  const timelineQuery = usePageFanTransactions(pageLabel!, platformUserId!, {
    limit: 10,
    offset: 0,
  });
  const createNote = useCreateFanNote(pageLabel!, platformUserId!);

  const backTo = resolveAudienceBackTarget(location.search, location.state, pageLabel);
  const backLink = <Link to={backTo} className="mb-4 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"><ArrowLeft size={14} />Назад к списку</Link>;

  if (!data) {
    return <div className="p-4 md:p-0">{backLink}{isError ? (
      <StatusPanel title="Не удалось загрузить карточку фана" description="Повторите запрос или вернитесь к исходному списку." tone="error" action={<button type="button" className="text-accent font-semibold" onClick={() => void refetch()}>Повторить</button>} />
    ) : <div role="status" aria-label="Загрузка карточки фана"><FanProfileSkeleton /></div>}</div>;
  }

  const { fan, page } = data;
  const fanLabel = resolveFanLabelForScope(fan, "page");
  const spenderDetail = spenderQuery.data;
  const txData = txQuery.data;
  const timelineTxData = timelineQuery.data;
  const latestProfileData = latestProfileQuery.data;
  const profileVersionsData = profileVersionsQuery.data;
  const selectedProfileData = selectedProfileQuery.data;
  const moneyState = fanReadState(spenderQuery);
  const latestProfileState = fanReadState(latestProfileQuery);
  const profileVersionsState = fanReadState(profileVersionsQuery);
  const txState = fanReadState(txQuery);
  const timelineState = fanReadState(timelineQuery);
  // Type breakdown from spender detail
  const typeBreakdown = spenderDetail?.typeBreakdown;
  function amountForType(canonicalType: string): number | null {
    if (!typeBreakdown) return null;
    const entry = typeBreakdown.find(
      (t: { canonicalType: string }) => t.canonicalType === canonicalType,
    );
    return entry?.creatorNetAmountMills ?? 0;
  }
  const totalSpent = spenderPeriod === "lifetime"
    ? (spenderDetail?.metrics.lifetime.scopeCreatorNetAmountMills ?? null)
    : (spenderDetail?.metrics.window?.creatorNetAmountMills ?? null);

  const txItems = txData?.items ?? [];
  const txTotal = txData?.total;
  const latestProfile = latestProfileData?.profile ?? null;
  const profileVersions = profileVersionsData?.items ?? [];
  const viewingHistoricalVersion = selectedProfileVersion !== null;
  const displayedProfile = viewingHistoricalVersion
    ? selectedProfileData ?? null
    : latestProfile;
  const profileState = viewingHistoricalVersion
    ? fanReadState(selectedProfileQuery)
    : latestProfileState;
  const selectedVersionIsCurrent = selectedProfileVersion !== null
    && latestProfile?.version === selectedProfileVersion;

  async function handleAddNote() {
    const body = noteBody.trim();
    if (!body || noteInFlight.current) return;
    noteInFlight.current = true;
    setNoteError("");
    const origin = { routeKey, noteBody };
    try {
      await createNote.mutateAsync({ body });
      if (currentNote.current.routeKey === origin.routeKey && currentNote.current.noteBody === origin.noteBody) setNoteBody("");
      toast.success(`${pageLabel} · заметка для ${fanLabel} добавлена`);
    } catch {
      if (currentNote.current.routeKey === origin.routeKey) setNoteError("Не удалось добавить заметку. Текст сохранён — повторите после проверки соединения.");
      else toast.error(`${pageLabel} · не удалось добавить заметку для ${fanLabel}`);
    } finally { noteInFlight.current = false; }
  }

  const stats = [
    {
      label: "Доход автора",
      value: totalSpent === null ? "—" : formatUsdFromMills(totalSpent),
      accent: true,
    },
    {
      label: "Подписки",
      value: amountForType("subscription") === null ? "—" : formatUsdFromMills(amountForType("subscription")!),
      accent: false,
    },
    {
      label: "Чаевые",
      value: amountForType("tip") === null ? "—" : formatUsdFromMills(amountForType("tip")!),
      accent: false,
    },
    {
      label: "Покупки сообщений",
      value: amountForType("message_purchase") === null ? "—" : formatUsdFromMills(amountForType("message_purchase")!),
      accent: false,
    },
  ];
  const subscriptionRemainingDays = page.subscriptionExpiresAt
    ? daysRemaining(page.subscriptionExpiresAt)
    : null;

  // Build timeline from its own independent query so paging the table below
  // does not corrupt the timeline.
  const timelineEvents = (timelineTxData?.items ?? []).map((tx) => ({
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
    <div className="min-w-0 p-4 md:p-0">
      {backLink}
      <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />

      {/* Header */}
      <div className="mb-6 flex items-start gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-hover text-2xl font-bold text-text-secondary">
          {fanLabel.label[0]?.toUpperCase() ?? "?"}
        </div>
        <div>
          <h1 className="break-words text-2xl font-extrabold text-text-primary">
            {fanLabel.label}
          </h1>
          {fanLabel.secondaryPlatformHandle && (
            <div className="mt-1 text-sm text-text-muted">@{fanLabel.secondaryPlatformHandle}</div>
          )}
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            {page?.isSubscriber && <Badge variant="subscriber">Подписка</Badge>}
            {page?.isFollower && <Badge variant="follower">Фолловер</Badge>}
          </div>
          <p className="mt-1 text-xs text-text-muted">
            ID платформы: {platformUserId}
            {fan?.createdAtExternal && (
              <> &middot; Регистрация: {formatDate(fan.createdAtExternal)}</>
            )}
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <p className="mb-3 text-xs text-text-muted">Доход автора после комиссии за выбранный период. История операций ниже охватывает всё время.</p>
      <FanSectionNotice state={moneyState} loadingLabel="Загружаем суммы…" />
      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
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
            Состояние подписки
          </div>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <CalendarDays size={14} className="text-text-muted" />
              <div>
                <div className="text-xs text-text-muted">Окончание</div>
                <div className="text-sm font-medium text-text-primary">
                  {page.subscriptionExpiresAt ? formatDate(page.subscriptionExpiresAt) : "—"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-text-muted" />
              <div>
                <div className="text-xs text-text-muted">Осталось</div>
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
                <div className="text-xs text-text-muted">Автопродление</div>
                <div className={`text-sm font-medium ${
                  page.autoRenew === true
                    ? "text-green"
                    : page.autoRenew === false
                      ? "text-danger"
                      : "text-text-muted"
                }`}>
                  {page.autoRenew === true ? "Включено" : page.autoRenew === false ? "Выключено" : "Неизвестно"}
                </div>
                {page.autoRenew === false && page.autoRenewOffDetectedAt && (
                  <div className="text-xs text-warning-dark">
                    Замечено {formatDate(page.autoRenewOffDetectedAt, { includeYear: true })}
                  </div>
                )}
              </div>
            </div>
            {page.subscriberSince && (
              <div>
                <div className="text-xs text-text-muted">Начало</div>
                <div className="text-sm font-medium text-text-primary">{formatDate(page.subscriberSince)}</div>
              </div>
            )}
          </div>
        </div>
      )}

      <FanIntelligenceSection
        pageLabel={page.pageLabel}
        latestProfile={latestProfile}
        latestProfileState={latestProfileState}
        intelligenceOpen={intelligenceOpen}
        onOpen={() => setIntelligenceOpen(true)}
        viewingHistoricalVersion={viewingHistoricalVersion}
        selectedProfileVersion={selectedProfileVersion}
        selectedVersionIsCurrent={selectedVersionIsCurrent}
        onBackToLatest={() => setSelectedProfileVersion(null)}
        profileState={profileState}
        displayedProfile={displayedProfile}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((value) => !value)}
        profileVersionsState={profileVersionsState}
        profileVersions={profileVersions}
        onSelectProfileVersion={handleSelectProfileVersion}
      />

      <FanProfileActivityGrid
        notes={page.notes}
        noteError={noteError}
        noteBody={noteBody}
        onNoteBodyChange={setNoteBody}
        onAddNote={handleAddNote}
        isAddingNote={createNote.isPending}
        timelineState={timelineState}
        timelineEvents={timelineEvents}
        timelineDotColor={timelineDotColor}
      />

      <FanTransactionHistorySection
        state={txState}
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
  latestProfileState,
  intelligenceOpen,
  onOpen,
  viewingHistoricalVersion,
  selectedProfileVersion,
  selectedVersionIsCurrent,
  onBackToLatest,
  profileState,
  displayedProfile,
  historyOpen,
  onToggleHistory,
  profileVersionsState,
  profileVersions,
  onSelectProfileVersion,
}: {
  pageLabel: string;
  latestProfile: FanProfileDocument | null;
  latestProfileState: FanReadState;
  intelligenceOpen: boolean;
  onOpen: () => void;
  viewingHistoricalVersion: boolean;
  selectedProfileVersion: number | null;
  selectedVersionIsCurrent: boolean;
  onBackToLatest: () => void;
  profileState: FanReadState;
  displayedProfile: FanProfileDocument | null;
  historyOpen: boolean;
  onToggleHistory: () => void;
  profileVersionsState: FanReadState;
  profileVersions: FanProfileVersionListResponse["items"];
  onSelectProfileVersion: (version: number) => void;
}) {
  if (!latestProfile && latestProfileState.hasData && !latestProfileState.error && !intelligenceOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="mb-6 flex w-full items-center justify-between rounded-xl border border-border bg-card px-5 py-4 text-left transition-colors hover:bg-hover-alt"
      >
        <span className="text-sm font-bold text-text-primary">AI-профиль фана</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Профиль ещё не создан</span>
          <ChevronDown size={16} className="text-text-muted" />
        </div>
      </button>
    );
  }

  return (
    <section className="mb-6 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-text-primary">AI-профиль фана</h2>
          <p className="mt-1 text-xs text-text-muted">
            Последний сохранённый профиль ChatMuse на {pageLabel}.
          </p>
        </div>
        {viewingHistoricalVersion && (
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-border bg-hover px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Версия {selectedProfileVersion}
            </span>
            {selectedVersionIsCurrent && (
              <span className="rounded-full border border-border bg-hover-alt px-2 py-1 text-[11px] text-text-muted">
                Текущая
              </span>
            )}
            <button
              type="button"
              onClick={onBackToLatest}
              className="text-xs font-medium text-accent transition-colors hover:opacity-80"
            >
              К последней версии
            </button>
          </div>
        )}
      </div>

      {viewingHistoricalVersion && <FanSectionNotice state={latestProfileState} loadingLabel="Проверяем текущую версию…" />}
      <div className="mt-4 rounded-xl border border-border bg-hover-alt/40 p-5">
        <FanSectionNotice state={profileState} loadingLabel={viewingHistoricalVersion ? "Загружаем выбранную версию…" : "Загружаем AI-профиль…"} />
        {!profileState.hasData ? null : viewingHistoricalVersion && !displayedProfile ? (
          <p className="text-sm text-text-muted">Выбранная версия недоступна.</p>
        ) : displayedProfile ? (
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
              <span>Версия {displayedProfile.version}</span>
              <span>&middot;</span>
              <span>{formatDateTime(displayedProfile.createdAt)}</span>
            </div>
            <FanIntelligenceMarkdown body={displayedProfile.body} />
          </div>
        ) : (
          <p className="text-sm text-text-muted">AI-профиль ещё не создан</p>
        )}
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={onToggleHistory}
          className="flex w-full items-center justify-between rounded-lg border border-border bg-hover-alt/30 px-4 py-2.5 text-left transition-colors hover:bg-hover-alt"
          aria-expanded={historyOpen}
        >
          <span className="text-[13px] font-medium text-text-secondary">История версий</span>
          <ChevronDown
            size={16}
            className={`text-text-muted transition-transform ${historyOpen ? "rotate-180" : ""}`}
          />
        </button>

        {historyOpen && (
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
            <div className="px-4 pt-3"><FanSectionNotice state={profileVersionsState} loadingLabel="Загружаем версии…" /></div>
            {!profileVersionsState.hasData ? null : profileVersions.length === 0 ? (
              <div className="px-4 py-4 text-sm text-text-muted">Сохранённых версий пока нет.</div>
            ) : (
              <div>
                {profileVersions.map((item) => {
                  const selected = selectedProfileVersion === item.version;
                  return (
                    <button
                      key={item.version}
                      type="button"
                      onClick={() => onSelectProfileVersion(item.version)}
                      aria-pressed={selected}
                      className={`flex w-full items-center justify-between border-t border-border px-4 py-3 text-left transition-colors first:border-t-0 ${
                        selected ? "bg-hover" : "hover:bg-hover-alt"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">
                          Версия {item.version}
                        </span>
                        {item.isCurrent && (
                          <span className="rounded-full border border-border bg-hover px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                            Текущая
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
  noteError,
  noteBody,
  onNoteBodyChange,
  onAddNote,
  isAddingNote,
  timelineEvents,
  timelineState,
  timelineDotColor,
}: {
  notes: PageFanDetailResponse["page"]["notes"];
  noteError: string;
  noteBody: string;
  onNoteBodyChange: (value: string) => void;
  onAddNote: () => void;
  isAddingNote: boolean;
  timelineEvents: TimelineEvent[];
  timelineState: FanReadState;
  timelineDotColor: (type: string) => string;
}) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-text-primary">Заметки</h2>
          <button
            type="button"
            onClick={onAddNote}
            disabled={!noteBody.trim() || isAddingNote}
            className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Добавить
          </button>
        </div>

        <div className="space-y-2 mb-3">
          {notes.length === 0 && (
            <p className="text-xs text-text-muted">Заметок пока нет.</p>
          )}
          {notes.map((note) => (
            <div
              key={note.id}
              className="rounded-md border-l-[3px] border-border bg-hover-alt p-2.5"
            >
              <div className="text-[11px] text-text-muted">
                Заметка &middot; {formatDateTime(note.createdAt)}
              </div>
              <div className="mt-1 text-sm text-text-primary">{note.body}</div>
            </div>
          ))}
        </div>

        {noteError && <p role="alert" className="mb-2 text-sm text-danger">{noteError}</p>}
        <textarea
          aria-label="Новая заметка"
          disabled={isAddingNote}
          value={noteBody}
          onChange={(event) => onNoteBodyChange(event.target.value)}
          placeholder="Текст заметки…"
          rows={3}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none"
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-bold text-text-primary">Последние операции</h2>
        <FanSectionNotice state={timelineState} loadingLabel="Загружаем последние операции…" />
        {timelineState.hasData && timelineEvents.length === 0 && (
          <p className="text-xs text-text-muted">Операций пока нет.</p>
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
  state,
  txItems,
  txTotal,
  txOffset,
  onPageChange,
}: {
  state: FanReadState;
  txItems: FanTransactionListResponse["items"];
  txTotal: number | undefined;
  txOffset: number;
  onPageChange: (offset: number) => void;
}) {
  return (
    <section className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold text-text-primary">
          История операций
          <span className="ml-2 text-xs font-normal text-text-muted">{txTotal === undefined ? "Число операций неизвестно" : `${txTotal} записей`}</span>
        </h2>
      </div>
      <div className="px-4 pt-3"><FanSectionNotice state={state} loadingLabel="Загружаем историю операций…" /></div>
      {state.hasData && <>
      <table className="w-full min-w-[540px] border-collapse">
        <thead>
          <tr className="bg-hover-alt">
            {["Дата", "Тип", "Статус", "Доход автора"].map((col) => (
              <th
                key={col}
                className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted ${
                  col === "Доход автора" ? "text-right" : "text-left"
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
                {txOffset > 0 ? "На этой странице нет операций." : "Операции пока не найдены."}
                {txOffset > 0 && <button type="button" className="block mx-auto mt-2 text-accent" onClick={() => onPageChange(0)}>К началу истории</button>}
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
        total={txTotal!}
        onPageChange={onPageChange}
        {...audiencePaginationLabels}
      />
      </>}
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
      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
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
