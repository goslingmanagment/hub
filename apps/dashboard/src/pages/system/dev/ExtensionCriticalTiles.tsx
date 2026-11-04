import type { AdminClientHealthResponse } from "@agency_hub_core/contracts";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatCount } from "@/lib/format";

/** The four critical counters, the same number as the row of «Ждут вас» at 7 days. */
export const CRITICAL_COUNTERS: ReadonlyArray<readonly [code: string, label: string]> = [
  ["p1.insert-misplaced", "Вставка в чужой чат"],
  ["p1.send-without-human", "Отправка без человека"],
  ["p1.read-without-human", "Чтение чата без человека"],
  ["p1.other", "Другой критичный сбой"],
];

/** The tiles of «Расширение: замеры»: in the main colour; under a non-zero one, «нужно разобрать». No answer is «—». */
export function ExtensionCriticalTiles({ data }: { data: AdminClientHealthResponse | undefined }) {
  return (
    <StatGrid>
      {CRITICAL_COUNTERS.map(([code, label]) => {
        // The extension sends `p1.other` only once such an error happened: its absence is a zero.
        const total = data ? data.counters.find((row) => row.code === code)?.total ?? 0 : null;
        return (
          <Stat
            key={code}
            label={label}
            value={total === null ? "—" : formatCount(total)}
            meta={total === null ? "Hub не ответил" : total > 0 ? <span className="badge badge-bare badge-danger">нужно разобрать</span> : "за период не было"}
          />
        );
      })}
    </StatGrid>
  );
}
