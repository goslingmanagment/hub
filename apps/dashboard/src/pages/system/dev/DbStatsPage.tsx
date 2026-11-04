import { useState } from "react";
import { useAdminDbStats } from "@/api/queries";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatCount, formatDateTime } from "@/lib/format";
import { freshOf } from "../shared.js";

const UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
/** The largest tables shown before «Показать все» (the server lists them largest first). */
const TABLES_SHOWN = 15;
/** The latest migrations shown before «Показать все» (the server lists them oldest first). */
const MIGRATIONS_SHOWN = 10;

function ShowAll({ total, shown, open, onToggle }: { total: number; shown: number; open: boolean; onToggle: () => void }) {
  if (total <= shown) return null;
  return (
    <div className="card-footer">
      <span className="text-text-secondary">{open ? `Показаны все: ${total}` : `Показано ${shown} из ${total}`}</span>
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
  const query = useAdminDbStats();
  const { data, isLoading, isError } = query;
  const [allTables, setAllTables] = useState(false);
  const [allMigrations, setAllMigrations] = useState(false);

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        {isLoading ? (
          <>
            <StatCardSkeleton count={3} />
            <div className="card"><TableSkeleton rows={8} columns={4} /></div>
          </>
        ) : (
          <div className="card"><NoAnswerPanel retry={query.refetch} /></div>
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

  // A size is not money: the sum is the bytes' own, for show only. An unknown table size stays out, never a zero.
  const known = tables.map((t) => t.totalBytes).filter((bytes): bytes is number => bytes != null && Number.isFinite(bytes));
  const total = known.length === 0 ? null : known.reduce((sum, bytes) => sum + bytes, 0);
  const lastMigration = latestFirst[0];

  return (
    <div className="space-y-6">
      <PageHeader fresh={freshOf(query)} />
      {isError && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
          {staleDataText(query.dataUpdatedAt)}
        </Notice>
      )}
      <StatGrid className="sys-tiles-3">
        <Stat label="Размер базы" value={formatBytes(total)} meta={known.length < tables.length ? "без таблиц с неизвестным размером" : "все таблицы"} />
        <Stat label="Таблиц" value={formatCount(tables.length)} />
        <Stat
          label="Миграций"
          value={formatCount(migrations.length)}
          meta={lastMigration?.appliedAt ? `последняя ${formatDateTime(lastMigration.appliedAt, { yearUnlessCurrent: true })}` : undefined}
        />
      </StatGrid>

      <section className="card" aria-labelledby="db-tables-title">
        <div className="card-header">
          <div>
            <h2 id="db-tables-title" className="card-title">Таблицы</h2>
            <p className="card-description">Самые большие сверху.</p>
          </div>
        </div>
        <div className="table-wrap">
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
                  <td colSpan={4} className="text-center text-text-secondary">Данных о таблицах нет.</td>
                </tr>
              )}
              {shownTables.map((t) => (
                <tr key={t.table}>
                  <td><span className="sys-code sys-code-strong">{t.table}</span></td>
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
            <h2 id="db-migrations-title" className="card-title">Миграции</h2>
            <p className="card-description">Последние применённые сверху.</p>
          </div>
        </div>
        <div className="table-wrap">
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
                  <td colSpan={2} className="text-center text-text-secondary">Миграций нет.</td>
                </tr>
              )}
              {shownMigrations.map((m) => (
                <tr key={m.name ?? "unknown-migration"}>
                  <td><span className="sys-code sys-code-strong">{m.name ?? "—"}</span></td>
                  <td className="muted whitespace-nowrap">{m.appliedAt ? formatDateTime(m.appliedAt, { yearUnlessCurrent: true }) : "—"}</td>
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
