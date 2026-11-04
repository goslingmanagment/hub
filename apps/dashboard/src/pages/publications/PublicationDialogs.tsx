import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { PublicationQueueSnapshotWire, PublicationWire, PublicationWithdrawResult } from "@agency_hub_core/contracts";
import { useResolvePublication } from "@/api/publications";
import { ConfirmModal, type ConfirmFact } from "@/components/shared/ConfirmModal";
import { ModalShell } from "@/components/shared/ModalShell";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { Spinner } from "@/components/ui/Skeleton";
import { buildProfileUrl } from "@/lib/platformUrls";
import {
  DELETE_POST_CONFIRM_TEXT,
  EMPTY_RESOLVE_DRAFT,
  KIND_LABELS,
  WITHDRAW_MIN_LEAD_MINUTES,
  actionFailure,
  actionFailureReason,
  audienceLabel,
  cancelLabel,
  mediaSummary,
  momentLabel,
  placeLabel,
  platformName,
  priceLabel,
  resolveForm,
  textStart,
  timeOf,
  whatLabel,
  withdrawConfirmText,
  withdrawResultText,
  type ApprovalRefusal,
  type ApprovalSummary,
  type PagePublishing,
  type ResolveDraft,
} from "./publicationsView.js";

/** Where a page lives, from the catalog: the place a write lands, named from the object. */
export interface PagePlace {
  modelName: string | null;
  username: string | null;
}

// ── A. Approve one post ─────────────────────────────────────────────────────

