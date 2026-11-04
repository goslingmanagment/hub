import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";

export interface ChartTableColumn<Row> {
  key: string;
  label: string;
  /** Numbers stand on the right. */
  num?: boolean;
  value: (row: Row) => ReactNode;
}

/**
 * «Числа таблицей» under a chart: no value lives only in a tooltip. Folded, and built
 * at the first opening: a year of days is not worth rendering for nobody.
 */
export function ChartTable<Row>({ rows, columns, rowKey, caption }: {
  rows: readonly Row[];
  columns: readonly ChartTableColumn<Row>[];
  rowKey: (row: Row) => string;
  caption: string;
}) {
  return (
    <Disclosure label="Числа таблицей" lazy>
      <div className="table-wrap">
        <table className="data-table data-table-dense" aria-label={caption}>
          <thead>
            <tr>
              {columns.map((column) => <th key={column.key} scope="col" className={column.num ? "num" : undefined}>{column.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => <td key={column.key} className={column.num ? "num" : undefined}>{column.value(row)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Disclosure>
  );
}
