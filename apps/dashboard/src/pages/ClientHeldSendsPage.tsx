import { useId, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ClientSendCustodyListItem, ClientSendCustodyListState } from "@agency_hub_core/contracts";
import { clientHeldSendsQueryOptions, useClientHeldSends, useResolveClientSend } from "@/api/queries";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { ModalShell } from "@/components/shared/ModalShell";
import { Pagination } from "@/components/shared/Pagination";
import { staleDataText } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import {
  EMPTY_RESOLVE_DRAFT,
  HELD_SENDS_PAGE_SIZE,
  HELD_SENDS_TABS,
  NOT_SENT_OUTCOME_HINT,
  RESOLVE_NOTE_MAX,
  changeHeldSendsView,
  heldCountLabel,
  heldSendRows,
  heldSendsPageLabels,
  notSentWarning,
  parseHeldSendsView,
  resolveFailure,
  resolveForm,
  resolvedSendRows,
  sentOutcomeHint,
  shortId,
  type HeldSendRow,
  type HeldSendsView,
  type ResolveDraft,
  type ResolveFailure,
  type ResolvedSendRow,
} from "./clientHeldSendsView.js";

// Tighter cells below a wide window: with «Разобрать» pinned at the right edge, the columns up to
// «Когда» have to fit beside it at 1024 px, or the minutes of the time end up under the button.
const HEAD_CELL = "whitespace-nowrap";
const CELL_BASE = "align-top";
const CELL = `${CELL_BASE} text-text-secondary`;
const CELL_MAIN = `${CELL_BASE} font-medium text-text-primary`;
const SUB = "team-sub";
/**
 * The column of «Разобрать» stays at the right edge while a narrow window
 * scrolls the table sideways: the one thing to do with a row is never off
 * screen. The cell brings its own background (the head's, the body's).
 */
const ACTION_COLUMN = "team-sticky-action";
/** How holding works, folded at the bottom of the screen. */
const HOW_IT_WORKS = [
  "Когда чаттер отправляет сообщение из превью, расширение сообщает Hub, ушло оно или нет. Если отчёт не пришёл, "
    + "Hub этого не знает и держит фана: из превью ему больше не отправят, а нового подписчика не поприветствуют, пока "
    + "человек не посмотрит чат и не запишет здесь, что произошло.",
  "Само удержание не снимается никогда: ни со временем, ни после нового входа. На этой странице текста нет: Hub не знает, какой текст ушёл.",
  "Под именем чаттера — установка расширения, с которой ушла отправка: у одного человека их может быть несколько. "
    + "Время на странице ваше местное, как в чате. Список обновляется сам раз в полминуты.",
];

/** The fan's OnlyFans id, as a link to what the hub knows of the fan. */
function FanLink({ pageLabel, fanRef, backTo }: { pageLabel: string; fanRef: string; backTo: string }) {
  const navigation = buildFanProfileNavigation(pageLabel, "onlyfans", fanRef, backTo, fanRef);
  return (
    <Link to={navigation.to} state={navigation.state} className="team-link tabular-nums">
      {fanRef}
    </Link>
  );
}

/** "часть 1 из 3, вариант 2" may wrap after the comma and nowhere else: no lone "2" on a line of its own. */
function Clauses({ text }: { text: string }) {
  const clauses = text.split(", ");
  return (
    <>
      {clauses.map((clause, index) => (
        <span key={clause} className="whitespace-nowrap">{clause}{index < clauses.length - 1 ? ", " : ""}</span>
      ))}
    </>
  );
}

