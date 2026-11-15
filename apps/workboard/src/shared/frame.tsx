import { useEffect, useState, type ReactNode } from "react";
import { acceptPort, portTransport, takeFrameKey, type PortTransport } from "../screens/report/transport.js";
import { setFrameClient } from "./hub.js";
import "../screens/report/board.css";

/**
 * Workboard's screens in the extension's frame beside the board (products package R5; R-protocol.md, handshake v2):
 * «Записать кастом» (`/frame/custom`) and «Спросить» (`/frame/ask`). The frame takes the extension's port by the key of
 * its own address, then every request of the screen goes over it (`setFrameClient`): no cookie, never a sign-in. Closing
 * the screen says `collapse`; a finished one says `done` with what it made, so the fan panel shows it at once.
 */
export type FrameLink = { kind: "waiting" } | { kind: "none" } | { kind: "version" } | { kind: "port"; transport: PortTransport };

export function useFramePort(): FrameLink {
  const [link, setLink] = useState<FrameLink>({ kind: "waiting" });
  useEffect(() => {
    let alive = true;
    let held: PortTransport | null = null;
    // The key is read once and leaves the address at once.
    const key = takeFrameKey(window);
    void acceptPort(window, key).then((result) => {
      if (!alive) {
        if (result.kind !== "none") result.port?.close();
        return;
      }
      if (result.kind === "port") {
        held = portTransport(result.port);
        setFrameClient(held.fetch);
        setLink({ kind: "port", transport: held });
      } else setLink({ kind: result.kind });
    });
    return () => {
      alive = false;
      held?.close();
    };
  }, []);
  return link;
}

/** The frame's own states before its screen: waiting for the port, opened outside the extension, an older extension. */
export function FrameGate({ link, title, children }: { link: FrameLink; title: string; children: (transport: PortTransport) => ReactNode }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  if (link.kind === "waiting") return <Gate waiting>Открываем…</Gate>;
  if (link.kind === "version") return <Gate><b>Обновите ChatGoose</b>Эта версия расширения не умеет открывать этот экран поверх сайта.</Gate>;
  if (link.kind === "none") return <Gate><b>Откройте из ChatGoose</b>Этот экран открывается из панели фана в ChatGoose на Fansly или в ChatSpace.</Gate>;
  return <>{children(link.transport)}</>;
}

/** One sentence in the middle of the frame, in the board's look (the board's own frame says its states the same way). */
function Gate({ children, waiting = false }: { children: ReactNode; waiting?: boolean }) {
  return (
    <div className="rb">
      <div className="view">
        <div className="gate" role={waiting ? "status" : undefined}>
          {waiting && <i className="spin" />}
          {children}
        </div>
      </div>
    </div>
  );
}
