import { useEffect, useState, type ReactNode } from "react";
import { acceptPort, portTransport, takeFrameKey, type PortTransport } from "../screens/report/transport.js";
import { setFrameClient } from "./hub.js";
import "../screens/report/board.css";

/**
 * Workboard's screens in the extension's frame beside the board (products package R5; R-protocol.md, handshake v2):
 * «Записать кастом» (`/frame/custom`) and «Спросить» (`/frame/ask`). The frame takes the extension's port by the key of
 * its own address, then every request of the screen goes over it (`setFrameClient`): no cookie, never a sign-in. Closing
 * the screen says `collapse`; a finished one says `done` with what it made, so the fan panel shows it at once.
 * The board's own frame (`/frame/report`) takes its port the same way, with `client: false`: it makes its own client
 * over the port and never touches Workboard's one; it keeps the port of a `version` answer for «Открыть во вкладке».
 */
export type FrameLink = { kind: "waiting" } | { kind: "none" } | { kind: "version"; port: MessagePort | null } | { kind: "port"; transport: PortTransport };

export function useFramePort(options: { client: boolean }): FrameLink {
  const { client } = options;
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
        if (client) setFrameClient(held.fetch);
        setLink({ kind: "port", transport: held });
      } else setLink(result);
    });
    return () => {
      alive = false;
      held?.close();
    };
  }, [client]);
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

/**
 * One sentence in the middle of the window, in the board's look: the frames' states and a board that cannot be drawn. In
 * a frame (the extension's) it takes the scheme the frame is given, as the board there does (board.css `.is-frame`).
 */
export function Gate({ children, waiting = false }: { children: ReactNode; waiting?: boolean }) {
  return (
    <div className={window.parent !== window ? "rb is-frame" : "rb"}>
      <div className="view">
        <div className="gate" role={waiting ? "status" : undefined}>
          {waiting && <i className="spin" />}
          {children}
        </div>
      </div>
    </div>
  );
}
