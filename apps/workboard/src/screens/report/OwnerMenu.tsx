import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { Ico } from "./icons";
import { askOpen, ownerMenu, type MenuItem, type Row } from "./model";
import { placeBy } from "./place";
import type { BoardApi } from "./useBoard";

/**
 * The menu «Чья продажа» under a row's pill: the plain words with their short consequence, the colleagues as a matrix
 * «пополам / отдать» (each named once), and a footer that spells out the hovered or focused word in full. Opaque, of a
 * fixed width that fits, inside the window (it opens upwards near the bottom); the arrows move between its words.
 */
export function OwnerMenu({ api, row }: { api: BoardApi; row: Row }) {
  const ref = useRef<HTMLDivElement>(null);
  const menu = useMemo(() => ownerMenu(api.board, row), [api.board, row]);
  const [foot, setFoot] = useState<string | null>(null);
  const waits = askOpen(row);
  const anchorOf = useCallback(() => document.querySelector(`[data-menu="${CSS.escape(row.key)}"]`), [row.key]);

  const place = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    const anchor = anchorOf();
    box.style.visibility = anchor === null ? "hidden" : "";
    if (anchor !== null) placeBy(box, anchor);
  }, [anchorOf]);
  useLayoutEffect(() => {
    place();
  });
  useEffect(() => {
    document.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [place]);
  // The current word takes the focus, so the keys go on in the menu; the footer keeps its first words meanwhile.
  const opening = useRef(true);
  useEffect(() => {
    const box = ref.current;
    (box?.querySelector<HTMLElement>('[aria-checked="true"]') ?? box?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus({ preventScroll: true });
    opening.current = false;
  }, []);
  // A press outside closes it (its own pill toggles it).
  const { setMenu } = api;
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target !== null && (ref.current?.contains(target) || anchorOf()?.contains(target))) return;
      setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchorOf, setMenu]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const words = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = words.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? 0 : (at + (event.key === "ArrowDown" ? 1 : words.length - 1)) % words.length;
    words[next]?.focus();
  };
  // The footer follows the pointer and the focus.
  const follow = (event: SyntheticEvent) => {
    if (opening.current) return;
    const words = (event.target as Element).closest<HTMLElement>("[data-foot]")?.dataset.foot;
    if (words !== undefined) setFoot(words);
  };
  const pick = (item: MenuItem) => void api.apply(row, item.choice);
  const on = (item: MenuItem) => item.choice.key === menu.currentKey;

  return (
    <div className="menu" ref={ref} role="menu" aria-label={`Чья продажа: ${menu.subject}`} onKeyDown={onKeyDown} onPointerOver={follow} onFocus={follow}>
      <div className="mn-h"><b>Чья продажа</b> · {menu.subject}</div>
      {menu.items.map((item) => (
        <button type="button" key={item.choice.key} className={`mi${on(item) ? " is-on" : ""}`} role="menuitemradio" aria-checked={on(item)}
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
                <button type="button" key={item.choice.key} className={`rd${on(item) ? waits ? " is-wait" : " is-on" : ""}`} role="menuitemradio"
                  aria-checked={on(item)} aria-label={item.label} data-foot={item.foot} onClick={() => pick(item)}><i /></button>
              )))}
            </div>
          ))}
        </>
      )}
      <div className="mn-f" aria-live="polite">{foot ?? menu.foot}</div>
    </div>
  );
}