export function ApproveOneDialog({ publication, place, page, ofapiOn, todayKey, isPending, onConfirm, onClose }: {
  /** The row as it was when the window opened: its id and version go. */
  publication: PublicationWire;
  place: PagePlace | undefined;
  page: PagePublishing | undefined;
  ofapiOn: boolean;
  todayKey: string;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const facts: ConfirmFact[] = [
    { label: "Куда", value: placeLabel(publication.pageLabel, publication.platform, place?.modelName) },
    { label: "Что именно", value: whatLabel(publication) },
    ...(publication.priceMills !== null ? [{ label: "Цена", value: priceLabel(publication.priceMills) }] : []),
    { label: "Когда", value: momentLabel(publication.publishAt, todayKey) },
    { label: "Кто увидит", value: audienceLabel(publication) },
    ...(publication.platform === "onlyfans" && ofapiOn ? [{ label: "Сколько стоит", value: "1 кредит за пост, загрузка новых файлов около 3 кредитов за МБ" }] : []),
    { label: "Отменить", value: cancelLabel([publication.kind]) },
    ...(page?.notPublishing ? [{ label: "Страница сейчас", value: `${page.badge.word}: пост не выйдет, пока её не включат` }] : []),
  ];
  return (
    <ConfirmModal
      title={`Утвердить пост на ${publication.pageLabel}?`}
      message={publication.kind === "vault_album" ? "Hub сам соберёт альбом в медиатеке страницы." : "Пост выйдет сам в указанное время."}
      facts={facts}
      confirmLabel="Утвердить пост"
      pendingLabel="Утверждаем…"
      tone="primary"
      isPending={isPending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

// ── B. Approve the selection ────────────────────────────────────────────────

export function ApproveManyDialog({ summary, ofapiOnPages, isPending, onConfirm, onClose }: {
  /** Built from the ticked rows when the window opened: never from the filter. */
  summary: ApprovalSummary;
  /** OnlyFans pages among them while its API is on: their posts spend credits. */
  ofapiOnPages: boolean;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const facts: ConfirmFact[] = [
    { label: "Куда", value: summary.places },
    { label: "Что именно", value: summary.kinds },
    { label: "Когда", value: summary.when },
    { label: "Кто увидит", value: summary.audience },
    ...(ofapiOnPages ? [{ label: "Сколько стоит", value: "1 кредит за пост OnlyFans, загрузка новых файлов около 3 кредитов за МБ" }] : []),
    { label: "Отменить", value: summary.cancel },
    ...(summary.notNow !== null ? [{ label: "Не выйдут сейчас", value: summary.notNow }] : []),
  ];
  return (
    <ConfirmModal
      title={summary.title}
      message="Посты выйдут сами в указанное время."
      facts={facts}
      confirmLabel={summary.confirmLabel}
      pendingLabel="Утверждаем…"
      tone="primary"
      isPending={isPending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

// ── C. Cancel ───────────────────────────────────────────────────────────────

export function CancelDialog({ publication, place, todayKey, isPending, onConfirm, onClose }: {
  publication: PublicationWire;
  place: PagePlace | undefined;
  todayKey: string;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmModal
      title="Отменить публикацию?"
      message="Пост не уйдёт на площадку. Вернуть отменённую нельзя, понадобится новый черновик."
      facts={[
        { label: "Куда", value: placeLabel(publication.pageLabel, publication.platform, place?.modelName) },
        { label: "Что именно", value: whatLabel(publication) },
        { label: "Когда", value: momentLabel(publication.publishAt, todayKey) },
        { label: "Отменить", value: "Нельзя" },
      ]}
      confirmLabel="Отменить публикацию"
      pendingLabel="Отменяем…"
      cancelLabel="Не отменять"
      initialFocus="cancel"
      isPending={isPending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

// ── D. Withdraw from the schedule ──────────────────────────────────────────

export function WithdrawDialog({ publication, place, todayKey, isPending, onConfirm, onClose }: {
  publication: PublicationWire;
  place: PagePlace | undefined;
  todayKey: string;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmModal
      title={`Убрать пост из расписания ${platformName(publication.platform)}?`}
      message="Пост не выйдет."
      facts={[
        { label: "Откуда", value: placeLabel(publication.pageLabel, publication.platform, place?.modelName) },
        { label: "Что именно", value: whatLabel(publication) },
        { label: "Должен был выйти", value: momentLabel(publication.publishAt, todayKey) },
        { label: "Отменить", value: "Нельзя: вернуть можно только заменой и новым утверждением" },
      ]}
      details={<p>{withdrawConfirmText(publication.platform)}</p>}
      confirmLabel="Убрать из расписания"
      pendingLabel="Убираем…"
      cancelLabel="Не убирать"
      initialFocus="cancel"
      isPending={isPending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

// ── E. Delete from the wall ─────────────────────────────────────────────────

export function DeletePostDialog({ publication, place, todayKey, isPending, onConfirm, onClose }: {
  publication: PublicationWire;
  place: PagePlace | undefined;
  todayKey: string;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const text = publication.text.trim() === "" ? KIND_LABELS[publication.kind] : `«${textStart(publication.text, 48)}»`;
  return (
    <ConfirmModal
      title={`Удалить пост со стены ${publication.pageLabel}?`}
      message={`${text}, вышел ${momentLabel(publication.publishAt, todayKey)}.`}
      facts={[
        { label: "Откуда", value: placeLabel(publication.pageLabel, publication.platform, place?.modelName) },
        { label: "Отменить", value: "Нельзя: пост исчезнет со стены" },
      ]}
      details={(
        <>
          <p>{DELETE_POST_CONFIRM_TEXT}</p>
          {publication.platformPostRef !== null && <p className="mt-2">Номер поста: <span className="tabular-nums">{publication.platformPostRef}</span></p>}
        </>
      )}
      confirmLabel="Удалить со стены"
      pendingLabel="Удаляем…"
      cancelLabel="Не удалять"
      initialFocus="cancel"
      isPending={isPending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

// ── F. Withdraw everything Hub put on a page ────────────────────────────────

export function WithdrawPageDialog({ pageLabel, platform, place, queue, isPending, onConfirm, onClose }: {
  /** The strip's item: the page this acts on. */
  pageLabel: string;
  platform: string;
  place: PagePlace | undefined;
  /** The read when the window opened. */
  queue: PublicationQueueSnapshotWire | undefined;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const manual = queue?.entries.filter((entry) => entry.publicationId === null).length ?? 0;
  const hub = (queue?.entries.length ?? 0) - manual;
  const read = queue?.readAt ? `Постов Hub по чтению в ${timeOf(queue.readAt)}: ${hub}` : "Расписание ещё не читалось";
  return (
    <ConfirmModal
      title={`Убрать из расписания всё, что Hub поставил на ${pageLabel}?`}
      message={`Каждый пост Hub в расписании ${platformName(platform)} этой страницы — отдельной командой со своим исходом.`}
      facts={[
        { label: "Откуда", value: placeLabel(pageLabel, platform, place?.modelName) },
        { label: "Что именно", value: read },
        { label: "Что останется", value: `Поставленные вручную: ${manual}. Посты, до выхода которых меньше ${WITHDRAW_MIN_LEAD_MINUTES} минут` },
        { label: "Отменить", value: "Нельзя: вернуть можно только заменой и новым утверждением" },
      ]}
      confirmLabel={`Убрать всё из расписания ${pageLabel}`}
      pendingLabel="Убираем…"
      cancelLabel="Не убирать"
      initialFocus="cancel"
      isPending={isPending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

// ── G. Read OnlyFans' schedule now (paid) ───────────────────────────────────

export function RefreshOnlyfansDialog({ pageLabel, isPending, onConfirm, onClose }: {
  pageLabel: string;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmModal
      title={`Прочитать расписание ${pageLabel} сейчас?`}
      message="Чтение тратит кредиты OnlyFans API."
      confirmLabel="Прочитать расписание"
      pendingLabel="Запрашиваем…"
      tone="primary"
      isPending={isPending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

// ── «Ушёл ли пост?» (spec §4) ───────────────────────────────────────────────

/**
 * «Исход неизвестен» (spec §8.2): Hub sent the request and lost the answer, so
 * it does not know whether the post went out, and never sends it again by
 * itself. A person looks at the wall and the platform's schedule and says.
 */
export function ResolveDialog({ publication, username, todayKey, onClose }: {
  publication: PublicationWire;
  username: string | null;
  todayKey: string;
  onClose: () => void;
}) {
  const resolve = useResolvePublication();
  const [draft, setDraft] = useState<ResolveDraft>(EMPTY_RESOLVE_DRAFT);
  const [failure, setFailure] = useState<string | null>(null);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const outcomeName = useId();
  const stateName = useId();
  const refId = useId();
  const form = resolveForm(draft);
  const closeUnlessPending = () => { if (!resolve.isPending) onClose(); };
  const wall = buildProfileUrl(publication.platform, username);

  function submit() {
    if (form.body === null || resolve.isPending) return;
    setFailure(null);
    resolve.mutate({ id: publication.id, body: form.body }, {
      onSuccess: (result) => {
        toast.success(result.replacement === null
          ? "Записано: пост ушёл"
          : "Записано: пост не ушёл. Новый черновик ждёт утверждения");
        onClose();
      },
      onError: (error) => { setFailure(actionFailure(error)); setFailureReason(actionFailureReason(error)); },
    });
  }

  const choices = [
    ["went_out", "Пост ушёл", "Укажите его номер на площадке и где он: в расписании или уже на стене."],
    ["did_not_go_out", "Пост не ушёл", "Hub отметит «Не вышел» и создаст новый черновик со ссылкой на этот. Его нужно будет утвердить заново."],
  ] as const;

  return (
    <ModalShell title="Ушёл ли пост?" onClose={closeUnlessPending} size="short">
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <p className="dialog-text">
          Hub отправил пост на площадку, но ответа не получил. Сам он отправку не повторит. Откройте стену и расписание
          страницы на площадке и найдите этот пост около указанного времени.
        </p>
        <dl className="confirm-facts">
          <dt>Страница</dt><dd>{publication.pageLabel}, {platformName(publication.platform)}</dd>
          <dt>Выход</dt><dd>{momentLabel(publication.publishAt, todayKey)}</dd>
          <dt>Пост</dt><dd>{KIND_LABELS[publication.kind]}: {textStart(publication.text, 80)}</dd>
          <dt>Файлы</dt><dd>{mediaSummary(publication.media).replace(/^б/, "Б")}</dd>
        </dl>
        {wall !== null && (
          <p className="pub-dialog-link">
            <a className="link" href={wall} target="_blank" rel="noopener noreferrer">Открыть стену {publication.pageLabel}</a>
          </p>
        )}

        <fieldset disabled={resolve.isPending} className="pub-choices">
          <legend className="field-label">Что вы увидели на площадке</legend>
          {choices.map(([value, title, hint]) => (
            <label key={value} className={`pub-choice ${draft.outcome === value ? "is-picked" : ""}`.trim()}>
              <input
                type="radio"
                name={outcomeName}
                checked={draft.outcome === value}
                onChange={() => setDraft((current) => ({ ...current, outcome: value }))}
              />
              <span>
                <span className="pub-choice-title">{title}</span>
                <span className="pub-choice-hint">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {draft.outcome === "went_out" && (
          <div className="pub-form-block">
            <div>
              <label htmlFor={refId} className="field-label">Номер поста на площадке</label>
              <input
                id={refId}
                className={`input tabular-nums ${form.postRefError !== null ? "input-invalid" : ""}`.trim()}
                value={draft.postRef}
                autoComplete="off"
                maxLength={64}
                disabled={resolve.isPending}
                aria-invalid={form.postRefError !== null}
                onChange={(event) => setDraft((current) => ({ ...current, postRef: event.target.value }))}
              />
              {form.postRefError !== null && <p role="alert" className="field-error">{form.postRefError}</p>}
            </div>
            <fieldset disabled={resolve.isPending} className="pub-inline-radios">
              <legend className="field-label">Где он сейчас</legend>
              {([["scheduled", "Стоит в расписании"], ["published", "Уже на стене"]] as const).map(([value, title]) => (
                <label key={value} className="pub-inline-radio">
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
          <Notice tone="warning" className="pub-form-block">
            Проверьте и стену, и расписание, прежде чем записать «не ушёл»: если пост всё-таки там, новый черновик после
            утверждения выложит его второй раз.
          </Notice>
        )}

        {failure !== null && <Notice tone="danger" role="alert" className="pub-form-block" detail={failureReason !== null ? <Disclosure label="Подробнее"><p>{failureReason}</p></Disclosure> : undefined}>{failure}</Notice>}

        <div className="dialog-actions pub-dialog-actions">
          {form.missing !== null && <span className="pub-dialog-missing">{form.missing}</span>}
          <button type="button" className="btn" disabled={resolve.isPending} onClick={closeUnlessPending}>Отмена</button>
          <button
            type="submit"
            className={draft.outcome === "did_not_go_out" ? "btn btn-danger" : "btn btn-primary"}
            disabled={form.body === null || resolve.isPending}
          >
            {resolve.isPending && <Spinner />}
            {resolve.isPending ? "Записываем…"
              : draft.outcome === "did_not_go_out" ? "Записать: не ушёл"
                : "Записать: ушёл"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ── Reports (block 5) ───────────────────────────────────────────────────────

/** A report scrolls itself into view: the button that made it may be far away. */
function useScrollIntoView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  return ref;
}

function ReportBox({ tone, children }: { tone: "warning" | "info"; children: ReactNode }) {
  const ref = useScrollIntoView<HTMLDivElement>();
  return <div ref={ref} role="status" className="pub-report"><Notice tone={tone}>{children}</Notice></div>;
}

/** What an approval with refusals did: how many went through, and every refusal with its reason. */
export function ApprovalReport({ report, onClose }: { report: { approved: number; refused: ApprovalRefusal[] }; onClose: () => void }) {
  return (
    <ReportBox tone="warning">
      <div className="pub-report-head">
        <b>Утверждено: {report.approved}. Не утверждено: {report.refused.length}.</b>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Скрыть</button>
      </div>
      <ul className="pub-report-list">
        {report.refused.map((item) => (
          <li key={item.id}>
            {item.title} — {item.reason}
            {item.findings.length > 0 && <>: {item.findings.join("; ")}</>}
          </li>
        ))}
      </ul>
    </ReportBox>
  );
}

/** Each withdrawal's own outcome: one command per post. */
export function WithdrawReport({ report, todayKey, onClose }: {
  report: { pageLabel: string; platform: string; results: PublicationWithdrawResult[] };
  todayKey: string;
  onClose: () => void;
}) {
  return (
    <ReportBox tone="info">
      <div className="pub-report-head">
        <b>Убрать из расписания: {report.pageLabel}, {platformName(report.platform)}</b>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Закрыть</button>
      </div>
      {report.results.length === 0 ? <p className="pub-report-list">Hub не ставил на эту страницу постов, которые можно убрать.</p> : (
        <ul className="pub-report-list">
          {report.results.map((result) => (
            <li key={result.id}>
              {result.publication === null ? "пост"
                : `${result.publication.pageLabel}, ${momentLabel(result.publication.publishAt, todayKey)}, ${textStart(result.publication.text, 40)}`}
              {" — "}{withdrawResultText(result)}
            </li>
          ))}
        </ul>
      )}
    </ReportBox>
  );
}
