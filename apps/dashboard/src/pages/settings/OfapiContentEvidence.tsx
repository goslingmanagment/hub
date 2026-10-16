import { useState } from "react";
import { useAdminOfapiContentEvents } from "@/api/adminOfapiContentEvents";
import { formatDateTime } from "@/lib/format";

/** A provider instant in local time; the raw value stays in a tooltip. */
function Instant({ iso }: { iso: string }) {
  return <span title={iso}>{formatDateTime(iso, { yearUnlessCurrent: true })}</span>;
}

/** Owner-local evidence. Mounting/refreshing this report never collects vendor data.
 *  The card around it (title, description) belongs to the screen. */
export function OfapiContentEvidence({
  pages,
}: {
  pages: { id: number; label: string }[];
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const pageId = selected ?? pages[0]?.id;
  const query = useAdminOfapiContentEvents(pageId);
  const boolean = (value: unknown) =>
    value === true ? "да" : value === false ? "нет" : "неизвестно";
  return (
    <div className="space-y-4 text-sm">
      <p className="text-text-secondary">
        Только события, которые уже пришли от провайдера, — без новых запросов. Лайки не образуют полный список.
        Завершение очереди не подтверждает доставку каждому фану.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Страница для истории контента"
          className="select w-auto min-w-[200px]"
          value={pageId ?? ""}
          disabled={pages.length === 0}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          {pages.length === 0 && <option value="">Нет страниц OnlyFans</option>}
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={pageId === undefined || query.isFetching}
          onClick={() => void query.refetch()}
        >
          Обновить
        </button>
      </div>
      {pages.length === 0 && <p className="text-text-secondary">Добавьте страницу OnlyFans, чтобы просматривать её сохранённые события.</p>}
      {query.isLoading && pageId !== undefined && <p role="status" className="text-text-secondary">Читаем сохранённую историю…</p>}
      {query.isError && (
        <p role="alert" className="notice notice-warning">
          Не удалось обновить сохранённую историю. Повторите чтение; ниже остаётся предыдущий срез, если он был загружен.
        </p>
      )}
      {query.data && (
        <>
          <h4 className="font-semibold text-text-primary">
            Очередь рассылок · {query.data.queues.length}
            {query.data.queuesHasMore ? " из последних записей" : ""}
          </h4>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Очередь</th>
                  <th>Событие</th>
                  <th className="num">Ожидает / всего</th>
                  <th>Отменена / ошибка</th>
                </tr>
              </thead>
              <tbody>
                {query.data.queues.map((row) => (
                  <tr key={row.queueId}>
                    <td>
                      <span className="font-mono text-xs">{row.queueId}</span>
                      <span className="block text-xs text-text-secondary">получено <Instant iso={row.observedAt} /></span>
                    </td>
                    <td>
                      {row.phase === "finished" ? "Завершение" : "Обновление"}
                    </td>
                    <td className="num">
                      {String(row.state.pending ?? "?")} /{" "}
                      {String(row.state.total ?? "?")}
                    </td>
                    <td>
                      {boolean(row.state.isCanceled)} /{" "}
                      {boolean(row.state.hasError)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field-hint">
            Порядок прогресса основан на времени получения: провайдер не сообщает время изменения. Флаг завершения
            сохраняется при запоздалом обновлении.
          </p>
          <h4 className="font-semibold text-text-primary">
            Лайки · {query.data.likes.length}
            {query.data.likesHasMore ? " из последних записей" : ""}
          </h4>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Пост</th>
                  <th>Фан</th>
                  <th>Время у провайдера</th>
                  <th>Получено</th>
                </tr>
              </thead>
              <tbody>
                {query.data.likes.map((row) => (
                  <tr key={`${row.postRef}:${row.fanRef}`}>
                    <td className="font-mono text-xs">{row.postRef}</td>
                    <td className="font-mono text-xs">{row.fanRef}</td>
                    <td className="muted"><Instant iso={row.sourceAt} /></td>
                    <td className="muted"><Instant iso={row.observedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-text-secondary">
            Без надёжной ссылки на пост: {query.data.unattributedLikes}. Источник сохранён; ID уведомления не
            подставляется вместо ID поста.
          </p>
          {!query.data.queues.length && !query.data.likes.length && (
            <p className="text-text-secondary">
              Событий пока нет. Лайки постов включаются в разделе «События и восстановление» выше.
            </p>
          )}
        </>
      )}
    </div>
  );
}
