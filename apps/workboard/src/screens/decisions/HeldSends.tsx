import { useId, useState } from "react";
import { Button, Disclosure, ErrorState, Fan, Field, Hint, Modal, Notice, Section, Table, Textarea, TextInput, TimeMsk, toast, type Column } from "@agency_hub_core/ui";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import {
  EMPTY_RESOLVE_DRAFT,
  NOT_SENT_OUTCOME_HINT,
  RESOLVE_NOTE_MAX,
  formatSpan,
  greetingCell,
  heldSince,
  messageIdLabel,
  notSentWarning,
  outcomeLabel,
  partLabel,
  platformWord,
  purposeLabel,
  resolveFailure,
  resolveForm,
  sentOutcomeHint,
  shortId,
  type ResolveDraft,
  type ResolveFailure,
} from "@agency_hub_core/ui/heldSends";
import { consoleFanHref, PersonLink } from "@/shared/links";
import { FanCell, collidingIn, goColumn, pageWords } from "./FanCell";
import { RESOLVED_PAGE_SIZE, useResolveHeldSend, useResolvedSends, type FanRefOnPage, type HeldSend, type KnownFan } from "./data";

/**
 * Зависшие отправки: a send from the extension's preview whose outcome Hub
 * never learned; until someone looks at the chat and records it, Hub holds the
 * fan. The resolve is the console's (ClientHeldSendsPage.tsx:203-370): no answer
 * preselected, «why» required, a message id only with «ушло», the audit trail —
 * with words for the page's own platform (most held sends are Fansly's).
 */

function What({ item }: { item: HeldSend }) {
  return <span>{purposeLabel(item.purpose)}<span className="decisions-sub decisions-nowrap">{partLabel(item)}</span></span>;
}

/**
 * Is the fan's greeting already on record (Р8): «Ещё нет», «Да», «Да, вручную»
 * — the last is the case not to misread (this very part went out by hand);
 * how and when, on hover. Null: the send is not a greeting.
 */
function greeted(item: HeldSend): { text: string; hint: string | null } | null {
  const cell = greetingCell(item);
  if (cell === null) return null;
  if (cell.sentByHand) return { text: "Да, вручную", hint: cell.hint };
  if (cell.label === "Нет") return { text: "Ещё нет", hint: null };
  return { text: "Да", hint: cell.hint };
}

const GREETED_HEADER = "Уже поприветствован?";

function Greeted({ item, focusable }: { item: HeldSend; focusable: boolean }) {
  const words = greeted(item);
  if (words === null) return <Hint content="Это не приветствие: про приветствие фана отправка ничего не говорит" focusable={focusable}><span className="text-ink-3">—</span></Hint>;
  return words.hint === null ? <span>{words.text}</span> : <Hint content={words.hint} focusable={focusable}>{words.text}</Hint>;
}

export function HeldSection({ items, total, serverNow, platformOf, fanOf, onOpen, selected }: {
  selected: string | null;
  items: readonly HeldSend[];
  total: number;
  serverNow: string;
  platformOf: (pageLabel: string) => string | undefined;
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined;
  onOpen: (attemptId: string) => void;
}) {
  const now = Date.parse(serverNow);
  const collides = collidingIn(items, fanOf);
  const columns: Column<HeldSend>[] = [
    { key: "fan", header: "Фан", width: 210, cell: (row) => <FanCell fan={fanOf(row)} fanRef={row.fanRef} pageLabel={row.pageLabel} platform={platformOf(row.pageLabel)} showLogin={collides(row)} /> },
    { key: "what", header: "Что отправляли", headerWrap: false, cell: (row) => <What item={row} /> },
    { key: "who", header: "Кто отправлял", headerWrap: false, width: 180, cell: (row) => <PersonLink userId={row.userId} name={row.username} backLabel="Решения" /> },
    {
      key: "when",
      header: "Когда",
      width: 200,
      nowrap: true,
      sortValue: (row) => row.createdAt,
      cell: (row) => <span><TimeMsk at={row.createdAt} /><span className="decisions-sub">без отчёта {formatSpan(now - heldSince(row))}</span></span>,
    },
    { key: "greeting", header: GREETED_HEADER, headerWrap: false, width: 200, cell: (row) => <Greeted item={row} focusable={false} /> },
    goColumn<HeldSend>(),
  ];
  return (
    <Section
      id="held"
      className="decisions-section"
      title={<>Зависшие отправки <span className="decisions-count">{total}</span></>}
      description="Расширение отправило сообщение и не сообщило, ушло ли оно. Пока отправку не разберут, Hub держит фана: из превью ему не отправят, нового подписчика не поприветствуют."
    >
      <Table label="Зависшие отправки" columns={columns} rows={items} rowKey={(row) => row.attemptId} onRowClick={(row) => onOpen(row.attemptId)} selectedKey={selected} />
      {total > items.length && <p className="decisions-note">Показаны {items.length} из {total}: сверху те, что ждут дольше всех.</p>}
    </Section>
  );
}

