import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { createClient } from "@kernel/sdk";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { Gate, useFramePort } from "@/shared/frame";
import { kernel as sessionKernel } from "@/shared/hub";
import { ReportBoard, type Host } from "./Board";
import { BoardKernel, useCurrentReport, useReport } from "./data";
import { frameState } from "./model";
import type { PortTransport } from "./transport";
import type { ShiftReportResponse } from "@agency_hub_core/contracts";
import "./board.css";

/**
 * The «Отчёт» board's addresses (package R, R-board.md §1): `/report/:shiftId` and `/report` in a Workboard tab on the
 * cookie session (inside the sign-in gate, without Workboard's frame: the board is the whole window), and
 * `/frame/report[?shift=<id>]` — the same board in the extension's frame over the site, outside the sign-in gate:
 * it never reads `me`, a cookie or storage for auth; its requests go over the extension's port (transport.ts).
 */

const TITLE = "Отчёт смены";

function Failed({ error, host, retry }: { error: unknown; host: Host; retry: () => void }) {
  const status = hubErrorStatus(error);
  if (status === 401 && host === "frame") return <Gate><b>ChatGoose не вошёл в Hub</b>Войдите в расширении и откройте отчёт снова.</Gate>;
  if (status === 403 || status === 404) return <Gate><b>Такой смены нет</b>Или она не ваша: отчёт открывает тот, чья смена, и команда, которая её видит.</Gate>;
  return (
    <Gate>
      <b>Hub не ответил</b>
      <span>Отчёт не пришёл. Это не значит, что с ним что-то случилось.</span>
      <button type="button" className="btn btn--line btn--sm" onClick={retry}>Ещё раз</button>
    </Gate>
  );
}

/** One shift's board, read and drawn. */
function ShiftBoard({ shiftId, host, light, transport, seed }: {
  shiftId: number;
  host: Host;
  light: number | null;
  transport: PortTransport | null;
  seed?: ShiftReportResponse;
}) {
  const read = useReport(shiftId, seed);
  const report = read.data;
  // The frame without a board: the extension's bar says there is nothing to hand in.
  useEffect(() => {
    if (transport && report && report.board === null) transport.post(frameState(shiftId, null));
  }, [transport, report, shiftId]);
  if (read.isPending) return <Gate waiting>Открываем отчёт…</Gate>;
  if (read.isError || !report) return <Failed error={read.error} host={host} retry={() => void read.refetch()} />;
  if (report.board === null) {
    return <Gate><b>У этой смены нет доски</b>Отчёт этой смены сдаётся постом в «Отчётность», как раньше.</Gate>;
  }
  return <ReportBoard report={report as ShiftReportResponse & { board: NonNullable<ShiftReportResponse["board"]> }} host={host} transport={transport} light={light} />;
}

/** No shift named: the person's own shift that needs them most (`shift-reports/current`). */
function CurrentBoard({ host, light, transport }: { host: Host; light: number | null; transport: PortTransport | null }) {
  const read = useCurrentReport(true);
  useEffect(() => {
    if (transport && read.data && read.data.report === null) transport.post(frameState(null, null));
  }, [transport, read.data]);
  if (read.isPending) return <Gate waiting>Открываем отчёт…</Gate>;
  if (read.isError) return <Failed error={read.error} host={host} retry={() => void read.refetch()} />;
  const report = read.data.report;
  // In a tab, no shift to report: Workboard's own «Смены → Мои», in its frame, says so (no dark screen without a way out).
  if (report === null && host === "tab") return <Navigate to={{ pathname: "/shifts/mine", search: "?noreport=1" }} replace />;
  if (report === null) return <Gate><b>Смены для отчёта нет</b>Отчёт откроется здесь, когда начнётся смена.</Gate>;
  return <ShiftBoard shiftId={report.shift.id} host={host} light={light} transport={transport} seed={report} />;
}

const numberOf = (value: string | null | undefined) => (value && /^\d{1,15}$/.test(value) ? Number(value) : null);

/** `/report/:shiftId`, `/report`: the board in a tab, on Workboard's session. */
export function ReportScreen() {
  const params = useParams();
  const [search] = useSearchParams();
  const shiftId = numberOf(params.shiftId);
  const light = numberOf(search.get("sale"));
  useEffect(() => {
    document.title = TITLE;
  }, []);
  return (
    <BoardKernel.Provider value={sessionKernel}>
      {params.shiftId !== undefined && shiftId === null
        ? <Gate><b>Такой смены нет</b>В адресе нет номера смены.</Gate>
        : shiftId === null
          ? <CurrentBoard host="tab" light={light} transport={null} />
          : <ShiftBoard key={shiftId} shiftId={shiftId} host="tab" light={light} transport={null} />}
    </BoardKernel.Provider>
  );
}

/** `/frame/report[?shift=<id>]`: the board in the extension's frame, its requests over the extension's port (handshake v2). */
export function FrameReportScreen() {
  const [search] = useSearchParams();
  const shiftId = numberOf(search.get("shift"));
  useEffect(() => {
    document.title = TITLE;
  }, []);
  // The extension's port (shared/frame.tsx); the board never touches Workboard's own client.
  const link = useFramePort({ client: false });
  // The board's API client in the frame: no credentials, every request over the port.
  const transport = link.kind === "port" ? link.transport : null;
  const kernel = useMemo(() => (transport ? createClient({ baseUrl: "", fetch: transport.fetch }) : null), [transport]);
  if (link.kind === "waiting") return <Gate waiting>Открываем отчёт…</Gate>;
  if (link.kind === "version") return <UpdateExtension port={link.port} />;
  if (transport === null || kernel === null) return <Gate><b>Откройте отчёт из ChatGoose</b>Отчёт смены открывается кнопкой «Отчёт» в ChatGoose на Fansly или в ChatSpace.</Gate>;
  return (
    <BoardKernel.Provider value={kernel}>
      {shiftId === null
        ? <CurrentBoard host="frame" light={null} transport={transport} />
        : <ShiftBoard key={shiftId} shiftId={shiftId} host="frame" light={null} transport={transport} />}
    </BoardKernel.Provider>
  );
}

/** The extension speaks another version of the frame's protocol: open the board in a tab instead. */
function UpdateExtension({ port }: { port: MessagePort | null }) {
  const [asked, setAsked] = useState(false);
  return (
    <Gate>
      <b>Обновите ChatGoose</b>
      {port ? (
        <>
          <span>Эта версия расширения не умеет открывать отчёт поверх сайта. Пока его можно открыть во вкладке.</span>
          <button type="button" className="btn btn--line btn--sm" disabled={asked} onClick={() => {
            port.postMessage({ t: "open-tab" });
            setAsked(true);
          }}>{asked ? "Открываем во вкладке…" : "Открыть во вкладке"}</button>
        </>
      ) : (
        <span>Эта версия расширения не умеет открывать отчёт поверх сайта. Пока откройте его из меню ChatGoose: значок расширения, «Сдать смену».</span>
      )}
    </Gate>
  );
}
