import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { ConfigItem, PublicationQueueSnapshotWire } from "@agency_hub_core/contracts";
import { useRereadPublications, useUpdatePublicationSettings } from "@/api/publications";
import { ConfirmModal, type ConfirmFact } from "@/components/shared/ConfirmModal";
import { ModalShell } from "@/components/shared/ModalShell";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { Notice } from "@/components/ui/Notice";
import { Skeleton, Spinner } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Switch } from "@/components/ui/Switch";
import { formatCount, formatDayRange } from "@/lib/format";
import { buildPageSectionRoute } from "@/lib/navigation";
import { OFAPI_OFF_REASON, OFAPI_OFF_WORD } from "@/lib/statusWords";
import { captureConfigSnapshot, seedValue, useBooleanConfigToggle } from "@/pages/settings/ConfigurationEditors";
import {
  actionFailure,
  autostopReasonLabel,
  dayKeyOf,
  isStopped,
  momentLabel,
  pageLimitsLine,
  placeLabel,
  platformName,
  queueIncompleteReasons,
  queueIncompleteText,
  queueReadLine,
  repostLine,
  settingsDraftFrom,
  settingsForm,
  type PagePublishing,
  type PublicationPageSettings,
  type SettingsDraft,
} from "./publicationsView.js";

// ── the switches (block 1) ──────────────────────────────────────────────────

interface SwitchQuestion {
  title: string;
  message: string;
  facts: ConfirmFact[];
  confirmLabel: string;
}

/**
 * A config switch on its business screen: the logic of «Все параметры»
 * (`useBooleanConfigToggle`: the snapshot, the stale check, the same body), with
 * the question in a window in front of the unchanged call.
 */
function ConfigSwitchRow({ item, title, hint, words, off, question }: {
  item: ConfigItem;
  title: string;
  hint: string;
  words: [on: string, off: string];
  /** The switch cannot be used now, and why. */
  off?: { word: string; reason: string } | undefined;
  question: (target: boolean) => SwitchQuestion;
}) {
  const toggle = useBooleanConfigToggle(item);
  const reread = useRereadPublications();
  const [asking, setAsking] = useState<boolean | null>(null);
  const status = toggle.mutations.update.status;
  const conflict = toggle.conflict;

  // The strip reads the new value at once: a read, not a write.
  useEffect(() => {
    if (status === "success") void reread();
  }, [status, reread]);
  useEffect(() => {
    if (asking === null) return;
    if (status === "success" || (status === "error" && conflict) || (toggle.staleConfirmation && status !== "pending")) setAsking(null);
  }, [asking, status, conflict, toggle.staleConfirmation]);

  function open() {
    if (toggle.pending || toggle.needsReview || off) return;
    const target = !toggle.current;
    toggle.setConfirm({ action: "save", target, snapshot: captureConfigSnapshot(item) });
    setAsking(target);
  }

  function close() {
    if (toggle.mutations.pending) return;
    setAsking(null);
    toggle.reset();
  }

  const shownError = status === "error" && !conflict ? "Не удалось сохранить: Hub не ответил или отказал. Настройка осталась прежней." : undefined;
  const ask = asking === null ? null : question(asking);
  const word = off ? off.word : toggle.current ? words[0] : words[1];

  return (
    <div className="pub-switch">
      <div className="switch-row">
        <div className="switch-text">
          <span className="pub-switch-title">{title}</span>
          <small>{hint}</small>
          {off && <small className="pub-switch-off">{off.reason}</small>}
        </div>
        <div className="switch-control">
          {word}
          <Switch
            checked={off ? false : toggle.current}
            label={title}
            disabled={off !== undefined || toggle.pending || toggle.needsReview}
            title={off?.reason}
            onChange={open}
          />
        </div>
      </div>
      {(toggle.mutations.pending || toggle.receipt.waiting) && <p className="pub-switch-status" role="status">Сохраняем…</p>}
      {!toggle.mutations.pending && !toggle.receipt.waiting && item.pendingApply && (
        <p className="pub-switch-status" role="status">Сохранено. Ждём, пока настройку подхватят все части Hub — обычно до минуты.</p>
      )}
      {toggle.needsReview && asking === null && (
        <Notice
          tone="warning"
          role="alert"
          detail={`Сохранено на сервере: ${toggle.current ? words[0] : words[1]}.`}
          action={<button type="button" className="btn btn-sm" onClick={toggle.reset}>Продолжить с текущей настройкой</button>}
        >
          Пока вы выбирали действие, настройку изменили. Проверьте значения перед повторной попыткой.
        </Notice>
      )}
      {ask !== null && (
        <ConfirmModal
          title={ask.title}
          message={ask.message}
          facts={ask.facts}
          confirmLabel={ask.confirmLabel}
          pendingLabel="Сохраняем…"
          tone="primary"
          error={shownError}
          isPending={toggle.mutations.pending}
          onConfirm={toggle.toggle}
          onClose={close}
        />
      )}
    </div>
  );
}

