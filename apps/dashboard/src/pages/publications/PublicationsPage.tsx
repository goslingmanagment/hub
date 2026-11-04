import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { PUBLICATION_APPROVE_BATCH_MAX, PUBLICATION_SCHEDULE_HORIZON_DAYS, PUBLICATION_STATUSES } from "@agency_hub_core/shared";
import type { PublicationWire, PublicationWithdrawResult } from "@agency_hub_core/contracts";
import { useAdminConfig } from "@/api/adminConfig";
import { useAuthMe } from "@/api/queries";
import {
  publicationsQueryOptions,
  useApprovePublications,
  useCancelPublication,
  useDeletePublicationPost,
  usePublicationQueues,
  usePublicationSettings,
  usePublicationsNotOut,
  usePublicationsWaiting,
  useRefreshPublicationQueue,
  useReplacePublication,
  useWithdrawPagePublications,
  useWithdrawPublication,
} from "@/api/publications";
import { useOfapiStatus, useWaitingCounts } from "@/api/waiting";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { formatWindowRange } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { seedValue } from "@/pages/settings/ConfigurationEditors";
import {
  ApprovalReport,
  ApproveManyDialog,
  ApproveOneDialog,
  CancelDialog,
  DeletePostDialog,
  RefreshOnlyfansDialog,
  ResolveDialog,
  WithdrawDialog,
  WithdrawPageDialog,
  WithdrawReport,
  type PagePlace,
} from "./PublicationDialogs.js";
import { PublicationDrawer } from "./PublicationDrawer.js";
import { FeedSkeleton, PublicationsFeed, type RowActions } from "./PublicationsFeed.js";
import { PublicationsPagesStrip, type StripPage } from "./PublicationsPagesStrip.js";
import { PublicationSettingsDrawer, SettingsDialog, type SettingsPageRow } from "./PublicationSettingsDrawer.js";
import {
  PUBLICATIONS_LIST_LIMIT,
  PUBLICATIONS_WAITING_LIMIT,
  PUBLICATION_WINDOWS,
  STATUS_FILTER_LABELS,
  actionFailure,
  actionFailureToast,
  approvalItems,
  approvalOutcome,
  approvalSummary,
  dayKeyOf,
  deletePostResultText,
  feedCountLabel,
  feedDays,
  isApprovable,
  isStopped,
  manualFeedRows,
  pagePublishing,
  parsePublicationsView,
  postsCountLabel,
  publicationsSearch,
  selectionLabel,
  windowPhrase,
  windowRange,
  withdrawResultText,
  type ApprovalRefusal,
  type PagePublishing,
  type PublicationStatusFilter,
  type PublicationsView,
} from "./publicationsView.js";

