import { useRef } from "react";
import { useSearchParams } from "react-router";
import { useOfapiWebhookRecovery, ofapiWebhookRecoveryActions } from "@/api/adminOfapiWebhookRecovery";
import { useAuthMe } from "@/api/queries";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { marketingFailureUncertain } from "../marketing/marketingForm.js";
import { useSessionWorkspace } from "@/lib/useSessionWorkspace";
import { clearEvidenceCustody, readEvidenceCustody, saveEvidenceCustody, type PendingOfapiEvidence } from "@/lib/ofapiEvidenceCustody";

const labels: Record<string, string> = {
  subscription_expiry: "Окончания подписок", account_lifecycle: "Отключения аккаунта",
  media_uploads: "Загрузки медиа", data_exports: "Экспорты", engagement: "Лайки постов",
};
const scanLabels: Record<string, string> = {
  pending: "частично", running: "идёт сбор", failed: "остановлено", complete: "завершено",
};
const applyLabels: Record<string, string> = { never: "Ещё не применялись", pending: "Ждёт применения", applying: "Применяются", applied: "Подтверждены провайдером", failed: "Применение не подтверждено" };
const redeliveryLabels: Record<string, string> = { preview: "Можно запросить", dispatching: "Запрос отправляется", accepted: "Провайдер принял в очередь", rejected: "Отклонён", indeterminate: "Результат неизвестен" };
const button = "min-h-10 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-primary hover:bg-hover disabled:opacity-50 focus-visible:outline-2";

/** Owner-only consumer mounted by the OFAPI collection/settings page. Reads are
 * DB-only. Vendor history capture, remote replay and registration are explicit. */
