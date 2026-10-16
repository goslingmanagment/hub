import { useState } from "react";
import { useAdminDbStats } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime } from "@/lib/format";
import { DevHeader } from "./DevHeader.js";

const UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
/** The largest tables shown before «Показать все» (the server lists them largest first). */
const TABLES_SHOWN = 15;
/** The latest migrations shown before «Показать все» (the server lists them oldest first). */
const MIGRATIONS_SHOWN = 10;

function ShowAll({ total, shown, open, onToggle }: { total: number; shown: number; open: boolean; onToggle: () => void }) {
  if (total <= shown) return null;
  return (
    <div className="card-footer">
      <span>{open ? `Показаны все: ${total}` : `Показано ${shown} из ${total}`}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onToggle} aria-expanded={open}>
        {open ? "Свернуть" : "Показать все"}
      </button>
    </div>
  );
}

/** A size the way a person reads it ("1,5 МБ"); an unknown one is a dash, never zero. */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 Б";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: i === 0 ? 0 : 1 })} ${UNITS[i]}`;
}

/** System → «База данных»: table sizes and the migrations applied. */
export function DbStatsPage() {
  const { data, isLoading, isError, error } = useAdminDbStats();
  const [allTables, setAllTables] = useState(false);
  const [allMigrations, setAllMigrations] = useState(false);

  const header = <DevHeader title="База данных" description="Размер таблиц и применённые миграции." />;

  if (isLoading || !data) {
    return (
      <div>
        {header}
        {isLoading ? (
          <StatusPanel title="Загружаем данные о базе" />
        ) : isError ? (
          <StatusPanel title="Данные о базе не загрузились" description="Hub не ответил. Попробуйте обновить страницу." tone="error" />
        ) : (
          <StatusPanel title="Данные о базе недоступны" description="Hub не вернул данных." tone="error" />
        )}
      </div>
    );
  }

  const tables = data.tables ?? [];
  const migrations = data.migrations ?? [];
  const shownTables = allTables ? tables : tables.slice(0, TABLES_SHOWN);
  // The latest first: the one applied last is what a deploy is checked against.
  const latestFirst = [...migrations].reverse();
  const shownMigrations = allMigrations ? latestFirst : latestFirst.slice(0, MIGRATIONS_SHOWN);

  return (
    <div className="space-y-5">
      {header}
      {isError && <StaleDataNotice error={error} />}

      <section className="card" aria-labelledby="db-tables-title">
        <div className="card-header">
          <div>
            <h3 id="db-tables-title" className="card-title">Таблицы</h3>
            <p className="card-description">Самые большие сверху.</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Таблица</th>
                <th className="num">Строк (оценка)</th>
                <th className="num">Всего</th>
                <th className="num">Индексы</th>
              </tr>
            </thead>
            <tbody>
              {tables.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-text-muted">Данных о таблицах нет.</td>
                </tr>
              )}
              {shownTables.map((t) => (
                <tr key={t.table}>
                  <td className="font-mono text-xs font-medium">{t.table}</td>
                  <td className="num">{t.rowEstimate != null ? Number(t.rowEstimate).toLocaleString("ru-RU") : "—"}</td>
                  <td className="num">{formatBytes(t.totalBytes)}</td>
                  <td className="num">{formatBytes(t.indexBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ShowAll total={tables.length} shown={TABLES_SHOWN} open={allTables} onToggle={() => setAllTables((value) => !value)} />
      </section>

      <section className="card" aria-labelledby="db-migrations-title">
        <div className="card-header">
          <div>
            <h3 id="db-migrations-title" className="card-title">Миграции</h3>
            <p className="card-description">Последние применённые сверху.</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Миграция</th>
                <th>Применена</th>
              </tr>
            </thead>
            <tbody>
              {migrations.length === 0 && (
                <tr>
                  <td colSpan={2} className="py-8 text-center text-text-muted">Миграций нет.</td>
                </tr>
              )}
              {shownMigrations.map((m) => (
                <tr key={m.name ?? "unknown-migration"}>
                  <td className="font-mono text-xs font-medium">{m.name ?? "—"}</td>
                  <td className="muted whitespace-nowrap">{m.appliedAt ? formatDateTime(m.appliedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ShowAll
          total={migrations.length}
          shown={MIGRATIONS_SHOWN}
          open={allMigrations}
          onToggle={() => setAllMigrations((value) => !value)}
        />
      </section>
    </div>
  );
}