/** The journal of resolves, folded: who, when, what they saw, why. Every resolve is also in Hub's audit. */
export function ResolvedJournal({ page, platformOf, fanOf }: {
  page: string | null;
  platformOf: (pageLabel: string) => string | undefined;
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined;
}) {
  const [offset, setOffset] = useState(0);
  const resolved = useResolvedSends({ offset, ...(page ? { pageLabel: page } : {}) });
  const data = resolved.data;
  const rows = (data?.items ?? []).filter((item) => item.resolution !== null);
  const collides = collidingIn(rows, fanOf);
  if (!data) {
    return resolved.isError
      ? <ErrorState compact onRetry={() => void resolved.refetch()} retrying={resolved.isFetching} title="Журнал разборов не пришёл" />
      : null;
  }
  if (data.total === 0) return null;
  const columns: Column<HeldSend>[] = [
    { key: "fan", header: "Фан", width: 240, cell: (row) => <FanCell fan={fanOf(row)} fanRef={row.fanRef} pageLabel={row.pageLabel} platform={platformOf(row.pageLabel)} showLogin={collides(row)} /> },
    { key: "what", header: "Что отправляли", headerWrap: false, width: 220, cell: (row) => <span>{purposeLabel(row.purpose)}<span className="decisions-sub">{row.username}, <TimeMsk at={row.createdAt} /></span></span> },
    {
      key: "outcome",
      header: "Итог",
      width: 200,
      cell: (row) => {
        if (row.resolution === null) return "—";
        const label = outcomeLabel(row.resolution.outcome);
        // The message's number is for the audit, not for reading (Р8): on hover.
        return row.resolution.platformMessageId === null ? label : <Hint content={`ID сообщения ${row.resolution.platformMessageId}`}>{label}</Hint>;
      },
    },
    {
      key: "by",
      header: "Кто разобрал",
      headerWrap: false,
      width: 190,
      nowrap: true,
      cell: (row) => row.resolution === null ? "—" : <span>{row.resolution.username}<span className="decisions-sub"><TimeMsk at={row.resolution.at} /></span></span>,
    },
    { key: "why", header: "Почему так решили", cell: (row) => <span className="decisions-text">{row.resolution?.note ?? "—"}</span> },
  ];
  const pages = Math.ceil(data.total / RESOLVED_PAGE_SIZE);
  const at = Math.floor(offset / RESOLVED_PAGE_SIZE) + 1;
  return (
    <Disclosure size="md" className="decisions-fold" summary="Разобранные отправки" hint={String(data.total)}>
      <p className="decisions-note">Сверху последние. Каждый разбор записан и в журнале аудита Hub.</p>
      <Table
        label="Разобранные отправки"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.attemptId}
        refreshing={resolved.isPlaceholderData}
        empty={<p className="decisions-note">На этой странице списка записей нет.</p>}
      />
      {pages > 1 && (
        <div className="decisions-pager">
          <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - RESOLVED_PAGE_SIZE))}>Назад</Button>
          <span>{at} из {pages}</span>
          <Button size="sm" disabled={at >= pages} onClick={() => setOffset(offset + RESOLVED_PAGE_SIZE)}>Дальше</Button>
        </div>
      )}
    </Disclosure>
  );
}

/**
 * The resolve of one held send. Two answers and neither is preselected:
 * «ушло» records a greeting for good, «не ушло» lets the fan be written to
 * again. The window cannot be closed while Hub records, nor by a stray click
 * once something is typed. It fits a 900 px screen with its buttons (Р1): the
 * send in two columns, one sentence of what to do, the answers side by side.
 */
