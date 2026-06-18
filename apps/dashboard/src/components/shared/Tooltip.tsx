import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  /** Make the trigger keyboard-focusable and wire ARIA (role="tooltip" +
   *  aria-describedby), so the tooltip opens on focus and dismisses on Escape — not just
   *  on hover. Off by default to keep existing hover-only callers (charts, badges) out of
   *  the tab order. */
  focusable?: boolean;
}

export function Tooltip({ content, children, className = "", focusable = false }: TooltipProps) {
  const [show, setShow] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  const open = () => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setCoords({ x: rect.left + rect.width / 2, y: rect.top });
    setShow(true);
  };
  const close = () => setShow(false);

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={focusable ? open : undefined}
        onBlur={focusable ? close : undefined}
        onKeyDown={
          focusable
            ? (e) => {
                if (e.key === "Escape") close();
              }
            : undefined
        }
        tabIndex={focusable ? 0 : undefined}
        aria-describedby={focusable && show ? tooltipId : undefined}
        className={`inline-flex ${className}`}
      >
        {children}
      </span>
      {show &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[100] -translate-x-1/2 -translate-y-full"
            style={{ left: coords.x, top: coords.y - 6 }}
          >
            <div
              id={tooltipId}
              role="tooltip"
              className="max-w-xs whitespace-normal rounded-md bg-[#1a1a1a] px-2.5 py-1.5 text-[11px] font-medium leading-snug text-white shadow-lg"
            >
              {content}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