export function OfapiWebhookRecovery() {
  const ownerId = useAuthMe().data?.user.id;
  const [search, setSearch] = useSearchParams();
  const rawOffset = Number(search.get("webhookOffset") ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const failedOnly = search.get("webhookFailed") === "true";
  const term = search.get("webhookQuery") ?? "";
  function filter(key: string, value: string, replace = false) { const next = new URLSearchParams(search); value ? next.set(key, value) : next.delete(key); if (key === "webhookFailed") next.delete("webhookOffset"); setSearch(next, { replace }); }
  const query = useOfapiWebhookRecovery({ offset, failedOnly });
  type Draft = { version: number; groups: string[]; historyEnabled: boolean };
  type Preview = { id: string; attemptId: number; unknown: boolean; pending: PendingOfapiEvidence | null };
  type Scan = Parameters<typeof ofapiWebhookRecoveryActions.scan>[0]["body"];
  type Workspace = { draft: Draft | null; busy: boolean; message: string | null; error: string; preview: Preview | null; scan: Scan | null; custodyError: string };
  const [workspace, setWorkspace, readWorkspace] = useSessionWorkspace<Workspace>("ofapi-webhook-recovery", () => {
    const saved = readEvidenceCustody(ownerId, "redelivery");
    return { draft: null, busy: false, message: null, error: "", preview: saved.request?.kind === "redelivery" ? { id: saved.request.id, attemptId: saved.request.attemptId, unknown: true, pending: saved.request } : null, scan: null, custodyError: saved.error };
  });
  const { draft, busy, message, error, preview } = workspace;
  const setDraft = (draft: Draft | null) => setWorkspace(current => ({ ...current, draft }));
  const setBusy = (busy: boolean) => setWorkspace(current => ({ ...current, busy }));
  const setMessage = (message: string | null) => setWorkspace(current => ({ ...current, message }));
  const setError = (error: string) => setWorkspace(current => ({ ...current, error }));
  const setPreview = (preview: Preview | null) => setWorkspace(current => ({ ...current, preview }));
  const inFlight = useRef(false);
  const policy = query.policy.data;
  const groups = draft?.groups ?? policy?.desiredGroups ?? [];
  const historyEnabled = draft?.historyEnabled ?? policy?.historyEnabled ?? false;
  const changed = draft !== null && draft.version !== policy?.version;
  function change(patch: Partial<Draft>) { if (!policy || readWorkspace().busy) return; setWorkspace(current => ({ ...current, draft: { ...(current.draft ?? { version: policy.version, groups: [...policy.desiredGroups], historyEnabled: policy.historyEnabled }), ...patch } })); }

  async function run(action: () => Promise<string>) {
    if (inFlight.current || readWorkspace().busy) return;
    inFlight.current = true; setBusy(true); setMessage(null); setError("");
    try { setMessage(await action()); await query.refetch(); }
    catch (error) { setError(error instanceof Error ? error.message : "Операция не выполнена"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const filters = <div className="flex flex-wrap items-end gap-3"><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={failedOnly} onChange={event => filter("webhookFailed", event.target.checked ? "true" : "")} />Только неуспешные доставки</label><label className="grid min-w-0 flex-1 gap-1 text-xs">Поиск в полученной странице<input type="search" className="min-h-10 min-w-0 rounded border border-border bg-card px-3 py-2 text-sm" value={term} onChange={event => filter("webhookQuery", event.target.value, true)} placeholder="Событие или номер попытки" /></label></div>;
  const history = query.history.data;
  const catalog = query.catalog.data;
  const saved = policy;
  const applied = new Set(saved?.appliedGroups ?? []);
  const attempts = history?.attempts.filter(attempt => `${attempt.eventType} ${attempt.attemptId} ${attempt.deliveryUuid}`.toLowerCase().includes(term.trim().toLowerCase())) ?? [];
  const writeBlocked = busy || query.policy.isError || !saved;
  const historyBlocked = busy || query.history.isError || !history;
  return <section className="space-y-4 rounded-xl border border-border bg-card p-5">
    <div><h2 className="text-base font-semibold text-text-primary">События и восстановление</h2>
      <p className="mt-1 text-sm text-text-secondary">Базовый поток сохраняется. Дополнительные события включайте по одному: сохраните выбор и примените его у провайдера.</p></div>
    {workspace.custodyError && <p role="alert" className="text-sm text-warning">{workspace.custodyError}</p>}
    {error && <p role="alert" className="break-words rounded border border-warning p-3 text-sm text-warning">{error}</p>}
    <button type="button" className={button} disabled={query.isFetching || busy} onClick={() => void query.refetch()}>Обновить состояние из Hub</button>
    <details className="rounded-lg border border-border p-3"><summary className="min-h-10 cursor-pointer text-sm text-text-primary">Каталог событий провайдера · {catalog?.state === "captured" ? catalog.events.length : "число неизвестно"}</summary>
      <QueryNotice error={query.catalog.isError} stale={catalog !== undefined} retry={query.catalog.refetch} />
      {!catalog && !query.catalog.isError && <p role="status" className="text-sm">Загружаем сохранённый каталог…</p>}
      <p className="my-2 text-xs text-text-secondary">Сохранённый ответ: {catalog?.observedAt??"ещё не получен"}. Каталог может меняться; новые события не включаются автоматически. {catalog?.state==='invalid'?'Последний ответ не прошёл проверку; исходные байты сохранены.':''}</p>
      <button type="button" className={button} disabled={busy} onClick={()=>void run(async()=>{const result=await ofapiWebhookRecoveryActions.refreshCatalog({body:{}});return result.state==='captured'?`Сохранено событий: ${result.events.length}. Подписки не изменены.`:'Ответ сохранён, но формат каталога не подтверждён.';})}>Обновить каталог · бесплатно</button>
      <ul className="mt-2 max-h-64 overflow-auto text-xs text-text-secondary">{catalog?.events.map(event=><li key={event.value} className="py-1"><span className="font-mono text-text-primary">{event.value}</span> · {event.description} · {event.requested?'запрошено':'не запрошено'} · {event.supported?'обработчик готов':'обработчик не подключён'}</li>)}</ul>
    </details>
    <QueryNotice error={query.policy.isError} stale={saved !== undefined} retry={query.policy.refetch} />
    {!saved && <StatusPanel title={query.policy.isError ? "Политика событий недоступна" : "Загружаем политику событий"} description="История доставок и каталог читаются независимо." />}
    {saved && <><div className="grid gap-2 sm:grid-cols-2">
      {saved.groups.map(group => <label key={group.id} className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={groups.includes(group.id)} disabled={writeBlocked} onChange={event => change({ groups: event.target.checked ? [...groups, group.id] : groups.filter(id => id !== group.id) })} />
        {labels[group.id] ?? group.id}<span className="text-xs text-text-secondary">{applied.has(group.id) ? "применено" : "выключено"}</span>
      </label>)}
    </div>
    <label className="flex items-start gap-2 text-sm text-text-primary">
      <input type="checkbox" checked={historyEnabled} disabled={writeBlocked} onChange={event => change({ historyEnabled: event.target.checked })} />
      <span>Сохранять историю доставок<span className="block text-xs text-text-secondary">Бесплатное чтение раз в 5 минут, до 100 попыток за запрос. Локальная настройка действует после сохранения.</span></span>
    </label>
    {draft && <div className="flex flex-wrap items-center gap-2 text-sm text-warning"><p>{changed ? "Политика изменилась. Черновик привязан к прежней версии; перечитайте выбор перед сохранением." : `Есть несохранённый выбор для версии ${draft.version}. Он не меняется при обновлении экрана.`}</p><button type="button" className={button} disabled={busy} onClick={() => setDraft(null)}>Сбросить к сохранённому выбору</button></div>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} disabled={writeBlocked || !draft || changed} onClick={() => void run(async () => {
        await ofapiWebhookRecoveryActions.save({ body: { expectedVersion: draft!.version, groups: groups as Array<"subscription_expiry" | "account_lifecycle" | "media_uploads" | "data_exports" | "engagement">, historyEnabled } });
        setDraft(null);
        return "Выбор сохранён. Примените дополнительные события у провайдера отдельным действием.";
      })}>Сохранить выбор</button>
      <button type="button" className={button} disabled={writeBlocked || draft !== null || saved.applyState === "applying"} onClick={() => void run(async () => {
        const result = await ofapiWebhookRecoveryActions.apply({ body: { expectedVersion: saved.version } });
        return result.applyState === "applied" ? "Состав событий подтверждён повторным чтением у провайдера." : `Применение не подтверждено: ${result.errorCode ?? result.applyState}`;
      })}>Применить события · платный поток</button>
      <span className="text-xs text-text-secondary">Состояние: {applyLabels[saved.applyState] ?? saved.applyState}{saved.errorCode ? ` · ${saved.errorCode}` : ""}</span>
    </div>
    </>}
    <div className="border-t border-border pt-4">
      <QueryNotice error={query.history.isError} stale={history !== undefined} retry={query.history.refetch} />
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-text-primary">Попытки доставки</h3>
        <button type="button" className={button} disabled={historyBlocked || !history?.webhookId || history?.latestScan?.state === "running"} onClick={() => void run(async () => {
          const last = history?.latestScan;
          const continuation = last && ["pending", "failed"].includes(last.state);
          const to = new Date();
          const body = readWorkspace().scan ?? {
            id: continuation ? last.id : crypto.randomUUID(), from: continuation ? last.from : new Date(to.getTime() - 86_400_000).toISOString(),
            to: continuation ? last.to : to.toISOString(), maxPages: 20,
          };
          setWorkspace(current => ({ ...current, scan: body }));
          const result = await ofapiWebhookRecoveryActions.scan({ body });
          setWorkspace(current => ({ ...current, scan: null }));
          return result.state === "complete" ? `История сохранена: ${result.capturedAttempts} новых попыток.` : `История частичная: ${result.state}. ${result.errorCode ?? "Продолжите чтение следующей порции."}`;
        })}>{workspace.scan || history?.latestScan && ["pending", "failed"].includes(history.latestScan.state) ? "Продолжить тот же сбор истории" : "Прочитать последние сутки · бесплатно"}</button>
      </div>
      {filters}
      <p className="my-2 text-xs text-text-secondary">Провайдер хранит попытки 7 дней; Hub сохраняет прочитанные записи. Доступ ограничен областью текущего ключа. Во время паузы события могут отсутствовать у самого провайдера.</p>
      {history && <>{history.latestScan && <div role="status" aria-label="Состояние чтения истории" className="mb-3 space-y-1 text-xs text-text-secondary">
        <p>Чтение истории: {scanLabels[history.latestScan.state] ?? history.latestScan.state} · просмотрено {history.latestScan.nextOffset} записей · сохранено {history.latestScan.capturedAttempts} новых попыток.</p>
        <p>Период UTC: {history.latestScan.from.slice(0, 19).replace("T", " ")} — {history.latestScan.to.slice(0, 19).replace("T", " ")}.</p>
        {history.latestScan.errorCode && <p>Причина остановки: {history.latestScan.errorCode}.</p>}
      </div>}
      <p className="my-2 text-xs text-text-secondary">Записей в ответе: {history.attempts.length}. Найдено: {attempts.length}. Смещение: {offset}. Полная история у провайдера не подтверждена.</p>
      <div className="overflow-x-auto" role="region" aria-label="Попытки доставки вебхуков" tabIndex={0}><table className="w-full text-left text-xs">
        <thead className="text-text-secondary"><tr><th className="p-2">Событие / UTC</th><th className="p-2">Провайдер</th><th className="p-2">Hub</th><th className="p-2">Действие</th></tr></thead>
        <tbody>{attempts.map(attempt => <tr key={attempt.attemptId} className="border-t border-border-light">
          <td className="p-2 text-text-primary">{attempt.eventType}<span className="block text-text-secondary">{attempt.createdAt.slice(0, 19).replace("T", " ")} · #{attempt.attemptNumber}</span></td>
          <td className="p-2 text-text-primary">{attempt.succeeded ? "Доставлено" : attempt.deliveryRecovered ? "Восстановлено следующей попыткой" : `Ошибка ${attempt.statusCode ?? "сети"}`}
            {attempt.redeliveryState && <span className="block text-text-secondary">Ручной повтор: {redeliveryLabels[attempt.redeliveryState] ?? attempt.redeliveryState} · {attempt.redeliverySucceeded === null ? "результат доставки неизвестен" : attempt.redeliverySucceeded ? "доставлено" : "пока без успеха"}</span>}</td>
          <td className="p-2 text-text-primary">{attempt.localEventId ? `${attempt.captureState} · проекция: ${attempt.projectionStatus} · разбор: ${attempt.canonicalVersion ?? "ожидает"}` : "Совпадающий receipt не найден"}</td>
          <td className="p-2">{attempt.localEventId ? <button type="button" className={button} disabled={historyBlocked} onClick={() => void run(async () => {
            await ofapiWebhookRecoveryActions.replay({ body: { eventId: attempt.localEventId!, dryRun: false } });
            return "Локальная обработка выполнена; результат виден в колонке Hub.";
          })}>Повторить локально</button> : <button type="button" className={button} disabled={historyBlocked || !!workspace.custodyError || preview !== null || ["dispatching", "accepted", "indeterminate"].includes(attempt.redeliveryState ?? "")} onClick={() => void run(async () => {
            const selected = { id: crypto.randomUUID(), attemptId: attempt.attemptId };
            await ofapiWebhookRecoveryActions.redeliver({ body: { ...selected, dryRun: true } });
            setPreview({ ...selected, unknown: false, pending: null }); return "Доставка доступна для ручного повтора. Подтвердите платную отправку ниже.";
          })}>Проверить повтор</button>}</td>
        </tr>)}</tbody>
      </table></div>
      {!query.history.isError && !attempts.length && <p className="py-3 text-sm text-text-secondary">{history.attempts.length ? "Совпадений на этой странице нет." : offset > 0 || failedOnly ? "Для выбранных условий на этой странице нет попыток. Вернитесь назад или измените фильтр." : "Сохранённых попыток пока нет. Прочитайте историю или включите её сбор."}</p>}
      <nav className="mt-3 flex flex-wrap gap-2" aria-label="Страницы попыток доставки"><button type="button" className={button} disabled={query.history.isFetching || offset === 0} onClick={() => filter("webhookOffset", String(Math.max(0, offset - 25)))}>Предыдущие 25</button><button type="button" className={button} disabled={query.history.isFetching || query.history.isError || history.attempts.length < 25} onClick={() => filter("webhookOffset", String(offset + 25))}>Следующие 25</button></nav></>}
      {!history && <StatusPanel title={query.history.isError ? "История доставок недоступна" : "Загружаем попытки доставки"} description="Фильтры сохраняются. Повторите чтение истории из Hub." />}
    </div>
    {preview && <div className="rounded-lg border border-border bg-hover p-3 text-sm text-text-primary">
      Повтор попытки {preview.attemptId}: ориентир 0,01 кредита за событие. Ответ «принято» означает очередь; итог проверяется по новой доставке и проекции Hub.
      <p className="mt-2 break-all text-xs">Идентификатор повтора: {preview.id}.</p>
      {preview.unknown && <><p role="alert" className="mt-2 text-warning">Результат запроса неизвестен. Новый идентификатор не создаётся. Проверка ниже читает исход той же попытки, без платной отправки.</p><button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => {
        const frozen = preview;
        const result = await ofapiWebhookRecoveryActions.redeliver({ body: { id: frozen.id, attemptId: frozen.attemptId, dryRun: true } });
        if (result.state === "preview") { setPreview({ ...frozen, unknown: false }); return "Отправка пока не записана в Hub. Ниже можно отдельно подтвердить тот же ID; сервер допускает одну отправку."; }
        if (result.state !== "dispatching") { if (frozen.pending) clearEvidenceCustody(ownerId, frozen.pending); setPreview(null); }
        return `Повтор ${frozen.id}: ${redeliveryLabels[result.state] ?? result.state}${result.errorCode ? ` · ${result.errorCode}` : ""}${result.redeliveryUuid ? ` · доставка ${result.redeliveryUuid}` : ""}.`;
      })}>Проверить сохранённый исход · без отправки</button></>}
      <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} disabled={historyBlocked || !!workspace.custodyError || preview.unknown} onClick={() => void run(async () => {
        const recovering = preview.pending !== null;
        const pending: PendingOfapiEvidence = { kind: "redelivery", requestId: crypto.randomUUID(), id: preview.id, attemptId: preview.attemptId };
        const frozen = { ...preview, pending }; saveEvidenceCustody(ownerId, pending); setPreview(frozen);
        try { const result = await ofapiWebhookRecoveryActions.redeliver({ body: { id: frozen.id, attemptId: frozen.attemptId, dryRun: false } });
          if (result.state === "dispatching") setPreview({ ...frozen, unknown: true }); else { clearEvidenceCustody(ownerId, pending); setPreview(null); }
          return `Попытка ${frozen.attemptId} · повтор ${frozen.id}: ${redeliveryLabels[result.state] ?? result.state}${result.errorCode ? ` · ${result.errorCode}` : ""}${result.redeliveryUuid ? ` · доставка ${result.redeliveryUuid}` : ""}.`;
        } catch (reason) { if (marketingFailureUncertain(reason, recovering)) setPreview({ ...frozen, unknown: true }); else { clearEvidenceCustody(ownerId, pending); setPreview({ ...frozen, pending: null }); } throw reason; }
      })}>Запросить платный повтор</button><button type="button" className={button} disabled={busy || preview.unknown || preview.pending !== null} onClick={() => setPreview(null)}>Отмена</button></div>
    </div>}
    {message && <p role="status" className="text-sm text-text-secondary">{message}</p>}
  </section>;
}
