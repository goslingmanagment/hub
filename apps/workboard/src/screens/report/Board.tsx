import type { ShiftReportResponse } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { Header } from "./Header";
import { Ico } from "./icons";
import { useBoardKeys } from "./keys";
import { otherShiftWords, plural, rowByKey, said, type Board } from "./model";
import { OwnerMenu } from "./OwnerMenu";
import { PageCard } from "./PageCard";
import { Panels } from "./Panels";
import { Rail } from "./Rail";
import { useBoard, type BoardApi, type Host } from "./useBoard";
import type { PortTransport } from "./transport";
import "./board.css";

/**
 * The «Отчёт» board (package R; the design of 2026-11-21, report-board-redesign/synthesis/mockup.html): one component,
 * in a Workboard tab (`/report/:shiftId`, the cookie session) and in the extension's frame over the site
 * (`/frame/report`, the port). The head with the phase's steps; the pages as cards, each sale a row with its tick and
 * «чья»; the rail with the total, the check and the one press of the phase. State and writes: useBoard.ts; the words:
 * model.ts.
 */
export function ReportBoard({ report, host, transport, light }: {
  report: ShiftReportResponse & { board: Board };
  host: Host;
  transport?: PortTransport | null;
  /** The row to light when the board opens (`?sale=`, a matter's link). */
  light?: number | null;
}) {
  const api = useBoard({ report, host, transport: transport ?? null, light: light ?? null });
  useBoardKeys(api);
  const menuRow = api.menu === null ? null : rowByKey(api.board, api.menu);
  return (
    // In the frame the board takes the scheme the frame is given, never a choice saved in Workboard (board.css).
    <div className={host === "frame" ? "rb is-frame" : "rb"}>
      <Header api={api} />
      <main className="main" ref={api.mainRef}>
        <div className="wrap">
          <div className="list">
            <Banners api={api} />
            <PageList api={api} />
          </div>
          <Rail api={api} />
        </div>
      </main>
      {menuRow && <OwnerMenu api={api} row={menuRow} key={menuRow.key} />}
      <Panels api={api} />
      <div className={`toast${api.toastText.on ? " is-on" : ""}`} role="status" aria-live="polite">{api.toastText.text}</div>
    </div>
  );
}

/** The pages as cards; a shift on two models' pages names each model over its pages. */
function PageList({ api }: { api: BoardApi }) {
  const columns = api.board.columns;
  const models = [...new Set(columns.map((column) => column.modelName ?? ""))];
  if (models.length < 2) return <>{columns.map((column) => <PageCard api={api} column={column} key={column.pageLabel} />)}</>;
  return (
    <>
      {models.map((model) => {
        const pages = columns.filter((column) => (column.modelName ?? "") === model);
        return [
          <div className="mh" key={`m-${model}`}><b>{model}</b><span>{pages.length} {plural(pages.length, "страница", "страницы", "страниц")}</span></div>,
          ...pages.map((column) => <PageCard api={api} column={column} key={column.pageLabel} />),
        ];
      })}
    </>
  );
}

/** Over the pages of one's own board: another shift that waits for the person, and the comment of the shift before. */
function Banners({ api }: { api: BoardApi }) {
  const { board, own, host } = api;
  if (!own) return null;
  const previous = board.previous ?? null;
  return (
    <>
      {(board.otherShifts ?? []).map((one) => (
        // Another shift of the person waits for them: its sales count only in its own report, so the way is here.
        <div className={`banner${one.ongoing ? " is-calm" : ""}`} key={one.shiftId}>
          <Ico name="report" size={18} />
          <span className="t">{otherShiftWords(one)}</span>
          <Link to={host === "tab" ? `/report/${one.shiftId}` : { search: `?shift=${one.shiftId}` }} className="btn btn--sec btn--sm"
            onClick={() => void api.commitNote()}>{one.ongoing ? "Вернуться" : "Открыть"}</Link>
        </div>
      ))}
      {previous !== null && previous.comment.trim() !== "" && (
        <div className="banner is-calm">
          <Ico name="note" size={18} />
          <span className="t">От прошлой смены ({previous.user.forms.nom}){said(previous.comment)}</span>
        </div>
      )}
    </>
  );
}