export function ResolveSendModal({ item, serverNow, platform, fan, onClose }: {
  item: HeldSend;
  serverNow: string;
  platform: string | undefined;
  fan: KnownFan | undefined;
  onClose: () => void;
}) {
  const resolve = useResolveHeldSend();
  const [draft, setDraft] = useState<ResolveDraft>(EMPTY_RESOLVE_DRAFT);
  const [failure, setFailure] = useState<ResolveFailure | null>(null);
  const outcomeName = useId();
  const form = resolveForm(draft);
  const greeting = greeted(item);
  const gone = failure?.gone === true;
  const pending = resolve.isPending;
  const dirty = draft.outcome !== null || draft.note.trim() !== "" || draft.platformMessageId.trim() !== "";
  const close = () => {
    if (pending) return;
    resolve.reset();
    onClose();
  };
  const submit = () => {
    if (form.body === null || pending || gone) return;
    setFailure(null);
    resolve.mutate({ pageLabel: item.pageLabel, attemptId: item.attemptId, body: form.body }, {
      onSuccess: () => {
        toast.success(form.body?.outcome === "sent" ? "Записано: сообщение ушло" : "Записано: сообщение не ушло");
        resolve.reset();
        onClose();
      },
      onError: (error) => setFailure(resolveFailure(error, draft)),
    });
  };
  const word = platformWord(platform);
  const summary = [
    { label: "Страница", value: pageWords(item.pageLabel, platform) },
    {
      label: "Фан",
      value: <Fan name={fan?.name ?? null} username={fan?.username ?? null} fanRef={item.fanRef} {...(platform ? { href: consoleFanHref(item.pageLabel, platform, item.fanRef) } : {})} />,
    },
    { label: "Что отправляли", value: `${purposeLabel(item.purpose)}, ${partLabel(item)}` },
    // The extension's install is for telling two installs of one person apart: on hover (Р8).
    { label: "Кто отправлял", value: <Hint content={`Установка расширения ${shortId(item.instanceId)}`}>{item.username}</Hint> },
    { label: "Когда, по Москве", value: <><TimeMsk at={item.createdAt} /> · без отчёта {formatSpan(Date.parse(serverNow) - heldSince(item))}</> },
    ...(greeting !== null ? [{ label: GREETED_HEADER, value: greeting.hint === null ? greeting.text : <Hint content={greeting.hint}>{greeting.text}</Hint> }] : []),
  ];

  return (
    <Modal
      title="Разобрать отправку"
      onClose={close}
      size="wide"
      explicitCloseOnly={pending || dirty}
      actions={(
        <>
          {!gone && form.missing !== null && <span className="decisions-missing">{form.missing}</span>}
          <Button data-autofocus={gone || undefined} disabled={pending} onClick={close}>{gone ? "Закрыть" : "Отмена"}</Button>
          {!gone && (
            <Button
              variant={draft.outcome === "not_sent" ? "danger" : "primary"}
              disabled={form.body === null}
              loading={pending}
              onClick={submit}
            >
              {pending ? "Записываем…"
                : draft.outcome === "sent" ? "Записать: сообщение ушло"
                : draft.outcome === "not_sent" ? "Записать: сообщение не ушло"
                : "Записать"}
            </Button>
          )}
        </>
      )}
    >
      <form
        className="decisions-resolve"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <dl className="decisions-summary">
          {summary.map((one) => (
            <div key={one.label} className="decisions-summary__item">
              <dt>{one.label}</dt>
              <dd>{one.value}</dd>
            </div>
          ))}
        </dl>

        {/* One sentence of what to do (Р1); the text itself only the sender knows — Hub never had it. */}
        <p className="decisions-intro">
          Откройте чат с фаном {word ? `на ${word}` : "там, где вы работаете с этой страницей"} и найдите сообщение
          около {formatTimeOfDay(item.createdAt)}. Текст знает {item.username}.
        </p>

        <fieldset disabled={pending || gone} className="decisions-choices decisions-choices--pair">
          <legend>Что вы увидели в чате</legend>
          {([
            ["sent", "Сообщение ушло", sentOutcomeHint(item)],
            ["not_sent", "Сообщение не ушло", NOT_SENT_OUTCOME_HINT],
          ] as const).map(([value, title, hint]) => (
            <label key={value} className="decisions-choice" data-picked={draft.outcome === value || undefined}>
              <input
                type="radio"
                name={outcomeName}
                value={value}
                checked={draft.outcome === value}
                onChange={() => setDraft((current) => ({ ...current, outcome: value }))}
              />
              <span>
                <span className="decisions-choice__title">{title}</span>
                <span className="decisions-choice__hint">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {draft.outcome === "not_sent" && (
          <Notice tone="warning" title="Проверьте, прежде чем записать «не ушло»">
            {notSentWarning(item, platform).map((line) => <p key={line} className="decisions-warning-line">{line}</p>)}
          </Notice>
        )}

        {draft.outcome === "sent" && (
          <Field label={messageIdLabel(platform)} error={form.platformMessageIdError ?? undefined}>
            {(control) => (
              <TextInput
                {...control}
                value={draft.platformMessageId}
                inputMode="numeric"
                autoComplete="off"
                maxLength={40}
                disabled={pending || gone}
                onChange={(event) => setDraft((current) => ({ ...current, platformMessageId: event.target.value }))}
                className="decisions-mono"
              />
            )}
          </Field>
        )}

        <Field
          label="Почему вы так решили (обязательно)"
          hint={form.noteLeft < 0 ? undefined : `Заметка сохранится в журнале разборов вместе с вашим именем. До ${RESOLVE_NOTE_MAX} знаков, осталось ${form.noteLeft}.`}
          error={form.noteLeft < 0 ? `Заметка длиннее ${RESOLVE_NOTE_MAX} знаков: сократите на ${-form.noteLeft}.` : undefined}
        >
          {(control) => (
            <Textarea
              {...control}
              value={draft.note}
              rows={2}
              disabled={pending || gone}
              onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
              placeholder="например: посмотрел чат, сообщение от 14:02 на месте"
            />
          )}
        </Field>

        {failure !== null && <Notice tone="danger" role="alert">{failure.message}</Notice>}

        <Disclosure summary="Для журнала: попытка и генерация">
          <p className="decisions-mono">Попытка {item.attemptId} · генерация {item.generationRef}</p>
        </Disclosure>
      </form>
    </Modal>
  );
}
