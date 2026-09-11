import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { NotificationDelivery } from "@/lib/notificationDelivery";

type Props = { current: NotificationDelivery | null; history: NotificationDelivery[]; error: string; pending: boolean; onRefresh: () => void; onAllowSeparate: (acknowledged: boolean) => boolean };
const label = (item: NotificationDelivery) => item.kind === "test" ? "Тестовое сообщение" : "Ежедневный отчёт";
const button = "min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-hover disabled:opacity-40";
export function NotificationDeliveryNotice({ current, history, error, pending, onRefresh, onAllowSeparate }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setAcknowledged(false); }, [current?.id]);
  if (!current && !history?.length && !error) return null;
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label="Результат ручной отправки">
    {current && <><h3 className="text-sm font-semibold">{label(current)} · {current.phase === "sending" ? "отправляется" : current.phase === "sent" ? "отправлено" : current.phase === "not_sent" ? "не отправлялось" : "исход неизвестен"}</h3><p role="status" className="break-words text-sm text-text-secondary">{current.detail}</p><p className="break-all text-xs text-text-muted">Начало: {current.startedAt}. В проверенных настройках: {current.recipient ? `чат ${current.recipient}` : "получатель неизвестен"}.{current.reportDate ? ` Отчёт за ${current.reportDate}.` : ""}</p></>}
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    <div className="flex flex-wrap items-center gap-3"><button type="button" className={button} disabled={pending} onClick={onRefresh}>Обновить данные для сверки</button>{current?.kind === "report" && <Link className="text-sm text-accent underline" to="/notifications?tab=reports">История отправок отчётов</Link>}</div>
    {current?.phase === "unknown" && !error && <div className="space-y-3 border-t border-border pt-3"><p className="text-sm text-text-secondary">Проверьте сообщение в Telegram{current.kind === "report" ? " и историю отчётов" : ""}. Обновление экрана не отправляет сообщение и само по себе не доказывает, что прежний запрос отменён.</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={pending} onChange={event => setAcknowledged(event.target.checked)} />Я проверил исход и разрешаю отдельную новую отправку. В Telegram может появиться второе сообщение; прежний исход останется в истории этой вкладки.</label><button type="button" className={button} disabled={pending || !acknowledged} onClick={() => { if (onAllowSeparate(acknowledged)) setAcknowledged(false); }}>Разрешить отдельную новую отправку</button></div>}
    {!!history?.length && <details className="text-xs text-text-muted"><summary className="min-h-10 cursor-pointer">Предыдущие отправки после сверки: {history.length}</summary><ul className="space-y-2">{history.map(item => <li key={item.id} className="break-words">{label(item)} · {item.startedAt} · {item.recipient ? `чат ${item.recipient}` : "получатель неизвестен"} · {item.phase === "sent" ? "Telegram подтвердил отправку" : item.phase === "not_sent" ? "сервер не отправлял сообщение" : "исход не подтверждён"}. {item.detail}</li>)}</ul></details>}
  </section>;
}
