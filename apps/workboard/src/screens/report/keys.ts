import { useEffect, useRef } from "react";
import { canTick, hasMenu, rowByKey } from "./model";
import type { BoardApi } from "./useBoard";

/**
 * The board's keys: J/K and the arrows move between sales, Space ticks, Enter opens «чья», C the comment, O shows the
 * sale on the site (in the frame), ⌘Enter / Ctrl+Enter hands in or confirms, «?» the list. Esc closes what is open
 * first (a panel, the menu, a field), and only then, in the frame, collapses the board. None of them acts while the
 * person types in a field: there Esc leaves the field (a row's form takes its own Esc).
 */
export function useBoardKeys(api: BoardApi): void {
  const ref = useRef(api);
  ref.current = api;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const api = ref.current;
      if (event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.closest("input, textarea, select, [contenteditable='true']") != null;
      if (event.key === "Escape") {
        event.preventDefault();
        if (typing) target!.blur();
        else if (api.panel !== null) {
          const anchor = document.querySelector<HTMLElement>(`[data-panel="${api.panel}"]`);
          api.setPanel(null);
          anchor?.focus({ preventScroll: true });
        } else if (api.menu !== null) {
          const pill = document.querySelector<HTMLElement>(`[data-menu="${CSS.escape(api.menu)}"]`);
          api.setMenu(null);
          pill?.focus({ preventScroll: true });
        } else if (api.edit !== null) api.setEdit(null);
        else if (api.ask !== null) api.setAsk(null);
        else if (api.refuse !== null) api.setRefuse(null);
        else if (api.host === "frame") api.collapse();
        return;
      }
      // The menu and the windows keep their own keys; a field keeps every key.
      if (typing || api.menu !== null || api.panel === "off" || api.panel === "find") return;
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (api.editing) void api.submit();
        else if (api.board.phase === "confirm" && api.board.canConfirm) void api.confirm();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "?") {
        event.preventDefault();
        api.setPanel(api.panel === "keys" ? null : "keys");
        return;
      }
      const onControl = target?.closest("button, a") != null;
      const row = api.selected === null ? null : rowByKey(api.board, api.selected);
      switch (event.code) {
        case "KeyJ": case "ArrowDown":
          event.preventDefault();
          move(api, 1);
          return;
        case "KeyK": case "ArrowUp":
          event.preventDefault();
          move(api, -1);
          return;
        case "Space":
          if (onControl || row === null || !canTick(api.board, row, api.preview)) return;
          event.preventDefault();
          void api.tick(row);
          return;
        case "Enter":
          if (onControl || row === null || !hasMenu(api.board, row, api.preview)) return;
          event.preventDefault();
          api.setPanel(null);
          api.setMenu(row.key);
          return;
        case "KeyC":
          if (row === null || !row.canNote || api.preview) return;
          event.preventDefault();
          api.openNote(row.key);
          return;
        case "KeyO":
          if (row === null || api.host !== "frame") return;
          event.preventDefault();
          api.find(row);
          return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** The focus to the next or the previous sale in the list (an open fold's ones too), scrolled only as far as needed. */
function move(api: BoardApi, step: 1 | -1) {
  const rows = [...(api.mainRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  if (rows.length === 0) return;
  const at = rows.findIndex((one) => one.dataset.row === api.selected);
  const next = rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + step))]!;
  next.focus({ preventScroll: true });
  api.setSelected(next.dataset.row ?? null);
  api.reveal(next.dataset.row ?? "", "near");
}