// ── a page's dialog «Публикация на mia-1» and window I ──────────────────────

/** One page's publishing: the switch, the paid price range in dollars, the repeat threshold and the daily limit. */
export function SettingsDialog({ settings, globalEnabled, modelName, ofapiOff, onClose }: {
  /** The page's row as it was when the window opened: the write's target. */
  settings: PublicationPageSettings;
  globalEnabled: boolean;
  modelName: string | null;
  ofapiOff: boolean;
  onClose: () => void;
}) {
  const update = useUpdatePublicationSettings();
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraftFrom(settings));
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const enabledId = useId();
  const minId = useId();
  const repostId = useId();
  const limitId = useId();
  const form = settingsForm(draft);
  const put = (change: Partial<SettingsDraft>) => setDraft((current) => ({ ...current, ...change }));
  const closeUnlessPending = () => { if (!update.isPending) onClose(); };
  const todayKey = dayKeyOf(new Date());
  const stopped = isStopped(settings);

  function send() {
    if (form.body === null || update.isPending) return;
    setFailure(null);
    update.mutate({ pageLabel: settings.pageLabel, body: form.body }, {
      onSuccess: () => { toast.success(`Сохранено: ${settings.pageLabel}`); onClose(); },
      onError: (error) => { setFailure(actionFailure(error)); setConfirming(false); },
    });
  }

  function submit() {
    if (form.body === null || update.isPending) return;
    // The page's own switch asks first; the range and limits are saved as they are.
    if (draft.enabled !== settings.enabled) setConfirming(true);
    else send();
  }

  if (confirming) {
    const place = placeLabel(settings.pageLabel, settings.platform, modelName);
    return draft.enabled ? (
      <ConfirmModal
        title={`Включить публикацию на ${settings.pageLabel}?`}
        message="Hub начнёт ставить утверждённые посты этой страницы на площадку. Это настоящие посты, которые видят фаны."
        facts={[
          { label: "Куда", value: place },
          ...(stopped ? [{ label: "Остановка", value: "Снимется, и закроется сбой «Hub остановил публикацию»" }] : []),
          ...(!globalEnabled ? [{ label: "Сейчас", value: "Общий выключатель выключен: страница всё равно не публикует" }] : []),
          { label: "Отменить", value: "Можно: выключить снова" },
        ]}
        confirmLabel="Включить публикацию"
        pendingLabel="Сохраняем…"
        tone="primary"
        isPending={update.isPending}
        onConfirm={send}
        onClose={() => { if (!update.isPending) setConfirming(false); }}
      />
    ) : (
      <ConfirmModal
        title={`Выключить публикацию на ${settings.pageLabel}?`}
        message="Hub перестанет ставить новые посты и загружать файлы на эту страницу. Уже поставленное останется в расписании площадки."
        facts={[
          { label: "Куда", value: place },
          { label: "Отменить", value: "Можно: включить снова" },
        ]}
        confirmLabel="Выключить публикацию"
        pendingLabel="Сохраняем…"
        tone="primary"
        isPending={update.isPending}
        onConfirm={send}
        onClose={() => { if (!update.isPending) setConfirming(false); }}
      />
    );
  }

  const priceInvalid = form.errors.price !== undefined;
  return (
    <ModalShell title={`Публикация на ${settings.pageLabel}`} onClose={closeUnlessPending}>
      <form className="pub-settings-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {stopped && (
          <Notice tone="danger" role="alert" detail={`${autostopReasonLabel(settings.autostopReason)}. Включите снова, когда разберётесь: включение снимает остановку.`}>
            <b>Hub остановил публикацию{settings.autostoppedAt === null ? "" : ` ${momentLabel(settings.autostoppedAt, todayKey)}`}</b>
          </Notice>
        )}
        {ofapiOff && <Notice tone="off">OnlyFans API выключен с 1 ноября. Настройки сохранятся, но страница публиковать не будет.</Notice>}

        <div>
          <label htmlFor={enabledId} className="pub-check-row">
            <input
              id={enabledId}
              type="checkbox"
              className="pub-check"
              checked={draft.enabled}
              disabled={update.isPending}
              onChange={(event) => put({ enabled: event.target.checked })}
            />
            <span>
              <span className="pub-check-title">Публиковать на этой странице</span>
              <span className="field-hint">
                Выключено — Hub не ставит новые посты и не загружает файлы на эту страницу. Уже поставленное остаётся в расписании площадки.
              </span>
            </span>
          </label>
          {draft.enabled && !globalEnabled && (
            <p className="field-hint pub-indent">Общий выключатель сейчас выключен: пока его не включат, страница всё равно не публикует.</p>
          )}
        </div>

        <div>
          <label htmlFor={minId} className="field-label">Цена платного поста, $</label>
          <div className="pub-range">
            <input
              id={minId}
              className={`input ${form.errors.priceMin !== undefined || priceInvalid ? "input-invalid" : ""}`.trim()}
              inputMode="decimal"
              placeholder="от, например 5"
              aria-label="Цена от, $"
              value={draft.priceMin}
              disabled={update.isPending}
              aria-invalid={form.errors.priceMin !== undefined || priceInvalid}
              onChange={(event) => put({ priceMin: event.target.value })}
            />
            <span className="pub-range-dash" aria-hidden="true">–</span>
            <input
              className={`input ${form.errors.priceMax !== undefined || priceInvalid ? "input-invalid" : ""}`.trim()}
              inputMode="decimal"
              placeholder="до, например 30"
              aria-label="Цена до, $"
              value={draft.priceMax}
              disabled={update.isPending}
              aria-invalid={form.errors.priceMax !== undefined || priceInvalid}
              onChange={(event) => put({ priceMax: event.target.value })}
            />
          </div>
          {(form.errors.priceMin ?? form.errors.priceMax ?? form.errors.price) !== undefined && (
            <p role="alert" className="field-error">{form.errors.priceMin ?? form.errors.priceMax ?? form.errors.price}</p>
          )}
          <p className="field-hint">
            {settings.platform === "onlyfans"
              ? "Платные посты на OnlyFans пока выключены; вилка понадобится, когда их включат."
              : "Цена вне вилки не утверждается. Пусто — платные посты на странице не утверждаются."}
          </p>
        </div>

        <div className="pub-settings-pair">
          <div>
            <label htmlFor={repostId} className="field-label">Повтор файла, дней</label>
            <input
              id={repostId}
              className={`input tabular-nums ${form.errors.repostDays !== undefined ? "input-invalid" : ""}`.trim()}
              inputMode="numeric"
              value={draft.repostDays}
              disabled={update.isPending}
              aria-invalid={form.errors.repostDays !== undefined}
              onChange={(event) => put({ repostDays: event.target.value })}
            />
            {form.errors.repostDays !== undefined && <p role="alert" className="field-error">{form.errors.repostDays}</p>}
          </div>
          <div>
            <label htmlFor={limitId} className="field-label">Предел постов в сутки</label>
            <input
              id={limitId}
              className={`input tabular-nums ${form.errors.dailyLimit !== undefined ? "input-invalid" : ""}`.trim()}
              inputMode="numeric"
              placeholder="без предела"
              value={draft.dailyLimit}
              disabled={update.isPending}
              aria-invalid={form.errors.dailyLimit !== undefined}
              onChange={(event) => put({ dailyLimit: event.target.value })}
            />
            {form.errors.dailyLimit !== undefined && <p role="alert" className="field-error">{form.errors.dailyLimit}</p>}
          </div>
        </div>
        <div className="pub-settings-hints">
          <p className="field-hint">Повтор: файл, который выходил на странице ближе этого срока, утверждается только с отметкой «перезалив».</p>
          <p className="field-hint">Предел: пусто — без предела. Hub и так предупредит, когда за день набирается вдвое больше постов, чем обычно.</p>
        </div>

        {failure !== null && <Notice tone="danger" role="alert">{failure}</Notice>}

        <div className="dialog-actions">
          <button type="button" className="btn" disabled={update.isPending} onClick={closeUnlessPending}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={form.body === null || update.isPending}>
            {update.isPending && <Spinner />}
            {update.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ── the panel ───────────────────────────────────────────────────────────────

export interface SettingsPageRow {
  settings: PublicationPageSettings;
  state: PagePublishing;
  queue: PublicationQueueSnapshotWire | undefined;
}

function configValue(items: readonly ConfigItem[], key: string): string | null {
  const item = items.find((candidate) => candidate.key === key);
  return item === undefined ? null : seedValue(item);
}

/**
 * «Настройки публикации» (spec §3): what Hub may publish and on which pages,
 * in one place. Every row writes only its own page; the filter's page is
 * only highlighted.
 */
export function PublicationSettingsDrawer({ rows, settingsState, globalEnabled, config, configState, ofapiOff, focusPage, onRetrySettings, onRetryConfig, onEdit, onClose }: {
  rows: readonly SettingsPageRow[];
  settingsState: "loading" | "failed" | "ready";
  globalEnabled: boolean | null;
  config: readonly ConfigItem[] | undefined;
  configState: "loading" | "failed" | "ready";
  ofapiOff: boolean;
  focusPage: string | null;
  onRetrySettings: () => void;
  onRetryConfig: () => void;
  onEdit: (pageLabel: string) => void;
  onClose: () => void;
}) {
  const focused = useRef<HTMLDivElement>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: "nearest" });
  }, [focusPage, settingsState]);

  const items = config ?? [];
  const globalItem = items.find((item) => item.key === "publishingEnabled");
  const onlyfansItem = items.find((item) => item.key === "publishingOnlyfansEnabled");
  const allPages = rows.map((row) => row.settings.pageLabel);
  const enabledPages = rows.filter((row) => row.settings.enabled).map((row) => row.settings.pageLabel);
  const onlyfansPages = rows.filter((row) => row.settings.platform === "onlyfans").map((row) => row.settings.pageLabel);

  const placeholder = (title: string, value: boolean | null) => (
    <div className="switch-row">
      <div className="switch-text"><span className="pub-switch-title">{title}</span></div>
      <div className="switch-control">
        {value === null ? <Skeleton width={72} /> : value ? "Включена" : "Выключена"}
        <Switch checked={value === true} label={title} disabled onChange={() => undefined} />
      </div>
    </div>
  );

  const credits = configValue(items, "publishingOnlyfansDailyCredits");
  const fileMax = configValue(items, "publicationFileMaxMb");
  const filesTotal = configValue(items, "publicationFilesMaxTotalGb");
  const number = (value: string | null) => (value === null || value === "" || Number.isNaN(Number(value)) ? "—" : formatCount(Number(value)));

  return (
    <Drawer title="Настройки публикации" onClose={onClose}>
      <div className="pub-drawer">
        <p className="pub-drawer-lead">Что публикует Hub и на каких страницах.</p>

        <section className="pub-switches" aria-label="Выключатели">
          {globalItem ? (
            <ConfigSwitchRow
              item={globalItem}
              title="Публикация постов через Hub"
              hint="Общий выключатель. Выключено — Hub не создаёт посты и не загружает файлы ни на одной странице. Убрать уже поставленное и проверить исход по-прежнему можно."
              words={["Включена", "Выключена"]}
              question={(target) => target ? {
                title: "Включить публикацию на всех страницах?",
                message: "Hub начнёт ставить утверждённые посты на страницы, где публикация включена. Это настоящие посты, которые видят фаны.",
                facts: [
                  { label: "Куда", value: enabledPages.length > 0 ? enabledPages.join(", ") : "Ни у одной страницы публикация не включена" },
                  { label: "Сколько стоит", value: "Посты OnlyFans тратят кредиты OnlyFans API" },
                  { label: "Отменить", value: "Можно: выключить снова" },
                ],
                confirmLabel: "Включить публикацию",
              } : {
                title: "Выключить публикацию на всех страницах?",
                message: "Hub сразу перестанет ставить новые посты и загружать файлы.",
                facts: [
                  { label: "Куда", value: `Все страницы: ${allPages.length}` },
                  { label: "Что останется", value: "Посты в расписаниях площадок выйдут. Убрать их и проверить исход можно" },
                  { label: "Отменить", value: "Можно: включить снова" },
                ],
                confirmLabel: "Выключить публикацию",
              }}
            />
          ) : placeholder("Публикация постов через Hub", globalEnabled)}
          {onlyfansItem ? (
            <ConfigSwitchRow
              item={onlyfansItem}
              title="Публикация на OnlyFans"
              hint="Работает только вместе с общим выключателем и выключателем страницы. Выключение сразу останавливает новые посты и сториз; проверка уже отправленного продолжается."
              words={["Включена", "Выключена"]}
              off={ofapiOff ? { word: OFAPI_OFF_WORD, reason: OFAPI_OFF_REASON } : undefined}
              question={(target) => ({
                title: target ? "Включить публикацию на OnlyFans?" : "Выключить публикацию на OnlyFans?",
                message: target
                  ? "Hub начнёт ставить утверждённые посты и сториз на страницы OnlyFans, где публикация включена."
                  : "Hub сразу перестанет ставить новые посты и сториз на OnlyFans.",
                facts: [
                  { label: "Куда", value: onlyfansPages.length > 0 ? onlyfansPages.join(", ") : "Страниц OnlyFans нет" },
                  { label: "Сколько стоит", value: "1 кредит за пост, загрузка файла около 3 кредитов за МБ" },
                  { label: "Отменить", value: "Можно" },
                ],
                confirmLabel: target ? "Включить публикацию" : "Выключить публикацию",
              })}
            />
          ) : placeholder("Публикация на OnlyFans", null)}
          {configState === "failed" && (
            <p className="pub-muted" role="alert">
              Параметры не загрузились.{" "}
              <button type="button" className="link" onClick={onRetryConfig}>Повторить</button>
            </p>
          )}
        </section>

        <section className="pub-drawer-block" aria-labelledby="pub-settings-pages">
          <h3 id="pub-settings-pages" className="pub-drawer-heading">Страницы</h3>
          <p className="pub-muted">У новой страницы публикация выключена.</p>
          {settingsState === "loading" ? (
            <div className="pub-settings-list" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="pub-settings-row"><Skeleton width="40%" /><div className="mt-2"><Skeleton width="70%" /></div></div>
              ))}
            </div>
          ) : settingsState === "failed" ? (
            <StatusPanel
              title="Настройки не загрузились"
              description="Hub не ответил: попробуйте ещё раз."
              tone="error"
              action={<button type="button" className="btn btn-sm" onClick={onRetrySettings}>Повторить</button>}
            />
          ) : rows.length === 0 ? (
            <p className="pub-muted">Нет активных страниц.</p>
          ) : (
            <div className="pub-settings-list">
              {rows.map((row) => (
                <PageRow
                  key={row.settings.pageLabel}
                  row={row}
                  ref={row.settings.pageLabel === focusPage ? focused : undefined}
                  picked={row.settings.pageLabel === focusPage}
                  onEdit={() => onEdit(row.settings.pageLabel)}
                />
              ))}
            </div>
          )}
        </section>

        <Disclosure label="Подробнее">
          <dl className="pub-limits">
            <dt>Кредиты на публикации OnlyFans в сутки</dt><dd>{number(credits)}</dd>
            <dt>Предел одного файла</dt><dd>{fileMax === null ? "—" : `${number(fileMax)} МБ`}</dd>
            <dt>Предел всех файлов</dt><dd>{filesTotal === null ? "—" : `${number(filesTotal)} ГБ`}</dd>
          </dl>
          <p className="mt-2"><Link className="link" to="/system/dev/config#config-publishingOnlyfansDailyCredits">Все параметры</Link></p>
        </Disclosure>
      </div>
    </Drawer>
  );
}

