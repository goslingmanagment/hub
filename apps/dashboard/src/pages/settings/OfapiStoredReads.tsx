import { useState } from "react";
import { useAdminOfapiStoredReads } from "@/api/adminOfapiStoredReads";
import { formatMills } from "@/lib/format";
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
  const [selectedPage, setSelectedPage] = useState<number | null>(null),
    [operation, setOperation] = useState(""),
    [snapshotId, setSnapshotId] = useState<string | null>(null);
  const pageId = selectedPage ?? pages[0]?.id,
    query = useAdminOfapiStoredReads(pageId, operation);
  const snapshot =
    query.data?.snapshots.find((row) => row.id === snapshotId) ??
    query.data?.snapshots[0];
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
      <summary className="cursor-pointer text-sm font-semibold text-text-primary">
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
            className="rounded border border-border bg-card p-2"
            value={pageId ?? ""}
            onChange={(event) => {
              setSelectedPage(Number(event.target.value));
              setSnapshotId(null);
            }}
          >
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Набор сохранённых данных"
            className="rounded border border-border bg-card p-2"
            value={operation}
            onChange={(event) => {
              setOperation(event.target.value);
              setSnapshotId(null);
            }}
          >
            <option value="">Все наборы · последние 25 ответов</option>
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
        {query.isError && (
          <p role="alert">Не удалось прочитать данные. Повторите чтение.</p>
        )}
        {query.isLoading && <p>Чтение сохранённых данных…</p>}
        {query.data && !query.data.snapshots.length && (
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
            onChange={(event) => setSnapshotId(event.target.value)}
          >
            {query.data.snapshots.map((row) => (
              <option key={row.id} value={row.id}>
                {label[row.operation] ?? row.operation} · {row.observedAt} ·{" "}
                {row.pathname} · {row.items.length} строк
              </option>
            ))}
          </select>
        )}
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
              {snapshot.coverage.state}
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
            <div className="overflow-x-auto">
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
                  {snapshot.items.slice(0, 100).map((raw, index) => {
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
                            ? ` · пользователей: ${value(row.usersCount)} · превью: ${Array.isArray(row.previewUsers) ? row.previewUsers.length : 0}`
                            : members
                              ? ` · ${value(row.membershipScope)}`
                              : ""}
                        </td>
                        <td className="max-w-md p-2">
                          {typeof row.text === "string" && (
                            <p className="whitespace-pre-wrap">
                              {row.text.slice(0, 500)}
                            </p>
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
            {snapshot.items.length > 100 && (
              <p>Показаны первые 100 строк этого ответа.</p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
