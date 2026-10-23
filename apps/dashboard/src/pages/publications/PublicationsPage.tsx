import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { PUBLICATION_STATUSES, type PublicationStatus } from "@agency_hub_core/shared";
import type { PublicationWire } from "@agency_hub_core/contracts";
import { useAdminUsers, useAgentKeys } from "@/api/queries";
import {
  useApprovePublications,
  useCancelPublication,
  usePublicationDetail,
  usePublications,
  usePublicationSettings,
  useResolvePublication,
} from "@/api/publications";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { ModalShell } from "@/components/shared/ModalShell";
import { PlatformTag } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { GlobalSwitchLine, PageStateMark } from "./PublicationParts.js";
import {
  EMPTY_RESOLVE_DRAFT,
  FINDING_TONES,
  KIND_LABELS,
  PUBLICATIONS_LIST_LIMIT,
  PUBLICATION_WINDOWS,
  STATUS_BADGES,
  STATUS_LABELS,
  actionFailure,
  actorLabel,
  approvalItems,
  approvalOutcome,
  authorLabel,
  dayKeyOf,
  eventReasonLabel,
  findingText,
  groupPublicationsByDay,
  isApprovable,
  isCancellable,
  mediaList,
  mediaSummary,
  momentLabel,
  orderedFindings,
  parsePublicationsView,
  priceLabel,
  priceRangeLabel,
  publicationsCountLabel,
  publicationsSearch,
  resolveForm,
  textStart,
  timeOf,
  windowRange,
  type ApprovalRefusal,
  type Names,
  type PublicationWindow,
  type PublicationsView,
  type ResolveDraft,
} from "./publicationsView.js";

const CELL = "align-top";
const SUB = "mt-0.5 text-xs text-text-muted";