function PageRow({ row, picked, onEdit, ref }: { row: SettingsPageRow; picked: boolean; onEdit: () => void; ref?: Ref<HTMLDivElement> | undefined }) {
  const { settings, state, queue } = row;
  const lines: ReactNode[] = [
    <p key="limits">{pageLimitsLine(settings)}</p>,
    <p key="repost">{repostLine(settings.repostThresholdDays)}</p>,
  ];
  if (state.tone !== "good") {
    lines.push(
      <p key="reason" className={state.tone === "broken" ? "pub-reason-broken" : state.tone === "attention" ? "pub-reason-attention" : ""}>
        {state.reason}
        {state.action === "login" && <> <Link className="link" to={buildPageSectionRoute(settings.pageLabel, "browser-login")}>Войти в Fansly</Link></>}
      </p>,
    );
  }
  if (queue !== undefined && !state.ofapiOff) {
    lines.push(<p key="read">{queueReadLine(queue)}</p>);
    if (queue.platform === "onlyfans" && queue.windowFrom !== null && queue.windowTo !== null) {
      lines.push(<p key="days">Прочитаны дни {formatDayRange(queue.windowFrom, queue.windowTo)}</p>);
    }
    if (queue.readAt !== null && !queue.complete && queueIncompleteReasons(queue.incompleteReasons).length > 0) {
      lines.push(<p key="incomplete" className="pub-reason-attention">Прочитано неполно: {queueIncompleteText(queue.incompleteReasons)}.</p>);
    }
  }
  return (
    <div ref={ref} className={`pub-settings-row ${picked ? "is-picked" : ""}`.trim()}>
      <div className="pub-settings-head">
        <span className="pub-settings-name">
          <b>{settings.pageLabel}</b>
          <span className="pub-muted">{platformName(settings.platform)}</span>
        </span>
        <StatusBadge status={state.badge} bare />
        <button type="button" className="btn btn-sm" onClick={onEdit}>Изменить</button>
      </div>
      <div className="pub-settings-lines">{lines}</div>
    </div>
  );
}
