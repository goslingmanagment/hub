import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { useDismiss, useFocusScope } from "@agency_hub_core/ui";
import { useFloating } from "./floating";
import { Ico } from "./icons";
import { ownerMenu, type MenuItem, type Row } from "./model";
import type { BoardApi } from "./useBoard";

/**
 * The menu «Чья продажа» under a row's pill: the plain words with their short consequence, the colleagues as a matrix
 * «пополам / отдать» (each named once), and a footer that spells out the hovered or focused word in full. Opaque, of a
 * fixed width that fits, inside the window, on the side chosen when it opens; it closes when its row scrolls away.
 * The focus starts on the row's word and goes back to the pill; the arrows move between the words, ← and → along a
 * colleague's two.
 */
export function OwnerMenu({ api, row }: { api: BoardApi; row: Row }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);
  const menu = useMemo(() => ownerMenu(api.board, row), [api.board, row]);
  const [foot, setFoot] = useState<string | null>(null);
  const { setMenu } = api;
  const close = useCallback(() => setMenu(null), [setMenu]);
  const anchorOf = useCallback(() => {
    anchor.current = document.querySelector<HTMLElement>(`[data-menu="${CSS.escape(row.key)}"]`);
    return anchor.current;
  }, [row.key]);
  useFloating(ref, anchorOf, "below", close);
  const inside = useMemo(() => [ref, anchor], []);
  useDismiss(true, close, inside, anchor);
  useFocusScope(ref, true, { initial: first });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const words = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = words.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      words[at < 0 ? 0 : (at + (event.key === "ArrowDown" ? 1 : words.length - 1)) % words.length]?.focus();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && (document.activeElement as HTMLElement | null)?.classList.contains("rd")) {
      // Along a colleague's «пополам» and «отдать».
      event.preventDefault();
      const pair = [...(document.activeElement!.parentElement?.querySelectorAll<HTMLElement>(".rd") ?? [])];
      const here = pair.indexOf(document.activeElement as HTMLElement);
      pair[event.key === "ArrowRight" ? Math.min(pair.length - 1, here + 1) : Math.max(0, here - 1)]?.focus();
    }
  };
  // The footer follows the pointer and the focus (not the first focus the menu takes itself).
  const follow = (event: SyntheticEvent) => {
    if (event.type === "focus" && event.target === first.current && foot === null) return;
    const words = (event.target as Element).closest<HTMLElement>("[data-foot]")?.dataset.foot;
    if (words !== undefined) setFoot(words);
  };
  const pick = (item: MenuItem) => void api.apply(row, item.choice);
  const on = (item: MenuItem) => item.choice.key === menu.currentKey;
  const starts = (item: MenuItem) => item.choice.key === (menu.currentKey ?? menu.items[0]?.choice.key);
  const own = (item: MenuItem) => (element: HTMLButtonElement | null) => {
    if (element !== null && starts(item)) first.current = element;
  };

  return (
    <div className="menu" ref={ref} role="menu" aria-label={`Чья продажа: ${menu.subject}`} tabIndex={-1} onKeyDown={onKeyDown} onPointerOver={follow} onFocus={follow}>
      <div className="mn-h"><b>Чья продажа</b> · {menu.subject}</div>
      {menu.items.map((item) => (
        <button type="button" key={item.choice.key} ref={own(item)} className={`mi${on(item) ? " is-on" : ""}`} role="menuitemradio" aria-checked={on(item)}
          data-foot={item.foot} onClick={() => pick(item)}>
          <span className="mi-c">{on(item) && <Ico name="check" size={15} />}</span>
          <span className="mi-t">{item.label}</span>
          {item.short !== "" && <span className="mi-h">{item.short}</span>}
        </button>
      ))}
      {menu.colleagues.length > 0 && (
        <>
          <div className="mn-sep" role="separator" />
          <div className="mg-h" aria-hidden="true"><span>Коллеги</span><span>пополам</span><span>отдать</span></div>
          {menu.colleagues.map((one) => (
            <div className="mg-r" role="group" aria-label={one.name} key={one.userId}>
              <span className="mg-n">{one.name}{one.note !== "" && <small>{one.note}</small>}</span>
              {[one.share, one.give].map((item, index) => (item === null ? <span key={index} /> : (
                <button type="button" key={item.choice.key} ref={own(item)} className={`rd${on(item) ? " is-on" : item.choice.key === menu.askedKey ? " is-wait" : ""}`}
                  role="menuitemradio" aria-checked={on(item)} aria-label={item.label} data-foot={item.foot} onClick={() => pick(item)}><i /></button>
              )))}
            </div>
          ))}
        </>
      )}
      <div className="mn-f" aria-live="polite">{foot ?? menu.foot}</div>
    </div>
  );
}