/** Today's Moscow day, read again each minute: the date window follows the calendar, not the clock. */
function useTodayKey(): string {
  const [today, setToday] = useState(() => dayKeyOf(new Date()));
  useEffect(() => {
    const timer = window.setInterval(() => setToday(dayKeyOf(new Date())), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return today;
}

function useNames(): Names {
  const users = useAdminUsers();
  const keys = useAgentKeys();
  return useMemo(() => ({
    users: new Map((users.data ?? []).map((user) => [user.id, user.username])),
    agentKeys: new Map((keys.data ?? []).map((key) => [key.id, key.name])),
  }), [users.data, keys.data]);
}

/** A checkbox that can say "some of these". */
function Checkbox({ checked, indeterminate = false, disabled = false, label, onChange }: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      title={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function Findings({ publication, todayKey }: { publication: PublicationWire; todayKey: string }) {
  if (publication.findings.length === 0) return <span className="text-text-muted">—</span>;
  return (
    <ul className="space-y-1">
      {orderedFindings(publication.findings).map((finding, index) => (
        <li key={`${finding.code}:${finding.mediaKey ?? ""}:${index}`} className={`text-xs ${FINDING_TONES[finding.severity]}`}>
          {finding.severity === "blocking" && <span className="font-semibold">Нельзя утвердить: </span>}
          {findingText(finding, todayKey)}
        </li>
      ))}
    </ul>
  );
}

interface RowActions {
  busy: boolean;
  onApprove: (publication: PublicationWire) => void;
  onCancel: (publication: PublicationWire) => void;
  onResolve: (publication: PublicationWire) => void;
  onOpen: (publication: PublicationWire) => void;
}

function ActionButtons({ publication, actions }: { publication: PublicationWire; actions: RowActions }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {publication.status === "draft" && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={actions.busy || !isApprovable(publication)}
          title={publication.blocked ? "Есть замечания, которые не дают утвердить" : undefined}
          onClick={() => actions.onApprove(publication)}
        >
          Утвердить
        </button>
      )}
      {publication.status === "unknown" && (
        <button type="button" className="btn btn-primary btn-sm" disabled={actions.busy} onClick={() => actions.onResolve(publication)}>
          Разобрать
        </button>
      )}
      {isCancellable(publication) && (
        <button type="button" className="btn btn-ghost btn-sm" disabled={actions.busy} onClick={() => actions.onCancel(publication)}>
          Отменить
        </button>
      )}
    </div>
  );
}

function DayTable({ publications, todayKey, names, selected, onSelect, actions }: {
  publications: PublicationWire[];
  todayKey: string;
  names: Names;
  selected: ReadonlySet<number>;
  onSelect: (ids: number[], checked: boolean) => void;
  actions: RowActions;
}) {
  return (
    <table className="data-table min-w-[1080px]">
      <thead>
        <tr>
          <th className="w-8"><span className="sr-only">Выбор</span></th>
          <th className="w-16">Время</th>
          <th>Страница</th>
          <th>Пост</th>
          <th className="num">Цена</th>
          <th>Статус</th>
          <th>Замечания</th>
          <th>Автор</th>
          <th><span className="sr-only">Действия</span></th>
        </tr>
      </thead>
      <tbody>
        {publications.map((publication) => (
          <tr key={publication.id}>
            <td className={CELL}>
              {isApprovable(publication) && (
                <Checkbox
                  checked={selected.has(publication.id)}
                  label={`Выбрать: ${publication.pageLabel}, ${timeOf(publication.publishAt)}`}
                  onChange={(checked) => onSelect([publication.id], checked)}
                />
              )}
            </td>
            <td className={`${CELL} whitespace-nowrap font-medium tabular-nums`}>{timeOf(publication.publishAt)}</td>
            <td className={`${CELL} whitespace-nowrap`}>
              <span className="inline-flex items-center gap-1.5">{publication.pageLabel} <PlatformTag platform={publication.platform} /></span>
            </td>
            <td className={`${CELL} max-w-[340px]`}>
              <button type="button" className="link text-left font-medium" onClick={() => actions.onOpen(publication)}>
                {KIND_LABELS[publication.kind]}
              </button>
              {publication.repost && <span className="ml-1.5 text-xs text-text-muted">перезалив</span>}
              <div className="mt-0.5 truncate text-sm text-text-secondary" title={publication.text}>{textStart(publication.text)}</div>
              <div className={`${SUB} break-all`}>{mediaSummary(publication.media)}</div>
            </td>
            <td className={`${CELL} num`}>{publication.kind === "paid_post" ? priceLabel(publication.priceMills) : "—"}</td>
            <td className={`${CELL} whitespace-nowrap`}>
              <span className={STATUS_BADGES[publication.status]}>{STATUS_LABELS[publication.status]}</span>
              {publication.platformPostRef !== null && <div className={SUB}>пост <span className="font-mono">{publication.platformPostRef}</span></div>}
            </td>
            <td className={`${CELL} max-w-[300px]`}><Findings publication={publication} todayKey={todayKey} /></td>
            <td className={`${CELL} text-sm text-text-secondary`}>{authorLabel(publication.author, names)}</td>
            <td className={`${CELL} whitespace-nowrap`}><ActionButtons publication={publication} actions={actions} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-0.5 text-sm">
      <dt className="w-36 shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text-primary">{children}</dd>
    </div>
  );
}

/** Everything about one publication, with its status journal (spec §4: who and when moved it). */
function DetailDialog({ publication, todayKey, names, actions, onClose }: {
  publication: PublicationWire;
  todayKey: string;
  names: Names;
  actions: RowActions;
  onClose: () => void;
}) {
  const detail = usePublicationDetail(publication.id);
  const shown = detail.data ?? publication;
  const files = mediaList(shown.media, "media");
  const previews = mediaList(shown.media, "preview");
  return (
    <ModalShell title={`Публикация №${shown.id}`} onClose={onClose} wide>
      <div className="space-y-4">
        <dl className="rounded-lg border border-border bg-hover-alt px-4 py-2">
          <Line label="Страница">{shown.pageLabel}</Line>
          <Line label="Тип">{KIND_LABELS[shown.kind]}{shown.repost ? ", перезалив" : ""}</Line>
          <Line label="Выход, МСК">{momentLabel(shown.publishAt, todayKey)}</Line>
          <Line label="Снять со стены">{shown.expiresAt === null ? "не снимать" : momentLabel(shown.expiresAt, todayKey)}</Line>
          <Line label="Статус">
            <span className={STATUS_BADGES[shown.status]}>{STATUS_LABELS[shown.status]}</span>
            {shown.statusReason !== null && <span className="ml-2 text-text-secondary">{eventReasonLabel(shown.statusReason)}</span>}
          </Line>
          {shown.platformPostRef !== null && <Line label="Пост на площадке"><span className="font-mono">{shown.platformPostRef}</span></Line>}
          <Line label="Файлы">{files.length === 0 ? "нет" : files.join(", ")}</Line>
          {previews.length > 0 && <Line label="Превью">{previews.join(", ")}</Line>}
          {shown.kind === "paid_post" && <Line label="Цена">{priceLabel(shown.priceMills)}</Line>}
          {shown.wallRefs.length > 0 && <Line label="Стены">{shown.wallRefs.join(", ")}</Line>}
          {shown.tierRefs.length > 0 && <Line label="Уровни подписки">{shown.tierRefs.join(", ")}</Line>}
          <Line label="Автор">{authorLabel(shown.author, names)}, {momentLabel(shown.createdAt, todayKey)}</Line>
          {shown.previousPublicationId !== null && <Line label="Замена для">публикации №{shown.previousPublicationId}</Line>}
          {detail.data?.revision && (
            <Line label="Утверждена">
              {names.users.get(detail.data.revision.approvedByUserId) ?? `человек №${detail.data.revision.approvedByUserId}`},{" "}
              {momentLabel(detail.data.revision.approvedAt, todayKey)}
            </Line>
          )}
        </dl>

        <div>
          <p className="field-label">Текст</p>
          <p className="whitespace-pre-wrap break-words rounded-lg border border-border px-4 py-3 text-sm text-text-primary">
            {shown.text === "" ? <span className="text-text-muted">без текста</span> : shown.text}
          </p>
        </div>

        <div>
          <p className="field-label">Замечания проверки</p>
          <Findings publication={shown} todayKey={todayKey} />
        </div>

        <div>
          <p className="field-label">Журнал статусов</p>
          {detail.isLoading && <p role="status" className="text-sm text-text-muted">Загружаем журнал…</p>}
          {detail.isError && <p role="alert" className="text-sm text-danger">Журнал не загрузился.</p>}
          {detail.data && (
            <ol className="space-y-1 text-sm">
              {detail.data.events.map((event, index) => (
                <li key={`${event.at}:${index}`} className="flex flex-wrap gap-x-2">
                  <span className="whitespace-nowrap text-text-muted">{momentLabel(event.at, todayKey)}</span>
                  <span className="text-text-primary">
                    {event.fromStatus === null ? "" : `${STATUS_LABELS[event.fromStatus]} → `}{STATUS_LABELS[event.toStatus]}
                  </span>
                  <span className="text-text-secondary">{actorLabel(event, names)}</span>
                  {eventReasonLabel(event.reason) !== null && <span className="text-text-muted">({eventReasonLabel(event.reason)})</span>}
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="flex justify-end border-t border-border pt-4">
          <ActionButtons publication={shown} actions={actions} />
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * «Неизвестно» (spec §8.2): Hub sent the request and lost the answer, so it
 * does not know whether the post went out, and never sends it again by
 * itself. A person looks at the wall and the platform's schedule and says.
 */
function ResolveDialog({ publication, todayKey, onClose }: { publication: PublicationWire; todayKey: string; onClose: () => void }) {
  const resolve = useResolvePublication();
  const [draft, setDraft] = useState<ResolveDraft>(EMPTY_RESOLVE_DRAFT);
  const [failure, setFailure] = useState<string | null>(null);
  const outcomeName = useId();
  const stateName = useId();
  const form = resolveForm(draft);
  const closeUnlessPending = () => { if (!resolve.isPending) onClose(); };

  function submit() {
    if (form.body === null || resolve.isPending) return;
    setFailure(null);
    resolve.mutate({ id: publication.id, body: form.body }, {
      onSuccess: (result) => {
        toast.success(result.replacement === null
          ? "Записано: пост ушёл"
          : `Записано: пост не ушёл. Новый черновик №${result.replacement.id} ждёт утверждения`);
        onClose();
      },
      onError: (error) => setFailure(actionFailure(error)),
    });
  }

  const choices = [
    ["went_out", "Пост ушёл", "Укажите его ID на площадке и где он: в расписании или уже на стене."],
    ["did_not_go_out", "Пост не ушёл", "Hub отметит «Не вышел» и создаст новый черновик со ссылкой на этот. Его нужно будет утвердить заново."],
  ] as const;

  return (
    <ModalShell title="Ушёл ли пост?" onClose={closeUnlessPending}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <dl className="rounded-lg border border-border bg-hover-alt px-4 py-2">
          <Line label="Страница">{publication.pageLabel}</Line>
          <Line label="Выход, МСК">{momentLabel(publication.publishAt, todayKey)}</Line>
          <Line label="Пост">{KIND_LABELS[publication.kind]}: {textStart(publication.text, 120)}</Line>
          <Line label="Файлы">{mediaSummary(publication.media)}</Line>
        </dl>
        <p className="text-[13px] text-text-secondary">
          Hub отправил пост на площадку, но ответа не получил. Сам он отправку не повторит. Откройте стену и расписание
          страницы на площадке и найдите этот пост около указанного времени.
        </p>

        <fieldset disabled={resolve.isPending} className="space-y-2">
          <legend className="mb-1 text-sm font-semibold text-text-primary">Что вы увидели на площадке</legend>
          {choices.map(([value, title, hint]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 ${draft.outcome === value ? "border-accent bg-hover" : "border-border hover:bg-hover"}`}
            >
              <input
                type="radio"
                name={outcomeName}
                checked={draft.outcome === value}
                onChange={() => setDraft((current) => ({ ...current, outcome: value }))}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-text-primary">{title}</span>
                <span className="block text-xs text-text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {draft.outcome === "went_out" && (
          <div className="space-y-3">
            <label className="block">
              <span className="field-label">ID поста на площадке</span>
              <input
                className="input font-mono"
                value={draft.postRef}
                autoComplete="off"
                maxLength={64}
                disabled={resolve.isPending}
                aria-invalid={form.postRefError !== null}
                onChange={(event) => setDraft((current) => ({ ...current, postRef: event.target.value }))}
              />
              {form.postRefError !== null && <p role="alert" className="field-hint text-danger">{form.postRefError}</p>}
            </label>
            <fieldset disabled={resolve.isPending} className="flex flex-wrap gap-4 text-sm">
              <legend className="field-label">Где он сейчас</legend>
              {([["scheduled", "Стоит в расписании"], ["published", "Уже на стене"]] as const).map(([value, title]) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={stateName}
                    checked={draft.state === value}
                    onChange={() => setDraft((current) => ({ ...current, state: value }))}
                  />
                  {title}
                </label>
              ))}
            </fieldset>
          </div>
        )}

        {draft.outcome === "did_not_go_out" && (
          <p role="note" className="notice notice-warning">
            Проверьте и стену, и расписание, прежде чем записать «не ушёл»: если пост всё-таки там, новый черновик после
            утверждения выложит его второй раз.
          </p>
        )}

        {failure !== null && <p role="alert" className="notice notice-danger">{failure}</p>}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
          {form.missing !== null && <span className="mr-auto text-xs text-text-muted">{form.missing}</span>}
          <button type="button" className="btn" disabled={resolve.isPending} onClick={closeUnlessPending}>Отмена</button>
          <button
            type="submit"
            className={draft.outcome === "did_not_go_out" ? "btn btn-danger" : "btn btn-primary"}
            disabled={form.body === null || resolve.isPending}
          >
            {resolve.isPending ? "Записываем…"
              : draft.outcome === "did_not_go_out" ? "Записать: не ушёл"
                : "Записать: ушёл"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/** What the last approval did: how many went through, and every refusal with its reason. */
function ApprovalReport({ report, onClose }: { report: { approved: number; refused: ApprovalRefusal[] }; onClose: () => void }) {
  return (
    <div role="status" className={`notice ${report.refused.length > 0 ? "notice-warning" : "notice-success"} flex-col items-stretch`}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">
          Утверждено: {report.approved}.{report.refused.length > 0 ? ` Не утверждено: ${report.refused.length}.` : ""}
        </p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Скрыть</button>
      </div>
      {report.refused.length > 0 && (
        <ul className="mt-1 space-y-1 text-sm">
          {report.refused.map((item) => (
            <li key={item.id}>
              <span className="font-medium">{item.title}</span> — {item.reason}
              {item.findings.length > 0 && <span>: {item.findings.join("; ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * «Публикации» (spec §9): every page's posts by day. A person approves drafts
 * (one or a selection), cancels what has not gone yet, and answers
 * «Неизвестно». Hub puts approved posts on the platforms by itself.
 */
export function PublicationsPage() {
  const [search, setSearch] = useSearchParams();
  const view = parsePublicationsView(search);
  const todayKey = useTodayKey();
  const range = windowRange(view.window, todayKey);
  const list = usePublications({
    ...(view.pageLabel === null ? {} : { pageLabel: view.pageLabel }),
    ...(view.status === null ? {} : { status: view.status }),
    ...range,
    limit: PUBLICATIONS_LIST_LIMIT,
  });
  // Every «Неизвестно», whatever the filters: each one waits for a person.
  const unknown = usePublications({ status: "unknown", limit: 200 });
  const settings = usePublicationSettings();
  const { pages } = useDashboardShell();
  const names = useNames();
  const approve = useApprovePublications();
  const cancel = useCancelPublication();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [report, setReport] = useState<{ approved: number; refused: ApprovalRefusal[] } | null>(null);
  const [opened, setOpened] = useState<PublicationWire | null>(null);
  const [resolving, setResolving] = useState<PublicationWire | null>(null);
  const [cancelling, setCancelling] = useState<PublicationWire | null>(null);
  const pageFilterId = useId();
  const statusFilterId = useId();
  const windowFilterId = useId();

  const publications = useMemo(() => list.data?.publications ?? [], [list.data]);
  const days = useMemo(() => groupPublicationsByDay(publications, todayKey), [publications, todayKey]);
  const shownInOrder = useMemo(() => days.flatMap((day) => day.publications), [days]);
  const approvable = shownInOrder.filter(isApprovable);
  // A selected draft that left the list or stopped being approvable is not selected any more.
  const selection = new Set(approvable.filter((item) => selected.has(item.id)).map((item) => item.id));
  const pageLabels = settings.data?.pages.map((page) => page.pageLabel) ?? pages.map((page) => page.label);
  const busy = approve.isPending || cancel.isPending;

  function show(change: Partial<PublicationsView>) {
    setSearch(publicationsSearch({ ...parsePublicationsView(new URLSearchParams(window.location.search)), ...change }));
  }

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

  function runApproval(items: Array<{ id: number; version: number }>) {
    if (items.length === 0 || approve.isPending) return;
    setReport(null);
    approve.mutate(items, {
      onSuccess: (result) => {
        const outcome = approvalOutcome(result.results, todayKey);
        setSelected(new Set());
        if (outcome.refused.length === 0 && items.length === 1) toast.success("Утверждено");
        else setReport(outcome);
      },
      onError: (error) => toast.error(actionFailure(error)),
    });
  }

  const actions: RowActions = {
    busy,
    onApprove: (publication) => runApproval([{ id: publication.id, version: publication.version }]),
    onCancel: setCancelling,
    onResolve: (publication) => { setOpened(null); setResolving(publication); },
    onOpen: setOpened,
  };

  const filters = (
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={pageFilterId} className="flex items-center gap-2 text-sm text-text-secondary">
        Страница
        <select
          id={pageFilterId}
          value={view.pageLabel ?? ""}
          onChange={(event) => show({ pageLabel: event.target.value === "" ? null : event.target.value })}
          className="select w-auto min-h-[34px] py-1.5"
        >
          <option value="">Все страницы</option>
          {pageLabels.map((label) => <option key={label} value={label}>{label}</option>)}
        </select>
      </label>
      <label htmlFor={statusFilterId} className="flex items-center gap-2 text-sm text-text-secondary">
        Статус
        <select
          id={statusFilterId}
          value={view.status ?? ""}
          onChange={(event) => show({ status: event.target.value === "" ? null : event.target.value as PublicationStatus })}
          className="select w-auto min-h-[34px] py-1.5"
        >
          <option value="">Все статусы</option>
          {PUBLICATION_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
        </select>
      </label>
      <label htmlFor={windowFilterId} className="flex items-center gap-2 text-sm text-text-secondary">
        Даты
        <select
          id={windowFilterId}
          value={view.window}
          onChange={(event) => show({ window: event.target.value as PublicationWindow })}
          className="select w-auto min-h-[34px] py-1.5"
        >
          {PUBLICATION_WINDOWS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
      </label>
      <span className="ml-auto text-xs text-text-muted">Время московское (МСК)</span>
    </div>
  );

  const unknownCount = unknown.data?.publications.length ?? 0;

  return (
    <div className="space-y-5">
      <section className="card" aria-labelledby="publication-pages-title">
        <div className="card-header">
          <div>
            <h2 id="publication-pages-title" className="card-title">Страницы</h2>
            {settings.data && <div className="mt-1"><GlobalSwitchLine enabled={settings.data.globalEnabled} /></div>}
          </div>
          <Link to="/publication-settings" className="btn btn-sm">Настроить страницы</Link>
        </div>
        <div className="card-body">
          {settings.isLoading && <p role="status" className="text-sm text-text-muted">Загружаем настройки страниц…</p>}
          {settings.isError && !settings.data && (
            <p role="alert" className="text-sm text-danger">
              Настройки страниц не загрузились.{" "}
              <button type="button" className="link" onClick={() => void settings.refetch()}>Повторить</button>
            </p>
          )}
          {settings.data && (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {settings.data.pages.map((page) => (
                <li key={page.pageLabel} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-text-primary">
                      {page.pageLabel} <PlatformTag platform={page.platform} />
                    </span>
                    <PageStateMark settings={page} />
                  </div>
                  <div className="mt-0.5 text-xs text-text-muted">Платные: {priceRangeLabel(page.paidPriceMinMills, page.paidPriceMaxMills)}</div>
                  {page.autostopReason !== null && (
                    <div className="mt-0.5 text-xs text-danger" title={page.autostopReason}>{page.autostopReason}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {unknownCount > 0 && view.status !== "unknown" && (
        <div role="alert" className="notice notice-warning flex-wrap items-center justify-between">
          <span>
            {publicationsCountLabel(unknownCount)} с исходом «Неизвестно»: Hub не знает, ушёл ли пост, и ждёт ответа человека.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => show({ status: "unknown", window: "all", pageLabel: null })}>
            Разобрать
          </button>
        </div>
      )}

      {filters}

      {report !== null && <ApprovalReport report={report} onClose={() => setReport(null)} />}

      {!list.data ? (
        list.isLoading
          ? <TableSkeleton rows={5} columns={8} />
          : (
            <StatusPanel
              title="Список не загрузился"
              description="Hub не ответил. Публикации никуда не делись: попробуйте ещё раз."
              tone="error"
              action={<button type="button" className="btn btn-sm" onClick={() => void list.refetch()}>Повторить</button>}
            />
          )
      ) : (
        <div aria-busy={list.isPlaceholderData} className={`space-y-5 ${list.isPlaceholderData ? "opacity-60" : ""}`}>
          {list.isError && (
            <div role="alert" className="notice notice-warning flex-wrap items-center justify-between">
              <span>Обновить не получилось. Показан список прошлой загрузки: он мог устареть.</span>
              <button type="button" className="btn btn-sm" onClick={() => void list.refetch()}>Повторить</button>
            </div>
          )}
          {publications.length >= PUBLICATIONS_LIST_LIMIT && (
            <p className="notice notice-warning">Показаны первые {PUBLICATIONS_LIST_LIMIT}. Сузьте фильтр, чтобы увидеть остальные.</p>
          )}

          {approvable.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
              <Checkbox
                checked={selection.size === approvable.length}
                indeterminate={selection.size > 0 && selection.size < approvable.length}
                label="Выбрать все черновики, которые можно утвердить"
                onChange={(checked) => select(approvable.map((item) => item.id), checked)}
              />
              <span className="text-text-secondary">
                {selection.size === 0
                  ? `Можно утвердить: ${approvable.length}`
                  : `Выбрано ${selection.size} из ${approvable.length}`}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm ml-auto"
                disabled={selection.size === 0 || busy}
                onClick={() => runApproval(approvalItems(shownInOrder, selection))}
              >
                {approve.isPending ? "Утверждаем…" : `Утвердить выбранные${selection.size > 0 ? ` (${selection.size})` : ""}`}
              </button>
            </div>
          )}

          {days.length === 0 ? (
            <StatusPanel
              title="Публикаций нет"
              description={view.status === null && view.pageLabel === null
                ? "В эти даты публикаций нет. Черновики создают агенты и люди; здесь их утверждают."
                : "Под этот фильтр ничего не подошло."}
            />
          ) : days.map((day) => {
            const dayApprovable = day.publications.filter(isApprovable).map((item) => item.id);
            const daySelected = dayApprovable.filter((id) => selection.has(id)).length;
            return (
              <section key={day.key} className="card" aria-label={day.label}>
                <div className="card-header">
                  <div>
                    <h2 className="card-title">{day.label}</h2>
                    <p className="card-description">{publicationsCountLabel(day.publications.length)}</p>
                  </div>
                  {dayApprovable.length > 0 && (
                    <label className="flex items-center gap-2 text-sm text-text-secondary">
                      <Checkbox
                        checked={daySelected === dayApprovable.length}
                        indeterminate={daySelected > 0 && daySelected < dayApprovable.length}
                        label={`Выбрать черновики дня: ${day.label}`}
                        onChange={(checked) => select(dayApprovable, checked)}
                      />
                      Черновики дня ({dayApprovable.length})
                    </label>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <DayTable
                    publications={day.publications}
                    todayKey={todayKey}
                    names={names}
                    selected={selection}
                    onSelect={select}
                    actions={actions}
                  />
                </div>
              </section>
            );
          })}
        </div>
      )}

      {opened !== null && (
        <DetailDialog
          key={opened.id}
          publication={publications.find((item) => item.id === opened.id) ?? opened}
          todayKey={todayKey}
          names={names}
          actions={actions}
          onClose={() => setOpened(null)}
        />
      )}
      {resolving !== null && (
        <ResolveDialog key={resolving.id} publication={resolving} todayKey={todayKey} onClose={() => setResolving(null)} />
      )}
      {cancelling !== null && (
        <ConfirmModal
          title="Отменить публикацию?"
          message={`${cancelling.pageLabel}, ${momentLabel(cancelling.publishAt, todayKey)} МСК: ${KIND_LABELS[cancelling.kind].toLowerCase()} не уйдёт на площадку. `
            + "Вернуть отменённую нельзя, понадобится новый черновик."}
          confirmLabel="Отменить публикацию"
          cancelLabel="Не отменять"
          isPending={cancel.isPending}
          onClose={() => { if (!cancel.isPending) setCancelling(null); }}
          onConfirm={() => cancel.mutate(cancelling.id, {
            onSuccess: () => { toast.success("Публикация отменена"); setCancelling(null); setOpened(null); },
            onError: (error) => { toast.error(actionFailure(error)); setCancelling(null); },
          })}
        />
      )}
    </div>
  );
}
