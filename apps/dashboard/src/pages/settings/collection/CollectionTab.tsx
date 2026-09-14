import { OfapiContentEvidence } from "../OfapiContentEvidence.js";
import { OfapiStoredReads } from "../OfapiStoredReads.js";
import { OfapiWebhookRecovery } from "../OfapiWebhookRecovery.js";
import { Fragment, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import {
  useAdminOfapiCollection,
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
  jobStateLabel,
  modeLabel,
  MODE_DESCRIPTIONS_RU,
  PRICE_UNIT_LABELS_RU,
  prerequisiteLabel,
  sourceLabel,
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
  jobsFor,
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
} from "./collectionModel.js";

// Settings › Collection (S-UI, decisions #250/#251). One screen: what the
// kernel asks OnlyFans API for in the background, how often, under which
// credit limits. Every control is a DRAFT until "Проверить и применить" runs
// the server preview and the versioned apply; opening the screen never spends
// a credit (the GET reads retained rows only). Supported modes come from the
// registry in the GET — the UI decides nothing about what a category can do.

const eyebrowClass = "text-[11px] font-bold uppercase tracking-wide text-text-secondary";
const cardClass = "rounded-xl border border-border bg-card";
const thClass = "px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text-secondary bg-hover-alt border-y border-border-light first:pl-4 last:pr-4";
const tdClass = "px-3 py-3 align-top text-[12.5px] text-text-secondary first:pl-4 last:pr-4";
const buttonClass = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-text-secondary hover:bg-hover disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const primaryButtonClass = "inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const dangerOutlineButtonClass = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-danger/40 bg-card px-3 text-[13px] font-medium text-red-700 hover:bg-red-500/5 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const dangerButtonClass = "inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const smallButtonClass = "inline-flex h-[26px] items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-text-secondary hover:bg-hover disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const inputClass = "h-8 w-full rounded-lg border border-border bg-card px-2.5 text-[13px] text-text-primary tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const fieldHintClass = "mt-1 text-[11px] leading-snug text-text-muted";

const TONE_TEXT: Record<RowTone, string> = {
  ok: "text-green-700",
  warning: "text-amber-700",
  danger: "text-red-700",
  accent: "text-accent",
  muted: "text-text-secondary",
  off: "text-text-muted",
};

const TONE_DOT: Record<RowTone, string> = {
  ok: "bg-green",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  muted: "bg-text-muted",
  off: "border border-text-muted bg-transparent",
};

function Dot(props: { tone: RowTone }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${TONE_DOT[props.tone]}`}
    />
  );
}

function StateLabel(props: { tone: RowTone; label: string; detail?: string | null }) {
  return (
    <div>
      <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${TONE_TEXT[props.tone]}`}>
        <Dot tone={props.tone} />
        {props.label}
      </span>
      {props.detail && <div className="mt-0.5 text-[11px] leading-snug text-text-muted">{props.detail}</div>}
    </div>
  );
}

