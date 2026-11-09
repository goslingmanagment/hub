import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx.js";
import { rectAnchor, useAnchoredPosition, type AnchorLike, type ScreenRect } from "./popover.js";

export type { ScreenRect } from "./popover.js";

interface TooltipBase {
  content: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}

/** Around an element: the hint follows the pointer and the keyboard focus on it. */
interface TooltipAround extends TooltipBase {
  children: ReactNode;
  /** Milliseconds before it shows on hover (250). Keyboard focus shows it at once. */
  delay?: number;
  /** The wrapper's class (it is an inline-flex span). */
  className?: string;
  at?: undefined;
}

/**
 * At a place on the screen, controlled by the caller: a mark on a chart, a cell
 * of a grid. `at` null hides it. The caller decides when (pointer over its own
 * drawing) and what it says.
 */
interface TooltipAt extends TooltipBase {
  at: ScreenRect | DOMRect | null;
  children?: undefined;
  delay?: undefined;
  className?: undefined;
}

export type TooltipProps = TooltipAround | TooltipAt;

/**
 * A short hint on hover and on keyboard focus, in Russian, only adding to what
 * is already written (on a phone there is none). Never hide meaning in it.
 *
 * Two ways: around an element (`<Tooltip content="…"><span>…</span></Tooltip>`),
 * or at a place on the screen (`<Tooltip at={{ x, y, width, height }} content="…" />`)
 * for marks of a chart that have no element of their own.
 */
export function Tooltip(props: TooltipProps) {
  if (props.at !== undefined) return <TooltipAtPlace {...props} />;
  return <TooltipAroundElement {...props} />;
}

function TooltipAroundElement({ content, children, side = "top", align = "center", delay = 250, className }: TooltipAround) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const style = useAnchoredPosition(anchor, box, open, { side, align });
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const empty = content === null || content === undefined || content === false || content === "";
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  if (empty) return <>{children}</>;
  return (
    <>
      <span
        ref={anchor}
        className={cx("ui-tooltip-anchor", className)}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        // A press means the reader moved on (a row opens a panel): the hint must not stay over what opened.
        onPointerDown={hide}
        onFocus={() => setOpen(true)}
        onBlur={hide}
      >
        {children}
      </span>
      {open && createPortal(<div ref={box} id={id} role="tooltip" className="ui-tooltip" style={style}>{content}</div>, document.body)}
    </>
  );
}

function TooltipAtPlace({ content, at, side = "top", align = "center" }: TooltipAt) {
  const box = useRef<HTMLDivElement>(null);
  const anchor = useMemo<{ current: AnchorLike | null }>(() => ({ current: at ? rectAnchor(at) : null }), [at]);
  const open = at !== null;
  const style = useAnchoredPosition(anchor, box, open, { side, align });
  if (!open) return null;
  return createPortal(<div ref={box} role="tooltip" className="ui-tooltip" style={style}>{content}</div>, document.body);
}

/**
 * Words with a definition behind them: a dotted underline and the definition
 * on hover and on keyboard focus (a column's header, a fact's value, «коллега»).
 * The words must make sense alone; the hint only explains them.
 */
export function Hint({ content, children, side = "top", align = "center", focusable = true, className }: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  /** Reachable with Tab (default). Off inside a control that already takes the focus (a sort button). */
  focusable?: boolean;
  className?: string;
}) {
  if (content === null || content === undefined || content === false || content === "") return <>{children}</>;
  return (
    <Tooltip content={content} side={side} align={align}>
      <span className={cx("ui-hint", className)} tabIndex={focusable ? 0 : undefined}>{children}</span>
    </Tooltip>
  );
}
