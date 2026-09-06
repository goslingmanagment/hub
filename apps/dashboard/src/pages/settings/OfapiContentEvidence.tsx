import { useState } from "react";
import { useAdminOfapiContentEvents } from "@/api/adminOfapiContentEvents";
/** Owner-local evidence. Mounting/refreshing this report never collects vendor data. */
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
    <details className="rounded-xl border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-semibold text-text-primary">
        Очередь сообщений и лайки постов · сохранённые события
      </summary>
      <div className="mt-3 space-y-3 text-sm text-text-secondary">
        <p>
          Только полученные события OFAPI, без запроса к провайдеру. Лайки не
          образуют полный список. Завершение очереди не подтверждает доставку
          каждому фану.
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Страница для истории контента"
            className="rounded border border-border bg-card p-2"
            value={pageId ?? ""}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded border border-border px-3 py-2"
            disabled={pageId === undefined || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Обновить из Hub
          </button>
        </div>
        {query.isError && (
          <p role="alert">
            Не удалось прочитать сохранённую историю. Повторите чтение.
          </p>
        )}
        {query.data && (
          <>
            <h3 className="font-medium text-text-primary">
              Очередь · {query.data.queues.length}
              {query.data.queuesHasMore ? " из последних записей" : ""}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="p-2">Queue ID / получено UTC</th>
                    <th className="p-2">Событие</th>
                    <th className="p-2">Ожидает / всего</th>
                    <th className="p-2">Отменена / ошибка</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.queues.map((row) => (
                    <tr key={row.queueId} className="border-t border-border">
                      <td className="p-2">
                        {row.queueId}
                        <br />
                        {row.observedAt}
                      </td>
                      <td className="p-2">
                        {row.phase === "finished" ? "Завершение" : "Обновление"}
                      </td>
                      <td className="p-2">
                        {String(row.state.pending ?? "?")} /{" "}
                        {String(row.state.total ?? "?")}
                      </td>
                      <td className="p-2">
                        {boolean(row.state.isCanceled)} /{" "}
                        {boolean(row.state.hasError)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs">
              Порядок прогресса основан на получении: провайдер не документирует
              отдельное время изменения. Флаг завершения сохраняется при
              запоздалом обновлении.
            </p>
            <h3 className="font-medium text-text-primary">
              Лайки · {query.data.likes.length}
              {query.data.likesHasMore ? " из последних записей" : ""}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="p-2">Пост</th>
                    <th className="p-2">Фан</th>
                    <th className="p-2">Время провайдера UTC</th>
                    <th className="p-2">Получено UTC</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.likes.map((row) => (
                    <tr
                      key={`${row.postRef}:${row.fanRef}`}
                      className="border-t border-border"
                    >
                      <td className="p-2">{row.postRef}</td>
                      <td className="p-2">{row.fanRef}</td>
                      <td className="p-2">{row.sourceAt}</td>
                      <td className="p-2">{row.observedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Без надёжной ссылки на пост: {query.data.unattributedLikes}.
              Источник сохранён; ID уведомления не подставляется вместо ID
              поста.
            </p>
            {!query.data.queues.length && !query.data.likes.length && (
              <p>
                Событий пока нет. Дополнительные лайки включаются владельцем в
                составе вебхука.
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
