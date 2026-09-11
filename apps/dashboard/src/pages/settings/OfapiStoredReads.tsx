import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useAdminOfapiStoredReads } from "@/api/adminOfapiStoredReads";
import { formatMills } from "@/lib/format";
import { resolveOfapiPage } from "@/lib/ofapiNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
const label: Record<string, string> = {
  ofapi_read_user_lists: "Пользовательские списки",
  ofapi_read_user_list: "Сведения о списке",
  ofapi_read_user_list_users: "Участники списка",
  ofapi_read_user_list_pinned_users: "Закреплённые участники",
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const value = (input: unknown) =>
  typeof input === "string" || typeof input === "number" ? String(input) : "—";
function spend(input: unknown) {
  if (
    typeof input !== "string" ||
    !/^-?\d+$/.test(input) ||
    !Number.isSafeInteger(Number(input))
  )
    return "—";
  return formatMills(Number(input));
}
/** Bounded DB-first inspection for any stored read, with explicit list/member semantics. */
export function OfapiStoredReads({
  pages,
}: {
  pages: { id: number; label: string }[];
}) {
  const [search, setSearch] = useSearchParams();
  const selectedPage = resolveOfapiPage(pages, search.get("page"));
  const pageId = selectedPage?.id;
  const operation = search.get("storedOperation") ?? "";
  const snapshotId = search.get("storedSnapshot");
  const term = search.get("storedQuery") ?? "";
  const [shown, setShown] = useState(100);
  const query = useAdminOfapiStoredReads(pageId, operation);
  const snapshot = snapshotId === null ? query.data?.snapshots[0] : query.data?.snapshots.find(row => row.id === snapshotId);
  function update(values: Record<string, string | null>, replace = false) {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(values)) value === null ? next.delete(key) : next.set(key, value);
    setSearch(next, { replace });
  }
  useEffect(() => { setShown(100); }, [snapshot?.id, term]);
  useEffect(() => { if (snapshotId === null && snapshot) update({ storedSnapshot: snapshot.id }, true); }, [snapshotId, snapshot?.id]);
  const rows = snapshot?.items.filter(row => !term.trim() || JSON.stringify(row).toLocaleLowerCase().includes(term.trim().toLocaleLowerCase())) ?? [];
  const listPreview = [
    "ofapi_read_user_list",
    "ofapi_read_user_lists",
  ].includes(snapshot?.operation ?? "");
  const members = [
    "ofapi_read_user_list_users",
    "ofapi_read_user_list_pinned_users",
  ].includes(snapshot?.operation ?? "");
  return (
    <details className="rounded-xl border border-border bg-card p-4">
      <summary className="min-h-10 cursor-pointer text-sm font-semibold text-text-primary focus-visible:outline-2">
        Сохранённые данные и участники списков
      </summary>
      <div className="mt-3 space-y-3 text-sm text-text-secondary">
        <p>
          Просмотр читает только Hub. Выберите страницу и сохранённый ответ.
          Автоматический сбор и действия с участниками отсюда не запускаются.
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Страница сохранённых данных"
            className="min-h-10 min-w-0 max-w-full rounded border border-border bg-card p-2"
            value={selectedPage?.label ?? ""}
            onChange={(event) => {
              update({ page: event.target.value, storedSnapshot: null });
            }}
          >
            {!selectedPage && <option value="">Выберите страницу</option>}
            {pages.map((page) => (
              <option key={page.id} value={page.label}>
                {page.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Набор сохранённых данных"
            className="min-h-10 min-w-0 max-w-full rounded border border-border bg-card p-2"
            value={operation}
            onChange={(event) => {
              update({ storedOperation: event.target.value || null, storedSnapshot: null });
            }}
          >
            <option value="">Все наборы · последние 25 ответов</option>
            {operation && !query.data?.catalog.some(item => item.operation === operation) && <option value={operation}>{operation}</option>}
            {query.data?.catalog.map((item) => (
              <option key={item.operation} value={item.operation}>
                {label[item.operation] ?? item.id}
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
        {!selectedPage && <StatusPanel title="Выберите страницу для сохранённых данных" description="Для просмотра отдельного ответа нужен доступный аккаунт. Страница из ссылки не подменяется первым аккаунтом." />}
        <QueryNotice error={query.isError} stale={query.data !== undefined} retry={query.refetch} />
        {pageId !== undefined && query.isLoading && !query.data && <p role="status">Чтение сохранённых данных…</p>}
        {query.data && !query.isError && !query.data.snapshots.length && (
          <p>
            Сохранённых ответов пока нет. Нужный сбор разрешает владелец
            отдельной политикой или разовым заданием.
          </p>
        )}
        {!!query.data?.snapshots.length && (
          <select
            aria-label="Сохранённый ответ"
            className="max-w-full rounded border border-border bg-card p-2"
            value={snapshot?.id ?? ""}
            onChange={(event) => update({ storedSnapshot: event.target.value })}
          >
            {!snapshot && <option value="">Ответ из ссылки не найден среди последних 25</option>}
            {query.data.snapshots.map((row) => (
              <option key={row.id} value={row.id}>
                {label[row.operation] ?? row.operation} · {row.observedAt} ·{" "}
                {row.pathname} · {row.items.length} строк
              </option>
            ))}
          </select>
        )}
        {snapshotId !== null && query.data && !snapshot && <p role="status" className="text-warning">Выбранного ответа нет в текущей выборке. Выберите сохранённый ответ из списка выше.</p>}
        {query.data?.snapshots.length === 25 && <p className="text-xs text-text-muted">Показаны последние 25 ответов. Более ранние ответы могут не попасть в выборку; уточните набор данных.</p>}
        {snapshot && (
          <>
            <p>
              <strong className="text-text-primary">
                {label[snapshot.operation] ?? snapshot.operation}
              </strong>{" "}
              · OnlyFansAPI · получено {snapshot.observedAt} · возраст{" "}
              {snapshot.ageSeconds} с · источник #{snapshot.observationId}
            </p>
            <p>
              Окно: {snapshot.window.from ?? "не задано"} —{" "}
              {snapshot.window.to ?? "не задано"}. Полнота ответа:{" "}
              {{ complete: "полный ответ", partial: "частичный ответ", unknown: "неизвестна" }[snapshot.coverage.state]}
              {snapshot.coverage.reason ? ` · ${snapshot.coverage.reason}` : ""}
              .{" "}
              {snapshot.coverage.nextQuery
                ? "Существует следующая страница."
                : ""}
            </p>
            <p className="text-xs">
              {snapshot.pathname} ·{" "}
              {Object.entries(snapshot.query)
                .map(([key, val]) => `${key}=${val}`)
                .join(" · ") || "без параметров"}
            </p>
            {listPreview && (
              <p>
                Вложенные пользователи — превью, не полный состав. usersCount —
                отдельное число провайдера. Полный состав читается отдельным
                ограниченным заданием участников.
              </p>
            )}
            {members && (
              <p>
                {snapshot.operation === "ofapi_read_user_list_pinned_users"
                  ? "Только закреплённые участники. "
                  : "Участники в этом ответе. "}
                Старая страница остаётся историей; отсутствие фана в частичном
                ответе не удаляет его из списка.
              </p>
            )}
            <label className="grid gap-1 text-xs">Поиск в выбранном ответе<input className="min-h-10 rounded border border-border bg-card px-3 py-2 text-sm" type="search" value={term} onChange={event => update({ storedQuery: event.target.value || null }, true)} placeholder="ID, имя или текст" /></label>
            <p className="text-xs">Строк в ответе: {snapshot.items.length}. Найдено: {rows.length}. Показано: {Math.min(shown, rows.length)}.</p>
            {rows.length === 0 && <p role="status">{snapshot.items.length === 0 ? "В этом сохранённом ответе нет строк. Полноту определяет состояние ответа выше." : "Совпадений в выбранном ответе нет."}</p>}
            <div className="overflow-x-auto" role="region" aria-label="Строки сохранённого ответа" tabIndex={0}>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="p-2">ID / имя</th>
                    <th className="p-2">Список / состав</th>
                    <th className="p-2">Сведения</th>
                    <th className="p-2">Доступность</th>
                    <th className="p-2">Последний ответ / расходы фана</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, shown).map((raw, index) => {
                    const row = record(raw);
                    return (
                      <tr
                        key={`${value(row.nativeId)}:${index}`}
                        className="border-t border-border"
                      >
                        <td className="p-2">
                          {value(row.nativeId)}
                          <br />
                          {value(
                            row.listName ??
                              row.name ??
                              row.username ??
                              row.text,
                          )}
                        </td>
                        <td className="p-2">
                          {value(row.listId)}
                          {listPreview
                            ? ` · пользователей: ${value(row.usersCount)} · превью: ${Array.isArray(row.previewUsers) ? row.previewUsers.length : "неизвестно"}`
                            : members
                              ? ` · ${value(row.membershipScope)}`
                              : ""}
                        </td>
                        <td className="max-w-md p-2">
                          {typeof row.text === "string" && (
                            <div className="whitespace-pre-wrap break-words">{row.text.slice(0, 500)}{row.text.length > 500 && <details><summary className="cursor-pointer text-accent">Показать текст целиком</summary>{row.text}</details>}</div>
                          )}
                          {Array.isArray(row.replies) &&
                            row.replies.length > 0 && (
                              <p>Вложенных ответов: {row.replies.length}</p>
                            )}
                          {Array.isArray(row.media) && row.media.length > 0 && (
                            <p>Медиа: {row.media.length}</p>
                          )}
                          {Array.isArray(row.metrics) &&
                            row.metrics.slice(0, 8).map((rawMetric, index) => {
                              const metric = record(rawMetric);
                              return (
                                <p key={index}>
                                  {value(metric.path)}:{" "}
                                  {metric.valueMills !== null &&
                                  metric.valueMills !== undefined
                                    ? spend(metric.valueMills)
                                    : value(metric.value)}
                                </p>
                              );
                            })}
                        </td>
                        <td className="p-2">{value(row.contactability)}</td>
                        <td className="p-2">
                          {value(row.lastReplyAt)}
                          <br />
                          {spend(row.priorSpendMills)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > shown && <button type="button" className="min-h-10 rounded border border-border px-3 py-2" onClick={() => setShown(current => current + 100)}>Показать ещё 100 строк</button>}
          </>
        )}
      </div>
    </details>
  );
}
