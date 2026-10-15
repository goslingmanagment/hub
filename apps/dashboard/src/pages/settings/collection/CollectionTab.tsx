import { Fragment, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";

import {
  useAdminOfapiCollection,
  useAdminOfapiCollectionJobs,
  useAdminOfapiWebhookStatus,
  useOfapiCollectionApply,
  useOfapiCollectionJobCreate,
  useOfapiCollectionJobResume,
  useOfapiCollectionJobFinishIncomplete,
  useOfapiCollectionPreview,
  type OfapiCollectionCategory,
  type OfapiCollectionChangeBody,
  type OfapiCollectionJob,
  type OfapiCollectionJobBody,
  type OfapiCollectionJobStateFilter,
  type OfapiCollectionMode,
  type OfapiCollectionPreview,
  type OfapiCollectionSettings,
  type OfapiCollectionSnapshot,
} from "@/api/adminOfapiCollection";
import { useAdminUsers } from "@/api/adminUsers";
import { KernelApiError } from "@/api/sdk";
import { ModalShell } from "@/components/shared/ModalShell";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Tooltip } from "@/components/shared/Tooltip";

import {
  categoryLabel,
  categoryWhy,
  consumerLabel,
  JOB_STATE_FILTER_OPTIONS_RU,
  jobStateLabel,
  modeLabel,
  MODE_DESCRIPTIONS_RU,
  noScheduledReadsNote,
  PRICE_UNIT_LABELS_RU,
  prerequisiteLabel,
  sourceLabel,
  webhookOperationLabel,
  webhookStateLabel,
} from "./collectionCopyRu.js";
import {
  buildCategoryViews,
  buildChangeBody,
  CATEGORY_GROUP_ORDER,
  defaultJobBody,
  describePolicyPill,
  describeSettings,
  diffDraftAgainstSnapshot,
  DRAFT_STORAGE_KEY,
  draftBlockReason,
  draftEntries,
  draftKey,
  draftSize,
  emptyDraft,
  fmtCredits,
  formatBytes,
  groupCategoryViews,
  groupWebhookEvents,
  INTERVAL_OPTIONS_MINUTES,
  intervalLabel,
  jobProgress,
  jobReasonText,
  jobsFor,
  localDateTime,
  localDateTimeToIso,
  maskWebhookId,
  parseSelection,
  relativeAge,
  restoreDraft,
  rowState,
  ruPlural,
  sameSettings,
  scopeLabel,
  scopePageId,
  serializeDraft,
  staleEntries,
  stopSummary,
  summarizeAudit,
  usageTotals,
  utcDateTime,
  type ApplyPhase,
  type CategoryGroup,
  type CategoryView,
  type CollectionDraft,
  type CollectionScope,
  type DraftEntry,
  type RowTone,
  type StaleEntry,
  CAP_LEVER_FIELD_RU,
} from "./collectionModel.js";
import { DisclosureCard } from "./DisclosureCard.js";

// Settings › Collection (S-UI, decisions #250/#251). One screen: what the
// kernel asks OnlyFans API for in the background, how often, under which
// credit limits. Every control is a DRAFT until "Проверить и применить" runs
// the server preview and the versioned apply; opening the screen never spends
// a credit (the GET reads retained rows only). Supported modes come from the
// registry in the GET — the UI decides nothing about what a category can do.

const TONE_TEXT: Record<RowTone, string> = {
  ok: "text-green",
  warning: "text-warning-dark",
  danger: "text-danger",
  accent: "text-accent",
  muted: "text-text-secondary",
  off: "text-text-muted",
};

const TONE_DOT: Record<RowTone, string> = {
  ok: "status-dot status-dot-ok",
  warning: "status-dot status-dot-warn",
  danger: "status-dot status-dot-error",
  accent: "status-dot bg-accent",
  muted: "status-dot",
  off: "status-dot border border-text-muted bg-transparent",
};

/** Job states that still need the server or a person: the jobs card opens for them. */
const ACTIVE_JOB_STATES = new Set(["queued", "running", "paused", "blocked", "budget_exhausted"]);

function Dot(props: { tone: RowTone }) {
  return <span aria-hidden="true" className={TONE_DOT[props.tone]} />;
}

function StateLabel(props: { tone: RowTone; label: string; detail?: string | null }) {
  return (
    <div>
      <span className={`inline-flex items-center gap-2 text-sm font-medium ${TONE_TEXT[props.tone]}`}>
        <Dot tone={props.tone} />
        {props.label}
      </span>
      {props.detail && <div className="mt-0.5 text-xs leading-snug text-text-muted">{props.detail}</div>}
    </div>
  );
}

