import { Link } from "react-router";
import { shiftPath } from "@/shared/links";
import { Ico } from "./icons";
import { clock, day, salesCount, usd } from "./model";
import type { BoardApi } from "./useBoard";

/**
 * «Отчёт учтён»: the rail as the receipt of the counted report, each page's sum (under its model's name when the shift
 * has two models), «Итого, N продаж» with Hub's total; in a tab the way to the shift's page.
 */
export function Receipt({ api }: { api: BoardApi }) {
  const { board, report, host } = api;
  const models = [...new Set(board.columns.map((column) => column.modelName ?? ""))];
  const version = report.latest?.version ?? 1;
  return (
    <div className="rc">
      <div className="rc-ic"><Ico name="check" size={24} /></div>
      <div className="rc-t">Отчёт учтён</div>
      {board.countedAt !== null && <div className="rc-s">{day(board.countedAt)}, {clock(board.countedAt)}{version > 1 ? `, версия ${version}` : ""}</div>}
      <div className="perf" />
      {models.map((model) => (
        <div key={model}>
          {models.length > 1 && model !== "" && <div className="rl is-model"><span>{model}</span></div>}
          {board.columns.filter((column) => (column.modelName ?? "") === model).map((column) => (
            <div className="rl" key={column.pageLabel}><span>{column.pageLabel}</span><i /><b>{usd(column.sumMills)}</b></div>
          ))}
        </div>
      ))}
      <div className="perf" />
      <div className="rl is-tot"><span>Итого, {salesCount(board.totals.count)}</span><i /><b>{usd(board.totals.nowMills)}</b></div>
      {host === "tab" && <Link to={shiftPath(report.shift.userId, report.shift.startedAt)} className="lk rc-l">Итог смены</Link>}
    </div>
  );
}
