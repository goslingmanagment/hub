import { useRef, useState } from "react";
import { useOfapiWebhookRecovery, ofapiWebhookRecoveryActions } from "@/api/adminOfapiWebhookRecovery";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime } from "@/lib/format";

export interface WebhookSelectionDraft {
  version: number;
  desiredGroups: string[];
  historyEnabled: boolean;
}

export function editWebhookSelection(
  draft: WebhookSelectionDraft | null,
  policy: WebhookSelectionDraft,
  patch: Partial<Pick<WebhookSelectionDraft, "desiredGroups" | "historyEnabled">>,
): WebhookSelectionDraft {
  return { ...(draft ?? { version: policy.version, desiredGroups: [...policy.desiredGroups], historyEnabled: policy.historyEnabled }), ...patch };
}

const labels: Record<string, string> = {
  subscription_expiry: "Окончания подписок", account_lifecycle: "Отключения аккаунта",
  media_uploads: "Загрузки медиа", data_exports: "Экспорты", engagement: "Лайки постов",
};
const scanLabels: Record<string, string> = {
  pending: "частично", running: "идёт сбор", failed: "остановлено", complete: "завершено",
};
/** Server enums in words; the raw value stays in a tooltip for debugging. */
const applyStateLabels: Record<string, string> = {
  never: "ещё не применялось", none: "нет данных", pending: "ждёт применения", applying: "применяется",
  applied: "применено", failed: "ошибка применения",
};
const captureStateLabels: Record<string, string> = {
  accepted: "принято", raw_captured: "получено, не разобрано", quarantined_malformed: "отложено: неверный формат",
};
const projectionLabels: Record<string, string> = {
  none: "не требуется", pending: "ожидает", projected: "выполнена", failed: "ошибка", skipped: "пропущена", blocked: "заблокирована",
};
const redeliveryLabels: Record<string, string> = {
  preview: "проверка", dispatching: "отправляется", accepted: "принят провайдером", indeterminate: "исход неизвестен",
  failed: "ошибка", rejected: "отклонён",
};
const applyStateLabel = (state: string) => applyStateLabels[state] ?? state;
const redeliveryLabel = (state: string) => redeliveryLabels[state] ?? state;
const localTime = (iso: string) => formatDateTime(iso, { yearUnlessCurrent: true });

const button = "btn btn-sm";
type WebhookPolicy = NonNullable<ReturnType<typeof useOfapiWebhookRecovery>["data"]>["policy"];

export function webhookApplyIsRunning(state: string): boolean {
  return state === "applying";
}

export function webhookReadbackResolvesAction(applyBaseline: { version: number; applyState: string } | undefined, policy: { version: number; applyState: string }): boolean {
  if (policy.applyState === "applying") return false;
  if (applyBaseline === undefined) return true;
  // A terminal state already present before the request is not evidence that a
  // new reconciliation attempt completed. This applies to both failed and applied.
  return policy.version > applyBaseline.version || (policy.version === applyBaseline.version
    && (policy.applyState === "applied" || policy.applyState === "failed")
    && policy.applyState !== applyBaseline.applyState);
}

export function webhookCanPrepareNewAction(
  reviewed: { version: number; applyState: string } | null,
  current: { version: number; applyState: string },
  acknowledged: boolean,
  unavailable: boolean,
): boolean {
  // A same-version failed apply cannot identify which attempt failed. Reading it
  // permits an explicit new intent, never a claim that the old request failed.
  return !unavailable && acknowledged && reviewed !== null
    && current.applyState !== "applying"
    && JSON.stringify(reviewed) === JSON.stringify(current);
}

/** Owner-only consumer mounted in System › OnlyFans API. Reads are DB-only.
 * Vendor history capture, remote replay and registration are explicit. The
 * card around it (title, description) belongs to the screen. */
