import { Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { Button, ErrorState, Skeleton } from "@agency_hub_core/ui";
import { FrameGate, useFramePort } from "@/shared/frame";
import { ScreenHeader } from "@/shared/ScreenHeader";
import type { PortTransport } from "../report/transport";
import { readFailure, useCustomBoard, useCustomsReread } from "./data";
import { CustomsFactsScreen } from "./facts";
import { CustomsBoardScreen, RecordFromSaleModal } from "./index";

/**
 * `/frame/custom?page=<page>&fan=<fan ref>&name=<fan's name>`: «Записать кастом» in the extension's frame over the site
 * (products package R5): the board's own form with the page and the fan filled in by the fan panel. Its requests go
 * over the extension's port; recorded, it says `done` with the order's code (the fan panel shows the order at once);
 * closed, `collapse`.
 */
export function FrameCustomScreen() {
  const [search] = useSearchParams();
  const link = useFramePort({ client: true });
  const page = search.get("page") ?? "";
  const fan = search.get("fan") ?? "";
  const name = search.get("name");
  return (
    <FrameGate link={link} title="Записать кастом">
      {(transport) => (
        <div className="cus-frame">
          <RecordFromSaleModal
            page={page}
            fan={fan}
            {...(name === null || name === "" ? {} : { fanName: name })}
            fixedPage
            onRecorded={(code) => transport.post({ t: "done", screen: "custom", code })}
            onClose={() => transport.post({ t: "collapse" })}
          />
        </div>
      )}
    </FrameGate>
  );
}

/**
 * Esc with nothing of the screen open folds the frame away (the board's way, report/keys.ts): a window, the order's
 * panel or a menu takes its own Esc, a field keeps it. Caught before the screen's own listeners, so the panel that Esc
 * closes is still there to be seen.
 */
function useEscapeFolds(collapse: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']") != null) return;
      event.preventDefault();
      collapse();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [collapse]);
}

/** The extension says `show` on each open from the launcher: what the screen shows is read again. */
function useShowRereads(transport: PortTransport) {
  const reread = useCustomsReread();
  useEffect(() => transport.on((message) => {
    if (message.t === "show") reread();
  }), [transport, reread]);
}

/** Before the board's first answer: the header with «Свернуть», then the wait or why the board did not come. */
function FrameWaiting({ collapse }: { collapse: () => void }) {
  const board = useCustomBoard(null);
  return (
    <>
      <ScreenHeader title="Кастомы" actions={<Button icon={Minimize2} onClick={collapse}>Свернуть</Button>} />
      <div className="wb-content">
        {board.isError
          ? <ErrorState onRetry={() => void board.refetch()} retrying={board.isFetching}>{readFailure(board.error)}</ErrorState>
          : <Skeleton height={480} />}
      </div>
    </>
  );
}

/**
 * «Кастомы» in the frame by the live switch `customsFacts`, as entry.tsx (the board's answer carries `factsOn`): on, the
 * facts screen; off, the column board as it was. Either with the port's way to fold it away.
 */
function FramedCustoms({ transport }: { transport: PortTransport }) {
  const collapse = useCallback(() => transport.post({ t: "collapse" }), [transport]);
  const frame = useMemo(() => ({ collapse }), [collapse]);
  useEscapeFolds(collapse);
  useShowRereads(transport);
  const board = useCustomBoard(null);
  return (
    <main className="wb-main cus-frame-main">
      {!board.data ? <FrameWaiting collapse={collapse} />
        : board.data.factsOn ? <CustomsFactsScreen frame={frame} />
        : <CustomsBoardScreen frame={frame} />}
    </main>
  );
}

/**
 * `/frame/customs`: «Кастомы» in the extension's frame over the site (the launcher's row «Кастомы»): Workboard's facts
 * screen itself — «Сроки» and «Календарь», the order's panel — every request over the extension's port, run with its
 * device token, which Hub reads as a narrow session (a chatter's view and steps on the person's own pages, whatever the
 * role; no finding). It opens on every model with «Только мой ход» off: the address carries nothing more. The screen is
 * kept loaded while folded (the extension hides it) and reads itself again on each open (`show`); «Свернуть» and Esc
 * say `collapse`.
 */
export function FrameCustomsScreen() {
  const link = useFramePort({ client: true });
  return (
    <FrameGate link={link} title="Кастомы" opensFrom="«Кастомы» открываются кнопкой «Кастомы» в ChatGoose на Fansly или в ChatSpace.">
      {(transport) => <FramedCustoms transport={transport} />}
    </FrameGate>
  );
}
