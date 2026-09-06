import { useEffect, useState } from "react";
import { useOfapiWebhookRecovery, ofapiWebhookRecoveryActions } from "@/api/adminOfapiWebhookRecovery";

const labels: Record<string, string> = {
  subscription_expiry: "Окончания подписок", account_lifecycle: "Отключения аккаунта",
  media_uploads: "Загрузки медиа", data_exports: "Экспорты", engagement: "Лайки постов",
};
const button = "rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-primary hover:bg-hover disabled:opacity-50";

/** Owner-only consumer mounted by the OFAPI collection/settings page. Reads are
 * DB-only. Vendor history capture, remote replay and registration are explicit. */
export function OfapiWebhookRecovery() {
  const query = useOfapiWebhookRecovery();
  const [groups, setGroups] = useState<string[]>([]);
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; attemptId: number } | null>(null);
  const policy = query.data?.policy;
  useEffect(() => {
    if (policy) { setGroups(policy.desiredGroups); setHistoryEnabled(policy.historyEnabled); }
  }, [policy]);

  async function run(action: () => Promise<string>) {
    setBusy(true); setMessage(null);
    try { setMessage(await action()); await query.refetch(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Операция не выполнена"); }
    finally { setBusy(false); }
  }
  if (query.isPending) return <p className="text-sm text-text-secondary">Загрузка истории вебхуков…</p>;
  if (!query.data) return <p role="alert" className="text-sm text-text-secondary">Не удалось прочитать состояние вебхуков. <button type="button" className={button} onClick={() => void query.refetch()}>Повторить</button></p>;
  const { history } = query.data;
  const saved = query.data.policy;
  const applied = new Set(saved.appliedGroups);
  return <section className="space-y-4 rounded-xl border border-border bg-card p-5">
    <div><h2 className="text-base font-semibold text-text-primary">События и восстановление</h2>
      <p className="mt-1 text-sm text-text-secondary">Базовый поток сохраняется. Дополнительные события включайте по одному: сохраните выбор и примените его у провайдера.</p></div>
    <div className="grid gap-2 sm:grid-cols-2">
      {saved.groups.map(group => <label key={group.id} className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={groups.includes(group.id)} disabled={busy} onChange={event => setGroups(current => event.target.checked ? [...current, group.id] : current.filter(id => id !== group.id))} />
        {labels[group.id] ?? group.id}<span className="text-xs text-text-secondary">{applied.has(group.id) ? "применено" : "выключено"}</span>
      </label>)}
    </div>
    <label className="flex items-start gap-2 text-sm text-text-primary">
      <input type="checkbox" checked={historyEnabled} disabled={busy} onChange={event => setHistoryEnabled(event.target.checked)} />
      <span>Сохранять историю доставок<span className="block text-xs text-text-secondary">Бесплатное чтение раз в 5 минут, до 100 попыток за запрос. Локальная настройка действует после сохранения.</span></span>
    </label>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} disabled={busy} onClick={() => void run(async () => {
        await ofapiWebhookRecoveryActions.save({ body: { expectedVersion: saved.version, groups: groups as Array<"subscription_expiry" | "account_lifecycle" | "media_uploads" | "data_exports" | "engagement">, historyEnabled } });
        return "Выбор сохранён. Примените дополнительные события у провайдера отдельным действием.";
      })}>Сохранить выбор</button>
      <button type="button" className={button} disabled={busy || saved.applyState === "applying"} onClick={() => void run(async () => {
        const result = await ofapiWebhookRecoveryActions.apply({ body: { expectedVersion: saved.version } });
        return result.applyState === "applied" ? "Состав событий подтверждён повторным чтением у провайдера." : `Применение не подтверждено: ${result.errorCode ?? result.applyState}`;
      })}>Применить события · платный поток</button>
      <span className="text-xs text-text-secondary">Состояние: {saved.applyState}{saved.errorCode ? ` · ${saved.errorCode}` : ""}</span>
    </div>
    <div className="border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-text-primary">Попытки доставки</h3>
        <button type="button" className={button} disabled={busy || !history.webhookId} onClick={() => void run(async () => {
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
      <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <thead className="text-text-secondary"><tr><th className="p-2">Событие / UTC</th><th className="p-2">Провайдер</th><th className="p-2">Hub</th><th className="p-2">Действие</th></tr></thead>
        <tbody>{history.attempts.map(attempt => <tr key={attempt.attemptId} className="border-t border-border-light">
          <td className="p-2 text-text-primary">{attempt.eventType}<span className="block text-text-secondary">{attempt.createdAt.slice(0, 19).replace("T", " ")} · #{attempt.attemptNumber}</span></td>
          <td className="p-2 text-text-primary">{attempt.succeeded ? "Доставлено" : attempt.deliveryRecovered ? "Восстановлено следующей попыткой" : `Ошибка ${attempt.statusCode ?? "сети"}`}
            {attempt.redeliveryState && <span className="block text-text-secondary">Ручной повтор: {attempt.redeliveryState} · {attempt.redeliverySucceeded === null ? "результат ожидается" : attempt.redeliverySucceeded ? "доставлено" : "пока без успеха"}</span>}</td>
          <td className="p-2 text-text-primary">{attempt.localEventId ? `${attempt.captureState} · проекция: ${attempt.projectionStatus} · разбор: ${attempt.canonicalVersion ?? "ожидает"}` : "Совпадающий receipt не найден"}</td>
          <td className="p-2">{attempt.localEventId ? <button type="button" className={button} disabled={busy} onClick={() => void run(async () => {
            await ofapiWebhookRecoveryActions.replay({ body: { eventId: attempt.localEventId!, dryRun: false } });
            return "Локальная обработка выполнена; результат виден в колонке Hub.";
          })}>Повторить локально</button> : <button type="button" className={button} disabled={busy} onClick={() => void run(async () => {
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
      <div className="mt-2 flex gap-2"><button type="button" className={button} disabled={busy} onClick={() => void run(async () => {
        const result = await ofapiWebhookRecoveryActions.redeliver({ body: { ...preview, dryRun: false } });
        setPreview(null); return `Повтор: ${result.state}${result.errorCode ? ` · ${result.errorCode}` : ""}${result.redeliveryUuid ? ` · доставка ${result.redeliveryUuid}` : ""}.`;
      })}>Запросить платный повтор</button><button type="button" className={button} onClick={() => setPreview(null)}>Отмена</button></div>
    </div>}
    {message && <p role="status" className="text-sm text-text-secondary">{message}</p>}
  </section>;
}