function Caret(props: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      aria-hidden="true"
      className={`transition-transform ${props.expanded ? "rotate-90" : ""}`}
    >
      <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ModeChip(props: { mode: OfapiCollectionMode | "mixed"; draft?: boolean; job?: boolean }) {
  const text = props.mode === "mixed" ? "Различается" : modeLabel(props.mode);
  const cls = props.job
    ? "border border-dashed border-border text-text-secondary"
    : props.mode === "off"
      ? "bg-hover text-text-secondary"
      : "bg-accent/10 text-accent";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-semibold ${cls}`}>
      {props.draft && <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />}
      {props.job ? "Разовая задача" : text}
    </span>
  );
}

function SourceTag(props: { unknown?: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-block rounded-md border px-1.5 py-px text-[11px] leading-snug text-text-secondary ${
        props.unknown ? "border-dashed border-border text-text-muted" : "border-border-light bg-hover-alt"
      }`}
    >
      {props.children}
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

  // Readback: "применено" only once the GET reports the applied revision.
  useEffect(() => {
    if (applyPhase.kind === "saved" && snapshot && snapshot.revision >= applyPhase.revision) {
      toast.success(`Политика v${applyPhase.revision} применена и подтверждена чтением.`);
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
    return user ? user.username : `user #${userId}`;
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
      setConflictMessage(errorMessage(error, "Политика изменена в другом окне."));
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
        toast.message(`Сохранено как v${result.revision} · ждём подтверждения чтением`);
      },
      onError: (error) => handleMutationError(error, "apply"),
    });
  }, [apply, handleMutationError]);

  const submitJob = useCallback((body: OfapiCollectionJobBody) => {
    jobCreate.mutate(body, {
      onSuccess: (result) => {
        setModal(null);
        toast.success(`Задача ${result.id.slice(0, 8)} поставлена в очередь.`);
      },
      onError: (error) => handleMutationError(error, "job"),
    });
  }, [handleMutationError, jobCreate]);

  const refreshAndCompare = useCallback(() => {
    void snapshotQuery.refetch();
    setModal({ kind: "conflict" });
  }, [snapshotQuery]);

  if (snapshotQuery.isLoading && !snapshot) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading />
        <TableSkeleton rows={6} columns={6} />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading />
        <StatusPanel
          tone="error"
          title="Настройки сбора недоступны"
          description={errorMessage(snapshotQuery.error, "Сервер не ответил. Политика не читается, ручки недоступны.")}
          action={(
            <button type="button" className={buttonClass} onClick={() => void snapshotQuery.refetch()}>
              Повторить
            </button>
          )}
        />
      </div>
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
  const blockReason = draftBlockReason(draft);
  const busy = preview.isPending || apply.isPending;

  return (
    <div className="flex flex-col gap-4 pb-24">
      {snapshotQuery.isError && <StaleDataNotice title="Показана последняя загруженная политика" error={snapshotQuery.error} />}
      {snapshot.backgroundPaused && (
        <PausedBanner
          snapshot={snapshot}
          actorName={actorName}
          inFlight={totals.inFlight}
          busy={busy}
          onResume={() => openPausePreview(true)}
        />
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading />
        <div className="flex flex-col items-end gap-2.5">
          <ScopeSelector snapshot={snapshot} scope={scope} onChange={setScope} />
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            <span
              data-testid="policy-pill"
              className="inline-flex h-7 items-center gap-2 rounded-full border border-border bg-card px-3 text-[12px] text-text-secondary"
            >
              <Dot tone={pill.tone} />
              <span className="font-medium text-text-primary">{pill.text}</span>
            </span>
            {conflict && (
              <button type="button" className={buttonClass} onClick={refreshAndCompare}>
                Обновить и сравнить
              </button>
            )}
            {applyPhase.kind === "error" && (
              <button
                type="button"
                className={buttonClass}
                onClick={() => (draft && size > 0 ? openDraftPreview() : setApplyPhase({ kind: "idle" }))}
              >
                Повторить
              </button>
            )}
            <button
              type="button"
              className={dangerOutlineButtonClass}
              disabled={snapshot.backgroundPaused || busy}
              onClick={() => openPausePreview(false)}
            >
              Остановить фоновый сбор
            </button>
          </div>
          {applyPhase.kind === "error" && (
            <p className="max-w-md text-right text-[12px] text-red-700">{applyPhase.message}</p>
          )}
          {conflictMessage && (
            <p className="max-w-md text-right text-[12px] text-text-secondary">
              {conflictMessage} Черновик сохранён и не перетирает чужие изменения.
            </p>
          )}
        </div>
      </div>

      <UsageCard snapshot={snapshot} scope={scope} views={views} totals={totals} />

      <section className={cardClass} aria-labelledby="collection-categories-heading">
        <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
          <h3 id="collection-categories-heading" className={eyebrowClass}>Категории</h3>
          <span className="text-[12px] text-text-secondary">
            {scope.kind === "all"
              ? `Показаны все OF-страницы · ${snapshot.pages.length} · внутри группы по расходу за 30 дней`
              : `Показана страница ${scopeLabel(scope.pageId, snapshot.pages)}`}
          </span>
        </div>
        {snapshot.pages.length === 0
          ? (
            <p className="px-4 py-6 text-[13px] text-text-secondary">
              OF-страниц нет: политика применяется только к страницам OnlyFans с привязкой OFAPI.
            </p>
          )
          : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse">
                <thead>
                  <tr>
                    <th className={`${thClass} w-[30%]`}>Категория</th>
                    <th className={`${thClass} w-[17%]`}>Режим</th>
                    <th className={`${thClass} w-[14%]`}>Свежесть</th>
                    <th className={`${thClass} w-[13%] text-right`}>Сегодня · кр</th>
                    <th className={`${thClass} w-[10%] text-right`}>30 дней</th>
                    <th className={`${thClass} w-[16%]`}>Состояние</th>
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
        <p className="px-4 pb-3.5 pt-3 text-[12px] text-text-muted">
          Изменения на этом экране становятся черновиком и действуют после «Применить». Выключение категории останавливает
          новые запросы; уже собранные данные остаются и читаются с их реальной свежестью. Лимиты проверяет сервер перед
          каждым запросом, не форма.
        </p>
      </section>

      <JobsCard snapshot={snapshot} scope={scope} />
      <WebhookCard />
      <OfapiWebhookRecovery />
      <OfapiContentEvidence pages={snapshot.pages} />
      <OfapiStoredReads pages={snapshot.pages} />
      <AuditCard snapshot={snapshot} actorName={actorName} />

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
          <p className="text-[13px] text-text-secondary">
            Черновика нет; экран обновлён до v{snapshot.revision}.
          </p>
          <div className="mt-5 flex justify-end">
            <button type="button" className={buttonClass} onClick={() => { setConflictMessage(null); setModal(null); }}>
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

function PageHeading() {
  return (
    <div className="min-w-0">
      <h2 className="text-[17px] font-bold tracking-tight text-text-primary">Сбор данных OFAPI</h2>
      <p className="mt-1 max-w-[62ch] text-[13px] text-text-secondary">
        Фоновые запросы Hub к OnlyFans API: что собираем, как часто и под каким лимитом кредитов. Выключение
        останавливает новые запросы и не удаляет собранное. Fansly настраивается в разделе «Возможности»; кредиты OFAPI на него не расходуются.
      </p>
    </div>
  );
}

function ScopeSelector(props: {
  snapshot: OfapiCollectionSnapshot;
  scope: CollectionScope;
  onChange: (scope: CollectionScope) => void;
}) {
  const options: Array<{ key: string; label: string; scope: CollectionScope }> = [
    { key: "all", label: "Все OF-страницы", scope: { kind: "all" } },
    ...props.snapshot.pages.map((page) => ({
      key: `page:${page.id}`,
      label: page.label,
      scope: { kind: "page", pageId: page.id } as CollectionScope,
    })),
  ];
  const activeKey = props.scope.kind === "all" ? "all" : `page:${props.scope.pageId}`;
  return (
    <div role="group" aria-label="Охват" className="inline-flex rounded-lg border border-border bg-card p-0.5">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={option.key === activeKey}
          onClick={() => props.onChange(option.scope)}
          className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
            option.key === activeKey ? "bg-hover font-semibold text-text-primary" : "text-text-secondary hover:text-text-primary"
          }`}
        >
          {option.label}
        </button>
      ))}
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
    <div
      role="status"
      className="flex items-start justify-between gap-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3"
    >
      <div>
        <p className="text-[13.5px] font-semibold text-red-700">
          Фоновый сбор остановлен
          {latest ? ` · ${props.actorName(latest.actorUserId)} · ${utcDateTime(latest.createdAt)}` : ""}
        </p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">
          Новых фоновых запросов и разовых задач нет. Продолжают: события вебхука, интерактивные действия чаттеров,
          бесплатные чтения.{" "}
          {props.inFlight > 0
            ? <strong className="font-semibold text-text-primary">{props.inFlight} {ruPlural(props.inFlight, "запрос", "запроса", "запросов")} ещё в полёте — списание кредитов возможно.</strong>
            : "Запросов в полёте нет."}{" "}
          Категории ниже показаны с сохранёнными режимами.
        </p>
      </div>
      <button type="button" className={primaryButtonClass} disabled={props.busy} onClick={props.onResume}>
        Возобновить сбор
      </button>
    </div>
  );
}

function UsageCard(props: {
  snapshot: OfapiCollectionSnapshot;
  scope: CollectionScope;
  views: CategoryView[];
  totals: ReturnType<typeof usageTotals>;
}) {
  const { totals, snapshot } = props;
  const managed = props.views.flatMap((view) => view.policies).filter(
    (policy) => policy.mode !== "off" && policy.source !== "legacy_baseline",
  );
  const legacy = props.views.flatMap((view) => view.policies).filter(
    (policy) => policy.mode !== "off" && policy.source === "legacy_baseline",
  );
  const managedLimit = managed.reduce((sum, policy) => sum + policy.dailyCreditLimit, 0);
  const legacyCategories = new Set(legacy.map((policy) => policy.category)).size;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className={cardClass} aria-labelledby="collection-usage-heading">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <h3 id="collection-usage-heading" className={eyebrowClass}>Управляемые запросы · {today} UTC</h3>
        <span className="text-[12px] text-text-secondary">
          Полная картина списаний — в{" "}
          <Link to="/ofapi-credits" className="font-medium text-accent underline-offset-2 hover:underline">OFAPI Credits</Link>
        </span>
      </div>
      <div className="grid gap-4 px-4 pb-4 pt-3 lg:grid-cols-[1fr_300px]">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[26px] font-bold tracking-tight text-text-primary tabular-nums">
              {fmtCredits(totals.reservedCreditsToday)}
            </span>
            <span className="text-[12.5px] text-text-secondary">кр зарезервировано сегодня под фоновый сбор</span>
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12px] text-text-secondary sm:grid-cols-2">
            <div className="flex justify-between gap-3 border-t border-border-light pt-1.5">
              <dt>Фактически списано</dt>
              <dd className="tabular-nums text-text-primary">
                {totals.actualCreditsToday === null ? "факт не подтверждён" : `${fmtCredits(totals.actualCreditsToday)} кр`}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-border-light pt-1.5">
              <dt>Запросов сегодня</dt>
              <dd className="tabular-nums text-text-primary">{fmtCredits(totals.callsToday)}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-border-light pt-1.5">
              <dt>За 30 дней</dt>
              <dd className="tabular-nums text-text-primary">{fmtCredits(totals.credits30d)} кр</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-border-light pt-1.5">
              <dt>В полёте</dt>
              <dd className="tabular-nums text-text-primary">{totals.inFlight}</dd>
            </div>
          </dl>
          <p className="mt-2.5 text-[11.5px] leading-snug text-text-muted">
            Только запросы под управлением этого экрана. События вебхука, действия чаттеров и внешние списания того же
            ключа сюда не входят; баланс команды — не бюджет одного коллектора.
          </p>
        </div>
        <div className="border-t border-border-light pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <div className="flex justify-between text-[12px] text-text-secondary">
            <span>Предел новых управляемых запросов</span>
            <span className="font-semibold text-text-primary tabular-nums">
              {managed.length === 0 ? "нет включённых" : `${fmtCredits(managedLimit)} кр/сутки`}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] leading-snug text-text-muted">
            Сумма дневных лимитов включённых категорий в этом охвате.
            {legacyCategories > 0
              ? ` Ещё ${legacyCategories} ${ruPlural(legacyCategories, "категория", "категории", "категорий")} зависят от прежних настроек и бюджетов до первого применения.`
              : ""}
          </p>
          <p className="mt-2 text-[11px] leading-snug text-text-muted" lang="en">
            {snapshot.limitDescription}
          </p>
        </div>
      </div>
    </section>
  );
}

const GROUP_COPY: Record<CategoryGroup, { title: string; hint: string; pausedHint?: string }> = {
  running: {
    title: "Действующая конфигурация",
    hint: "действующая конфигурация, не меняется автоматически",
    pausedHint: "действующая конфигурация, остановлена глобальной паузой",
  },
  available: {
    title: "Доступно к включению",
    hint: "по умолчанию выключено · включается по одной категории за применение",
  },
  one_off: {
    title: "Только разовые задачи",
    hint: "без тумблера: период, выбор и потолок задаются на каждую задачу",
  },
  unavailable: {
    title: "Ещё не реализовано",
    hint: "категории из плана без работающего кода — тумблера нет",
  },
};

function GroupRow(props: { group: CategoryGroup; paused: boolean }) {
  const copyEntry = GROUP_COPY[props.group];
  return (
    <tr>
      <td colSpan={6} className="px-4 pb-1.5 pt-3.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {copyEntry.title}
        <span className="ml-2 font-normal normal-case tracking-normal">
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
  const shownSettings = draftEntry?.settings ?? view.settings;
  const modeForChip: OfapiCollectionMode | "mixed" = draftEntry ? draftEntry.settings.mode : view.mode;
  const subline = draftEntry
    ? `черновик · было: ${draftEntry.base ? modeLabel(draftEntry.base.mode) : "различалось"}`
    : !draftEntry && view.sources.includes("legacy_baseline")
      ? "Режим и лимиты задаёт прежний сборщик"
    : shownSettings && shownSettings.mode !== "off"
      ? describeSettings(shownSettings).split(" · ").slice(1).join(" · ")
      : view.group === "available" && view.supportsToggle
        ? `доступно: ${view.entry.modes.filter((mode) => mode !== "off").map((mode) => modeLabel(mode).toLowerCase()).join(", ")}`
        : "";
  const sourceLine = view.sources.length === 1 && view.sources[0] ? sourceLabel(view.sources[0]) : "источники различаются";
  const jobs = jobsFor(snapshot, props.scope, view.entry.id);
  const latestJob = jobs[0];

  return (
    <Fragment>
      <tr
        className={`border-t border-border-light ${expandable ? "cursor-pointer hover:bg-hover" : ""}`}
        onClick={expandable ? props.onToggle : undefined}
      >
        <td className={`${tdClass} text-text-primary`}>
          <div className="flex items-start gap-2">
            {expandable
              ? (
                <button
                  type="button"
                  aria-expanded={props.expanded}
                  aria-controls={detailId}
                  aria-label={`${props.expanded ? "Свернуть" : "Раскрыть"} настройки: ${categoryLabel(view.entry.id, view.entry.label)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggle();
                  }}
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Caret expanded={props.expanded} />
                </button>
              )
              : <span className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />}
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">{categoryLabel(view.entry.id, view.entry.label)}</div>
              {categoryWhy(view.entry.id) && <div className="mt-0.5 text-[12px] text-text-secondary">{categoryWhy(view.entry.id)}</div>}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {view.entry.consumers.map((consumer) => (
                  <span key={consumer} className="rounded-md bg-hover px-1.5 py-px text-[10.5px] font-medium text-text-secondary">
                    {consumerLabel(consumer)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </td>
        <td className={tdClass}>
          {view.group === "one_off"
            ? <ModeChip mode="off" job />
            : view.group === "unavailable"
              ? <span className="text-[12px] text-text-muted">ещё не реализовано</span>
              : !draftEntry && view.sources.includes("legacy_baseline") ? <span className="text-[12px] text-text-secondary">Прежние настройки</span> : <ModeChip mode={modeForChip} draft={draftEntry !== null} />}
          {subline && <div className="mt-1 text-[11.5px] leading-snug text-text-muted">{subline}</div>}
          {view.group !== "one_off" && view.group !== "unavailable" && (
            <div className="mt-0.5 text-[11px] text-text-muted">{sourceLine}</div>
          )}
        </td>
        <td className={tdClass}>
          <div className="text-[13px] font-semibold text-text-primary">{relativeAge(view.lastCapturedAt)}</div>
          <div className="mt-0.5 text-[11.5px] text-text-muted">
            {props.scope.kind === "all"
              ? `${view.policies.length} ${ruPlural(view.policies.length, "страница", "страницы", "страниц")}`
              : view.lastCapturedAt ? utcDateTime(view.lastCapturedAt) : "запросов не было"}
          </div>
        </td>
        <td className={`${tdClass} text-right tabular-nums`}>
          <div className="text-[13px] font-semibold text-text-primary">{fmtCredits(view.usage.reservedCreditsToday)}</div>
          <div className="mt-0.5 text-[11.5px] text-text-muted">
            {view.usage.actualCreditsToday === null ? "резерв · факт не подтверждён" : `факт ${fmtCredits(view.usage.actualCreditsToday)}`}
          </div>
        </td>
        <td className={`${tdClass} text-right tabular-nums`}>
          <div className="text-[13px] font-semibold text-text-primary">{fmtCredits(view.usage.credits30d)}</div>
          <div className="mt-0.5 text-[11.5px] text-text-muted">{fmtCredits(view.usage.callsToday)} запр. сегодня</div>
        </td>
        <td className={tdClass}>
          {view.group === "one_off"
            ? (
              <div>
                {view.entry.id === "vault_files" ? <Link className={smallButtonClass} to="/ofapi-media" onClick={event => event.stopPropagation()}>Загрузить свой файл…</Link> : <button
                  type="button"
                  className={smallButtonClass}
                  disabled={snapshot.backgroundPaused}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onCreateJob();
                  }}
                >
                  Создать задачу…
                </button>}
                <div className="mt-1 text-[11px] text-text-muted">
                  {latestJob
                    ? `последняя: ${jobStateLabel(latestJob.state)} · ${utcDateTime(latestJob.createdAt)}`
                    : "задач не было"}
                </div>
              </div>
            )
            : <StateLabel tone={state.tone} label={state.label} detail={state.detail} />}
        </td>
      </tr>
      {props.expanded && expandable && (
        <tr id={detailId} className="border-t border-border-light bg-hover-alt/60">
          <td colSpan={6} className="px-4 pb-4 pt-4">
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
    <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
      <div>
        {view.supportsToggle
          ? (
            <fieldset disabled={!editable} className="min-w-0">
              <legend id={legendId} className="mb-2 text-[12px] font-semibold text-text-primary">
                Режим · {scopeLabel(pageId, snapshot.pages)}
              </legend>
              {snapshot.backgroundPaused && (
                <p className="mb-2 text-[12px] text-red-700">Глобальная пауза: режимы сохранены, правки откроются после возобновления.</p>
              )}
              {modes.map((mode) => (
                <label key={mode} className="grid cursor-pointer grid-cols-[16px_1fr] gap-2.5 py-1.5 text-text-primary">
                  <input
                    type="radio"
                    name={`${legendId}-mode`}
                    value={mode}
                    checked={settings.mode === mode}
                    onChange={() => props.onChange({ mode })}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    <span className="block text-[13px] font-medium">{modeLabel(mode)}</span>
                    <span className="block text-[12px] text-text-secondary">{MODE_DESCRIPTIONS_RU[mode]}</span>
                  </span>
                </label>
              ))}
              {settings.mode !== "off" && (
                <div className="ml-[26px] mt-1.5 grid gap-3 rounded-[10px] border border-border-light bg-card p-3 sm:grid-cols-2">
                  {settings.mode === "scheduled" && (
                    <label className="block">
                      <span className="mb-1 block text-[12px] text-text-secondary">Интервал</span>
                      <select
                        value={settings.intervalMinutes}
                        onChange={(event) => props.onChange({ intervalMinutes: Number(event.target.value) })}
                        className={inputClass}
                      >
                        {intervalOptions.map((minutes) => (
                          <option key={minutes} value={minutes}>каждые {intervalLabel(minutes)}</option>
                        ))}
                      </select>
                      <span className={fieldHintClass}>Частота умножает цену одного обхода; окно и overlap ограничивает сервер.</span>
                    </label>
                  )}
                  {settings.mode === "scheduled" && (
                    <label className="block">
                      <span className="mb-1 block text-[12px] text-text-secondary">Запросов за запуск, не более</span>
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={settings.maxCallsPerRun}
                        onChange={(event) => props.onChange({ maxCallsPerRun: clampInt(event.target.value, 1, 1000) })}
                        className={inputClass}
                      />
                      <span className={fieldHintClass}>Глубина одного обхода: число физических запросов в интервале.</span>
                    </label>
                  )}
                  <label className="block">
                    <span className="mb-1 block text-[12px] text-text-secondary">Дневной лимит категории, кр</span>
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      value={settings.dailyCreditLimit}
                      onChange={(event) => props.onChange({ dailyCreditLimit: clampInt(event.target.value, 1, 100000) })}
                      className={inputClass}
                    />
                    <span className={fieldHintClass}>Сервер остановит новые запросы категории при достижении; ответы в полёте сохранятся.</span>
                  </label>
                  <label className="flex items-start gap-2 pt-5 text-[13px] text-text-primary">
                    <input
                      type="checkbox"
                      checked={settings.includeDetails}
                      onChange={(event) => props.onChange({ includeDetails: event.target.checked })}
                      className="mt-0.5 accent-accent"
                    />
                    <span>
                      Вложенные detail-запросы
                      <span className="block text-[11px] text-text-muted">Отдельный запрос на каждый объект: дороже обхода списком.</span>
                    </span>
                  </label>
                </div>
              )}
            </fieldset>
          )
          : view.entry.id === "vault_files" ? (
            <div>
              <div className="mb-2 text-[12px] font-semibold text-text-primary">Загрузка своего файла</div>
              <p className="text-[12.5px] text-text-secondary">Выберите свой файл, страницу и назначение в отдельном экране. Перед отправкой проверьте источник и потолок кредитов; готовый результат можно передать в чат.</p>
              <Link className={`${buttonClass} mt-3 inline-block`} to="/ofapi-media">Загрузить свой файл…</Link>
            </div>
          ) : (
            <div>
              <div className="mb-2 text-[12px] font-semibold text-text-primary">Только разовые задачи</div>
              <p className="text-[12.5px] text-text-secondary">
                Реестр не предлагает для этой категории ни расписания, ни режима «по запросу». Каждая задача ограничена
                потолком кредитов, запросов и байт и утверждается отдельно.
              </p>
              <button
                type="button"
                className={`${buttonClass} mt-3`}
                disabled={snapshot.backgroundPaused}
                onClick={props.onCreateJob}
              >
                Создать задачу…
              </button>
            </div>
          )}
        {legacy && view.supportsToggle && (
          <p className="mt-3 text-[12px] leading-snug text-amber-700">
            Категория работает по прежней конфигурации (baseline). Первое применение переведёт её под новую политику с
            указанными лимитами; прежний конфиг перестанет быть управляющей записью.
          </p>
        )}
        {props.scope.kind === "all" && overrideLabels.length > 0 && (
          <p className="mt-3 text-[12px] leading-snug text-text-secondary">
            Своя настройка есть у: {overrideLabels.join(", ")}. Общее изменение её не перекроет — переключите охват на
            страницу, чтобы изменить её отдельно.
          </p>
        )}
        {!view.uniform && view.policies.length > 1 && (
          <div className="mt-3 text-[12px] text-text-secondary">
            <div className="font-medium text-text-primary">Сейчас по страницам</div>
            <ul className="mt-1 space-y-0.5">
              {view.policies.map((policy) => (
                <li key={policy.pageId ?? "default"} className="flex justify-between gap-3">
                  <span>{scopeLabel(policy.pageId, snapshot.pages)}</span>
                  <span className="text-text-muted">{describeSettings(policy)} · {sourceLabel(policy.source)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="grid content-start gap-3">
        <SideBox title="Оценка">
          <div className="text-[13px] text-text-primary">
            {settings.mode === "off"
              ? "Новых запросов не будет."
              : <>
                <SourceTag unknown>не измерена</SourceTag>{" "}
                <span className="text-text-secondary">
                  Сервер не даёт прогноза по этой категории; единица цены — {PRICE_UNIT_LABELS_RU[view.entry.priceUnit] ?? view.entry.priceUnit}.
                </span>
              </>}
          </div>
          {settings.mode !== "off" && (
            <p className="mt-1.5 text-[12px] leading-snug text-text-secondary">
              Ограничитель — дневной лимит {fmtCredits(settings.dailyCreditLimit)} кр
              {settings.mode === "scheduled" ? ` и не более ${settings.maxCallsPerRun} запросов за запуск` : ""}. Неизвестная
              цена не означает «бесплатно».
            </p>
          )}
        </SideBox>
        <SideBox title="Кто использует">
          {consumers.length > 0
            ? (
              <ul className="text-[12.5px] text-text-primary">
                {consumers.map((consumer) => <li key={consumer} className="py-0.5">{consumer}</li>)}
              </ul>
            )
            : <p className="text-[12.5px] text-text-secondary">Потребители в реестре не указаны.</p>}
          {view.entry.prerequisites.length > 0 && (
            <p className="mt-1.5 text-[11.5px] text-text-muted">
              Требуется: {view.entry.prerequisites.map(prerequisiteLabel).join(", ")}.
            </p>
          )}
        </SideBox>
        <SideBox title="Если выключить">
          <p className="text-[12.5px] text-text-primary">
            {view.mode === "off"
              ? "Ничего не перестанет обновляться: категория сейчас не собирается."
              : `Перестанут обновляться: ${consumers.join(", ") || "потребители не указаны"}. Сохранённое остаётся и читается с реальной свежестью; чекпоинты не стираются.`}
          </p>
        </SideBox>
        <SideBox title="Последние запуски">
          <p className="text-[12.5px] text-text-primary">
            {view.lastCapturedAt ? `Последний ответ ${utcDateTime(view.lastCapturedAt)}` : "Запусков ещё не было"}
            {view.usage.callsToday > 0 ? ` · сегодня ${view.usage.callsToday} ${ruPlural(view.usage.callsToday, "запрос", "запроса", "запросов")}` : ""}
            {view.usage.inFlight > 0 ? ` · ${view.usage.inFlight} в полёте` : ""}
          </p>
        </SideBox>
        {view.entry.supportsOneOff && view.supportsToggle && (
          <SideBox title="Разовые задачи">
            {props.jobs.length === 0
              ? <p className="text-[12.5px] text-text-secondary">Задач не было.</p>
              : (
                <ul className="space-y-1 text-[12px] text-text-primary">
                  {props.jobs.slice(0, 3).map((job) => (
                    <li key={job.id}>
                      <span className="font-medium">{jobStateLabel(job.state)}</span> · {utcDateTime(job.createdAt)} · {jobProgress(job)}
                    </li>
                  ))}
                </ul>
              )}
            <button
              type="button"
              className={`${smallButtonClass} mt-2`}
              disabled={snapshot.backgroundPaused}
              onClick={props.onCreateJob}
            >
              Создать задачу…
            </button>
          </SideBox>
        )}
      </div>
    </div>
  );
}

function clampInt(raw: string, min: number, max: number) {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function SideBox(props: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-border-light bg-card px-3.5 py-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{props.title}</div>
      {props.children}
    </div>
  );
}

export function JobsCard(props: { snapshot: OfapiCollectionSnapshot; scope: CollectionScope }) {
  const resume = useOfapiCollectionJobResume();
  const finish = useOfapiCollectionJobFinishIncomplete();
  const [finishPreview, setFinishPreview] = useState<{ job: OfapiCollectionJob; revision: number } | null>(null);
  const jobs = jobsFor(props.snapshot, props.scope);
  if (jobs.length === 0) return null;
  return (
    <section className={cardClass} aria-labelledby="collection-jobs-heading">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <h3 id="collection-jobs-heading" className={eyebrowClass}>Проходы сбора и разовые задачи</h3>
        {resume.isError && <p role="alert" className="text-[12px] text-red-700">{errorMessage(resume.error, "Не удалось продолжить задачу")}</p>}
        <span className="text-[12px] text-text-secondary">{jobs.length} {ruPlural(jobs.length, "задача", "задачи", "задач")} · потолки на каждую</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr>
              <th className={thClass}>Категория</th>
              <th className={thClass}>Страница</th>
              <th className={thClass}>Состояние</th>
              <th className={thClass}>Использовано</th>
              <th className={thClass}>Создана</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-t border-border-light">
                <td className={`${tdClass} text-text-primary`}>{categoryLabel(job.category)}</td>
                <td className={tdClass}>{scopeLabel(job.pageId, props.snapshot.pages)}</td>
                <td className={tdClass}>
                  <span className="font-medium text-text-primary">{jobStateLabel(job.state)}</span>
                  {job.reason && <div className="mt-0.5 text-[11px] text-text-muted">{job.reason}</div>}
                  {job.category === "vault_files" ? <Link className={smallButtonClass} to="/ofapi-media">Открыть загрузку</Link> : ["paused", "blocked", "budget_exhausted"].includes(job.state) && <button type="button" className={smallButtonClass} disabled={resume.isPending || props.snapshot.backgroundPaused} onClick={() => resume.mutate({ id: job.id, expectedRevision: props.snapshot.revision })}>Продолжить с чекпоинта</button>}
                  {job.canFinishIncomplete && <button type="button" className={smallButtonClass} disabled={resume.isPending || finish.isPending} onClick={() => {
                    finish.reset();
                    setFinishPreview({ job, revision: props.snapshot.revision });
                  }}>Завершить неполный проход</button>}
                </td>
                <td className={`${tdClass} tabular-nums`}>{jobProgress(job)}</td>
                <td className={`${tdClass} tabular-nums`}>{utcDateTime(job.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    </section>
  );
}

export function FinishIncompleteRunModal(props: {
  job: OfapiCollectionJob; pageLabel: string; pending: boolean; error: string | null;
  onClose: () => void; onConfirm: () => void;
}) {
  return <ModalShell title="Завершить неполный проход?" onClose={props.onClose}>
    <p className="text-sm text-text-primary">{categoryLabel(props.job.category)} · {props.pageLabel}</p>
    <p className="mt-3 text-sm text-text-secondary">Сохранённые данные, курсор и учёт неподтверждённых списаний останутся. Этот проход завершится как неполный. Новых запросов сейчас не будет; следующий проход начнётся по штатному расписанию, если сбор включён.</p>
    {props.error && <p role="alert" className="mt-3 text-sm text-red-700">{props.error}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" className={buttonClass} disabled={props.pending} onClick={props.onClose}>Оставить на паузе</button>
      <button type="button" className={primaryButtonClass} disabled={props.pending} onClick={props.onConfirm}>{props.pending ? "Завершаем…" : "Завершить неполный проход"}</button>
    </div>
  </ModalShell>;
}

function WebhookCard() {
  const query = useAdminOfapiWebhookStatus();
  const status = query.data;
  const groupsList = status ? groupWebhookEvents(status.events) : [];
  const tone: RowTone = !status
    ? "muted"
    : status.registrationState === "stable"
      ? "ok"
      : status.registrationState === null
        ? "off"
        : /failed|indeterminate/.test(status.registrationState)
          ? "danger"
          : "warning";

  return (
    <section className={cardClass} aria-labelledby="collection-webhook-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-4 pt-3.5">
        <h3 id="collection-webhook-heading" className={eyebrowClass}>
          События вебхука · одна регистрация на все OF-страницы
        </h3>
        {status && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary">
            <Dot tone={tone} />
            {webhookStateLabel(status.registrationState)}
            {status.externalWebhookId && <> · <span className="font-mono text-[11px]">{maskWebhookId(status.externalWebhookId)}</span></>}
            {status.updatedAt && <> · проверена {utcDateTime(status.updatedAt)}</>}
          </span>
        )}
      </div>
      <p className="max-w-[80ch] px-4 pt-2 text-[12.5px] text-text-secondary">
        Набор типов общий для всех страниц{status?.accountScope ? ` (область: ${status.accountScope})` : ""}.
        Здесь показана текущая регистрация. Управление дополнительными событиями и восстановление доставок — ниже.
      </p>
      {query.isLoading && <p className="px-4 py-3 text-[12px] text-text-muted">Читаем регистрацию…</p>}
      {query.isError && (
        <p className="px-4 py-3 text-[12px] text-red-700">
          Регистрация не прочитана: {errorMessage(query.error, "сервер не ответил")}.
        </p>
      )}
      {status && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr>
                <th className={thClass}>Группа</th>
                <th className={thClass}>Типы событий</th>
                <th className={`${thClass} text-right`}>Подписка</th>
              </tr>
            </thead>
            <tbody>
              {groupsList.length === 0 && (
                <tr className="border-t border-border-light">
                  <td colSpan={3} className={`${tdClass} text-text-muted`}>
                    {status.configured ? "Типы событий не перечислены в регистрации." : "Вебхук не зарегистрирован."}
                  </td>
                </tr>
              )}
              {groupsList.map((group) => (
                <tr key={group.group} className="border-t border-border-light">
                  <td className={`${tdClass} text-text-primary`}>{group.label}</td>
                  <td className={`${tdClass} font-mono text-[11px]`}>{group.events.join(" · ")}</td>
                  <td className={`${tdClass} text-right`}>
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary">
                      <Dot tone="ok" />
                      в текущем наборе
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border-light px-4 py-2.5 text-[12px] text-text-secondary">
            {status.endpointUrl && <span>цель <span className="font-mono text-[11px]">{status.endpointUrl}</span></span>}
            <span>страниц с привязкой: <strong className="font-semibold text-text-primary">{status.pages.filter((page) => page.ofapiAccountId).length}</strong> из {status.pages.length}</span>
            {status.registrationError && <span className="text-red-700">ошибка регистрации: {status.registrationError}</span>}
            {status.pendingRegistration && (
              <span className="text-amber-700">
                ожидает readback: {status.pendingRegistration.operation} · подготовлено {utcDateTime(status.pendingRegistration.preparedAt)}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function AuditCard(props: { snapshot: OfapiCollectionSnapshot; actorName: (userId: number) => string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const rows = props.snapshot.audit;
  const latest = rows[0];
  return (
    <section className={cardClass}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-xl px-4 py-3 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="text-text-muted"><Caret expanded={open} /></span>
        <span className={eyebrowClass}>Журнал изменений</span>
        <span className="text-[12px] text-text-secondary">
          {rows.length === 0
            ? "записей нет · политика ещё не применялась"
            : `${rows.length} ${ruPlural(rows.length, "запись", "записи", "записей")} · последняя: v${latest!.revision}, ${utcDateTime(latest!.createdAt)}, ${props.actorName(latest!.actorUserId)}`}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="border-t border-border-light">
          {rows.length === 0
            ? <p className="px-4 py-3 text-[12px] text-text-muted">Пока пусто.</p>
            : (
              <ul className="divide-y divide-border-light">
                {rows.map((row) => (
                  <li key={row.revision} className="grid gap-1 px-4 py-2.5 text-[12.5px] sm:grid-cols-[120px_1fr]">
                    <div className="text-text-secondary tabular-nums">
                      <span className="font-semibold text-text-primary">v{row.revision}</span>
                      <div className="text-[11px]">{utcDateTime(row.createdAt)}</div>
                      <div className="text-[11px]">{props.actorName(row.actorUserId)}</div>
                    </div>
                    <div className="text-text-primary">{summarizeAudit(row, props.snapshot.pages)}</div>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </section>
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
      className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-[0_10px_30px_rgba(40,30,20,0.14),0_1px_2px_rgba(0,0,0,0.06)]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-text-primary">
        <strong className="whitespace-nowrap font-semibold">
          {count} {ruPlural(count, "изменение", "изменения", "изменений")} в черновике
        </strong>
        {entries.map((entry) => (
          <span
            key={draftKey(entry.settings.pageId, entry.settings.category)}
            className="max-w-[420px] truncate rounded-md border border-border-light bg-hover-alt px-2 py-0.5 text-[12px] text-text-secondary"
            title={`${categoryLabel(entry.settings.category)} · ${scopeLabel(entry.settings.pageId, props.snapshot.pages)}`}
          >
            <strong className="font-semibold text-text-primary">{categoryLabel(entry.settings.category)}</strong>
            {": "}
            {entry.base ? modeLabel(entry.base.mode) : "различалось"} → {describeSettings(entry.settings)}
            {entry.settings.pageId === null ? " · все страницы" : ` · ${scopeLabel(entry.settings.pageId, props.snapshot.pages)}`}
          </span>
        ))}
        {props.blockReason && <span className="basis-full text-[12px] text-amber-700">{props.blockReason}</span>}
        {props.conflict && (
          <span className="basis-full text-[12px] text-accent">
            Черновик собран против v{props.draft.revision}, сервер уже на v{props.snapshot.revision}. Сравните перед применением.
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={`${buttonClass} border-transparent bg-transparent`} onClick={props.onReset} disabled={props.busy}>
          Сбросить
        </button>
        {props.conflict
          ? (
            <button type="button" className={primaryButtonClass} onClick={props.onCompare} disabled={props.busy}>
              Обновить и сравнить
            </button>
          )
          : (
            <button
              type="button"
              className={primaryButtonClass}
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
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{props.title}</div>
      {props.children}
    </div>
  );
}

function CostSection(props: { preview: OfapiCollectionPreview; enabling: boolean }) {
  const { preview } = props;
  return (
    <ModalSection title="Расход">
      <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[200px_1fr]">
        <dt className="text-text-secondary">Периодический</dt>
        <dd className="text-text-primary">
          {preview.cost.maximumNewCreditsPerDay > 0
            ? <>не более <strong className="font-semibold">{fmtCredits(preview.cost.maximumNewCreditsPerDay)} кр в сутки</strong> новых управляемых запросов по расписанию (сумма дневных лимитов)</>
            : props.enabling
              ? "по расписанию ничего не добавляется; режим «по запросу» тратит только по явному действию в пределах своего лимита"
              : "новых периодических запросов нет"}
        </dd>
        <dt className="text-text-secondary">Оценка</dt>
        <dd className="text-text-primary">
          {preview.cost.estimatedCredits === null
            ? <><SourceTag unknown>не измерена</SourceTag> <span className="text-text-secondary">— сервер не даёт прогноза; пустая оценка не означает «0»</span></>
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
      <p className="text-[13px] text-text-primary">
        {props.inFlight > 0
          ? `В полёте ${props.inFlight} ${ruPlural(props.inFlight, "запрос", "запроса", "запросов")}. Они завершатся и могут списать кредиты независимо от этого изменения.`
          : "Запросов в полёте нет. Уже принятые провайдером экспорты и загрузки всё равно могут завершиться и списать кредиты."}
      </p>
    </ModalSection>
  );
}

function ServerNotesSection(props: { consequences: string[] }) {
  if (props.consequences.length === 0) return null;
  return (
    <ModalSection title="Сервер сообщает">
      <ul className="list-disc space-y-0.5 pl-5 text-[12.5px] text-text-secondary" lang="en">
        {props.consequences.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </ModalSection>
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
              <li key={draftKey(change.pageId, change.category)} className="text-[13px]">
                <div className="font-medium text-text-primary">{categoryLabel(change.category)}</div>
                <div className="text-text-secondary">
                  {base ? describeSettings(base) : "различалось по страницам"}
                  <span className="mx-2 text-text-muted">→</span>
                  <span className="text-text-primary">{describeSettings(change)}</span>
                </div>
                <div className="text-[12px] text-text-muted">
                  {scopeLabel(change.pageId, snapshot.pages)} · вебхук не меняется
                </div>
              </li>
            );
          })}
        </ul>
      </ModalSection>
      <ModalSection title="Перестанет обновляться">
        {turnedOff.length === 0
          ? <p className="text-[13px] text-text-secondary">Ничего: категории включаются или меняют лимиты, а не выключаются.</p>
          : (
            <ul className="space-y-1 text-[13px] text-text-primary">
              {turnedOff.map((change) => {
                const entry = snapshot.catalog.find((candidate) => candidate.id === change.category);
                return (
                  <li key={change.category}>
                    <span className="font-medium">{categoryLabel(change.category)}</span>
                    {": "}
                    {entry && entry.consumers.length > 0 ? entry.consumers.map(consumerLabel).join(", ") : "потребители не указаны"}
                    <span className="text-text-secondary"> — сохранённое остаётся и читается с реальной свежестью</span>
                  </li>
                );
              })}
            </ul>
          )}
      </ModalSection>
      <CostSection preview={preview} enabling={enabling} />
      <InFlightSection inFlight={preview.inFlight} />
      <ServerNotesSection consequences={preview.consequences} />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-3.5">
        <span className="text-[12px] text-text-muted">Политика v{preview.revision} → v{preview.revision + 1}</span>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={props.onClose} disabled={props.pending}>Назад</button>
          <button type="button" className={primaryButtonClass} onClick={props.onApply} disabled={props.pending}>
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
        <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[200px_1fr]">
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
        <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[200px_1fr]">
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
      <p className="border-t border-border-light pt-3 text-[12.5px] text-text-secondary">
        Собранные данные остаются. Возобновление продолжает с чекпоинтов и не догружает пропущенное автоматически. Пауза
        хранится на сервере и переживает рестарт и переподключение аккаунтов.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-3.5">
        <span className="text-[12px] text-text-muted">Политика v{props.preview.revision} → v{props.preview.revision + 1} · запись в журнал</span>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={props.onClose} disabled={props.pending}>Отмена</button>
          <button
            type="button"
            className={props.resume ? primaryButtonClass : dangerButtonClass}
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
      <p className="text-[13px] text-text-secondary">
        Черновик собран против v{props.draft.revision}; сервер сейчас на v{props.snapshot.revision}
        {props.refreshing ? " (обновляем…)" : ""}. Ничего не перетёрто: ниже «было», «сейчас на сервере» и ваш черновик.
      </p>
      <ModalSection title={`Сравнение · ${rows.length}`}>
        <ul className="space-y-2.5">
          {rows.map((row) => (
            <li key={row.key} className="text-[12.5px]">
              <div className="font-medium text-text-primary">
                {categoryLabel(row.category)} · {scopeLabel(row.pageId, props.snapshot.pages)}
                {row.changedElsewhere && <span className="ml-2 rounded-md bg-accent/10 px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-accent">изменено там</span>}
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
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-3.5">
        <span className="text-[12px] text-text-muted">
          {changedElsewhere.length > 0
            ? `Изменено другим окном: ${changedElsewhere.length} из ${rows.length}`
            : "затронутые строки на сервере не менялись"}
        </span>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={props.onDiscard}>Сбросить черновик</button>
          <button type="button" className={primaryButtonClass} onClick={props.onRebase} disabled={props.refreshing}>
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
  const canSubmit = pageId !== null && !windowInvalid && !props.pending;

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
        ? <Link className={buttonClass} to="/ofapi-media">Загрузить свой файл…</Link>
        : <p className="text-sm text-text-secondary">Для этой категории настройте действующий сбор. Разовые задачи недоступны.</p>}
    </ModalShell>
  );
  return (
    <ModalShell title={`Разовая задача · ${categoryLabel(props.category, entry?.label)}`} onClose={props.onClose}>
      <p className="text-[13px] text-text-secondary">
        Одна ограниченная задача: сервер не отправит ни одного запроса сверх потолков ниже. Задача привязана к политике
        v{snapshot.revision}; она не включает категорию и не меняет расписание.
        {entry && entry.prerequisites.length > 0 ? ` Требуется: ${entry.prerequisites.map(prerequisiteLabel).join(", ")}.` : ""}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[12px] text-text-secondary">Страница</span>
          <select
            value={pageId ?? ""}
            onChange={(event) => setPageId(event.target.value ? Number(event.target.value) : null)}
            className={inputClass}
          >
            {snapshot.pages.length === 0 && <option value="">OF-страниц нет</option>}
            {snapshot.pages.map((page) => <option key={page.id} value={page.id}>{page.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-secondary">Потолок кредитов</span>
          <input type="number" min={1} max={100000} value={maxCredits} onChange={(event) => setMaxCredits(clampInt(event.target.value, 1, 100000))} className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-secondary">Потолок запросов</span>
          <input type="number" min={1} max={1000} value={maxCalls} onChange={(event) => setMaxCalls(clampInt(event.target.value, 1, 1000))} className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-secondary">Потолок объёма, МБ</span>
          <input type="number" min={1} max={10240} value={maxMegabytes} onChange={(event) => setMaxMegabytes(clampInt(event.target.value, 1, 10240))} className={inputClass} />
          <span className={fieldHintClass}>= {formatBytes(Math.round(maxMegabytes * 1024 * 1024))}; учитывает сохранённые ответы и файлы.</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2 sm:col-span-2">
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-secondary">Период с (необязательно)</span>
            <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-secondary">Период по (необязательно)</span>
            <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} className={inputClass} />
            {windowInvalid && <span className="mt-1 block text-[11px] text-red-700">Начало периода должно быть раньше конца.</span>}
          </label>
        </div>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[12px] text-text-secondary">
            Выбор (необязательно: идентификаторы, по одному в строке)
          </span>
          <textarea
            value={selectionRaw}
            onChange={(event) => setSelectionRaw(event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-[12px] text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
          <span className={fieldHintClass}>{selection.length} из 100 элементов.</span>
        </label>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border-light pt-3.5">
        <button type="button" className={buttonClass} onClick={props.onClose} disabled={props.pending}>Отмена</button>
        <Tooltip focusable content="Сервер проверит потолки и версию политики; задача попадёт в очередь только при совпадении версии.">
          <button type="button" className={primaryButtonClass} onClick={submit} disabled={!canSubmit}>
            {props.pending ? "Отправляем…" : "Поставить задачу в очередь"}
          </button>
        </Tooltip>
      </div>
    </ModalShell>
  );
}
