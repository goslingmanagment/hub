import { useSearchParams } from "react-router";
import { useAdminOfapiContentEvents } from "@/api/adminOfapiContentEvents";
import { resolveOfapiPage } from "@/lib/ofapiNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
/** Owner-local evidence. Mounting/refreshing this report never collects vendor data. */
export function OfapiContentEvidence({
  pages,
}: {
  pages: { id: number; label: string }[];
}) {
  const [search, setSearch] = useSearchParams();
  const selected = resolveOfapiPage(pages, search.get("page"));
  const pageId = selected?.id;
  const view = search.get("contentView") === "likes" ? "likes" : "queues";
  const term = search.get("contentQuery") ?? "";
  function update(key: string, value: string, replace = false) { const next = new URLSearchParams(search); value ? next.set(key, value) : next.delete(key); setSearch(next, { replace }); }
  const query = useAdminOfapiContentEvents(pageId);
  const queues = query.data?.queues.filter(row => `${row.queueId} ${row.phase}`.toLowerCase().includes(term.trim().toLowerCase())) ?? [];
  const likes = query.data?.likes.filter(row => `${row.postRef} ${row.fanRef}`.toLowerCase().includes(term.trim().toLowerCase())) ?? [];
  const boolean = (value: unknown) =>
    value === true ? "да" : value === false ? "нет" : "неизвестно";
  return (
    <details className="rounded-xl border border-border bg-card p-4">
      <summary className="min-h-10 cursor-pointer text-sm font-semibold text-text-primary focus-visible:outline-2">
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
            className="min-h-10 min-w-0 max-w-full rounded border border-border bg-card p-2"
            value={selected?.label ?? ""}
            onChange={(event) => update("page", event.target.value)}
          >
            {!selected && <option value="">Выберите страницу</option>}
            {pages.map((page) => (
              <option key={page.id} value={page.label}>
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
        {!selected && <StatusPanel title="Выберите страницу для истории контента" description="Нужен доступный аккаунт; неизвестная страница из ссылки не подменяется первой." />}
        <QueryNotice error={query.isError} stale={query.data !== undefined} retry={query.refetch} />
        {pageId !== undefined && query.isLoading && !query.data && <p role="status">Загружаем сохранённые события…</p>}
        <nav className="flex flex-wrap gap-2" aria-label="Вид сохранённых событий">{[["queues", "Очередь сообщений"], ["likes", "Лайки постов"]].map(([id, label]) => <button key={id} type="button" className={`min-h-10 rounded border px-3 py-2 ${view === id ? "border-accent text-accent" : "border-border"}`} aria-pressed={view === id} onClick={() => update("contentView", id!)}>{label}</button>)}</nav>
        <label className="grid gap-1 text-xs">Поиск в полученных событиях<input type="search" value={term} onChange={event => update("contentQuery", event.target.value, true)} placeholder={view === "queues" ? "ID очереди" : "ID поста или фана"} className="min-h-10 rounded border border-border bg-card px-3 py-2 text-sm" /></label>
        {query.data && (
          <>
            {view === "queues" && <><h3 className="font-medium text-text-primary">Очередей в выборке: {query.data.queues.length}. Найдено: {queues.length}.</h3>
            {query.data.queuesHasMore && <p className="text-xs text-warning">Показаны последние 50 очередей; более ранние не входят в эту выборку.</p>}
            <div className="overflow-x-auto" role="region" aria-label="Сохранённая очередь сообщений" tabIndex={0}>
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
                  {queues.map((row) => (
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
            {queues.length === 0 && !query.isError && <p role="status">{query.data.queues.length ? "Совпадений в полученной выборке нет." : "Сохранённых событий очереди пока нет."}</p>}</>}
            {view === "likes" && <><h3 className="font-medium text-text-primary">Лайков в выборке: {query.data.likes.length}. Найдено: {likes.length}.</h3>
            {query.data.likesHasMore && <p className="text-xs text-warning">Показаны последние 50 записей; полного состава лайков эта выборка не подтверждает.</p>}
            <div className="overflow-x-auto" role="region" aria-label="Сохранённые лайки постов" tabIndex={0}>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="p-2">Пост</th>
                    <th className="p-2">Фан</th>
                    <th className="p-2">Состояние</th>
                    <th className="p-2">Время провайдера UTC</th>
                    <th className="p-2">Получено UTC</th>
                  </tr>
                </thead>
                <tbody>
                  {likes.map((row) => (
                    <tr
                      key={`${row.postRef}:${row.fanRef}`}
                      className="border-t border-border"
                    >
                      <td className="p-2">{row.postRef}</td>
                      <td className="p-2">{row.fanRef}</td>
                      <td className="p-2">{row.state === "undone" ? "Лайк снят" : "Лайк поставлен"}</td>
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
            {likes.length === 0 && !query.isError && <p role="status">{query.data.likes.length ? "Совпадений в полученной выборке нет." : "Сохранённых лайков пока нет."}</p>}</>}
            {!query.isError && !query.data.queues.length && !query.data.likes.length && (
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