/** Today's Moscow day, read again each minute: the date window follows the calendar, not the clock. */
function useTodayKey(): string {
  const [today, setToday] = useState(() => dayKeyOf(new Date()));
  useEffect(() => {
    const timer = window.setInterval(() => setToday(dayKeyOf(new Date())), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return today;
}

type Segment = "all" | "draft" | "unknown" | "not_out";
const SEGMENT_TARGETS: Readonly<Record<Segment, Pick<PublicationsView, "status" | "window">>> = {
  all: { status: null, window: "next7" },
  draft: { status: "draft", window: "all" },
  unknown: { status: "unknown", window: "all" },
  not_out: { status: "not_out", window: "last7" },
};
const SEGMENT_LABELS: Readonly<Record<Segment, string>> = {
  all: "Все",
  draft: "Ждут утверждения",
  unknown: "Исход неизвестен",
  not_out: "Не вышли за 7 дней",
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type CountedQuery = { data?: { publications: PublicationWire[] } | undefined; isError: boolean };

/**
 * «Публикации» (design/screens/publications.md): what goes out on every page
 * and when, what waits for approval or an answer, and whether a page can
 * publish. The page filter only narrows what is shown: every write takes its
 * target from its own row, card or form.
 */
export function PublicationsPage() {
  const [search, setSearch] = useSearchParams();
  const view = parsePublicationsView(search);
  const filter = usePageFilter();
  const pageLabel = filter.page;
  const { pages: catalog } = useDashboardShell();
  const { data: auth } = useAuthMe();
  const role = auth?.user.role ?? "owner";
  const ofapi = useOfapiStatus(role);
  const { loginPages } = useWaitingCounts(role);
  const todayKey = useTodayKey();
  const range = useMemo(() => windowRange(view.window, todayKey), [view.window, todayKey]);
  const lastWeek = useMemo(() => windowRange("last7", todayKey), [todayKey]);
  const notOut = view.status === "not_out";

  // ── reads ──
  const single = useQuery({
    ...publicationsQueryOptions({
      ...(pageLabel === null ? {} : { pageLabel }),
      ...(view.status === null || view.status === "not_out" ? {} : { status: view.status }),
      ...range,
      limit: PUBLICATIONS_LIST_LIMIT,
    }),
    enabled: !notOut,
  });
  const merged = usePublicationsNotOut(range, pageLabel, PUBLICATIONS_LIST_LIMIT, notOut);
  const list = notOut
    ? merged
    : {
      data: single.data,
      longest: single.data?.publications.length ?? 0,
      isLoading: single.isLoading,
      isError: single.isError,
      isFetching: single.isFetching,
      isPlaceholderData: single.isPlaceholderData,
      dataUpdatedAt: single.dataUpdatedAt,
      refetch: single.refetch,
    };
  const waiting = usePublicationsWaiting();
  const weekNotOut = usePublicationsNotOut(lastWeek, null, PUBLICATIONS_WAITING_LIMIT);
  const settings = usePublicationSettings();
  const queues = usePublicationQueues();
  const config = useAdminConfig();

  // ── writes: the mutations as they were, each called with its row's own target ──
  const approve = useApprovePublications();
  const cancel = useCancelPublication();
  const refreshQueue = useRefreshPublicationQueue();
  const withdraw = useWithdrawPublication();
  const withdrawPage = useWithdrawPagePublications();
  const deletePost = useDeletePublicationPost();
  const replace = useReplacePublication();
  const busy = approve.isPending || cancel.isPending || withdraw.isPending || withdrawPage.isPending || deletePost.isPending || replace.isPending;

  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  // The ticks do not outlive the view they were made on: a hidden row cannot be
  // approved together with the visible ones.
  useEffect(() => {
    setSelected(new Set());
  }, [pageLabel, view.status, view.window]);
  /** The rows of an approval window, frozen when it opened: the versions the person saw. */
  const [approving, setApproving] = useState<PublicationWire[] | null>(null);
  const [cancelling, setCancelling] = useState<PublicationWire | null>(null);
  const [withdrawing, setWithdrawing] = useState<PublicationWire | null>(null);
  const [deleting, setDeleting] = useState<PublicationWire | null>(null);
  const [resolving, setResolving] = useState<PublicationWire | null>(null);
  const [withdrawingPage, setWithdrawingPage] = useState<StripPage | null>(null);
  const [refreshingOf, setRefreshingOf] = useState<StripPage | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [approvalReport, setApprovalReport] = useState<{ approved: number; refused: ApprovalRefusal[] } | null>(null);
  const [withdrawReport, setWithdrawReport] = useState<{ pageLabel: string; platform: string; results: PublicationWithdrawResult[] } | null>(null);

  /** A change of the view's own parameters; the page and every other parameter stay. */
  const change = useCallback((next: Partial<Omit<PublicationsView, "pageLabel">>, replaceEntry: boolean) => {
    setSearch(publicationsSearch(next, new URLSearchParams(window.location.search)), { replace: replaceEntry });
  }, [setSearch]);

  // ── pages ──
  const configItems = useMemo(() => config.data?.subsystems.flatMap((subsystem) => subsystem.items), [config.data]);
  const onlyfansItem = configItems?.find((item) => item.key === "publishingOnlyfansEnabled");
  const onlyfansSwitch = onlyfansItem === undefined ? null : seedValue(onlyfansItem) === "true";
  const places = useMemo(() => new Map<string, PagePlace>(catalog.map((page) => [page.label, { modelName: page.modelName, username: page.username }])), [catalog]);
  const queueByPage = useMemo(() => new Map((queues.data?.pages ?? []).map((queue) => [queue.pageLabel, queue])), [queues.data]);
  const settingsPages = useMemo(() => {
    const order = new Map(catalog.map((page, index) => [page.label, index]));
    // Hub does not publish in Telegram: its page answers like any other and is left out here.
    return (settings.data?.pages ?? [])
      .filter((page) => page.platform === "fansly" || page.platform === "onlyfans")
      .sort((a, b) => (order.get(a.pageLabel) ?? 999) - (order.get(b.pageLabel) ?? 999));
  }, [settings.data, catalog]);
  const pageStates = useMemo(() => {
    const login = new Set(loginPages);
    return new Map<string, PagePublishing>(settingsPages.map((page) => [page.pageLabel, pagePublishing({
      platform: page.platform,
      settings: page,
      globalEnabled: settings.data?.globalEnabled ?? true,
      ofapi,
      onlyfansSwitch,
      needsLogin: login.has(page.pageLabel),
      queue: queueByPage.get(page.pageLabel),
      todayKey,
    })]));
  }, [settingsPages, settings.data, ofapi, onlyfansSwitch, loginPages, queueByPage, todayKey]);
  const stoppedPages = useMemo(() => new Set(settingsPages.filter(isStopped).map((page) => page.pageLabel)), [settingsPages]);
  const ofapiOffPages = useMemo(() => new Set(ofapi === "off"
    ? [...catalog.filter((page) => page.platform === "onlyfans").map((page) => page.label), ...settingsPages.filter((page) => page.platform === "onlyfans").map((page) => page.pageLabel)]
    : []), [ofapi, catalog, settingsPages]);
  const stripPages: StripPage[] = settingsPages.flatMap((page) => {
    const state = pageStates.get(page.pageLabel);
    return state === undefined ? [] : [{
      pageLabel: page.pageLabel,
      platform: page.platform as "fansly" | "onlyfans",
      username: places.get(page.pageLabel)?.username ?? null,
      state,
      queue: queueByPage.get(page.pageLabel),
    }];
  });

  // ── the feed ──
  const publications = useMemo(() => list.data?.publications ?? [], [list.data]);
  const manual = useMemo(
    () => manualFeedRows(queues.data?.pages ?? [], { pageLabel, status: view.status, window: view.window }, range, ofapi === "off"),
    [queues.data, pageLabel, view.status, view.window, range, ofapi],
  );
  const days = useMemo(() => feedDays(publications, manual, todayKey), [publications, manual, todayKey]);
  const shownInOrder = useMemo(() => days.flatMap((day) => day.rows.flatMap((row) => (row.kind === "post" ? [row.publication] : []))), [days]);
  const canSelect = useCallback((publication: PublicationWire) => isApprovable(publication) && !ofapiOffPages.has(publication.pageLabel), [ofapiOffPages]);
  const selectable = shownInOrder.filter(canSelect);
  // A ticked row that left the list or stopped being approvable is not ticked any more.
  const selection = new Set(selectable.filter((item) => selected.has(item.id)).map((item) => item.id));
  const selectedRows = selectable.filter((item) => selection.has(item.id));
  const placeholder = list.isPlaceholderData;
  const tooMany = selection.size > PUBLICATION_APPROVE_BATCH_MAX;

  function select(ids: number[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const openHref = (id: number) => `?${publicationsSearch({ publication: id, panel: null }, search).toString()}`;

  const actions: RowActions = {
    busy,
    stoppedPages,
    ofapiOffPages,
    usernameOf: (label) => places.get(label)?.username ?? null,
    openHref: (publication) => openHref(publication.id),
    onOpen: (publication) => change({ publication: publication.id, panel: null }, true),
    onApprove: (publication) => setApproving([publication]),
    onCancel: setCancelling,
    onResolve: setResolving,
    onWithdraw: setWithdrawing,
    onDeletePost: setDeleting,
    onReplace: (publication) => replace.mutate(publication.id, {
      onSuccess: () => toast.success("Замена создана черновиком: утвердите её"),
      onError: (error) => toast.error(actionFailure(error), actionFailureToast(error)),
    }),
  };

  function runApproval(rows: PublicationWire[]) {
    // The body comes from the rows frozen when the window opened, in the order shown.
    const items = approvalItems(rows, new Set(rows.map((row) => row.id)));
    if (items.length === 0 || approve.isPending) return;
    const summary = approvalSummary(rows, pageStates, todayKey);
    setApprovalReport(null);
    approve.mutate(items, {
      onSuccess: (result) => {
        const outcome = approvalOutcome(result.results, todayKey);
        setSelected(new Set());
        if (outcome.refused.length === 0) toast.success(summary.toast);
        else setApprovalReport(outcome);
      },
      onError: (error) => toast.error(`Не удалось утвердить: ${actionFailure(error)}`, actionFailureToast(error)),
      onSettled: () => setApproving(null),
    });
  }

  function refresh(page: StripPage) {
    refreshQueue.mutate(page.pageLabel, {
      onSuccess: () => toast.success(page.platform === "fansly" ? "Hub прочитает расписание в течение пары минут" : "Hub прочитает расписание в течение минуты"),
      onError: (error) => toast.error(actionFailure(error), actionFailureToast(error)),
      onSettled: () => setRefreshingOf(null),
    });
  }

  // ── «Ждут вас» of this screen: the home's reads, the page counted here ──
  const onPage = (rows: readonly PublicationWire[]) => (pageLabel === null ? rows : rows.filter((row) => row.pageLabel === pageLabel));
  const counted = (query: CountedQuery): number | null => {
    if (query.data === undefined) return query.isError ? null : 0;
    return onPage(query.data.publications).length;
  };
  const capped = (query: CountedQuery) => query.data?.publications.length === PUBLICATIONS_WAITING_LIMIT;
  const segment: Segment | null = view.status === null ? "all"
    : view.status === "draft" || view.status === "unknown" || view.status === "not_out" ? view.status : null;
  const counts: Partial<Record<Segment, { value: number | null; capped: boolean; ink: boolean }>> = {
    draft: { value: counted(waiting.drafts), capped: capped(waiting.drafts), ink: true },
    unknown: { value: counted(waiting.unknown), capped: capped(waiting.unknown), ink: true },
    not_out: { value: counted(weekNotOut), capped: false, ink: false },
  };
  const waitingRows = [...(waiting.drafts.data?.publications ?? []), ...(waiting.unknown.data?.publications ?? [])];
  const elsewhere = pageLabel === null ? 0 : waitingRows.filter((row) => row.pageLabel !== pageLabel).length;
  const outsideDates = (view.status === null || view.status === "draft") && view.window !== "all"
    ? onPage(waiting.drafts.data?.publications ?? []).filter((row) => {
      const at = Date.parse(row.publishAt);
      return (range.from !== undefined && at < Date.parse(range.from)) || (range.to !== undefined && at >= Date.parse(range.to));
    }).length
    : 0;

  // ── header ──
  const dates = view.window === "all" || range.from === undefined || range.to === undefined ? "Все даты" : formatWindowRange(range.from, range.to);
  const freshAt = list.dataUpdatedAt;
  const refreshing = list.isFetching || settings.isFetching || queues.isFetching;
  const refetchAll = () => {
    void list.refetch();
    void settings.refetch();
    void queues.refetch();
  };

  const globalOff = settings.data?.globalEnabled === false;
  const pickedOfOff = filter.item?.platform === "onlyfans" && ofapi === "off";
  const shownPublication = view.publication;
  const drawerRow = shownPublication === null ? undefined
    : [...publications, ...waitingRows].find((row) => row.id === shownPublication);
  const editingSettings = editing === null ? undefined : settingsPages.find((page) => page.pageLabel === editing);

  const settingsRows: SettingsPageRow[] = settingsPages.flatMap((page) => {
    const state = pageStates.get(page.pageLabel);
    return state === undefined ? [] : [{ settings: page, state, queue: queueByPage.get(page.pageLabel) }];
  });

  const statusPhrase = view.status === null ? ""
    : view.status === "not_out" ? " невышедших постов"
      : ` постов со статусом «${STATUS_FILTER_LABELS[view.status]}»`;
  const totalRows = days.reduce((sum, day) => sum + day.total, 0);

  return (
    <div className="pub-screen">
      <PageHeader
        actions={(
          <Segmented
            className="pub-window-seg"
            label="Даты"
            value={view.window}
            onChange={(window) => change({ window }, false)}
            options={PUBLICATION_WINDOWS.map((item) => ({ value: item.key, label: item.label }))}
          />
        )}
        window={dates}
        fresh={freshAt > 0 ? { at: freshAt, onRefresh: refetchAll, refreshing } : undefined}
      />

      {(globalOff || pickedOfOff) && (
        <div className="pub-notices">
          {globalOff && (
            <Notice
              tone="off"
              detail="Hub ничего не публикует ни на одной странице, что бы ни стояло у страниц."
              action={<button type="button" className="btn btn-sm" onClick={() => change({ panel: "settings", publication: null }, true)}>Настройки публикации</button>}
            >
              <b>Общий выключатель выключен.</b>
            </Notice>
          )}
          {pickedOfOff && (
            <Notice tone="off" detail="OnlyFans API выключен с 1 ноября. Записи ниже не обновляются.">
              <b>{filter.page}: публикация недоступна.</b>
            </Notice>
          )}
        </div>
      )}

      <PublicationsPagesStrip
        pages={stripPages}
        picked={pageLabel}
        loading={settings.isLoading}
        failed={settings.data === undefined && settings.isError}
        onRetry={() => void settings.refetch()}
        busy={busy}
        refreshing={refreshQueue.isPending}
        onPick={(label) => filter.select(label)}
        onEdit={(label) => { setEditing(label); change({ panel: "settings", publication: null }, true); }}
        onOpenSettings={() => change({ panel: "settings", publication: null }, true)}
        onRefresh={(page) => (page.platform === "onlyfans" ? setRefreshingOf(page) : refresh(page))}
        onWithdrawAll={setWithdrawingPage}
      />

      <div className="table-toolbar pub-toolbar">
        <div className="pub-filters">
          <div className="segmented" role="group" aria-label="Статус">
            {(Object.keys(SEGMENT_LABELS) as Segment[]).map((key) => {
              const count = counts[key];
              const value = count?.value;
              return (
                <button
                  key={key}
                  type="button"
                  className="segment"
                  aria-pressed={segment === key}
                  title={value === null ? "Не удалось проверить" : undefined}
                  onClick={() => { if (segment !== key) change(SEGMENT_TARGETS[key], false); }}
                >
                  {SEGMENT_LABELS[key]}
                  {count !== undefined && value !== 0 && value !== undefined && (
                    <span className={`segment-count ${count.ink && value !== null ? "pub-count-ink" : ""}`.trim()}>
                      {value === null ? "—" : count.capped && pageLabel === null ? `${value}+` : value}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <select
            className={`select pub-status-select ${segment === null ? "is-picked" : ""}`.trim()}
            aria-label="Другой статус"
            value={segment === null ? view.status ?? "" : ""}
            onChange={(event) => { if (event.target.value !== "") change({ status: event.target.value as PublicationStatusFilter }, false); }}
          >
            <option value="">Другой статус</option>
            {PUBLICATION_STATUSES.map((status) => <option key={status} value={status}>{STATUS_FILTER_LABELS[status]}</option>)}
          </select>
        </div>
        <div className="pub-toolbar-notes">
          {elsewhere > 0 && (
            <span className="table-toolbar-note">
              Показана только {pageLabel}. На других страницах ждут ещё {postsCountLabel(elsewhere)}.{" "}
              <button type="button" className="link" onClick={() => filter.select(null)}>Показать все страницы</button>
            </span>
          )}
          {outsideDates > 0 && (
            <span className="table-toolbar-note">
              Ещё {postsCountLabel(outsideDates)} {ruPlural(outsideDates, "ждёт", "ждут", "ждут")} утверждения вне этих дат.{" "}
              <button type="button" className="link" onClick={() => change({ window: "all" }, false)}>Показать все даты</button>
            </span>
          )}
          {elsewhere === 0 && outsideDates === 0 && selection.size === 0 && selectable.length > 0 && (
            <span className="table-toolbar-note">Можно утвердить: {selectable.length}</span>
          )}
        </div>
      </div>

      {approvalReport !== null && <ApprovalReport report={approvalReport} onClose={() => setApprovalReport(null)} />}
      {withdrawReport !== null && <WithdrawReport report={withdrawReport} todayKey={todayKey} onClose={() => setWithdrawReport(null)} />}

      {!list.data ? (
        list.isLoading ? <FeedSkeleton /> : (
          <div className="card">
            <StatusPanel
              tone="error"
              title="Hub не ответил"
              description="Список не пришёл. Публикации никуда не делись: попробуйте ещё раз."
              action={<button type="button" className="btn btn-sm" onClick={() => void list.refetch()}>Повторить</button>}
            />
          </div>
        )
      ) : (
        <>
          <QueryNotice error={list.isError} stale retry={list.refetch} at={freshAt} />
          {queues.isError && (
            <Notice
              tone="warning"
              role="alert"
              className="mb-3"
              action={<button type="button" className="btn btn-sm" onClick={() => void queues.refetch()}>Повторить</button>}
            >
              Не удалось прочитать, что стоит на площадках. Посты, поставленные вручную, не показаны.
            </Notice>
          )}
          {list.longest >= PUBLICATIONS_LIST_LIMIT && (
            <Notice tone="warning" className="mb-3">Показаны первые {PUBLICATIONS_LIST_LIMIT}. Сузьте фильтр, чтобы увидеть остальные.</Notice>
          )}
          {days.length === 0 ? (
            <div className="card">
              {view.status !== null ? (
                <StatusPanel
                  title={`${capitalize(windowPhrase(view.window))}${pageLabel === null ? "" : ` на ${pageLabel}`}${statusPhrase} нет`}
                  action={<button type="button" className="btn btn-sm" onClick={() => change({ status: null }, false)}>Показать все статусы</button>}
                />
              ) : pageLabel !== null ? (
                <StatusPanel
                  title={`На ${pageLabel} ${windowPhrase(view.window)} публикаций нет`}
                  action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}
                />
              ) : (
                <StatusPanel
                  title={`${capitalize(windowPhrase(view.window))} публикаций нет`}
                  description="Черновики создают агенты и люди; здесь их утверждают."
                  action={view.window === "all" ? undefined : <button type="button" className="btn btn-sm" onClick={() => change({ window: "all" }, false)}>Показать все даты</button>}
                />
              )}
            </div>
          ) : (
            <PublicationsFeed
              days={days}
              todayKey={todayKey}
              showPage={pageLabel === null}
              selection={selection}
              canSelect={canSelect}
              selectDisabled={placeholder || busy}
              onSelect={select}
              pageStates={pageStates}
              actions={actions}
              dimmed={placeholder}
              footer={`Показано ${feedCountLabel(totalRows, manual.length)}`}
              selectBar={selection.size > 0 ? (
                <div className="select-bar pub-select-bar">
                  <span className="select-bar-text">{selectionLabel(selectedRows)}</span>
                  {tooMany && <span className="pub-select-note">За один раз можно утвердить не больше {PUBLICATION_APPROVE_BATCH_MAX} постов</span>}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Снять выбор</button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy || tooMany || placeholder}
                    onClick={() => setApproving(selectedRows)}
                  >
                    {approve.isPending ? "Утверждаем…" : `Утвердить ${postsCountLabel(selection.size)}`}
                  </button>
                </div>
              ) : null}
            />
          )}
        </>
      )}

      <Disclosure label="Как это считается" className="pub-help">
        <p>Время везде московское, день — московские сутки.</p>
        <p>«Ждут утверждения» и «Исход неизвестен» считают все даты. «Не вышли за 7 дней» — статусы «Не вышел», «Отклонён» и «Пропущен» за последние 7 дней, сегодня включительно.</p>
        <p>Hub ставит посты в расписание площадки за {PUBLICATION_SCHEDULE_HORIZON_DAYS} дней до выхода, позже стоящие посты ждут в Hub.</p>
        <p>Посты, поставленные вручную, Hub видит в расписании самой площадки. Расписание Fansly он читает раз в час через браузер страницы, по кнопке — в течение пары минут. Расписание OnlyFans — раз в час, пока там стоят его посты, иначе раз в сутки, по кнопке — сразу, и это тратит кредиты.</p>
        <p>Неполный или несвежий список не доказывает, что поста там нет.</p>
      </Disclosure>

      {shownPublication !== null ? (
        <PublicationDrawer
          key={shownPublication}
          id={shownPublication}
          row={drawerRow}
          todayKey={todayKey}
          pageState={drawerRow ? pageStates.get(drawerRow.pageLabel) : undefined}
          username={drawerRow ? places.get(drawerRow.pageLabel)?.username ?? null : null}
          actions={actions}
          publicationHref={openHref}
          onClose={() => change({ publication: null }, true)}
        />
      ) : view.panel === "settings" ? (
        <PublicationSettingsDrawer
          rows={settingsRows}
          settingsState={settings.data ? "ready" : settings.isLoading ? "loading" : "failed"}
          globalEnabled={settings.data?.globalEnabled ?? null}
          config={configItems}
          configState={config.data ? "ready" : config.isLoading ? "loading" : "failed"}
          ofapiOff={ofapi === "off"}
          focusPage={pageLabel}
          onRetrySettings={() => void settings.refetch()}
          onRetryConfig={() => void config.refetch()}
          onEdit={setEditing}
          onClose={() => change({ panel: null }, true)}
        />
      ) : null}

      {approving !== null && approving.length === 1 && approving[0] !== undefined && (
        <ApproveOneDialog
          publication={approving[0]}
          place={places.get(approving[0].pageLabel)}
          page={pageStates.get(approving[0].pageLabel)}
          ofapiOn={ofapi === "on"}
          todayKey={todayKey}
          isPending={approve.isPending}
          onConfirm={() => runApproval(approving)}
          onClose={() => { if (!approve.isPending) setApproving(null); }}
        />
      )}
      {approving !== null && approving.length > 1 && (
        <ApproveManyDialog
          summary={approvalSummary(approving, pageStates, todayKey)}
          ofapiOnPages={ofapi === "on" && approving.some((row) => row.platform === "onlyfans")}
          isPending={approve.isPending}
          onConfirm={() => runApproval(approving)}
          onClose={() => { if (!approve.isPending) setApproving(null); }}
        />
      )}
      {cancelling !== null && (
        <CancelDialog
          publication={cancelling}
          place={places.get(cancelling.pageLabel)}
          todayKey={todayKey}
          isPending={cancel.isPending}
          onClose={() => { if (!cancel.isPending) setCancelling(null); }}
          onConfirm={() => cancel.mutate(cancelling.id, {
            onSuccess: () => toast.success("Публикация отменена"),
            onError: (error) => toast.error(actionFailure(error), actionFailureToast(error)),
            onSettled: () => setCancelling(null),
          })}
        />
      )}
      {withdrawing !== null && (
        <WithdrawDialog
          publication={withdrawing}
          place={places.get(withdrawing.pageLabel)}
          todayKey={todayKey}
          isPending={withdraw.isPending}
          onClose={() => { if (!withdraw.isPending) setWithdrawing(null); }}
          onConfirm={() => withdraw.mutate(withdrawing.id, {
            onSuccess: (response) => {
              const result = response.results[0];
              const text = result === undefined ? "Hub не прислал исход команды" : capitalize(withdrawResultText(result));
              if (result !== undefined && (result.outcome === "accepted" || result.outcome === "withdrawn")) toast.success(text);
              else toast.error(text, { duration: Infinity });
            },
            onError: (error) => toast.error(actionFailure(error), actionFailureToast(error)),
            onSettled: () => setWithdrawing(null),
          })}
        />
      )}
      {deleting !== null && (
        <DeletePostDialog
          publication={deleting}
          place={places.get(deleting.pageLabel)}
          todayKey={todayKey}
          isPending={deletePost.isPending}
          onClose={() => { if (!deletePost.isPending) setDeleting(null); }}
          onConfirm={() => deletePost.mutate(deleting.id, {
            onSuccess: (response) => {
              const result = response.results[0];
              if (result?.outcome === "accepted") toast.success(deletePostResultText(result));
              else toast.error(result === undefined ? "Hub не прислал исход команды" : deletePostResultText(result), { duration: Infinity });
            },
            onError: (error) => toast.error(actionFailure(error), actionFailureToast(error)),
            onSettled: () => setDeleting(null),
          })}
        />
      )}
      {withdrawingPage !== null && (
        <WithdrawPageDialog
          pageLabel={withdrawingPage.pageLabel}
          platform={withdrawingPage.platform}
          place={places.get(withdrawingPage.pageLabel)}
          queue={withdrawingPage.queue}
          isPending={withdrawPage.isPending}
          onClose={() => { if (!withdrawPage.isPending) setWithdrawingPage(null); }}
          onConfirm={() => withdrawPage.mutate(withdrawingPage.pageLabel, {
            onSuccess: (response) => setWithdrawReport({ pageLabel: withdrawingPage.pageLabel, platform: withdrawingPage.platform, results: response.results }),
            onError: (error) => toast.error(actionFailure(error), actionFailureToast(error)),
            onSettled: () => setWithdrawingPage(null),
          })}
        />
      )}
      {refreshingOf !== null && (
        <RefreshOnlyfansDialog
          pageLabel={refreshingOf.pageLabel}
          isPending={refreshQueue.isPending}
          onConfirm={() => refresh(refreshingOf)}
          onClose={() => { if (!refreshQueue.isPending) setRefreshingOf(null); }}
        />
      )}
      {resolving !== null && (
        <ResolveDialog
          key={resolving.id}
          publication={resolving}
          username={places.get(resolving.pageLabel)?.username ?? null}
          todayKey={todayKey}
          onClose={() => setResolving(null)}
        />
      )}
      {editingSettings !== undefined && settings.data !== undefined && (
        <SettingsDialog
          key={editingSettings.pageLabel}
          settings={editingSettings}
          globalEnabled={settings.data.globalEnabled}
          modelName={places.get(editingSettings.pageLabel)?.modelName ?? null}
          ofapiOff={ofapiOffPages.has(editingSettings.pageLabel)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