function ModeBadge(props: { mode: OfapiCollectionMode | "mixed"; draft?: boolean; job?: boolean; title?: string | undefined }) {
  const text = props.job ? "Разовая задача" : props.mode === "mixed" ? "Различается" : modeLabel(props.mode);
  const tone = props.job || props.mode === "off" ? "badge" : "badge badge-accent";
  return (
    <span className={tone} title={props.title}>
      {props.draft && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />}
      {text}
    </span>
  );
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isConflictError(error: unknown) {
  return error instanceof KernelApiError && error.status === 409;
}

function readStoredDraft(): CollectionDraft | null {
  if (typeof window === "undefined") return null;
  try {
    return restoreDraft(window.sessionStorage.getItem(DRAFT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredDraft(draft: CollectionDraft | null) {
  if (typeof window === "undefined") return;
  try {
    if (draft && draftSize(draft) > 0) {
      window.sessionStorage.setItem(DRAFT_STORAGE_KEY, serializeDraft(draft));
    } else {
      window.sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  } catch {
    // Storage may be unavailable (private mode); the in-memory draft still works.
  }
}

const FALLBACK_SETTINGS: Omit<OfapiCollectionSettings, "pageId" | "category"> = {
  mode: "off",
  intervalMinutes: 1440,
  dailyCreditLimit: 200,
  maxCallsPerRun: 10,
  includeDetails: false,
};

type Modal =
  | { kind: "preview"; preview: OfapiCollectionPreview; body: OfapiCollectionChangeBody }
  | { kind: "pause"; preview: OfapiCollectionPreview; body: OfapiCollectionChangeBody; resume: boolean }
  | { kind: "conflict" }
  | { kind: "job"; category: OfapiCollectionCategory; pageId: number | null };

export function CollectionTab() {
  const snapshotQuery = useAdminOfapiCollection();
  const usersQuery = useAdminUsers();
  const preview = useOfapiCollectionPreview();
  const apply = useOfapiCollectionApply();
  const jobCreate = useOfapiCollectionJobCreate();

  const [draft, setDraft] = useState<CollectionDraft | null>(readStoredDraft);
  const [scope, setScope] = useState<CollectionScope>(() => readStoredDraft()?.scope ?? { kind: "all" });
  const [expanded, setExpanded] = useState<OfapiCollectionCategory | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [applyPhase, setApplyPhase] = useState<ApplyPhase>({ kind: "idle" });
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const snapshot = snapshotQuery.data;
  const size = draftSize(draft);

  // The draft survives tab switches (SettingsPage unmounts the tab) and a
  // reload through sessionStorage; it is keyed by the revision it was built
  // against, so a newer server revision is detected on the way back.
  useEffect(() => {
    writeStoredDraft(draft);
  }, [draft]);

  useEffect(() => {
    if (size === 0 || typeof window === "undefined") return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [size]);

  // "Применено" only once the GET reports the applied revision.
  useEffect(() => {
    if (applyPhase.kind === "saved" && snapshot && snapshot.revision >= applyPhase.revision) {
      toast.success("Изменения применены и подтверждены сервером.");
      setApplyPhase({ kind: "idle" });
    }
  }, [applyPhase, snapshot]);

  const draftStale = draft !== null && size > 0 && snapshot !== undefined && draft.revision !== snapshot.revision;
  const conflict = conflictMessage !== null || draftStale;

  const views = useMemo(
    () => (snapshot ? buildCategoryViews(snapshot, scope) : []),
    [snapshot, scope],
  );
  const groups = useMemo(() => groupCategoryViews(views), [views]);
  const actorName = useCallback((userId: number) => {
    const user = usersQuery.data?.find((candidate) => candidate.id === userId);
    return user ? user.username : `пользователь ${userId}`;
  }, [usersQuery.data]);

  const updateEntry = useCallback((view: CategoryView, patch: Partial<OfapiCollectionSettings>) => {
    if (!snapshot) return;
    const pageId = scopePageId(scope);
    const key = draftKey(pageId, view.entry.id);
    setDraft((previous) => {
      const working = previous ?? emptyDraft(snapshot.revision, scope);
      const existing = working.entries[key];
      const base = existing ? existing.base : view.settings;
      const current: OfapiCollectionSettings = existing?.settings
        ?? view.settings
        ?? { ...FALLBACK_SETTINGS, pageId, category: view.entry.id };
      const next: OfapiCollectionSettings = { ...current, ...patch, pageId, category: view.entry.id };
      const entries = { ...working.entries };
      if (base && sameSettings(base, next)) {
        delete entries[key];
      } else {
        entries[key] = { settings: next, base };
      }
      return { ...working, entries };
    });
  }, [scope, snapshot]);

  const resetDraft = useCallback(() => {
    setDraft(null);
    setConflictMessage(null);
  }, []);

  const handleMutationError = useCallback((error: unknown, phase: "preview" | "apply" | "job") => {
    if (isConflictError(error)) {
      setConflictMessage(errorMessage(error, "Настройки изменены в другом окне."));
      setModal(null);
      return;
    }
    const message = errorMessage(error, "Запрос не выполнен.");
    if (phase === "apply") {
      setApplyPhase({ kind: "error", message });
    }
    toast.error(message);
  }, []);

  const runPreview = useCallback((body: OfapiCollectionChangeBody, onSuccess: (result: OfapiCollectionPreview) => void) => {
    preview.mutate(body, {
      onSuccess,
      onError: (error) => handleMutationError(error, "preview"),
    });
  }, [handleMutationError, preview]);

  const openDraftPreview = useCallback(() => {
    if (!draft || !snapshot) return;
    const body = buildChangeBody(draft);
    runPreview(body, (result) => setModal({ kind: "preview", preview: result, body }));
  }, [draft, runPreview, snapshot]);

  const openPausePreview = useCallback((resume: boolean) => {
    if (!snapshot) return;
    const body: OfapiCollectionChangeBody = {
      expectedRevision: snapshot.revision,
      changes: [],
      backgroundPaused: !resume,
    };
    runPreview(body, (result) => setModal({ kind: "pause", preview: result, body, resume }));
  }, [runPreview, snapshot]);

  const runApply = useCallback((body: OfapiCollectionChangeBody, clearDraft: boolean) => {
    setApplyPhase({ kind: "idle" });
    apply.mutate(body, {
      onSuccess: (result) => {
        setModal(null);
        setApplyPhase({ kind: "saved", revision: result.revision });
        setConflictMessage(null);
        if (clearDraft) setDraft(null);
        toast.message("Сохранено. Ждём подтверждения сервера.");
      },
      onError: (error) => handleMutationError(error, "apply"),
    });
  }, [apply, handleMutationError]);

  const submitJob = useCallback((body: OfapiCollectionJobBody) => {
    jobCreate.mutate(body, {
      onSuccess: () => {
        setModal(null);
        toast.success("Задача поставлена в очередь.");
      },
      onError: (error) => handleMutationError(error, "job"),
    });
  }, [handleMutationError, jobCreate]);

  const refreshAndCompare = useCallback(() => {
    void snapshotQuery.refetch();
    setModal({ kind: "conflict" });
  }, [snapshotQuery]);

  if (snapshotQuery.isLoading && !snapshot) {
    return <TableSkeleton rows={6} columns={6} />;
  }

  if (!snapshot) {
    return (
      <StatusPanel
        tone="error"
        title="Настройки сбора недоступны"
        description={errorMessage(snapshotQuery.error, "Сервер не ответил. Настройки сбора не прочитаны.")}
        action={(
          <button type="button" className="btn" onClick={() => void snapshotQuery.refetch()}>
            Повторить
          </button>
        )}
      />
    );
  }

  const pill = describePolicyPill({
    snapshot,
    applyPhase,
    conflict,
    actorName: (() => {
      const latest = snapshot.audit.find((row) => row.revision === snapshot.revision);
      return latest ? actorName(latest.actorUserId) : null;
    })(),
  });
  const scopePolicies = views.flatMap((view) => view.policies);
  const totals = usageTotals(scopePolicies);
  const stale = staleEntries(snapshot);
  const blockReason = draftBlockReason(draft);
  const busy = preview.isPending || apply.isPending;

  return (
    <div className="space-y-5 pb-24">
      {snapshotQuery.isError && <StaleDataNotice title="Показаны последние загруженные настройки" error={snapshotQuery.error} />}
      {snapshot.backgroundPaused && (
        <PausedBanner
          snapshot={snapshot}
          actorName={actorName}
          inFlight={totals.inFlight}
          busy={busy}
          onResume={() => openPausePreview(true)}
        />
      )}
      {stale.length > 0 && <StaleBanner entries={stale} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScopeSelect snapshot={snapshot} scope={scope} onChange={setScope} />
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="policy-pill" className="mr-1 inline-flex items-center gap-2 text-sm text-text-secondary">
            <Dot tone={pill.tone} />
            {pill.text}
          </span>
          {conflict && (
            <button type="button" className="btn btn-sm" onClick={refreshAndCompare}>
              Обновить и сравнить
            </button>
          )}
          {applyPhase.kind === "error" && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => (draft && size > 0 ? openDraftPreview() : setApplyPhase({ kind: "idle" }))}
            >
              Повторить
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm text-danger"
            disabled={snapshot.backgroundPaused || busy}
            onClick={() => openPausePreview(false)}
          >
            Остановить фоновый сбор
          </button>
        </div>
      </div>
      {applyPhase.kind === "error" && (
        <div role="alert" className="notice notice-danger">{applyPhase.message}</div>
      )}
      {conflictMessage && (
        <div role="status" className="notice">
          {conflictMessage} Черновик сохранён и не перетирает чужие изменения.
        </div>
      )}

      <UsageSummary views={views} totals={totals} />

      <section className="card" aria-labelledby="collection-categories-heading">
        <div className="card-header">
          <div className="min-w-0">
            <h3 id="collection-categories-heading" className="card-title">Категории</h3>
            <p className="card-description">
              {scope.kind === "all"
                ? `Что Hub загружает в фоне для всех страниц (${snapshot.pages.length}). Нажмите на строку, чтобы изменить режим и лимиты.`
                : `Что Hub загружает в фоне для страницы ${scopeLabel(scope.pageId, snapshot.pages)}. Нажмите на строку, чтобы изменить режим и лимиты.`}
            </p>
          </div>
        </div>
        {snapshot.pages.length === 0
          ? (
            <div className="empty">
              <p className="empty-title">Страниц OnlyFans нет</p>
              <p className="empty-text">Настройки сбора действуют только для страниц OnlyFans, подключённых к OnlyFans API.</p>
            </div>
          )
          : (
            <div className="overflow-x-auto">
              <table className="data-table min-w-[720px]">
                <thead>
                  <tr>
                    <th className="w-[36%]">Категория</th>
                    <th className="w-[17%]">Режим</th>
                    <th>Свежесть</th>
                    <th className="num">Сегодня, кр</th>
                    <th className="num">30 дней, кр</th>
                    <th className="w-[18%]">Состояние</th>
                  </tr>
                </thead>
                <tbody>
                  {CATEGORY_GROUP_ORDER.map((group) => (
                    groups[group].length === 0 ? null : (
                      <Fragment key={group}>
                        <GroupRow group={group} paused={snapshot.backgroundPaused} />
                        {groups[group].map((view) => (
                          <CategoryRow
                            key={view.entry.id}
                            snapshot={snapshot}
                            scope={scope}
                            view={view}
                            draftEntry={draft?.entries[draftKey(scopePageId(scope), view.entry.id)] ?? null}
                            expanded={expanded === view.entry.id}
                            onToggle={() => setExpanded((current) => (current === view.entry.id ? null : view.entry.id))}
                            onChange={(patch) => updateEntry(view, patch)}
                            onCreateJob={() => setModal({ kind: "job", category: view.entry.id, pageId: scopePageId(scope) })}
                          />
                        ))}
                      </Fragment>
                    )
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <JobsCard snapshot={snapshot} scope={scope} />
      <AuditCard snapshot={snapshot} actorName={actorName} />

      <div className="space-y-2">
        <details className="help">
          <summary>Как это работает</summary>
          <div className="help-body">
            <p>
              Изменения на этом экране сначала попадают в черновик. Они начинают действовать после «Проверить и применить»:
              сервер показывает, что изменится и сколько это может стоить, и только потом сохраняет.
            </p>
            <p>
              Выключение категории останавливает новые запросы; уже собранные данные остаются и показываются с их реальной
              свежестью. Лимиты проверяет сервер перед каждым запросом, а не форма. Включать можно по одной категории за раз.
            </p>
            <p>
              Расход вверху — только фоновые запросы этого экрана. События вебхука, действия чаттеров и внешние списания
              того же доступа сюда не входят.
            </p>
            <p>
              Сбор Fansly кредиты OnlyFans API не расходует. Пауза между его запросами задаётся в разделе{" "}
              <Link className="link" to="/settings?tab=configuration#config-fanslyDefaultDelayMs">«Система → Все параметры»</Link>.
            </p>
          </div>
        </details>
        <details className="help">
          <summary>Технические детали</summary>
          <div className="help-body">
            <p>Как сервер считает лимиты (текст сервера):</p>
            <p lang="en">{snapshot.limitDescription}</p>
          </div>
        </details>
      </div>

      {size > 0 && draft && (
        <DraftBar
          draft={draft}
          snapshot={snapshot}
          blockReason={blockReason}
          busy={busy}
          conflict={conflict}
          onReset={resetDraft}
          onPreview={openDraftPreview}
          onCompare={refreshAndCompare}
        />
      )}

      {modal?.kind === "preview" && (
        <PreviewModal
          snapshot={snapshot}
          draft={draft}
          preview={modal.preview}
          body={modal.body}
          pending={apply.isPending}
          onClose={() => setModal(null)}
          onApply={() => runApply(modal.body, true)}
        />
      )}
      {modal?.kind === "pause" && (
        <PauseModal
          snapshot={snapshot}
          preview={modal.preview}
          resume={modal.resume}
          pending={apply.isPending}
          onClose={() => setModal(null)}
          onApply={() => runApply(modal.body, false)}
        />
      )}
      {modal?.kind === "conflict" && draft && (
        <ConflictModal
          draft={draft}
          snapshot={snapshot}
          refreshing={snapshotQuery.isFetching}
          onClose={() => setModal(null)}
          onRebase={() => {
            setDraft({ ...draft, revision: snapshot.revision });
            setConflictMessage(null);
            setModal(null);
          }}
          onDiscard={() => {
            resetDraft();
            setModal(null);
          }}
        />
      )}
      {modal?.kind === "conflict" && !draft && (
        <ModalShell title="Изменения в другом окне" onClose={() => setModal(null)}>
          <p className="text-sm text-text-secondary">
            Черновика нет; экран показывает актуальные настройки.
          </p>
          <div className="mt-5 flex justify-end">
            <button type="button" className="btn" onClick={() => { setConflictMessage(null); setModal(null); }}>
              Понятно
            </button>
          </div>
        </ModalShell>
      )}
      {modal?.kind === "job" && (
        <JobModal
          snapshot={snapshot}
          category={modal.category}
          initialPageId={modal.pageId}
          pending={jobCreate.isPending}
          onClose={() => setModal(null)}
          onSubmit={submitJob}
        />
      )}
    </div>
  );
}

/** Which pages the table shows and edits: all of them (the shared setting)
 *  or one page's own. A select scales to any number of pages. */
function ScopeSelect(props: {
  snapshot: OfapiCollectionSnapshot;
  scope: CollectionScope;
  onChange: (scope: CollectionScope) => void;
}) {
  const id = useId();
  const value = props.scope.kind === "all" ? "all" : String(props.scope.pageId);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-sm font-medium text-text-secondary">Страница</label>
      <select
        id={id}
        className="select w-auto min-w-[200px] max-w-full"
        value={value}
        onChange={(event) => props.onChange(
          event.target.value === "all" ? { kind: "all" } : { kind: "page", pageId: Number(event.target.value) },
        )}
      >
        <option value="all">Все страницы</option>
        {props.snapshot.pages.map((page) => (
          <option key={page.id} value={String(page.id)}>{page.label}</option>
        ))}
      </select>
    </div>
  );
}

function PausedBanner(props: {
  snapshot: OfapiCollectionSnapshot;
  actorName: (userId: number) => string;
  inFlight: number;
  busy: boolean;
  onResume: () => void;
}) {
  const latest = props.snapshot.audit.find((row) => row.revision === props.snapshot.revision);
  return (
    <div role="status" className="notice notice-danger flex-wrap justify-between">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          Фоновый сбор остановлен
          {latest ? ` · ${props.actorName(latest.actorUserId)} · ${localDateTime(latest.createdAt)}` : ""}
        </p>
        <p className="mt-0.5">
          Новых фоновых запросов и разовых задач нет. Продолжают работать события вебхука, действия чаттеров и бесплатные
          чтения.{" "}
          {props.inFlight > 0
            ? <strong className="font-semibold">{props.inFlight} {ruPlural(props.inFlight, "запрос", "запроса", "запросов")} ещё в полёте — списание кредитов возможно.</strong>
            : "Запросов в полёте нет."}{" "}
          Режимы категорий сохранены.
        </p>
      </div>
      <button type="button" className="btn btn-primary btn-sm" disabled={props.busy} onClick={props.onResume}>
        Возобновить сбор
      </button>
    </div>
  );
}

/** Traffic plan §2.8 п. 3: categories no scheduled run completed for two
 *  intervals. Same rule as the digest incident `collection_stale`. */
export function StaleBanner(props: { entries: StaleEntry[] }) {
  const n = props.entries.length;
  const outgrows = props.entries.some((entry) => entry.outgrowsRun);
  const levers = (["calls", "credits"] as const).filter((lever) => props.entries.some((entry) => entry.lever === lever));
  return (
    <div role="status" data-testid="collection-stale-banner" className="notice notice-warning">
      <div className="min-w-0">
        <p className="font-semibold">
          Сбор по расписанию отстаёт: {n} {ruPlural(n, "категория не завершалась", "категории не завершались", "категорий не завершались")} успешно
          дольше двух интервалов
        </p>
        <ul className="mt-1.5 space-y-1">
          {props.entries.map((entry) => (
            <li key={`${entry.pageId}:${entry.category}`}>
              <span className="font-semibold">{categoryLabel(entry.category)}</span>
              {" · "}{entry.pageLabel}{" — "}{entry.cause}
              <span className="opacity-80">
                {" · "}
                {entry.policy.scheduleHealth.lastCompletedAt
                  ? `последний успешный проход ${localDateTime(entry.policy.scheduleHealth.lastCompletedAt)}`
                  : "успешных проходов не было"}
              </span>
            </li>
          ))}
        </ul>
        {outgrows && (
          <p className="mt-1.5">
            Проход начинается каждый интервал и тратит потолок задачи, но до конца списка не доходит.
            {levers.length > 0 && <>
              {" "}Поднять потолок: раскройте категорию и увеличьте {levers.map((lever) => CAP_LEVER_FIELD_RU[lever]).join(" или ")}.
            </>}
            {" "}Сохранённые настройки сами не меняются.
          </p>
        )}
      </div>
    </div>
  );
}

function UsageSummary(props: {
  views: CategoryView[];
  totals: ReturnType<typeof usageTotals>;
}) {
  const { totals } = props;
  const policies = props.views.flatMap((view) => view.policies);
  const managed = policies.filter((policy) => policy.mode !== "off" && policy.source !== "legacy_baseline");
  const legacy = policies.filter((policy) => policy.mode !== "off" && policy.source === "legacy_baseline");
  const managedLimit = managed.reduce((sum, policy) => sum + policy.dailyCreditLimit, 0);
  const legacyCategories = new Set(legacy.map((policy) => policy.category)).size;

  return (
    <section aria-labelledby="collection-usage-heading" className="space-y-2">
      <h3 id="collection-usage-heading" className="sr-only">Расход кредитов на фоновый сбор</h3>
      <div className="stat-grid grid-cols-2 lg:grid-cols-4">
        <div className="stat">
          <div className="stat-label">Зарезервировано сегодня</div>
          <div className="stat-value">{fmtCredits(totals.reservedCreditsToday)} кр</div>
          <div className="stat-meta">
            {totals.actualCreditsToday === null ? "факт не подтверждён" : `фактически списано ${fmtCredits(totals.actualCreditsToday)} кр`}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Запросов сегодня</div>
          <div className="stat-value">{fmtCredits(totals.callsToday)}</div>
          <div className="stat-meta">{totals.inFlight > 0 ? `в полёте: ${totals.inFlight}` : "в полёте нет"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">За 30 дней</div>
          <div className="stat-value">{fmtCredits(totals.credits30d)} кр</div>
        </div>
        <div className="stat">
          <div className="stat-label">Дневной предел</div>
          <div className="stat-value">{managed.length === 0 ? "—" : `${fmtCredits(managedLimit)} кр`}</div>
          <div className="stat-meta">
            {managed.length === 0 ? "нет включённых категорий" : "сумма лимитов включённых категорий"}
            {legacyCategories > 0
              ? ` · ещё ${legacyCategories} ${ruPlural(legacyCategories, "категория", "категории", "категорий")} на прежних настройках`
              : ""}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-xs text-text-secondary">
        <p>Только фоновые запросы этого экрана; сутки считаются по UTC.</p>
        <Link to="/ofapi-credits" className="link shrink-0">Полная картина списаний →</Link>
      </div>
    </section>
  );
}

const GROUP_COPY: Record<CategoryGroup, { title: string; hint: string; pausedHint?: string }> = {
  running: {
    title: "Действующая конфигурация",
    hint: "не меняется автоматически",
    pausedHint: "остановлена глобальной паузой",
  },
  available: {
    title: "Доступно к включению",
    hint: "по умолчанию выключено · включается по одной категории за применение",
  },
  one_off: {
    title: "Только разовые задачи",
    hint: "период, выбор и потолок задаются на каждую задачу",
  },
  unavailable: {
    title: "Ещё не реализовано",
    hint: "категории из плана без работающего кода",
  },
};

function GroupRow(props: { group: CategoryGroup; paused: boolean }) {
  const copyEntry = GROUP_COPY[props.group];
  return (
    <tr>
      <td colSpan={6} className="bg-hover-alt py-2 text-xs whitespace-normal">
        <span className="font-semibold text-text-primary">{copyEntry.title}</span>
        <span className="ml-2 text-text-muted">
          {props.paused && copyEntry.pausedHint ? copyEntry.pausedHint : copyEntry.hint}
        </span>
      </td>
    </tr>
  );
}

function CategoryRow(props: {
  snapshot: OfapiCollectionSnapshot;
  scope: CollectionScope;
  view: CategoryView;
  draftEntry: DraftEntry | null;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<OfapiCollectionSettings>) => void;
  onCreateJob: () => void;
}) {
  const { view, draftEntry, snapshot } = props;
  const detailId = useId();
  const state = rowState(view, snapshot.backgroundPaused);
  const expandable = view.group !== "unavailable";
  const legacy = !draftEntry && view.sources.includes("legacy_baseline");
  const shownSettings = draftEntry?.settings ?? view.settings;
  const modeForBadge: OfapiCollectionMode | "mixed" = draftEntry ? draftEntry.settings.mode : view.mode;
  const subline = draftEntry
    ? `черновик · было: ${draftEntry.base ? modeLabel(draftEntry.base.mode) : "различалось"}`
    : legacy
      ? ""
      : shownSettings && shownSettings.mode !== "off"
        ? describeSettings(shownSettings).split(" · ").slice(1).join(" · ")
        : "";
  const available = view.group === "available" && view.supportsToggle && !draftEntry
    ? ` · доступно: ${view.entry.modes.filter((mode) => mode !== "off").map((mode) => modeLabel(mode).toLowerCase()).join(", ")}`
    : "";
  const sourceTitle = `Источник настройки: ${view.sources.length === 1 && view.sources[0] ? sourceLabel(view.sources[0]) : "различается по страницам"}${available}`;
  const consumers = view.entry.consumers.map(consumerLabel);
  const label = categoryLabel(view.entry.id, view.entry.label);
  const why = categoryWhy(view.entry.id);
  const jobs = jobsFor(snapshot, props.scope, view.entry.id);
  const latestJob = jobs[0];

  return (
    <Fragment>
      <tr
        className={expandable ? "cursor-pointer" : ""}
        onClick={expandable ? props.onToggle : undefined}
      >
        <td className="min-w-[240px] whitespace-normal align-top">
          <div className="flex items-start gap-2">
            {expandable
              ? (
                <button
                  type="button"
                  aria-expanded={props.expanded}
                  aria-controls={detailId}
                  aria-label={`${props.expanded ? "Свернуть" : "Раскрыть"} настройки: ${label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggle();
                  }}
                  className="-ml-1 mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted hover:text-text-primary"
                >
                  <ChevronRight size={16} aria-hidden="true" className={`transition-transform ${props.expanded ? "rotate-90" : ""}`} />
                </button>
              )
              : <span className="h-5 w-5 shrink-0" aria-hidden="true" />}
            <div className="min-w-0">
              <div className="font-medium" title={consumers.length > 0 ? `Кто использует: ${consumers.join(", ")}` : undefined}>{label}</div>
              {why && <div className="mt-0.5 text-[13px] leading-snug text-text-secondary">{why}</div>}
            </div>
          </div>
        </td>
        <td className="min-w-[150px] whitespace-normal align-top">
          {view.group === "one_off"
            ? <ModeBadge mode="off" job />
            : view.group === "unavailable"
              ? <span className="text-sm text-text-muted">ещё не реализовано</span>
              : legacy
                ? <span className="text-sm text-text-secondary" title={sourceTitle}>Прежние настройки</span>
                : <ModeBadge mode={modeForBadge} draft={draftEntry !== null} title={sourceTitle} />}
          {subline && <div className="mt-1 text-xs leading-snug text-text-muted">{subline}</div>}
        </td>
        <td className="whitespace-nowrap align-top">
          <div title={view.lastCapturedAt ? localDateTime(view.lastCapturedAt) : undefined}>{relativeAge(view.lastCapturedAt)}</div>
        </td>
        <td
          className="num align-top"
          title={view.usage.actualCreditsToday === null ? "Зарезервировано; факт не подтверждён" : `Зарезервировано; фактически списано ${fmtCredits(view.usage.actualCreditsToday)} кр`}
        >
          {fmtCredits(view.usage.reservedCreditsToday)}
        </td>
        <td className="num align-top">{fmtCredits(view.usage.credits30d)}</td>
        <td className="min-w-[170px] whitespace-normal align-top">
          {view.group === "one_off"
            ? (
              <div>
                {view.entry.id === "vault_files"
                  ? <Link className="btn btn-sm" to="/ofapi-media" onClick={(event) => event.stopPropagation()}>Загрузить свой файл…</Link>
                  : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={snapshot.backgroundPaused}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onCreateJob();
                      }}
                    >
                      Создать задачу…
                    </button>
                  )}
                <div className="mt-1 text-xs text-text-muted">
                  {latestJob
                    ? `последняя: ${jobStateLabel(latestJob.state)} · ${localDateTime(latestJob.createdAt)}`
                    : "задач не было"}
                </div>
              </div>
            )
            : (
              // A legacy row already says "Прежние настройки" in its mode cell;
              // the explanation of the state moves to a tooltip.
              <div title={legacy && state.label === "прежняя конфигурация" ? state.detail ?? undefined : undefined}>
                <StateLabel tone={state.tone} label={state.label} detail={legacy && state.label === "прежняя конфигурация" ? null : state.detail} />
              </div>
            )}
        </td>
      </tr>
      {props.expanded && expandable && (
        <tr id={detailId}>
          <td colSpan={6} className="bg-hover-alt px-5 py-5 whitespace-normal">
            <CategoryEditor
              snapshot={snapshot}
              scope={props.scope}
              view={view}
              draftEntry={draftEntry}
              jobs={jobs}
              onChange={props.onChange}
              onCreateJob={props.onCreateJob}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function CategoryEditor(props: {
  snapshot: OfapiCollectionSnapshot;
  scope: CollectionScope;
  view: CategoryView;
  draftEntry: DraftEntry | null;
  jobs: OfapiCollectionJob[];
  onChange: (patch: Partial<OfapiCollectionSettings>) => void;
  onCreateJob: () => void;
}) {
  const { view, snapshot, draftEntry } = props;
  const legendId = useId();
  const pageId = scopePageId(props.scope);
  const settings: OfapiCollectionSettings = draftEntry?.settings
    ?? view.settings
    ?? { ...FALLBACK_SETTINGS, pageId, category: view.entry.id };
  const editable = view.supportsToggle && !snapshot.backgroundPaused;
  const modes = view.entry.modes;
  const overrideLabels = view.overridePageIds.map((id) => scopeLabel(id, snapshot.pages));
  const legacy = view.sources.includes("legacy_baseline");
  const consumers = view.entry.consumers.map(consumerLabel);
  const intervalOptions = INTERVAL_OPTIONS_MINUTES.includes(settings.intervalMinutes as (typeof INTERVAL_OPTIONS_MINUTES)[number])
    ? [...INTERVAL_OPTIONS_MINUTES]
    : [...INTERVAL_OPTIONS_MINUTES, settings.intervalMinutes].sort((a, b) => a - b);

  return (
    <div className="grid gap-6 text-sm lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        {view.supportsToggle
          ? (
            <fieldset disabled={!editable} className="min-w-0">
              <legend id={legendId} className="mb-2 font-semibold text-text-primary">
                Режим · {scopeLabel(pageId, snapshot.pages)}
              </legend>
              {snapshot.backgroundPaused && (
                <p className="mb-2 text-danger">Глобальная пауза: режимы сохранены, правки откроются после возобновления.</p>
              )}
              {modes.map((mode) => (
                <label key={mode} className="grid cursor-pointer grid-cols-[16px_1fr] gap-2.5 py-1.5 text-text-primary">
                  <input
                    type="radio"
                    name={`${legendId}-mode`}
                    value={mode}
                    checked={settings.mode === mode}
                    onChange={() => props.onChange({ mode })}
                    className="mt-1 accent-accent"
                  />
                  <span>
                    <span className="block font-medium">{modeLabel(mode)}</span>
                    <span className="block text-[13px] text-text-secondary">{MODE_DESCRIPTIONS_RU[mode]}</span>
                  </span>
                </label>
              ))}
              {settings.mode !== "off" && (
                <div className="mt-3 grid gap-4 pl-[26px] sm:grid-cols-2">
                  {settings.mode === "scheduled" && (
                    <label className="block">
                      <span className="field-label">Интервал</span>
                      <select
                        value={settings.intervalMinutes}
                        onChange={(event) => props.onChange({ intervalMinutes: Number(event.target.value) })}
                        className="select"
                      >
                        {intervalOptions.map((minutes) => (
                          <option key={minutes} value={minutes}>каждые {intervalLabel(minutes)}</option>
                        ))}
                      </select>
                      <span className="field-hint block">Чем чаще запуск, тем больше запросов за сутки.</span>
                    </label>
                  )}
                  {settings.mode === "scheduled" && (
                    <label className="block">
                      <span className="field-label">Запросов за запуск, не более</span>
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={settings.maxCallsPerRun}
                        onChange={(event) => props.onChange({ maxCallsPerRun: clampInt(event.target.value, 1, 1000) })}
                        className="input tabular-nums"
                      />
                      <span className="field-hint block">Сколько запросов может сделать один запуск.</span>
                    </label>
                  )}
                  <label className="block">
                    <span className="field-label">Дневной лимит категории, кр</span>
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      value={settings.dailyCreditLimit}
                      onChange={(event) => props.onChange({ dailyCreditLimit: clampInt(event.target.value, 1, 100000) })}
                      className="input tabular-nums"
                    />
                    <span className="field-hint block">На лимите сервер остановит новые запросы; ответы в полёте сохранятся.</span>
                  </label>
                  <label className="flex items-start gap-2 text-text-primary sm:pt-6">
                    <input
                      type="checkbox"
                      checked={settings.includeDetails}
                      onChange={(event) => props.onChange({ includeDetails: event.target.checked })}
                      className="mt-1 accent-accent"
                    />
                    <span>
                      Подробные запросы по каждому объекту
                      <span className="field-hint block mt-0.5">Отдельный запрос на объект — дороже, чем обход списком.</span>
                    </span>
                  </label>
                </div>
              )}
            </fieldset>
          )
          : view.entry.id === "vault_files" ? (
            <div>
              <div className="mb-1 font-semibold text-text-primary">Загрузка своего файла</div>
              <p className="text-text-secondary">Файл, страницу и назначение выбирают на отдельном экране. Перед отправкой проверьте источник и потолок кредитов; готовый результат можно передать в чат.</p>
              <Link className="btn btn-sm mt-3" to="/ofapi-media">Загрузить свой файл…</Link>
            </div>
          ) : (
            <div>
              <div className="mb-1 font-semibold text-text-primary">Только разовые задачи</div>
              <p className="text-text-secondary">
                Для этой категории нет ни расписания, ни режима «по запросу». Каждая задача ограничена потолком кредитов,
                запросов и объёма и подтверждается отдельно.
              </p>
              <button
                type="button"
                className="btn btn-sm mt-3"
                disabled={snapshot.backgroundPaused}
                onClick={props.onCreateJob}
              >
                Создать задачу…
              </button>
            </div>
          )}
        {view.entry.noScheduledReads && (
          <div className="mt-4 space-y-1 text-[13px]">
            <p className="text-text-secondary">{noScheduledReadsNote(view.entry.id).text}</p>
            {noScheduledReadsNote(view.entry.id).keep && (
              <p className="text-warning-dark">{noScheduledReadsNote(view.entry.id).keep}</p>
            )}
          </div>
        )}
        {legacy && view.supportsToggle && (
          <p className="mt-4 text-[13px] text-warning-dark">
            Категория работает по прежней конфигурации. Первое применение переведёт её на лимиты этого экрана; прежняя
            настройка перестанет управлять сбором.
          </p>
        )}
        {props.scope.kind === "all" && overrideLabels.length > 0 && (
          <p className="mt-4 text-[13px] text-text-secondary">
            Своя настройка есть у: {overrideLabels.join(", ")}. Общее изменение её не перекроет — выберите эту страницу
            вверху, чтобы изменить её отдельно.
          </p>
        )}
        {!view.uniform && view.policies.length > 1 && (
          <div className="mt-4 text-[13px] text-text-secondary">
            <div className="font-medium text-text-primary">Сейчас по страницам</div>
            <ul className="mt-1 space-y-0.5">
              {view.policies.map((policy) => (
                <li key={policy.pageId ?? "default"} className="flex flex-wrap justify-between gap-x-3">
                  <span>{scopeLabel(policy.pageId, snapshot.pages)}</span>
                  <span className="text-text-muted">{describeSettings(policy)} · {sourceLabel(policy.source)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <dl className="grid content-start gap-3 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
        <InfoItem title="Оценка расхода">
          {settings.mode === "off"
            ? "Новых запросов не будет."
            : <>
              <span className="badge mr-1.5">не измерена</span>
              <span className="text-text-secondary">
                Сервер не даёт прогноза по этой категории; цена — {PRICE_UNIT_LABELS_RU[view.entry.priceUnit] ?? view.entry.priceUnit}.
                Ограничитель — дневной лимит {fmtCredits(settings.dailyCreditLimit)} кр
                {settings.mode === "scheduled" ? ` и не более ${settings.maxCallsPerRun} запросов за запуск` : ""}. Неизвестная
                цена не означает «бесплатно».
              </span>
            </>}
        </InfoItem>
        <InfoItem title="Кто использует">
          {consumers.length > 0 ? consumers.join(", ") : <span className="text-text-secondary">Не указано.</span>}
          {view.entry.prerequisites.length > 0 && (
            <span className="mt-0.5 block text-xs text-text-muted">
              Требуется: {view.entry.prerequisites.map(prerequisiteLabel).join(", ")}.
            </span>
          )}
        </InfoItem>
        <InfoItem title="Если выключить">
          {view.mode === "off"
            ? "Ничего не перестанет обновляться: категория сейчас не собирается."
            : `Перестанут обновляться: ${consumers.join(", ") || "потребители не указаны"}. Собранное остаётся и показывается с реальной свежестью.`}
        </InfoItem>
        <InfoItem title="Последние запуски">
          {view.lastCapturedAt ? `Последний ответ ${localDateTime(view.lastCapturedAt)}` : "Запусков ещё не было"}
          {view.usage.callsToday > 0 ? ` · сегодня ${view.usage.callsToday} ${ruPlural(view.usage.callsToday, "запрос", "запроса", "запросов")}` : ""}
          {view.usage.inFlight > 0 ? ` · ${view.usage.inFlight} в полёте` : ""}
        </InfoItem>
        {view.entry.supportsOneOff && view.supportsToggle && (
          <InfoItem title="Разовые задачи">
            {props.jobs.length === 0
              ? <span className="text-text-secondary">Задач не было.</span>
              : (
                <ul className="space-y-1">
                  {props.jobs.slice(0, 3).map((job) => (
                    <li key={job.id}>
                      <span className="font-medium">{jobStateLabel(job.state)}</span> · {localDateTime(job.createdAt)} · {jobProgress(job)}
                    </li>
                  ))}
                </ul>
              )}
            <button
              type="button"
              className="btn btn-sm mt-2"
              disabled={snapshot.backgroundPaused}
              onClick={props.onCreateJob}
            >
              Создать задачу…
            </button>
          </InfoItem>
        )}
      </dl>
    </div>
  );
}

function InfoItem(props: { title: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-text-secondary">{props.title}</dt>
      <dd className="mt-0.5 text-[13px] text-text-primary">{props.children}</dd>
    </div>
  );
}

function clampInt(raw: string, min: number, max: number) {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function JobsCard(props: { snapshot: OfapiCollectionSnapshot; scope: CollectionScope }) {
  const resume = useOfapiCollectionJobResume();
  const finish = useOfapiCollectionJobFinishIncomplete();
  const [finishPreview, setFinishPreview] = useState<{ job: OfapiCollectionJob; revision: number } | null>(null);
  const [stateFilter, setStateFilter] = useState<NonNullable<OfapiCollectionJobStateFilter> | null>(null);
  // The snapshot lists every page's jobs, paused first, then the newest, at
  // most 100. A selected page or state is asked of the server, never cut out
  // of that list here: an unfinished-state filter returns every match, so any
  // unfinished job stays reachable for «Продолжить» / «Завершить неполный проход».
  const pageId = scopePageId(props.scope);
  const own = stateFilter !== null || pageId !== null;
  const filtered = useAdminOfapiCollectionJobs(own ? { jobState: stateFilter, pageId } : null);
  const source = own ? filtered.data : props.snapshot;
  const jobs = source ? jobsFor(source, props.scope) : [];
  const total = source?.jobsTotal ?? jobs.length;
  if (stateFilter === null && jobs.length === 0) return null;
  const active = jobs.filter((job) => ACTIVE_JOB_STATES.has(job.state)).length;
  const countText = own && filtered.isPending
    ? "загружаем…"
    : total > jobs.length
      ? `показаны ${jobs.length} из ${total}`
      : `${jobs.length} ${ruPlural(jobs.length, "задача", "задачи", "задач")}`;
  return (
    <DisclosureCard
      title="Проходы сбора и разовые задачи"
      description={active > 0
        ? `Незавершённых: ${active}. У каждой задачи свой потолок кредитов, запросов и объёма.`
        : "Незавершённых задач нет. У каждой задачи свой потолок кредитов, запросов и объёма."}
      meta={countText}
      defaultOpen={active > 0}
      headingId="collection-jobs-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
          <span>Показать</span>
          <select
            aria-label="Фильтр задач по состоянию"
            value={stateFilter ?? ""}
            onChange={(event) => setStateFilter(event.target.value === "" ? null : event.target.value as NonNullable<OfapiCollectionJobStateFilter>)}
            className="select w-auto"
          >
            {JOB_STATE_FILTER_OPTIONS_RU.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <span className="text-sm text-text-secondary">{countText}</span>
      </div>
      {resume.isError && <p role="alert" className="px-5 pb-3 text-sm text-danger">{errorMessage(resume.error, "Не удалось продолжить задачу")}</p>}
      {own && filtered.isError && <p role="alert" className="px-5 pb-3 text-sm text-danger">{errorMessage(filtered.error, "Не удалось загрузить задачи")}</p>}
      {own && !filtered.isPending && jobs.length === 0 && <p className="px-5 pb-5 text-sm text-text-secondary">Задач в этом состоянии нет.</p>}
      {jobs.length > 0 && <div className="overflow-x-auto border-t border-border">
        <table className="data-table min-w-[720px]">
          <thead>
            <tr>
              <th>Категория</th>
              <th>Страница</th>
              <th>Состояние</th>
              <th>Использовано</th>
              <th>Создана</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td className="align-top">{categoryLabel(job.category)}</td>
                <td className="muted align-top">{scopeLabel(job.pageId, props.snapshot.pages)}</td>
                <td className="min-w-[220px] whitespace-normal align-top">
                  <span className="font-medium">{jobStateLabel(job.state)}</span>
                  {jobReasonText(job) && <div className="mt-0.5 text-xs text-text-muted">{jobReasonText(job)}</div>}
                  <div className="mt-1.5 flex flex-wrap gap-2 empty:hidden">
                    {job.category === "vault_files"
                      ? <Link className="btn btn-sm" to="/ofapi-media">Открыть загрузку</Link>
                      : ["paused", "blocked", "budget_exhausted"].includes(job.state) && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          title="Продолжить с места, где задача остановилась"
                          disabled={resume.isPending || props.snapshot.backgroundPaused}
                          onClick={() => resume.mutate({ id: job.id, expectedRevision: props.snapshot.revision })}
                        >
                          Продолжить
                        </button>
                      )}
                    {job.canFinishIncomplete && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={resume.isPending || finish.isPending}
                        onClick={() => {
                          finish.reset();
                          setFinishPreview({ job, revision: props.snapshot.revision });
                        }}
                      >
                        Завершить неполный проход
                      </button>
                    )}
                  </div>
                </td>
                <td className="muted min-w-[200px] whitespace-normal align-top text-[13px] tabular-nums">{jobProgress(job)}</td>
                <td className="muted align-top whitespace-nowrap tabular-nums">{localDateTime(job.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      {finishPreview && <FinishIncompleteRunModal job={finishPreview.job} pageLabel={scopeLabel(finishPreview.job.pageId, props.snapshot.pages)}
        pending={finish.isPending} error={finish.isError ? errorMessage(finish.error, "Не удалось завершить проход") : null}
        onClose={() => { if (!finish.isPending) setFinishPreview(null); }}
        onConfirm={() => finish.mutate({ params: { id: finishPreview.job.id }, body: {
          pageId: finishPreview.job.pageId, expectedRevision: finishPreview.revision, expectedState: "paused",
          reason: "Owner finished an incomplete scheduled read after reviewing its retained state",
        } }, { onSuccess: () => {
          setFinishPreview(null);
          toast.success("Неполный проход завершён. Данные и учёт списаний сохранены.");
        } })} />}
    </DisclosureCard>
  );
}

export function FinishIncompleteRunModal(props: {
  job: OfapiCollectionJob; pageLabel: string; pending: boolean; error: string | null;
  onClose: () => void; onConfirm: () => void;
}) {
  return <ModalShell title="Завершить неполный проход?" onClose={props.onClose}>
    <p className="text-sm text-text-primary">{categoryLabel(props.job.category)} · {props.pageLabel}</p>
    <p className="mt-3 text-sm text-text-secondary">Сохранённые данные, курсор и учёт неподтверждённых списаний останутся. Этот проход завершится как неполный. Новых запросов сейчас не будет; следующий проход начнётся по штатному расписанию, если сбор включён.</p>
    {props.error && <p role="alert" className="mt-3 text-sm text-danger">{props.error}</p>}
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <button type="button" className="btn" disabled={props.pending} onClick={props.onClose}>Оставить на паузе</button>
      <button type="button" className="btn btn-primary" disabled={props.pending} onClick={props.onConfirm}>{props.pending ? "Завершаем…" : "Завершить неполный проход"}</button>
    </div>
  </ModalShell>;
}

/** The single OnlyFans API webhook registration, read-only: its state at a
 *  glance, the event groups and the technical facts behind a disclosure. */
export function WebhookCard() {
  const query = useAdminOfapiWebhookStatus();
  const status = query.data;
  const groupsList = status ? groupWebhookEvents(status.events) : [];
  const tone = !status
    ? "badge"
    : status.registrationState === "stable"
      ? "badge badge-success"
      : status.registrationState === null
        ? "badge"
        : /failed|indeterminate/.test(status.registrationState)
          ? "badge badge-danger"
          : "badge badge-warning";
  const stateText = status ? webhookStateLabel(status.registrationState) : "";
  const linked = status ? status.pages.filter((page) => page.ofapiAccountId).length : 0;

  return (
    <section className="card" aria-labelledby="collection-webhook-heading">
      <div className="card-header items-start">
        <div className="min-w-0 flex-1 basis-64">
          <h3 id="collection-webhook-heading" className="card-title">Вебхук</h3>
          <p className="card-description">
            Одна регистрация на все страницы OnlyFans: через неё события приходят в Hub сами, без платных запросов.
          </p>
        </div>
        {status && (
          <span className={tone} title={status.registrationState ?? undefined}>
            {stateText.charAt(0).toUpperCase() + stateText.slice(1)}
          </span>
        )}
      </div>
      <div className="card-body space-y-4">
        {query.isLoading && <p className="text-sm text-text-secondary">Читаем регистрацию…</p>}
        {query.isError && (
          <div role="alert" className="notice notice-danger">
            Регистрация не прочитана: {errorMessage(query.error, "сервер не ответил")}.
          </div>
        )}
        {status && (
          <>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium text-text-secondary">Страниц подключено</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums">{linked} из {status.pages.length}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-text-secondary">Групп событий</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums">{groupsList.length}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-text-secondary">Последняя проверка</dt>
                <dd className="mt-0.5 text-base font-semibold">{status.updatedAt ? localDateTime(status.updatedAt) : "—"}</dd>
              </div>
            </dl>
            {status.registrationError && (
              <div role="alert" className="notice notice-danger">Ошибка регистрации: {status.registrationError}</div>
            )}
            {status.pendingRegistration && (
              <div role="status" className="notice notice-warning">
                Ждёт подтверждения: {webhookOperationLabel(status.pendingRegistration.operation)} регистрации, подготовлено{" "}
                {localDateTime(status.pendingRegistration.preparedAt)}.
              </div>
            )}
            <details className="help">
              <summary>События и технические детали</summary>
              <div className="help-body max-w-none">
                {groupsList.length === 0
                  ? <p>{status.configured ? "Типы событий не перечислены в регистрации." : "Вебхук не зарегистрирован."}</p>
                  : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <caption className="sr-only">Группы событий в текущем наборе</caption>
                        <thead>
                          <tr>
                            <th>Группа</th>
                            <th>Типы событий</th>
                            <th>Подписка</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupsList.map((group) => (
                            <tr key={group.group}>
                              <td>{group.label}</td>
                              <td className="muted font-mono text-xs">{group.events.join(" · ")}</td>
                              <td><span className="badge badge-success">в текущем наборе</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[160px_1fr]">
                  <dt>ID регистрации</dt>
                  <dd className="font-mono">{maskWebhookId(status.externalWebhookId)}</dd>
                  {status.endpointUrl && <><dt>Адрес доставки</dt><dd className="break-all font-mono">{status.endpointUrl}</dd></>}
                  {status.accountScope && <><dt>Область</dt><dd className="font-mono">{status.accountScope}</dd></>}
                  {status.updatedAt && <><dt>Проверена (UTC)</dt><dd>{utcDateTime(status.updatedAt)}</dd></>}
                </dl>
              </div>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

function AuditCard(props: { snapshot: OfapiCollectionSnapshot; actorName: (userId: number) => string }) {
  const rows = props.snapshot.audit;
  const latest = rows[0];
  return (
    <DisclosureCard
      title="Журнал изменений"
      description="Кто и когда менял настройки сбора. Номер версии связывает черновик с записью журнала."
      meta={rows.length === 0 || !latest
        ? "записей нет"
        : `${rows.length} ${ruPlural(rows.length, "запись", "записи", "записей")} · последняя ${localDateTime(latest.createdAt)} · ${props.actorName(latest.actorUserId)}`}
    >
      {rows.length === 0
        ? <p className="px-5 py-4 text-sm text-text-secondary">Записей нет: настройки сбора ещё не менялись (версия {props.snapshot.revision}).</p>
        : (
          <ul className="divide-y divide-border-light">
            {rows.map((row) => (
              <li key={row.revision} className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[160px_1fr]">
                <div className="text-xs text-text-secondary tabular-nums">
                  <div className="font-semibold text-text-primary">Версия {row.revision}</div>
                  <div>{localDateTime(row.createdAt)}</div>
                  <div>{props.actorName(row.actorUserId)}</div>
                </div>
                <div className="text-text-primary">{summarizeAudit(row, props.snapshot.pages)}</div>
              </li>
            ))}
          </ul>
        )}
    </DisclosureCard>
  );
}

export function DraftBar(props: {
  draft: CollectionDraft;
  snapshot: OfapiCollectionSnapshot;
  blockReason: string | null;
  busy: boolean;
  conflict: boolean;
  onReset: () => void;
  onPreview: () => void;
  onCompare: () => void;
}) {
  const entries = draftEntries(props.draft);
  const count = entries.length;
  return (
    <div
      role="region"
      aria-label="Черновик изменений"
      className="card sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 px-4 py-3 shadow-lg"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-text-primary">
        <strong className="whitespace-nowrap font-semibold">
          {count} {ruPlural(count, "изменение", "изменения", "изменений")} в черновике
        </strong>
        {entries.map((entry) => (
          <span
            key={draftKey(entry.settings.pageId, entry.settings.category)}
            className="max-w-full truncate rounded-md bg-hover px-2 py-0.5 text-xs text-text-secondary sm:max-w-[420px]"
            title={`${categoryLabel(entry.settings.category)} · ${scopeLabel(entry.settings.pageId, props.snapshot.pages)}`}
          >
            <strong className="font-semibold text-text-primary">{categoryLabel(entry.settings.category)}</strong>
            {": "}
            {entry.base ? modeLabel(entry.base.mode) : "различалось"} → {describeSettings(entry.settings)}
            {entry.settings.pageId === null ? " · все страницы" : ` · ${scopeLabel(entry.settings.pageId, props.snapshot.pages)}`}
          </span>
        ))}
        {props.blockReason && <span className="basis-full text-[13px] text-warning-dark">{props.blockReason}</span>}
        {props.conflict && (
          <span className="basis-full text-[13px] text-accent">
            Черновик собран против v{props.draft.revision}, сервер уже на v{props.snapshot.revision}. Сравните перед применением.
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-ghost" onClick={props.onReset} disabled={props.busy}>
          Сбросить
        </button>
        {props.conflict
          ? (
            <button type="button" className="btn btn-primary" onClick={props.onCompare} disabled={props.busy}>
              Обновить и сравнить
            </button>
          )
          : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={props.onPreview}
              disabled={props.busy || props.blockReason !== null}
            >
              {props.busy ? "Проверяем…" : "Проверить и применить"}
            </button>
          )}
      </div>
    </div>
  );
}

function ModalSection(props: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border-light py-3">
      <div className="mb-1.5 text-xs font-semibold text-text-secondary">{props.title}</div>
      {props.children}
    </div>
  );
}

function CostSection(props: { preview: OfapiCollectionPreview; enabling: boolean }) {
  const { preview } = props;
  return (
    <ModalSection title="Расход">
      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[180px_1fr]">
        <dt className="text-text-secondary">Периодический</dt>
        <dd className="text-text-primary">
          {preview.cost.maximumNewCreditsPerDay > 0
            ? <>не более <strong className="font-semibold">{fmtCredits(preview.cost.maximumNewCreditsPerDay)} кр в сутки</strong> новых запросов по расписанию (сумма дневных лимитов)</>
            : props.enabling
              ? "по расписанию ничего не добавляется; режим «по запросу» тратит только по явному действию в пределах своего лимита"
              : "новых периодических запросов нет"}
        </dd>
        <dt className="text-text-secondary">Оценка</dt>
        <dd className="text-text-primary">
          {preview.cost.estimatedCredits === null
            ? <><span className="badge">не измерена</span> <span className="text-text-secondary">— сервер не даёт прогноза; пустая оценка не означает «0»</span></>
            : `≈ ${fmtCredits(preview.cost.estimatedCredits)} кр`}
        </dd>
        <dt className="text-text-secondary">Источник оценки</dt>
        <dd className="text-text-primary">{preview.cost.source === "unknown" ? "неизвестен · ограничитель — лимиты выше" : preview.cost.source}</dd>
      </dl>
    </ModalSection>
  );
}

function InFlightSection(props: { inFlight: number }) {
  return (
    <ModalSection title="Сейчас у провайдера">
      <p className="text-sm text-text-primary">
        {props.inFlight > 0
          ? `В полёте ${props.inFlight} ${ruPlural(props.inFlight, "запрос", "запроса", "запросов")}. Они завершатся и могут списать кредиты независимо от этого изменения.`
          : "Запросов в полёте нет. Уже принятые провайдером экспорты и загрузки всё равно могут завершиться и списать кредиты."}
      </p>
    </ModalSection>
  );
}

/** The server's own consequence lines (English) — kept verbatim, behind a disclosure. */
function ServerNotesSection(props: { consequences: string[] }) {
  if (props.consequences.length === 0) return null;
  return (
    <div className="border-t border-border-light py-3">
      <details className="help">
        <summary>Технические детали: ответ сервера</summary>
        <ul className="help-body list-disc pl-5" lang="en">
          {props.consequences.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </details>
    </div>
  );
}

export function PreviewModal(props: {
  snapshot: OfapiCollectionSnapshot;
  draft: CollectionDraft | null;
  preview: OfapiCollectionPreview;
  body: OfapiCollectionChangeBody;
  pending: boolean;
  onClose: () => void;
  onApply: () => void;
}) {
  const { preview, snapshot } = props;
  const entries = props.draft ? draftEntries(props.draft) : [];
  const baseFor = (settings: OfapiCollectionSettings) =>
    entries.find((entry) => entry.settings.category === settings.category && entry.settings.pageId === settings.pageId)?.base ?? null;
  const turnedOff = preview.changes.filter((change) => change.mode === "off");
  const enabling = preview.changes.some((change) => change.mode !== "off");

  return (
    <ModalShell title="Проверить изменения" onClose={props.onClose}>
      <ModalSection title={`Изменится · ${preview.changes.length}`}>
        <ul className="space-y-2">
          {preview.changes.map((change) => {
            const base = baseFor(change);
            return (
              <li key={draftKey(change.pageId, change.category)} className="text-sm">
                <div className="font-medium text-text-primary">{categoryLabel(change.category)}</div>
                <div className="text-text-secondary">
                  {base ? describeSettings(base) : "различалось по страницам"}
                  <span className="mx-2 text-text-muted">→</span>
                  <span className="text-text-primary">{describeSettings(change)}</span>
                </div>
                <div className="text-xs text-text-muted">
                  {scopeLabel(change.pageId, snapshot.pages)} · вебхук не меняется
                </div>
              </li>
            );
          })}
        </ul>
      </ModalSection>
      <ModalSection title="Перестанет обновляться">
        {turnedOff.length === 0
          ? <p className="text-sm text-text-secondary">Ничего: категории включаются или меняют лимиты, а не выключаются.</p>
          : (
            <ul className="space-y-1 text-sm text-text-primary">
              {turnedOff.map((change) => {
                const entry = snapshot.catalog.find((candidate) => candidate.id === change.category);
                return (
                  <li key={change.category}>
                    <span className="font-medium">{categoryLabel(change.category)}</span>
                    {": "}
                    {entry && entry.consumers.length > 0 ? entry.consumers.map(consumerLabel).join(", ") : "потребители не указаны"}
                    <span className="text-text-secondary"> — собранное остаётся и показывается с реальной свежестью</span>
                  </li>
                );
              })}
            </ul>
          )}
      </ModalSection>
      <CostSection preview={preview} enabling={enabling} />
      <InFlightSection inFlight={preview.inFlight} />
      <ServerNotesSection consequences={preview.consequences} />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-4">
        <span className="text-xs text-text-muted">Политика v{preview.revision} → v{preview.revision + 1}</span>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={props.onClose} disabled={props.pending}>Назад</button>
          <button type="button" className="btn btn-primary" onClick={props.onApply} disabled={props.pending}>
            {props.pending ? "Применяем…" : "Применить"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function PauseModal(props: {
  snapshot: OfapiCollectionSnapshot;
  preview: OfapiCollectionPreview;
  resume: boolean;
  pending: boolean;
  onClose: () => void;
  onApply: () => void;
}) {
  const summary = stopSummary(props.snapshot);
  const list = (rows: Array<{ category: OfapiCollectionCategory; pages: number }>) =>
    rows.length === 0
      ? "нет"
      : rows.map((row) => `${categoryLabel(row.category)} (${row.pages} ${ruPlural(row.pages, "страница", "страницы", "страниц")})`).join(", ");

  return (
    <ModalShell title={props.resume ? "Возобновить фоновый сбор?" : "Остановить фоновый сбор?"} onClose={props.onClose}>
      <ModalSection title={props.resume ? "Возобновится" : "Остановится"}>
        <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[180px_1fr]">
          <dt className="text-text-secondary">Категории по расписанию</dt>
          <dd className="text-text-primary">{list(summary.scheduled)}</dd>
          <dt className="text-text-secondary">Категории по запросу</dt>
          <dd className="text-text-primary">{list(summary.onDemand)}</dd>
          <dt className="text-text-secondary">Разовые задачи</dt>
          <dd className="text-text-primary">
            {props.resume ? "снова принимаются к выполнению" : "новые запросы задач не отправляются; принятые результаты сохраняются"}
          </dd>
        </dl>
      </ModalSection>
      <ModalSection title="Продолжит работать и списывать">
        <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[180px_1fr]">
          <dt className="text-text-secondary">События вебхука</dt>
          <dd className="text-text-primary">приходят и учитываются как прежде; отписка — отдельное действие, здесь не выполняется</dd>
          <dt className="text-text-secondary">Действия чаттеров</dt>
          <dd className="text-text-primary">интерактивные запросы не блокируются паузой · свой бюджет</dd>
          <dt className="text-text-secondary">Уже в полёте</dt>
          <dd className="text-text-primary">
            {props.preview.inFlight} {ruPlural(props.preview.inFlight, "запрос", "запроса", "запросов")} — завершение и списание кредитов возможны
          </dd>
        </dl>
      </ModalSection>
      <ServerNotesSection consequences={props.preview.consequences} />
      <p className="border-t border-border-light pt-3 text-[13px] text-text-secondary">
        Собранные данные остаются. Возобновление продолжает с места остановки и не догружает пропущенное автоматически.
        Пауза хранится на сервере и переживает перезапуск и переподключение аккаунтов.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-4">
        <span className="text-xs text-text-muted">Политика v{props.preview.revision} → v{props.preview.revision + 1} · запись в журнал</span>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={props.onClose} disabled={props.pending}>Отмена</button>
          <button
            type="button"
            className={props.resume ? "btn btn-primary" : "btn btn-danger"}
            onClick={props.onApply}
            disabled={props.pending}
          >
            {props.pending ? "Применяем…" : props.resume ? "Возобновить сбор" : "Остановить фоновый сбор"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ConflictModal(props: {
  draft: CollectionDraft;
  snapshot: OfapiCollectionSnapshot;
  refreshing: boolean;
  onClose: () => void;
  onRebase: () => void;
  onDiscard: () => void;
}) {
  const rows = diffDraftAgainstSnapshot(props.draft, props.snapshot);
  const changedElsewhere = rows.filter((row) => row.changedElsewhere);
  return (
    <ModalShell title="Изменения в другом окне" onClose={props.onClose}>
      <p className="text-sm text-text-secondary">
        Черновик собран против v{props.draft.revision}; сервер сейчас на v{props.snapshot.revision}
        {props.refreshing ? " (обновляем…)" : ""}. Ничего не перетёрто: ниже «было», «сейчас на сервере» и ваш черновик.
      </p>
      <ModalSection title={`Сравнение · ${rows.length}`}>
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.key} className="text-[13px]">
              <div className="font-medium text-text-primary">
                {categoryLabel(row.category)} · {scopeLabel(row.pageId, props.snapshot.pages)}
                {row.changedElsewhere && <span className="badge badge-accent ml-2">изменено там</span>}
              </div>
              <dl className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-[140px_1fr]">
                <dt className="text-text-muted">было</dt>
                <dd className="text-text-secondary">{row.base ? describeSettings(row.base) : "различалось по страницам"}</dd>
                <dt className="text-text-muted">сейчас на сервере</dt>
                <dd className={row.changedElsewhere ? "text-accent" : "text-text-secondary"}>{row.current ? describeSettings(row.current) : "различается по страницам"}</dd>
                <dt className="text-text-muted">черновик</dt>
                <dd className="text-text-primary">{describeSettings(row.draft)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </ModalSection>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-4">
        <span className="text-xs text-text-muted">
          {changedElsewhere.length > 0
            ? `Изменено другим окном: ${changedElsewhere.length} из ${rows.length}`
            : "затронутые строки на сервере не менялись"}
        </span>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={props.onDiscard}>Сбросить черновик</button>
          <button type="button" className="btn btn-primary" onClick={props.onRebase} disabled={props.refreshing}>
            Продолжить с v{props.snapshot.revision}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function JobModal(props: {
  snapshot: OfapiCollectionSnapshot;
  category: OfapiCollectionCategory;
  initialPageId: number | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (body: OfapiCollectionJobBody) => void;
}) {
  const { snapshot } = props;
  const entry = snapshot.catalog.find((candidate) => candidate.id === props.category);
  const firstPage = props.initialPageId ?? snapshot.pages[0]?.id ?? null;
  const [pageId, setPageId] = useState<number | null>(firstPage);
  const [maxCredits, setMaxCredits] = useState(50);
  const [maxCalls, setMaxCalls] = useState(50);
  const [maxMegabytes, setMaxMegabytes] = useState(100);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectionRaw, setSelectionRaw] = useState("");
  const selection = parseSelection(selectionRaw);
  const fromIso = localDateTimeToIso(from);
  const toIso = localDateTimeToIso(to);
  const windowInvalid = fromIso !== null && toIso !== null && fromIso >= toIso;
  // A category without scheduled reads has no default plan: the job reads only what is named.
  const selectionRequired = entry?.noScheduledReads === true;
  const canSubmit = pageId !== null && !windowInvalid && !props.pending && (!selectionRequired || selection.length > 0);

  function submit() {
    if (pageId === null) return;
    const body: OfapiCollectionJobBody = {
      ...defaultJobBody(pageId, props.category, snapshot.revision),
      maxCredits: clampInt(String(maxCredits), 1, 100000),
      maxCalls: clampInt(String(maxCalls), 1, 1000),
      maxBytes: clampInt(String(Math.round(maxMegabytes * 1024 * 1024)), 1, 10737418240),
      from: fromIso,
      to: toIso,
      selection,
    };
    props.onSubmit(body);
  }

  if (props.category === "vault_files" || !entry?.supportsOneOff) return (
    <ModalShell title={categoryLabel(props.category, entry?.label)} onClose={props.onClose}>
      {props.category === "vault_files"
        ? <Link className="btn" to="/ofapi-media">Загрузить свой файл…</Link>
        : <p className="text-sm text-text-secondary">Для этой категории настройте действующий сбор. Разовые задачи недоступны.</p>}
    </ModalShell>
  );
  return (
    <ModalShell title={`Разовая задача · ${categoryLabel(props.category, entry?.label)}`} onClose={props.onClose}>
      <p className="text-sm text-text-secondary">
        Одна ограниченная задача: сервер не отправит ни одного запроса сверх потолков ниже. Задача привязана к текущей
        версии настроек; она не включает категорию и не меняет расписание.
        {entry && entry.prerequisites.length > 0 ? ` Требуется: ${entry.prerequisites.map(prerequisiteLabel).join(", ")}.` : ""}
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="field-label">Страница</span>
          <select
            value={pageId ?? ""}
            onChange={(event) => setPageId(event.target.value ? Number(event.target.value) : null)}
            className="select"
          >
            {snapshot.pages.length === 0 && <option value="">Страниц OnlyFans нет</option>}
            {snapshot.pages.map((page) => <option key={page.id} value={page.id}>{page.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Потолок кредитов</span>
          <input type="number" min={1} max={100000} value={maxCredits} onChange={(event) => setMaxCredits(clampInt(event.target.value, 1, 100000))} className="input tabular-nums" />
        </label>
        <label className="block">
          <span className="field-label">Потолок запросов</span>
          <input type="number" min={1} max={1000} value={maxCalls} onChange={(event) => setMaxCalls(clampInt(event.target.value, 1, 1000))} className="input tabular-nums" />
        </label>
        <label className="block">
          <span className="field-label">Потолок объёма, МБ</span>
          <input type="number" min={1} max={10240} value={maxMegabytes} onChange={(event) => setMaxMegabytes(clampInt(event.target.value, 1, 10240))} className="input tabular-nums" />
          <span className="field-hint block">= {formatBytes(Math.round(maxMegabytes * 1024 * 1024))}; учитывает сохранённые ответы и файлы.</span>
        </label>
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Период с (необязательно)</span>
            <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} className="input" />
          </label>
          <label className="block">
            <span className="field-label">Период по (необязательно)</span>
            <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} className="input" />
            {windowInvalid && <span className="field-hint block text-danger">Начало периода должно быть раньше конца.</span>}
          </label>
        </div>
        <label className="block sm:col-span-2">
          <span className="field-label">
            {selectionRequired
              ? "Выбор (обязательно: плановых чтений нет; идентификаторы чтений, по одному в строке)"
              : "Выбор (необязательно: идентификаторы, по одному в строке)"}
          </span>
          <textarea
            value={selectionRaw}
            onChange={(event) => setSelectionRaw(event.target.value)}
            rows={3}
            className="textarea font-mono text-[13px]"
          />
          <span className="field-hint block">{selection.length} из 100 элементов.</span>
        </label>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border-light pt-4">
        <button type="button" className="btn" onClick={props.onClose} disabled={props.pending}>Отмена</button>
        <Tooltip focusable content="Сервер проверит потолки и версию настроек; задача попадёт в очередь только при совпадении версии.">
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {props.pending ? "Отправляем…" : "Поставить задачу в очередь"}
          </button>
        </Tooltip>
      </div>
    </ModalShell>
  );
}
