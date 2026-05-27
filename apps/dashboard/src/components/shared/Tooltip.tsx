import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className = "" }: TooltipProps) {
  const [show, setShow] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  const onEnter = () => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setCoords({ x: rect.left + rect.width / 2, y: rect.top });
    setShow(true);
  };

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={onEnter}
        onMouseLeave={() => setShow(false)}
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
            <div className="rounded-md bg-[#1a1a1a] px-2.5 py-1.5 text-[11px] font-medium leading-snug text-white shadow-lg">
              {content}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
