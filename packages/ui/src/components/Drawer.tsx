import { X } from "lucide-react";
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button.js";
import { cx } from "./cx.js";
import { isModalOpen, useFocusScope, type InitialFocus } from "./focus.js";

/** The two widths of a side panel: `md` 560 (a record, a form), `lg` 760 (a table, long evidence). */
export type PanelSize = "md" | "lg";

const PANEL_WIDTH: Record<PanelSize, number> = { md: 560, lg: 760 };

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** A quiet line under the title: the context («alex.k · 7 нояб., 09:12–16:40»). */
  subtitle?: ReactNode;
  /** Bottom bar: one primary action and «Закрыть». */
  footer?: ReactNode;
  /** `md` 560 (default) or `lg` 760: what is inside must fit (a table in a panel: fewer columns). */
  size?: PanelSize;
  /** A width of one's own, px (kept for old calls; prefer `size`). */
  width?: number;
  /** Right of the title, before the cross: a menu. */
  actions?: ReactNode;
  /**
   * Where the focus starts: `auto` (`[data-autofocus]`, else the first field,
   * else the panel), `box` (the panel itself — a list of ticks, so a stray Space
   * ticks nothing), or a ref of one's own.
   */
  initialFocus?: InitialFocus;
  /**
   * A light veil over the page (default): the panel reads as on top. The page
   * stays usable under it — it scrolls, and a press on another row of a list
   * opens that row instead.
   */
  backdrop?: boolean;
  /** A press outside the panel closes it (default). Presses in menus, windows and on table rows opening panels never do. */
  closeOnOutside?: boolean;
  children: ReactNode;
  closeLabel?: string;
}

/** Where a press does not close an open panel: its own floating boxes, windows over it, toasts, rows that open panels. */
const KEEPS_PANEL = ".ui-popover, .ui-tooltip, .ui-modal-backdrop, [role='dialog'], [data-sonner-toaster], .ui-table__row--link, [data-ui-keep-panel]";

/**
 * A side panel on the right, full height, over the page: to look at one
 * record without losing the list (a dispute, a person's links and devices).
 * Escape, the cross and a press beside it close it; a window opened from it
 * gets Escape first. Put its state in the address where it can be shared.
 * For a panel that stands next to the content as a column (the evidence of
 * a shift's review), use `SidePanel`.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  footer,
  size = "md",
  width,
  actions,
  initialFocus = "auto",
  backdrop = true,
  closeOnOutside = true,
  children,
  closeLabel = "Закрыть",
}: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useFocusScope(ref, open, { trap: false, initial: initialFocus });

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && !isModalOpen()) closeRef.current();
    }
    function onPointer(event: PointerEvent) {
      if (!closeOnOutside || event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target || ref.current?.contains(target) || target.closest?.(KEEPS_PANEL) || isModalOpen()) return;
      closeRef.current();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [closeOnOutside, open]);

  if (!open) return null;
  return createPortal(
    <>
      {backdrop && <div className="ui-drawer-veil" aria-hidden />}
      <div
        ref={ref}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-drawer"
        style={{ "--ui-drawer-width": `${width ?? PANEL_WIDTH[size]}px` } as CSSProperties}
      >
        <PanelHead titleId={titleId} title={title} subtitle={subtitle} actions={actions} onClose={onClose} closeLabel={closeLabel} />
        <div className="ui-drawer__body">{children}</div>
        {footer !== undefined && <footer className="ui-drawer__foot">{footer}</footer>}
      </div>
    </>,
    document.body,
  );
}

function PanelHead({ titleId, title, subtitle, actions, onClose, closeLabel }: {
  titleId: string;
  title: ReactNode;
  subtitle: ReactNode;
  actions: ReactNode;
  onClose: (() => void) | undefined;
  closeLabel: string;
}) {
  return (
    <header className="ui-drawer__head">
      <div className="ui-drawer__titles">
        <h2 id={titleId} className="ui-drawer__title">{title}</h2>
        {subtitle !== undefined && subtitle !== null && <p className="ui-drawer__subtitle">{subtitle}</p>}
      </div>
      {actions}
      {onClose && <IconButton icon={X} label={closeLabel} onClick={onClose} />}
    </header>
  );
}

export interface SidePanelProps {
  title: ReactNode;
  subtitle?: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  /** The cross and Escape (when no window is over it). Without it the panel has no cross. */
  onClose?: () => void;
  /** Escape closes it (default, with `onClose`). Off when the screen's own keys use Escape. */
  closeOnEscape?: boolean;
  children: ReactNode;
  closeLabel?: string;
  /** Its own label for a screen reader, when the title is not words. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * A panel in the page's flow, as a column next to the content (a grid or
 * flex cell the screen gives it a width in): the same head, body and foot as
 * `Drawer`, a sheet with a hairline, the body scrolls by itself. It never
 * covers the screen's header or its list — the content beside it narrows.
 */
export function SidePanel({ title, subtitle, footer, actions, onClose, closeOnEscape = true, children, closeLabel = "Закрыть", label, className, style }: SidePanelProps) {
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const closable = onClose !== undefined;

  useEffect(() => {
    if (!closable || !closeOnEscape) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && !isModalOpen()) closeRef.current?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closable, closeOnEscape]);

  return (
    <aside className={cx("ui-side-panel", className)} style={style} {...(label ? { "aria-label": label } : { "aria-labelledby": titleId })}>
      <PanelHead titleId={titleId} title={title} subtitle={subtitle} actions={actions} onClose={onClose} closeLabel={closeLabel} />
      <div className="ui-drawer__body">{children}</div>
      {footer !== undefined && <footer className="ui-drawer__foot">{footer}</footer>}
    </aside>
  );
}
