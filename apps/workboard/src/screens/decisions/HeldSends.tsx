import { useId, useState } from "react";
import { Button, Disclosure, Fan, Field, Modal, Notice, Textarea, TextInput, TimeMsk, Tooltip, platformWord as pagePlatformWord, toast } from "@agency_hub_core/ui";
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
import { consoleFanHref } from "@/shared/links";
import { useResolveHeldSend, type HeldSend, type KnownFan } from "./data";
import "./decisions.css";

/**
 * Зависшие отправки: a send from the extension's preview whose outcome Hub
 * never learned; until someone looks at the chat and records it, Hub holds the
 * fan. The resolve is the console's (ClientHeldSendsPage.tsx:203-370): no answer
 * preselected, «why» required, a message id only with «ушло», the audit trail —
 * with words for the page's own platform (most held sends are Fansly's).
 */

/** «nova-1 · Fansly»: the send's page, in the window's summary. */
function pageWords(pageLabel: string, platform: string | null | undefined): string {
  const word = pagePlatformWord(platform);
  return word ? `${pageLabel} · ${word}` : pageLabel;
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
    { label: "Кто отправлял", value: <Tooltip content={`Установка расширения ${shortId(item.instanceId)}`}><span>{item.username}</span></Tooltip> },
    { label: "Когда, по Москве", value: <><TimeMsk at={item.createdAt} /> · без отчёта {formatSpan(Date.parse(serverNow) - heldSince(item))}</> },
    ...(greeting !== null ? [{ label: GREETED_HEADER, value: greeting.hint === null ? greeting.text : <Tooltip content={greeting.hint}><span>{greeting.text}</span></Tooltip> }] : []),
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
        // The focus starts on the window's words, not on an answer (Р-н7): a stray Space must not pick «ушло».
        tabIndex={-1}
        data-autofocus={gone ? undefined : true}
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
              placeholder={`например: посмотрел чат, сообщение от ${formatTimeOfDay(item.createdAt)} на месте`}
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
