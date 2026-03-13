import { useAdminDbStats } from "@/api/queries";
import { formatDateTime } from "@/lib/format";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function DbStatsPage() {
  const { data, isLoading } = useAdminDbStats();

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-text-muted text-sm">Loading...</span>
      </div>
    );
  }

  const tables = data.tables ?? [];
  const migrations = data.migrations ?? [];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">Database Stats</h1>
        <p className="text-sm text-text-muted mt-1">Table sizes and migrations</p>
      </div>

      {/* Tables */}
      <section className="overflow-hidden rounded-xl border border-border bg-card mb-8">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Tables</h2>
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Table", "Rows", "Total Size", "Index Size"].map((col) => (
                <th
                  key={col}
                  className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tables.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-text-muted">
                  No table data available.
                </td>
              </tr>
            )}
            {tables.map((t: any) => (
              <tr
                key={t.table}
                className="border-t border-border transition-colors hover:bg-hover"
              >
                <td className="px-4 py-3 text-sm text-text-primary font-medium font-mono">
                  {t.table}
                </td>
                <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                  {t.rowEstimate != null ? Number(t.rowEstimate).toLocaleString() : "\u2014"}
                </td>
                <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                  {formatBytes(t.totalBytes)}
                </td>
                <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                  {formatBytes(t.indexBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Migrations */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Migrations</h2>
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Name", "Hash", "Applied"].map((col) => (
                <th
                  key={col}
                  className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {migrations.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-sm text-text-muted">
                  No migrations found.
                </td>
              </tr>
            )}
            {migrations.map((m: any, idx: number) => (
              <tr
                key={m.id ?? idx}
                className="border-t border-border transition-colors hover:bg-hover"
              >
                <td className="px-4 py-3 text-sm text-text-primary font-medium font-mono">
                  {m.hash ? m.hash.slice(0, 16) : `#${m.id ?? idx}`}
                </td>
                <td className="px-4 py-3 text-sm text-text-muted font-mono">
                  {m.hash ?? "\u2014"}
                </td>
                <td className="px-4 py-3 text-sm text-text-secondary">
                  {m.createdAt ? formatDateTime(m.createdAt) : "\u2014"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