function HeldTable({ rows, backTo, onResolve }: {
  rows: HeldSendRow[];
  backTo: string;
  onResolve: (item: ClientSendCustodyListItem) => void;
}) {
  return (
    <table className="data-table min-w-[920px]">
      <thead>
        <tr>
          <th className={HEAD_CELL}>Страница и фан</th>
          <th className={HEAD_CELL}>Что отправляли</th>
          <th className={HEAD_CELL}>Кто отправлял</th>
          <th className={HEAD_CELL}>Когда</th>
          <th className={HEAD_CELL}>Приветствие фана</th>
          <th className={`${HEAD_CELL} ${ACTION_COLUMN}`}><span className="sr-only">Действие</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className={CELL_MAIN}>
              {row.pageLabel}
              <div className={SUB}>фан <FanLink pageLabel={row.pageLabel} fanRef={row.fanRef} backTo={backTo} /></div>
            </td>
            <td className={CELL}>
              <span className="text-text-primary">{row.purpose}</span>
              <div className={`${SUB} xl:whitespace-nowrap`}><Clauses text={row.part} /></div>
            </td>
            <td className={CELL}>
              <span className="text-text-primary">{row.username}</span>
              {/* Short here: the card's description says once that it is the extension's install. On a
                  wide window one line; on a narrow one it may wrap, so that «Когда» stays in view. */}
              <div className={`${SUB} xl:whitespace-nowrap`}>установка <span className="font-mono">{row.install}</span></div>
            </td>
            <td className={`${CELL} whitespace-nowrap`}>
              {row.dispatchedAt}
              <div className={SUB}>без отчёта {row.heldFor}</div>
            </td>
            <td className={`${CELL} max-w-[260px]`}>
              {row.greeting === null ? (
                // A held reply says nothing of a greeting, and its resolve changes nothing about one.
                <span className="text-text-muted" title="Это не приветствие">—</span>
              ) : (
                <>
                  <span className={row.greeting.sentByHand ? "font-medium team-warning-text" : "text-text-primary"}>{row.greeting.label}</span>
                  {row.greeting.hint !== null && <div className={SUB}>{row.greeting.hint}</div>}
                </>
              )}
            </td>
            <td className={`${CELL} ${ACTION_COLUMN} whitespace-nowrap text-right`}>
              <button type="button" onClick={() => onResolve(row.item)} className="btn btn-sm">
                Разобрать
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResolvedTable({ rows, backTo }: { rows: ResolvedSendRow[]; backTo: string }) {
  return (
    <table className="data-table min-w-[920px]">
      <thead>
        <tr>
          <th className={HEAD_CELL}>Страница и фан</th>
          <th className={HEAD_CELL}>Что отправляли</th>
          <th className={HEAD_CELL}>Итог</th>
          <th className={HEAD_CELL}>Кто и когда разобрал</th>
          <th className={HEAD_CELL}>Почему так решили</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className={CELL_MAIN}>
              {row.pageLabel}
              <div className={SUB}>фан <FanLink pageLabel={row.pageLabel} fanRef={row.fanRef} backTo={backTo} /></div>
            </td>
            <td className={CELL}>
              <span className="text-text-primary">{row.purpose}</span>
              <div className={SUB}>{row.part}</div>
              <div className={SUB}>{row.username}, {row.dispatchedAt}</div>
            </td>
            <td className={`${CELL} whitespace-nowrap`}>
              <span className="font-medium text-text-primary">{row.outcome}</span>
              {row.platformMessageId !== null && (
                <div className={SUB}>ID сообщения <span className="font-mono">{row.platformMessageId}</span></div>
              )}
              <div className={SUB} title={`Попытка ${row.attemptId}`}>попытка <span className="font-mono">{shortId(row.attemptId)}</span></div>
            </td>
            <td className={`${CELL} whitespace-nowrap`}>
              <span className="text-text-primary">{row.resolvedBy}</span>
              <div className={SUB}>{row.resolvedAt}</div>
            </td>
            <td className={`${CELL} max-w-[320px] whitespace-pre-wrap break-words`}>{row.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SummaryLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-0.5 text-sm">
      <dt className="w-36 shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 text-text-primary">{children}</dd>
    </div>
  );
}

/**
 * The resolve of one held send. Two answers and neither is preselected: "sent"
 * records a greeting for good, "not sent" lets the fan be written to again, so
 * the person says which one they saw in the chat, and why.
 *
 * The mutation is the page's, not the dialog's: a dialog-owned one would drop
 * its answer if the dialog closed while the hub was still recording.
 */
export function ResolveSendDialog({ item, serverNow, isPending, failure, onSubmit, onClose, initialDraft = EMPTY_RESOLVE_DRAFT }: {
  item: ClientSendCustodyListItem;
  serverNow: string;
  isPending: boolean;
  failure: ResolveFailure | null;
  onSubmit: (draft: ResolveDraft) => void;
  onClose: () => void;
  /** What the form opens with. The page opens it empty; the rendering tests open it mid-way. */
  initialDraft?: ResolveDraft;
}) {
  const [draft, setDraft] = useState<ResolveDraft>(initialDraft);
  const outcomeName = useId();
  const noteHintId = useId();
  const form = resolveForm(draft);
  const [row] = heldSendRows([item], serverNow) as [HeldSendRow];
  const { greeting } = row;
  const gone = failure?.gone === true;
  // While the hub is recording there is nothing useful to go back to.
  const closeUnlessPending = () => {
    if (!isPending) onClose();
  };

  return (
    <ModalShell title="Разобрать отправку" onClose={closeUnlessPending} closeLabel="Закрыть" size="short">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (form.body !== null && !isPending && !gone) onSubmit(draft);
        }}
      >
        <dl className="rounded-lg border border-border bg-hover-alt px-4 py-2">
          <SummaryLine label="Страница">{row.pageLabel}</SummaryLine>
          <SummaryLine label="Фан"><span className="font-mono">{row.fanRef}</span></SummaryLine>
          <SummaryLine label="Что отправляли">{row.purpose}, {row.part}</SummaryLine>
          <SummaryLine label="Кто отправлял">{row.username}, установка расширения <span className="font-mono">{row.install}</span></SummaryLine>
          <SummaryLine label="Когда">{row.dispatchedAt}, без отчёта {row.heldFor}</SummaryLine>
          {greeting !== null && (
            <SummaryLine label="Приветствие фана">
              {greeting.label}
              {greeting.hint !== null && <span className="block text-xs text-text-muted">{greeting.hint}</span>}
            </SummaryLine>
          )}
          {/* One line: the attempt short (whole in the tooltip; the audit trail names the send by it),
              the generation whole, because the owner looks the draft up by it. */}
          <SummaryLine label="Попытка">
            <span className="break-all text-xs">
              <span className="font-mono" title={`Попытка ${item.attemptId}`}>{shortId(item.attemptId)}</span>
              <span className="text-text-muted"> · генерация <span className="font-mono">{item.generationRef}</span></span>
            </span>
          </SummaryLine>
        </dl>

        <p className="text-xs text-text-secondary">
          Расширение отправило это сообщение из превью и не сообщило, чем кончилось. Hub не знает, ушло ли оно,
          и сам не узнает. Откройте чат с этим фаном там, где вы работаете с OnlyFans, и найдите исходящее сообщение
          около указанного времени. На этой странице текста нет: Hub не знает, какой текст ушёл, это знает сотрудник.
        </p>

        <fieldset disabled={isPending || gone} className="space-y-2">
          <legend className="mb-1 text-sm font-semibold text-text-primary">Что вы увидели в чате</legend>
          {([
            ["sent", "Сообщение ушло", sentOutcomeHint(item)],
            ["not_sent", "Сообщение не ушло", NOT_SENT_OUTCOME_HINT],
          ] as const).map(([value, title, description]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${
                draft.outcome === value ? "border-accent bg-hover" : "border-border hover:bg-hover"
              }`}
            >
              <input
                type="radio"
                name={outcomeName}
                value={value}
                checked={draft.outcome === value}
                onChange={() => setDraft((current) => ({ ...current, outcome: value }))}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-text-primary">{title}</span>
                <span className="block text-xs text-text-muted">{description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {draft.outcome === "not_sent" && (
          <div role="note" className="notice notice-warning">
            <div>
              <p className="font-semibold">Проверьте, прежде чем записать «не ушло»</p>
              {notSentWarning(item).map((line) => <p key={line} className="mt-1">{line}</p>)}
            </div>
          </div>
        )}

        {draft.outcome === "sent" && (
          <label className="block">
            <div className="field-label">ID сообщения в OnlyFans, если вы его знаете (необязательно)</div>
            <input
              value={draft.platformMessageId}
              inputMode="numeric"
              autoComplete="off"
              maxLength={40}
              disabled={isPending || gone}
              aria-invalid={form.platformMessageIdError !== null}
              onChange={(event) => setDraft((current) => ({ ...current, platformMessageId: event.target.value }))}
              className="input font-mono"
            />
            {form.platformMessageIdError !== null && (
              <p role="alert" className="field-hint text-danger">{form.platformMessageIdError}</p>
            )}
          </label>
        )}

        <label className="block">
          <div className="field-label">Почему вы так решили (обязательно)</div>
          <textarea
            value={draft.note}
            rows={2}
            disabled={isPending || gone}
            aria-describedby={noteHintId}
            onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
            placeholder="например: посмотрел чат, сообщение от 14:02 на месте"
            className="textarea"
          />
          <p id={noteHintId} className={`field-hint ${form.noteLeft < 0 ? "text-danger" : ""}`}>
            Заметка сохранится в журнале разборов вместе с вашим именем. До {RESOLVE_NOTE_MAX} знаков, осталось {form.noteLeft}.
          </p>
        </label>

        {failure !== null && (
          <p role="alert" className="notice notice-danger">
            {failure.message}
          </p>
        )}

        {/* The dialog scrolls inside ModalShell's box (p-6): the buttons stay at its bottom edge, over
            the form, so they are on screen at any height and in any state of the form. */}
        <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-raised px-6 py-4">
          {!gone && form.missing !== null && <span className="mr-auto text-xs text-text-muted">{form.missing}</span>}
          <button type="button" onClick={closeUnlessPending} disabled={isPending} className="btn">
            {gone ? "Закрыть" : "Отмена"}
          </button>
          {!gone && (
            <button
              type="submit"
              disabled={form.body === null || isPending}
              className={draft.outcome === "not_sent" ? "btn btn-danger" : "btn btn-primary"}
            >
              {isPending ? "Записываем…"
                : draft.outcome === "sent" ? "Записать: сообщение ушло"
                : draft.outcome === "not_sent" ? "Записать: сообщение не ушло"
                : "Записать"}
            </button>
          )}
        </div>
      </form>
    </ModalShell>
  );
}

/**
 * Held sends of the chat extension (chat-extension H-7e): the sends from the
 * preview whose outcome the hub never learned, for the owner and team leads to
 * resolve by hand, and the trail of the ones already resolved. The page is the
 * console's page filter (only OnlyFans pages hold sends); the resolve's target
 * is the row, never the filter.
 */
export function ClientHeldSendsPage() {
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const { pages, pageCatalogState } = useDashboardShell();
  const filter = usePageFilter();
  const pageLabels = heldSendsPageLabels(pages);
  const view: HeldSendsView = { ...parseHeldSendsView(search, pageCatalogState === "ready" ? pageLabels : null), pageLabel: filter.page };
  const { data, isLoading, isError, isFetching, isPlaceholderData, refetch, dataUpdatedAt } = useClientHeldSends({
    state: view.state,
    ...(view.pageLabel === null ? {} : { pageLabel: view.pageLabel }),
    limit: HELD_SENDS_PAGE_SIZE,
    offset: view.offset,
  });
  // The other list's number, and the queue of every page (the tab's number reads the same).
  const other = useQuery(clientHeldSendsQueryOptions({
    state: view.state === "held" ? "resolved" : "held",
    ...(view.pageLabel === null ? {} : { pageLabel: view.pageLabel }),
    limit: 1,
    offset: 0,
  }));
  const everywhere = useQuery({ ...clientHeldSendsQueryOptions({ state: "held", limit: 1, offset: 0 }), enabled: view.pageLabel !== null });
  const resolve = useResolveClientSend();
  const [resolving, setResolving] = useState<{ item: ClientSendCustodyListItem; serverNow: string } | null>(null);
  const [failure, setFailure] = useState<ResolveFailure | null>(null);

  // A change starts from the address the browser shows now, not from this render's `view`: the
  // router hands a new address to React in a transition, and a second change made before that
  // render commits would otherwise undo the first (changeHeldSendsView).
  function show(change: Partial<HeldSendsView>) {
    setSearch(changeHeldSendsView(
      new URLSearchParams(window.location.search),
      pageCatalogState === "ready" ? pageLabels : null,
      change,
    ));
  }

  function closeDialog() {
    setResolving(null);
    setFailure(null);
    resolve.reset();
  }

  function submit(draft: ResolveDraft) {
    const form = resolveForm(draft);
    if (resolving === null || form.body === null) return;
    setFailure(null);
    resolve.mutate({ pageLabel: resolving.item.pageLabel, attemptId: resolving.item.attemptId, body: form.body }, {
      onSuccess: () => {
        toast.success(form.body?.outcome === "sent" ? "Записано: сообщение ушло" : "Записано: сообщение не ушло");
        closeDialog();
      },
      onError: (error) => setFailure(resolveFailure(error, draft)),
    });
  }

  const held = view.state === "held";
  const heldTotal = held ? data?.total : other.data?.total;
  const resolvedTotal = held ? other.data?.total : data?.total;
  const elsewhere = held && view.pageLabel !== null && data && everywhere.data ? everywhere.data.total - data.total : 0;
  const backTo = `${location.pathname}${location.search}`;
  const retry = (
    <button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">
      Повторить
    </button>
  );
  const help = (
    <Disclosure>
      {HOW_IT_WORKS.map((line) => <p key={line}>{line}</p>)}
    </Disclosure>
  );

  const head = (
    <>
      <PageHeader fresh={data ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined} />
      <div className="table-toolbar team-toolbar">
        <Segmented
          label="Отправки"
          value={view.state}
          onChange={(key) => show({ state: key as ClientSendCustodyListState })}
          options={HELD_SENDS_TABS.map(({ key, label }) => ({ value: key, label, count: key === "held" ? heldTotal : resolvedTotal }))}
        />
      </div>
      {elsewhere > 0 && (
        <Notice action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}>
          Показана только {view.pageLabel}. На других страницах {ruPlural(elsewhere, "ждёт", "ждут", "ждут")} ещё {elsewhere} {ruPlural(elsewhere, "отправка", "отправки", "отправок")}.
        </Notice>
      )}
    </>
  );

  if (!data) {
    return (
      <div className="team-screen">
        {head}
        {isLoading
          ? <TableSkeleton rows={4} columns={6} />
          : (
            <StatusPanel
              title="Hub не ответил"
              description="Числа не пришли. Это не ноль: данные могут быть, просто экран их не получил. Отправки никуда не делись."
              tone="error"
              action={retry}
            />
          )}
        {help}
      </div>
    );
  }

  const heldRows = held ? heldSendRows(data.items, data.serverNow) : [];
  const resolvedRows = held ? [] : resolvedSendRows(data.items, data.serverNow);
  const empty = data.items.length === 0;

  return (
    <div className="team-screen">
      {head}
      {isError && <Notice tone="warning" role="alert" action={retry}>{staleDataText(dataUpdatedAt)}</Notice>}

      {empty && view.offset === 0 ? (
        held ? (
          <StatusPanel
            title={view.pageLabel === null ? "Проверять нечего" : `На ${view.pageLabel} проверять нечего`}
            description="Все отправки из превью закончились отчётом расширения или уже разобраны."
          />
        ) : (
          <StatusPanel
            title="Разобранных отправок нет"
            description="Здесь появится каждая отправка, которую владелец или тимлид разобрал вручную: кто, когда, с каким итогом и почему."
          />
        )
      ) : (
        // Rows of the previous page or filter stay on screen while the asked ones load, dimmed.
        <section aria-busy={isPlaceholderData} className={`card ${isPlaceholderData ? "is-refreshing" : ""}`}>
          <header className="card-header">
            <div>
              <h2 className="card-title">
                {held ? heldCountLabel(data.total) : `Разобрано вручную: ${data.total}`}
              </h2>
              <p className="card-description">
                {held
                  ? "Сверху те, что ждут дольше всех. Время ваше местное, как в чате."
                  : "Журнал разборов: сверху последние. Каждый разбор записан и в журнале аудита Hub."}
              </p>
            </div>
          </header>
          {empty ? (
            <div className="empty">
              <p className="empty-text">На этой странице списка записей нет.</p>
              <div className="empty-actions"><button type="button" className="btn btn-sm" onClick={() => show({})}>К началу списка</button></div>
            </div>
          ) : (
            <div className="table-wrap">
              {held ? (
                <HeldTable rows={heldRows} backTo={backTo} onResolve={(item) => { setFailure(null); setResolving({ item, serverNow: data.serverNow }); }} />
              ) : (
                <ResolvedTable rows={resolvedRows} backTo={backTo} />
              )}
            </div>
          )}
          <Pagination
            offset={view.offset}
            limit={HELD_SENDS_PAGE_SIZE}
            total={data.total}
            onPageChange={(offset) => show({ offset })}
            emptyLabel="0 отправок"
            formatRange={(start, end, total) => `${start}–${end} из ${total}`}
          />
        </section>
      )}

      {help}

      {resolving !== null && (
        <ResolveSendDialog
          key={resolving.item.attemptId}
          item={resolving.item}
          serverNow={resolving.serverNow}
          isPending={resolve.isPending}
          failure={failure}
          onSubmit={submit}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
