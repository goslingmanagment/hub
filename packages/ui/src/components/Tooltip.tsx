import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition } from "./popover.js";

/**
 * A short hint on hover and on keyboard focus, in Russian, only adding to what
 * is already written (on a phone there is none). Never hide meaning in it.
 */
export function Tooltip({ content, children, side = "top", align = "center" }: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const style = useAnchoredPosition(anchor, box, open, { side, align });
  const timer = useRef<number | undefined>(undefined);

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 250);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <>
      <span
        ref={anchor}
        className="ui-tooltip-anchor"
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={() => setOpen(true)}
        onBlur={hide}
      >
        {children}
      </span>
      {open && createPortal(<div ref={box} id={id} role="tooltip" className="ui-tooltip" style={style}>{content}</div>, document.body)}
    </>
  );
}
