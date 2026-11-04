import { useState } from "react";
import { useAdminOfapiStoredReads } from "@/api/adminOfapiStoredReads";
import { formatDateTime, formatMills } from "@/lib/format";
const label: Record<string, string> = {
  ofapi_read_user_lists: "Пользовательские списки",
  ofapi_read_user_list: "Сведения о списке",
  ofapi_read_user_list_users: "Участники списка",
  ofapi_read_user_list_pinned_users: "Закреплённые участники",
};
const coverageLabels: Record<string, string> = { complete: "полный", partial: "частичный", unknown: "неизвестна" };
const contactabilityLabels: Record<string, string> = {
  blocked: "заблокирован", restricted: "ограничен", contactable: "можно писать",
  unavailable: "сообщения недоступны", unknown: "неизвестно",
};
const membershipLabels: Record<string, string> = { members: "участники", pinned_only: "только закреплённые" };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const value = (input: unknown) =>
  typeof input === "string" || typeof input === "number" ? String(input) : "—";
/** A known enum in words, its raw value in a tooltip; anything else as sent. */
function Labeled({ raw, labels }: { raw: unknown; labels: Record<string, string> }) {
  const text = value(raw);
  return <span title={text}>{labels[text] ?? text}</span>;
}
function Instant({ raw }: { raw: unknown }) {
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) return <>{value(raw)}</>;
  return <span title={raw}>{formatDateTime(raw, { yearUnlessCurrent: true })}</span>;
}
function spend(input: unknown) {
  if (
    typeof input !== "string" ||
    !/^-?\d+$/.test(input) ||
    !Number.isSafeInteger(Number(input))
  )
    return "—";
  return formatMills(Number(input));
}
/** Bounded DB-first inspection for any stored read, with explicit list/member semantics.
 *  The card around it (title, description) belongs to the screen. */
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
    <div className="space-y-4 text-sm">
      <p className="text-text-secondary">
        Просмотр читает только базу Hub. Выберите страницу и сохранённый ответ. Сбор и действия с участниками отсюда не
        запускаются.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Страница сохранённых данных"
          className="select w-auto min-w-[200px]"
          value={pageId ?? ""}
          disabled={pages.length === 0}
          onChange={(event) => {
            setSelectedPage(Number(event.target.value));
            setSnapshotId(null);
          }}
        >
          {pages.length === 0 && <option value="">Нет страниц OnlyFans</option>}
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Набор сохранённых данных"
          className="select w-auto min-w-[200px]"
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
          className="btn"
          disabled={pageId === undefined || query.isFetching}
          onClick={() => void query.refetch()}
        >
          Обновить
        </button>
      </div>
      {pages.length === 0 && <p className="text-text-secondary">Добавьте страницу OnlyFans, чтобы просматривать её сохранённые ответы.</p>}
      {query.isError && (
        <p role="alert" className="notice notice-warning">Не удалось обновить данные. Повторите чтение; ниже остаётся предыдущий срез, если он был загружен.</p>
      )}
      {query.isLoading && <p className="text-text-secondary">Читаем сохранённые данные…</p>}
      {query.data && !query.data.snapshots.length && (
        <p className="text-text-secondary">
          Сохранённых ответов пока нет. Нужный сбор включается в «Сбор OnlyFans» или разовой задачей.
        </p>
      )}
      {!!query.data?.snapshots.length && (
        <select
          aria-label="Сохранённый ответ"
          className="select max-w-full"
          value={snapshot?.id ?? ""}
          onChange={(event) => setSnapshotId(event.target.value)}
        >
          {query.data.snapshots.map((row) => (
            <option key={row.id} value={row.id}>
              {label[row.operation] ?? row.operation} · {formatDateTime(row.observedAt, { yearUnlessCurrent: true })} · {row.items.length} строк
            </option>
          ))}
        </select>
      )}
      {snapshot && (
        <>
          <p className="text-text-secondary">
            <strong className="text-text-primary">
              {label[snapshot.operation] ?? snapshot.operation}
            </strong>{" "}
            · получено <Instant raw={snapshot.observedAt} /> · полнота ответа:{" "}
            <Labeled raw={snapshot.coverage.state} labels={coverageLabels} />
            {snapshot.coverage.nextQuery ? " · есть следующая страница" : ""}
            {snapshot.window.from || snapshot.window.to
              ? <> · окно: {snapshot.window.from ? <Instant raw={snapshot.window.from} /> : "не задано"} — {snapshot.window.to ? <Instant raw={snapshot.window.to} /> : "не задано"}</>
              : ""}
          </p>
          {listPreview && (
            <p className="text-text-secondary">
              Вложенные пользователи — превью, не полный состав. Число пользователей — отдельное число провайдера. Полный
              состав читается отдельным ограниченным заданием участников.
            </p>
          )}
          {members && (
            <p className="text-text-secondary">
              {snapshot.operation === "ofapi_read_user_list_pinned_users"
                ? "Только закреплённые участники. "
                : "Участники в этом ответе. "}
              Старая страница остаётся историей; отсутствие фана в частичном ответе не удаляет его из списка.
            </p>
          )}
          <details className="help">
            <summary>Технические детали</summary>
            <div className="help-body max-w-none text-xs">
              <p>
                OnlyFansAPI · источник #{snapshot.observationId} · возраст {snapshot.ageSeconds} с · полнота{" "}
                <span className="font-mono">{snapshot.coverage.state}</span>
                {snapshot.coverage.reason ? <> · <span className="font-mono">{snapshot.coverage.reason}</span></> : ""}
              </p>
              <p className="break-all font-mono">
                {snapshot.pathname} ·{" "}
                {Object.entries(snapshot.query)
                  .map(([key, val]) => `${key}=${val}`)
                  .join(" · ") || "без параметров"}
              </p>
            </div>
          </details>
          <div className="table-wrap">
            <table className="data-table min-w-[720px]">
              <thead>
                <tr>
                  <th>ID / имя</th>
                  <th>Список / состав</th>
                  <th>Сведения</th>
                  <th>Можно ли писать</th>
                  <th>Последний ответ / траты фана</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.items.slice(0, 100).map((raw, index) => {
                  const row = record(raw);
                  return (
                    <tr key={`${value(row.nativeId)}:${index}`}>
                      <td className="align-top">
                        <span className="font-mono text-xs">{value(row.nativeId)}</span>
                        <span className="block">
                          {value(
                            row.listName ??
                              row.name ??
                              row.username ??
                              row.text,
                          )}
                        </span>
                      </td>
                      <td className="align-top">
                        {value(row.listId)}
                        {listPreview
                          ? ` · пользователей: ${value(row.usersCount)} · превью: ${Array.isArray(row.previewUsers) ? row.previewUsers.length : 0}`
                          : members
                            ? <> · <Labeled raw={row.membershipScope} labels={membershipLabels} /></>
                            : ""}
                      </td>
                      <td className="max-w-md align-top">
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
                      <td className="align-top"><Labeled raw={row.contactability} labels={contactabilityLabels} /></td>
                      <td className="align-top">
                        <Instant raw={row.lastReplyAt} />
                        <span className="block">{spend(row.priorSpendMills)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {snapshot.items.length > 100 && (
            <p className="text-text-secondary">Показаны первые 100 строк этого ответа.</p>
          )}
        </>
      )}
    </div>
  );
}
