import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { FrameGate, useFramePort } from "@/shared/frame";
import type { PortTransport } from "../report/transport";
import { CustomsFactsScreen } from "./facts";
import { RecordFromSaleModal } from "./index";

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

/** The facts screen in the frame, with the port's way to fold it away. */
function FramedCustoms({ transport }: { transport: PortTransport }) {
  const collapse = useCallback(() => transport.post({ t: "collapse" }), [transport]);
  useEscapeFolds(collapse);
  return (
    <main className="wb-main">
      <CustomsFactsScreen frame={{ collapse }} />
    </main>
  );
}

/**
 * `/frame/customs`: «Кастомы» in the extension's frame over the site (the launcher's row «Кастомы»): Workboard's facts
 * screen itself — «Сроки» and «Календарь», the order's panel — every request over the extension's port, run with its
 * device token, which Hub reads as a narrow session (a chatter's view and steps; a finding's resolution shows the way to
 * the password in a tab). It opens on every model with «Только мой ход» off: the address carries nothing more. The
 * screen is kept loaded while folded (the extension hides it); «Свернуть» and Esc say `collapse`.
 */
export function FrameCustomsScreen() {
  const link = useFramePort({ client: true });
  return (
    <FrameGate link={link} title="Кастомы" opensFrom="«Кастомы» открываются кнопкой «Кастомы» в ChatGoose на Fansly или в ChatSpace.">
      {(transport) => <FramedCustoms transport={transport} />}
    </FrameGate>
  );
}