export function OfapiWebhookRecovery() {
  const query = useOfapiWebhookRecovery();
  const [draft, setDraft] = useState<WebhookSelectionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; attemptId: number } | null>(null);
  const [receipt, setReceipt] = useState<WebhookPolicy | null>(null);
  const [readbackRequired, setReadbackRequired] = useState<{ label: string; applyBaseline?: { version: number; applyState: string } } | null>(null);
  const [reviewedReadback, setReviewedReadback] = useState<WebhookPolicy | null>(null);
  const [newActionAcknowledged, setNewActionAcknowledged] = useState(false);
  const busyRef = useRef(false);

  async function run(action: () => Promise<string>, label = "Операция с вебхуком", applyBaseline?: { version: number; applyState: string }) {
    if (busyRef.current || readbackRequired) return;
    busyRef.current = true;
    setBusy(true); setMessage(null);
    setReviewedReadback(null); setNewActionAcknowledged(false);
    try {
      const result = await action();
      const refreshed = await query.refetch();
      const refreshedPolicy = refreshed.data?.policy;
      if (refreshed.isError) setReadbackRequired({ label, ...(applyBaseline === undefined ? {} : { applyBaseline }) });
      else if (refreshedPolicy) setReceipt(current => current && refreshedPolicy.version >= current.version ? null : current);
      setMessage(refreshed.isError ? `${result} Обновление экрана не удалось; проверьте состояние перед новым действием.` : result);
    }
    catch (error) {
      setReadbackRequired({ label, ...(applyBaseline === undefined ? {} : { applyBaseline }) });
      setMessage(`${error instanceof Error ? error.message : "Ответ на операцию не получен"}. Проверьте сохранённое состояние; запрос автоматически не повторяется.`);
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function readBack() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    setReviewedReadback(null); setNewActionAcknowledged(false);
    try {
      const result = await query.refetch();
      const policy = result.data?.policy;
      if (!result.isError && policy) {
        setReceipt(current => current && policy.version >= current.version ? null : current);
        const resolved = webhookReadbackResolvesAction(readbackRequired?.applyBaseline, policy);
        if (resolved) setReadbackRequired(null);
        else setReviewedReadback(policy);
        setMessage(`Прочитан срез v${policy.version}; состояние применения: ${applyStateLabel(policy.applyState)}. ${resolved ? "Проверьте его перед новым действием." : "По этому срезу нельзя установить исход прежнего применения. Автоматического повтора не будет."}`);
      } else {
        setMessage("Повторное чтение не удалось; результат остаётся неизвестным.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Повторное чтение не удалось; результат остаётся неизвестным.");
    } finally { busyRef.current = false; setBusy(false); }
  }
  if (query.isPending) return <p className="text-sm text-text-secondary">Загружаем историю вебхука…</p>;
  if (!query.data) return (
    <div role="alert" className="notice notice-danger flex-wrap items-center justify-between">
      <span>Не удалось прочитать состояние вебхука.</span>
      <button type="button" className={button} onClick={() => void query.refetch()}>Повторить</button>
    </div>
  );
  const { history } = query.data;
  const saved = receipt && receipt.version >= query.data.policy.version ? receipt : query.data.policy;
  const groups = draft?.desiredGroups ?? saved.desiredGroups;
  const historyEnabled = draft?.historyEnabled ?? saved.historyEnabled;
  const draftChanged = draft !== null && draft.version !== saved.version;
  const dirty = draft !== null;
  const unavailable = busy || query.isError || readbackRequired !== null;
  const canPrepareNew = webhookCanPrepareNewAction(reviewedReadback, query.data.policy, newActionAcknowledged, busy || query.isError || query.isFetching);
  const applied = new Set(saved.appliedGroups);
  const catalogObservedAt = query.data.catalog?.observedAt ?? null;
  return <div className="space-y-5 text-sm">
    {query.isError && <StaleDataNotice title="Показан предыдущий срез вебхуков" error={query.error} />}
    {readbackRequired && <div role="alert" className="notice notice-warning">
      <div className="min-w-0 space-y-2">
        <p>{readbackRequired.label}: перед следующим действием нужно прочитать результат. Выбор сохранён на экране.{receipt ? " Подтверждённая квитанция также сохранена." : ""}</p>
        <button type="button" className={button} disabled={busy} onClick={() => void readBack()}>Сверить состояние после запроса</button>
        {reviewedReadback && <div className="space-y-2 border-t border-current/20 pt-3">
          <p>Исход применения не установлен. Даже состояние «применено» или «ошибка» может относиться к прежней попытке. Новый запрос может повторить уже выполненное платное действие.</p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 accent-accent" checked={newActionAcknowledged} disabled={busy || query.isError || query.isFetching} onChange={event => setNewActionAcknowledged(event.target.checked)} />
            <span>Я проверил текущий срез и хочу подготовить отдельное новое действие, принимая неизвестный исход предыдущего.</span>
          </label>
          <button type="button" className={button} disabled={!canPrepareNew} onClick={() => {
            if (!canPrepareNew || busyRef.current) return;
            const previous = readbackRequired.label;
            setReadbackRequired(null); setReviewedReadback(null); setNewActionAcknowledged(false);
            setPreview(null);
            setMessage(`${previous}: исход остался неизвестным. Подготовка нового действия разрешена; запрос ещё не отправлен. Выберите и подтвердите его отдельно.`);
          }}>Подготовить новое действие</button>
          <p className="text-xs">Эта кнопка не отправляет запрос. Для применения событий или платного повтора потребуется отдельное нажатие.</p>
        </div>}
      </div>
    </div>}
    {receipt && <p role="status" className="text-text-secondary">Сервер вернул выбор версии {receipt.version}. Ниже показана эта квитанция; независимое чтение ещё не подтверждено.</p>}

    <section className="space-y-3" aria-label="Дополнительные события">
      <p className="text-text-secondary">Базовый поток сохраняется. Дополнительные события включайте по одному: сохраните выбор и примените его у провайдера.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {saved.groups.map(group => <label key={group.id} className="flex items-center gap-2 text-text-primary">
          <input type="checkbox" className="accent-accent" checked={groups.includes(group.id)} disabled={busy} onChange={event => setDraft(current => editWebhookSelection(current, saved, { desiredGroups: event.target.checked ? [...groups, group.id] : groups.filter(id => id !== group.id) }))} />
          {labels[group.id] ?? group.id}
          <span className={applied.has(group.id) ? "badge badge-success" : "badge"}>{applied.has(group.id) ? "применено" : "выключено"}</span>
        </label>)}
      </div>
      <label className="flex items-start gap-2 text-text-primary">
        <input type="checkbox" className="mt-1 accent-accent" checked={historyEnabled} disabled={busy} onChange={event => setDraft(current => editWebhookSelection(current, saved, { historyEnabled: event.target.checked }))} />
        <span>Сохранять историю доставок<span className="field-hint block">Бесплатное чтение раз в 5 минут, до 100 попыток за запрос. Начинает действовать после сохранения.</span></span>
      </label>
      {dirty && <div className="notice" role="status">
        <div className="min-w-0 space-y-2">
          <p>{draftChanged ? `На сервере уже версия ${saved.version}; ваш выбор сделан по версии ${draft.version}. Сравните актуальный набор ниже перед новым выбором.` : "Выбор не сохранён. Применение у провайдера станет доступно после сохранения."}</p>
          {draftChanged && <p>Сохранено сейчас: {saved.desiredGroups.map(group => labels[group] ?? group).join(", ") || "без дополнительных групп"}; история доставок {saved.historyEnabled ? "включена" : "выключена"}.</p>}
          <button type="button" className={button} disabled={busy} onClick={() => setDraft(null)}>Сбросить к сохранённому выбору</button>
        </div>
      </div>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={unavailable || !dirty || draftChanged} onClick={() => void run(async () => {
          const result = await ofapiWebhookRecoveryActions.save({ body: { expectedVersion: draft?.version ?? saved.version, groups: groups as Array<"subscription_expiry" | "account_lifecycle" | "media_uploads" | "data_exports" | "engagement">, historyEnabled } });
          setReceipt(result);
          setDraft(null);
          return "Выбор сохранён. Примените дополнительные события у провайдера отдельным действием.";
        })}>Сохранить выбор</button>
        <button type="button" className={button} disabled={unavailable || query.isFetching || dirty || webhookApplyIsRunning(saved.applyState)} onClick={() => void run(async () => {
          const result = await ofapiWebhookRecoveryActions.apply({ body: { expectedVersion: saved.version } });
          setReceipt(result);
          return result.applyState === "applied" ? "Состав событий подтверждён повторным чтением у провайдера." : `Применение не подтверждено: ${result.errorCode ?? applyStateLabel(result.applyState)}`;
        }, `Применение событий, версия ${saved.version}`, { version: saved.version, applyState: saved.applyState })}>{saved.applyState === "applied" ? "Проверить и восстановить события · платный поток" : "Применить события · платный поток"}</button>
        <span className="text-xs text-text-secondary">
          Состояние: <span title={saved.applyState}>{applyStateLabel(saved.applyState)}</span>
          {saved.errorCode ? <> · код ошибки <span className="font-mono">{saved.errorCode}</span></> : ""}
        </span>
      </div>
      {saved.applyState === "applied" && <p className="text-xs text-text-secondary">Hub хранит результат прежнего применения. Проверка у провайдера — отдельный запрос; при расхождении она восстановит сохранённый состав событий.</p>}
      <details className="help">
        <summary>Каталог событий провайдера · {query.data.catalog?.events.length ?? 0}</summary>
        <div className="help-body max-w-none">
          <p>
            Сохранённый ответ: {catalogObservedAt ? <span title={catalogObservedAt}>{localTime(catalogObservedAt)}</span> : "ещё не получен"}. Каталог может меняться; новые события не включаются автоматически.
            {query.data.catalog?.state === "invalid" ? " Последний ответ не прошёл проверку; исходные данные сохранены." : ""}
          </p>
          <div><button type="button" className={button} disabled={unavailable} onClick={() => void run(async () => { const result = await ofapiWebhookRecoveryActions.refreshCatalog({ body: {} }); return result.state === "captured" ? `Сохранено событий: ${result.events.length}. Подписки не изменены.` : "Ответ сохранён, но формат каталога не подтверждён."; })}>Обновить каталог · бесплатно</button></div>
          <ul className="max-h-64 divide-y divide-border-light overflow-auto text-xs">
            {query.data.catalog?.events.map(event => <li key={event.value} className="py-1.5"><span className="font-mono text-text-primary">{event.value}</span> · {event.description} · {event.requested ? "запрошено" : "не запрошено"} · {event.supported ? "обработчик готов" : "обработчик не подключён"}</li>)}
          </ul>
        </div>
      </details>
    </section>

    <section className="space-y-3 border-t border-border pt-5" aria-labelledby="webhook-attempts-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="webhook-attempts-heading" className="text-sm font-semibold text-text-primary">Попытки доставки</h4>
        <button type="button" className={button} disabled={unavailable || !history.webhookId} onClick={() => void run(async () => {
          const last = history.latestScan;
          const continuation = last && ["pending", "failed"].includes(last.state);
          const to = new Date();
          const result = await ofapiWebhookRecoveryActions.scan({ body: {
            id: continuation ? last.id : crypto.randomUUID(), from: continuation ? last.from : new Date(to.getTime() - 86_400_000).toISOString(),
            to: continuation ? last.to : to.toISOString(), maxPages: 20,
          } });
          return result.state === "complete" ? `История сохранена: ${result.capturedAttempts} новых попыток.` : `История частичная: ${scanLabels[result.state] ?? result.state}. ${result.errorCode ?? "Продолжите чтение следующей порции."}`;
        })}>{history.latestScan && ["pending", "failed"].includes(history.latestScan.state) ? "Продолжить сбор истории" : "Прочитать последние сутки · бесплатно"}</button>
      </div>
      <p className="text-xs text-text-secondary">Провайдер хранит попытки 7 дней; Hub сохраняет прочитанные записи. Видно только то, что доступно текущему ключу. Во время паузы события могут отсутствовать у самого провайдера.</p>
      {history.latestScan && <div role="status" aria-label="Состояние чтения истории" className="space-y-1 text-xs text-text-secondary">
        <p>Чтение истории: {scanLabels[history.latestScan.state] ?? history.latestScan.state} · просмотрено {history.latestScan.nextOffset} записей · сохранено {history.latestScan.capturedAttempts} новых попыток.</p>
        <p>Период: {localTime(history.latestScan.from)} — {localTime(history.latestScan.to)}.</p>
        {history.latestScan.errorCode && <p>Причина остановки: <span className="font-mono">{history.latestScan.errorCode}</span>.</p>}
      </div>}
      {history.attempts.length > 0 && <div className="table-wrap"><table className="data-table min-w-[640px]">
        <thead><tr><th>Событие</th><th>Провайдер</th><th>Hub</th><th>Действие</th></tr></thead>
        <tbody>{history.attempts.map(attempt => <tr key={attempt.attemptId}>
          <td className="align-top"><span className="font-mono text-xs">{attempt.eventType}</span><span className="block text-xs text-text-secondary" title={attempt.createdAt}>{localTime(attempt.createdAt)} · попытка {attempt.attemptNumber}</span></td>
          <td className="align-top">{attempt.succeeded ? "Доставлено" : attempt.deliveryRecovered ? "Восстановлено следующей попыткой" : `Ошибка ${attempt.statusCode ?? "сети"}`}
            {attempt.redeliveryState && <span className="block text-xs text-text-secondary"><span title={attempt.redeliveryState}>Повтор доставки: {redeliveryLabel(attempt.redeliveryState)}</span> · {attempt.redeliverySucceeded === null ? "результат ожидается" : attempt.redeliverySucceeded ? "доставлено" : "пока без успеха"}</span>}</td>
          <td className="align-top">{attempt.localEventId
            ? <span title={`capture: ${attempt.captureState ?? "—"} · projection: ${attempt.projectionStatus ?? "—"} · canonical: ${attempt.canonicalVersion ?? "—"}`}>
              {attempt.captureState ? captureStateLabels[attempt.captureState] ?? attempt.captureState : "—"}
              <span className="block text-xs text-text-secondary">обработка: {attempt.projectionStatus ? projectionLabels[attempt.projectionStatus] ?? attempt.projectionStatus : "—"} · {attempt.canonicalVersion === null ? "разбор ожидается" : `разбор, версия ${attempt.canonicalVersion}`}</span>
            </span>
            : <span className="text-text-secondary">Запись в Hub не найдена</span>}</td>
          <td className="align-top">{attempt.localEventId ? <button type="button" className={button} disabled={unavailable} onClick={() => void run(async () => {
            await ofapiWebhookRecoveryActions.replay({ body: { eventId: attempt.localEventId!, dryRun: false } });
            return "Локальная обработка выполнена; результат виден в колонке Hub.";
          })}>Повторить локально</button> : <button type="button" className={button} disabled={unavailable} onClick={() => void run(async () => {
            const selected = { id: crypto.randomUUID(), attemptId: attempt.attemptId };
            await ofapiWebhookRecoveryActions.redeliver({ body: { ...selected, dryRun: true } });
            setPreview(selected); return "Доставка доступна для ручного повтора. Подтвердите платную отправку ниже.";
          })}>Проверить повтор</button>}</td>
        </tr>)}</tbody>
      </table></div>}
      {!history.attempts.length && <p className="text-text-secondary">Сохранённых попыток пока нет. Прочитайте историю или включите её сбор.</p>}
    </section>
    {preview && <div className="notice notice-warning">
      <div className="min-w-0 space-y-2">
        <p>Повтор попытки {preview.attemptId}: ориентир 0,01 кредита за событие. Ответ «принято» означает очередь; итог проверяется по новой доставке и обработке в Hub.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-sm btn-primary" disabled={unavailable} onClick={() => void run(async () => {
          const result = await ofapiWebhookRecoveryActions.redeliver({ body: { ...preview, dryRun: false } });
          setPreview(null); return `Повтор: ${redeliveryLabel(result.state)}${result.errorCode ? ` · ${result.errorCode}` : ""}.`;
        }, `Платный повтор попытки ${preview.attemptId}`)}>Запросить платный повтор</button><button type="button" className={button} disabled={busy || readbackRequired !== null} onClick={() => setPreview(null)}>Отмена</button></div>
      </div>
    </div>}
    {message && <p role="status" className="text-text-secondary">{message}</p>}
  </div>;
}
