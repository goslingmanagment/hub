import { useSearchParams } from "react-router";
import { useAdminDbStats } from "@/api/queries";
import { QuerySection } from "@/components/shared/QuerySection";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
const migrationDate = new Intl.DateTimeFormat("ru-RU", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
});

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 Б";
  const units = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ", "ПиБ"];
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(bytes) / 10)));
  return `${(bytes / 1024 ** index).toLocaleString("ru-RU", { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
}

const cell = "px-4 py-3 text-sm text-text-secondary tabular-nums";
const column = "px-4 py-3 text-left text-xs font-semibold text-text-muted";
const scrollRegion = "overflow-x-auto focus-visible:outline-2 focus-visible:outline-accent";

export function DbStatsPage() {
  const query = useAdminDbStats();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const needle = search.trim().toLocaleLowerCase();
  const tables = query.data?.tables ?? [];
  const migrations = query.data?.migrations ?? [];
  const visibleTables = tables.filter(table => `${table.schema}.${table.table}`.toLocaleLowerCase().includes(needle));
  const visibleMigrations = migrations
    .filter(migration => migration.name.toLocaleLowerCase().includes(needle))
    .toSorted((left, right) => right.appliedAt.localeCompare(left.appliedAt) || right.name.localeCompare(left.name));

  function setSearch(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value);
    else next.delete("q");
    setSearchParams(next, { replace: true });
  }

  const clearSearch = <button type="button" className="text-accent underline" onClick={() => setSearch("")}>Сбросить поиск</button>;

  return (
    <div className="space-y-5 p-4 md:p-0">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">База данных</h1>
          <p className="mt-1 text-sm text-text-muted">Размеры таблиц и история применённых миграций.</p>
        </div>
        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary hover:bg-hover disabled:opacity-50">
          {query.isFetching ? "Обновляем…" : "Обновить"}
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Найти таблицу или миграцию…" />
        {search && clearSearch}
      </div>

      <QuerySection title="Статистика базы данных" hasData={Boolean(query.data)} isError={query.isError} retry={query.refetch}>
        <div className="space-y-6">
          <section className="min-w-0 rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-text-primary">Таблицы</h2>
                <span className="text-xs text-text-muted">{visibleTables.length} из {tables.length}</span>
              </div>
              <p className="mt-1 text-xs text-text-muted">Число строк — оценка PostgreSQL. Общий размер уже включает индексы.</p>
            </div>
            {visibleTables.length > 0 ? (
              <div role="region" aria-label="Размеры таблиц" tabIndex={0} className={scrollRegion}>
                <table className="w-full min-w-[600px] border-collapse">
                  <thead><tr className="bg-hover-alt">
                    {["Таблица", "Строки · оценка", "Общий размер", "Индексы"].map(label => <th key={label} scope="col" className={column}>{label}</th>)}
                  </tr></thead>
                  <tbody>{visibleTables.map(table => (
                    <tr key={`${table.schema}.${table.table}`} className="border-t border-border hover:bg-hover">
                      <th scope="row" className="px-4 py-3 text-left font-mono text-sm font-medium text-text-primary">
                        <span className="text-text-muted">{table.schema}.</span>{table.table}
                      </th>
                      <td className={cell}>{table.rowEstimate >= 0 ? table.rowEstimate.toLocaleString("ru-RU") : "—"}</td>
                      <td className={cell}>{formatBytes(table.totalBytes)}</td>
                      <td className={cell}>{formatBytes(table.indexBytes)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <div className="p-4"><StatusPanel title={needle ? "Таблицы не найдены" : "Нет сведений о таблицах"} description={needle ? "Попробуйте другое название или сбросьте поиск." : "Сервер не вернул сведения о таблицах."} action={needle ? clearSearch : undefined} /></div>
            )}
          </section>

          <section className="min-w-0 rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="font-semibold text-text-primary">Миграции</h2>
              <span className="text-xs text-text-muted">{visibleMigrations.length} из {migrations.length} · новые сверху</span>
            </div>
            {visibleMigrations.length > 0 ? (
              <div role="region" aria-label="История миграций" tabIndex={0} className={scrollRegion}>
                <table className="w-full min-w-[480px] border-collapse">
                  <thead><tr className="bg-hover-alt"><th scope="col" className={column}>Миграция</th><th scope="col" className={column}>Применена · UTC</th></tr></thead>
                  <tbody>{visibleMigrations.map(migration => (
                    <tr key={migration.name} className="border-t border-border hover:bg-hover">
                      <th scope="row" className="px-4 py-3 text-left font-mono text-sm font-medium text-text-primary">{migration.name}</th>
                      <td className={`${cell} whitespace-nowrap`}><time dateTime={migration.appliedAt}>{migrationDate.format(new Date(migration.appliedAt))}</time></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <div className="p-4"><StatusPanel title={needle ? "Миграции не найдены" : "Нет сведений о миграциях"} description={needle ? "Попробуйте другое название или сбросьте поиск." : "В ответе нет истории миграций. Это не подтверждает, что миграции не применялись."} action={needle ? clearSearch : undefined} /></div>
            )}
          </section>
        </div>
      </QuerySection>
    </div>
  );
}
