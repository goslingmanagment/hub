import { useRef, useState } from "react";
import { useOfapiWebhookRecovery, ofapiWebhookRecoveryActions } from "@/api/adminOfapiWebhookRecovery";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";

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
const button = "rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-primary hover:bg-hover disabled:opacity-50";
type WebhookPolicy = NonNullable<ReturnType<typeof useOfapiWebhookRecovery>["data"]>["policy"];

export function webhookApplyIsSettledOrRunning(state: string): boolean {
  return state === "applied" || state === "applying";
}

export function webhookReadbackResolvesAction(applyBaseline: { version: number; applyState: string } | undefined, policy: { version: number; applyState: string }): boolean {
  if (applyBaseline === undefined) return policy.applyState !== "applying";
  return policy.version > applyBaseline.version || (policy.version === applyBaseline.version && (policy.applyState === "applied" || (policy.applyState === "failed" && applyBaseline.applyState !== "failed")));
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

/** Owner-only consumer mounted by the OFAPI collection/settings page. Reads are
 * DB-only. Vendor history capture, remote replay and registration are explicit. */
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
        setMessage(`Прочитан срез v${policy.version}; состояние применения: ${policy.applyState}. ${resolved ? "Проверьте его перед новым действием." : "По этому срезу нельзя установить исход прежнего применения. Автоматического повтора не будет."}`);
      } else {
        setMessage("Повторное чтение не удалось; результат остаётся неизвестным.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Повторное чтение не удалось; результат остаётся неизвестным.");
    } finally { busyRef.current = false; setBusy(false); }
  }
  if (query.isPending) return <p className="text-sm text-text-secondary">Загрузка истории вебхуков…</p>;
  if (!query.data) return <p role="alert" className="text-sm text-text-secondary">Не удалось прочитать состояние вебхуков. <button type="button" className={button} onClick={() => void query.refetch()}>Повторить</button></p>;
  const { history } = query.data;
  const saved = receipt && receipt.version >= query.data.policy.version ? receipt : query.data.policy;
  const groups = draft?.desiredGroups ?? saved.desiredGroups;
  const historyEnabled = draft?.historyEnabled ?? saved.historyEnabled;
  const draftChanged = draft !== null && draft.version !== saved.version;
  const dirty = draft !== null;
  const unavailable = busy || query.isError || readbackRequired !== null;
  const canPrepareNew = webhookCanPrepareNewAction(reviewedReadback, query.data.policy, newActionAcknowledged, busy || query.isError || query.isFetching);
  const applied = new Set(saved.appliedGroups);
  return <section className="space-y-4 rounded-xl border border-border bg-card p-5">
    {query.isError && <StaleDataNotice title="Показан предыдущий срез вебхуков" error={query.error} />}
    {readbackRequired && <div role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text-primary">
      {readbackRequired.label}: перед следующим действием нужно прочитать результат. Выбор сохранён на экране.{receipt ? " Подтверждённая квитанция также сохранена." : ""}
      <button type="button" className={`${button} mt-2 block`} disabled={busy} onClick={() => void readBack()}>Сверить состояние после запроса</button>
      {reviewedReadback && <div className="mt-3 space-y-2 border-t border-border pt-3">
        <p>Исход применения не установлен. Даже состояние «failed» может относиться к прежней попытке. Новый запрос может повторить уже выполненное платное действие.</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={newActionAcknowledged} disabled={busy || query.isError || query.isFetching} onChange={event => setNewActionAcknowledged(event.target.checked)} />
          <span>Я проверил текущий срез и хочу подготовить отдельное новое действие, принимая неизвестный исход предыдущего.</span>
        </label>
        <button type="button" className={button} disabled={!canPrepareNew} onClick={() => {
          if (!canPrepareNew || busyRef.current) return;
          const previous = readbackRequired.label;
          setReadbackRequired(null); setReviewedReadback(null); setNewActionAcknowledged(false);
          setPreview(null);
          setMessage(`${previous}: исход остался неизвестным. Подготовка нового действия разрешена; запрос ещё не отправлен. Выберите и подтвердите его отдельно.`);
        }}>Подготовить новое действие</button>
        <p className="text-xs text-text-secondary">Эта кнопка не отправляет запрос. Для применения событий или платного повтора потребуется отдельное нажатие.</p>
      </div>}
    </div>}
    {receipt && <p role="status" className="text-sm text-text-secondary">Сервер вернул политику v{receipt.version}. Ниже показана эта квитанция; независимое чтение ещё не подтверждено.</p>}
    <div><h2 className="text-base font-semibold text-text-primary">События и восстановление</h2>
      <p className="mt-1 text-sm text-text-secondary">Базовый поток сохраняется. Дополнительные события включайте по одному: сохраните выбор и примените его у провайдера.</p></div>
    <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm text-text-primary">Каталог событий провайдера · {query.data.catalog?.events.length??0}</summary>
      <p className="my-2 text-xs text-text-secondary">Сохранённый ответ: {query.data.catalog?.observedAt??"ещё не получен"}. Каталог может меняться; новые события не включаются автоматически. {query.data.catalog?.state==='invalid'?'Последний ответ не прошёл проверку; исходные байты сохранены.':''}</p>
      <button type="button" className={button} disabled={unavailable} onClick={()=>void run(async()=>{const result=await ofapiWebhookRecoveryActions.refreshCatalog({body:{}});return result.state==='captured'?`Сохранено событий: ${result.events.length}. Подписки не изменены.`:'Ответ сохранён, но формат каталога не подтверждён.';})}>Обновить каталог · бесплатно</button>
      <ul className="mt-2 max-h-64 overflow-auto text-xs text-text-secondary">{query.data.catalog?.events.map(event=><li key={event.value} className="py-1"><span className="font-mono text-text-primary">{event.value}</span> · {event.description} · {event.requested?'запрошено':'не запрошено'} · {event.supported?'обработчик готов':'обработчик не подключён'}</li>)}</ul>
    </details>
    <div className="grid gap-2 sm:grid-cols-2">
      {saved.groups.map(group => <label key={group.id} className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={groups.includes(group.id)} disabled={busy} onChange={event => setDraft(current => editWebhookSelection(current, saved, { desiredGroups: event.target.checked ? [...groups, group.id] : groups.filter(id => id !== group.id) }))} />
        {labels[group.id] ?? group.id}<span className="text-xs text-text-secondary">{applied.has(group.id) ? "применено" : "выключено"}</span>
      </label>)}
    </div>
    <label className="flex items-start gap-2 text-sm text-text-primary">
      <input type="checkbox" checked={historyEnabled} disabled={busy} onChange={event => setDraft(current => editWebhookSelection(current, saved, { historyEnabled: event.target.checked }))} />
      <span>Сохранять историю доставок<span className="block text-xs text-text-secondary">Бесплатное чтение раз в 5 минут, до 100 попыток за запрос. Локальная настройка действует после сохранения.</span></span>
    </label>
    {dirty && <div className="rounded-lg border border-border bg-hover p-3 text-sm text-text-secondary" role="status">
      {draftChanged ? `На сервере уже v${saved.version}; ваш выбор сделан по v${draft.version}. Сравните актуальный набор ниже перед новым выбором.` : `Несохранённый выбор по v${draft.version}. Применение у провайдера доступно после сохранения.`}
      {draftChanged && <p>Сохранено сейчас: {saved.desiredGroups.map(group => labels[group] ?? group).join(", ") || "без дополнительных групп"}; история доставок {saved.historyEnabled ? "включена" : "выключена"}.</p>}
      <button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => setDraft(null)}>Сбросить черновик к сохранённому выбору</button>
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} disabled={unavailable || !dirty || draftChanged} onClick={() => void run(async () => {
        const result = await ofapiWebhookRecoveryActions.save({ body: { expectedVersion: draft?.version ?? saved.version, groups: groups as Array<"subscription_expiry" | "account_lifecycle" | "media_uploads" | "data_exports" | "engagement">, historyEnabled } });
        setReceipt(result);
        setDraft(null);
        return "Выбор сохранён. Примените дополнительные события у провайдера отдельным действием.";
      })}>Сохранить выбор</button>
      <button type="button" className={button} disabled={unavailable || dirty || webhookApplyIsSettledOrRunning(saved.applyState)} onClick={() => void run(async () => {
        const result = await ofapiWebhookRecoveryActions.apply({ body: { expectedVersion: saved.version } });
        setReceipt(result);
        return result.applyState === "applied" ? "Состав событий подтверждён повторным чтением у провайдера." : `Применение не подтверждено: ${result.errorCode ?? result.applyState}`;
      }, `Применение событий v${saved.version}`, { version: saved.version, applyState: saved.applyState })}>Применить события · платный поток</button>
      <span className="text-xs text-text-secondary">Состояние: {saved.applyState}{saved.errorCode ? ` · ${saved.errorCode}` : ""}</span>
    </div>
    <div className="border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-text-primary">Попытки доставки</h3>
        <button type="button" className={button} disabled={unavailable || !history.webhookId} onClick={() => void run(async () => {
          const last = history.latestScan;
          const continuation = last && ["pending", "failed"].includes(last.state);
          const to = new Date();
          const result = await ofapiWebhookRecoveryActions.scan({ body: {
            id: continuation ? last.id : crypto.randomUUID(), from: continuation ? last.from : new Date(to.getTime() - 86_400_000).toISOString(),
            to: continuation ? last.to : to.toISOString(), maxPages: 20,
          } });
          return result.state === "complete" ? `История сохранена: ${result.capturedAttempts} новых попыток.` : `История частичная: ${result.state}. ${result.errorCode ?? "Продолжите чтение следующей порции."}`;
        })}>{history.latestScan && ["pending", "failed"].includes(history.latestScan.state) ? "Продолжить сбор истории" : "Прочитать последние сутки · бесплатно"}</button>
      </div>
      <p className="my-2 text-xs text-text-secondary">Провайдер хранит попытки 7 дней; Hub сохраняет прочитанные записи. Доступ ограничен областью текущего ключа. Во время паузы события могут отсутствовать у самого провайдера.</p>
      {history.latestScan && <div role="status" aria-label="Состояние чтения истории" className="mb-3 space-y-1 text-xs text-text-secondary">
        <p>Чтение истории: {scanLabels[history.latestScan.state] ?? history.latestScan.state} · просмотрено {history.latestScan.nextOffset} записей · сохранено {history.latestScan.capturedAttempts} новых попыток.</p>
        <p>Период UTC: {history.latestScan.from.slice(0, 19).replace("T", " ")} — {history.latestScan.to.slice(0, 19).replace("T", " ")}.</p>
        {history.latestScan.errorCode && <p>Причина остановки: {history.latestScan.errorCode}.</p>}
      </div>}
      <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <thead className="text-text-secondary"><tr><th className="p-2">Событие / UTC</th><th className="p-2">Провайдер</th><th className="p-2">Hub</th><th className="p-2">Действие</th></tr></thead>
        <tbody>{history.attempts.map(attempt => <tr key={attempt.attemptId} className="border-t border-border-light">
          <td className="p-2 text-text-primary">{attempt.eventType}<span className="block text-text-secondary">{attempt.createdAt.slice(0, 19).replace("T", " ")} · #{attempt.attemptNumber}</span></td>
          <td className="p-2 text-text-primary">{attempt.succeeded ? "Доставлено" : attempt.deliveryRecovered ? "Восстановлено следующей попыткой" : `Ошибка ${attempt.statusCode ?? "сети"}`}
            {attempt.redeliveryState && <span className="block text-text-secondary">Ручной повтор: {attempt.redeliveryState} · {attempt.redeliverySucceeded === null ? "результат ожидается" : attempt.redeliverySucceeded ? "доставлено" : "пока без успеха"}</span>}</td>
          <td className="p-2 text-text-primary">{attempt.localEventId ? `${attempt.captureState} · проекция: ${attempt.projectionStatus} · разбор: ${attempt.canonicalVersion ?? "ожидает"}` : "Совпадающий receipt не найден"}</td>
          <td className="p-2">{attempt.localEventId ? <button type="button" className={button} disabled={unavailable} onClick={() => void run(async () => {
            await ofapiWebhookRecoveryActions.replay({ body: { eventId: attempt.localEventId!, dryRun: false } });
            return "Локальная обработка выполнена; результат виден в колонке Hub.";
          })}>Повторить локально</button> : <button type="button" className={button} disabled={unavailable} onClick={() => void run(async () => {
            const selected = { id: crypto.randomUUID(), attemptId: attempt.attemptId };
            await ofapiWebhookRecoveryActions.redeliver({ body: { ...selected, dryRun: true } });
            setPreview(selected); return "Доставка доступна для ручного повтора. Подтвердите платную отправку ниже.";
          })}>Проверить повтор</button>}</td>
        </tr>)}</tbody>
      </table></div>
      {!history.attempts.length && <p className="py-3 text-sm text-text-secondary">Сохранённых попыток пока нет. Прочитайте историю или включите её сбор.</p>}
    </div>
    {preview && <div className="rounded-lg border border-border bg-hover p-3 text-sm text-text-primary">
      Повтор попытки {preview.attemptId}: ориентир 0,01 кредита за событие. Ответ «принято» означает очередь; итог проверяется по новой доставке и проекции Hub.
      <div className="mt-2 flex gap-2"><button type="button" className={button} disabled={unavailable} onClick={() => void run(async () => {
        const result = await ofapiWebhookRecoveryActions.redeliver({ body: { ...preview, dryRun: false } });
        setPreview(null); return `Повтор: ${result.state}${result.errorCode ? ` · ${result.errorCode}` : ""}${result.redeliveryUuid ? ` · доставка ${result.redeliveryUuid}` : ""}.`;
      }, `Платный повтор попытки ${preview.attemptId} · запрос ${preview.id}`)}>Запросить платный повтор</button><button type="button" className={button} disabled={busy || readbackRequired !== null} onClick={() => setPreview(null)}>Отмена</button></div>
    </div>}
    {message && <p role="status" className="text-sm text-text-secondary">{message}</p>}
  </section>;
}
