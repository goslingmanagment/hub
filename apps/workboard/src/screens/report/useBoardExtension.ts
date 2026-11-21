import { useEffect, useMemo, useRef, useState } from "react";
import { frameState, keyOfTransaction, type Board } from "./model";
import type { PortTransport } from "./transport";

/**
 * The board and the extension's frame (R-protocol.md): every change of phase or totals goes to the extension's bar, an
 * OnlyFans page that waits for ChatSpace's statement asks for it once per candidate, «К отчёту» lights its row, and what
 * the site did not find is said once the board is seen again. `hidden` — the frame is hidden by the extension (after
 * «Свернуть» or a sale's number) until it says `show`. No message changes here: the extension needs no release.
 */
export function useBoardExtension({ transport, shiftId, board, show, toast }: {
  transport: PortTransport | null;
  shiftId: number;
  board: Board;
  show: (key: string) => void;
  toast: (text: string) => void;
}) {
  const hidden = useRef(false);
  const missToast = useRef<string | null>(null);
  /** The site could not find the row: a quiet line under it until the person's next action. */
  const [miss, setMiss] = useState<{ key: string | null; words: string } | null>(null);

  useEffect(() => {
    if (!transport) return;
    return transport.on((message) => {
      if (message.t === "show") {
        hidden.current = false;
        if (typeof message.transactionId === "number") show(keyOfTransaction(message.transactionId));
        if (missToast.current !== null) {
          toast(missToast.current);
          missToast.current = null;
        }
      } else if (message.t === "found" && !message.ok && message.words) {
        // A toast when the board is visible, and a quiet line under the row; `ok: true` needs nothing.
        const words = message.words;
        setMiss({ key: message.transactionId === null ? null : keyOfTransaction(message.transactionId), words });
        if (hidden.current) missToast.current = words;
        else toast(words);
      }
    });
  }, [transport, show, toast]);
  // The quiet line «Строка на сайте не найдена…» leaves with the next action on the visible board.
  useEffect(() => {
    if (miss === null) return;
    const clear = () => {
      if (!hidden.current) setMiss(null);
    };
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("keydown", clear, true);
    return () => {
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("keydown", clear, true);
    };
  }, [miss]);
  // What the extension's bar shows.
  const state = useMemo(() => JSON.stringify(frameState(shiftId, board)), [shiftId, board]);
  useEffect(() => {
    transport?.post(JSON.parse(state) as ReturnType<typeof frameState>);
  }, [transport, state]);
  const statementAsked = useRef<number | null>(null);
  useEffect(() => {
    const candidate = board.candidate;
    if (!transport || !candidate || statementAsked.current === candidate.id) return;
    const pages = candidate.hub.pages.filter((page) => page.state === "statement").map((page) => page.pageLabel);
    if (pages.length === 0) return;
    statementAsked.current = candidate.id;
    transport.post({ t: "statement", pages });
  }, [transport, board.candidate]);

  return { hidden, miss, setMiss };
}
