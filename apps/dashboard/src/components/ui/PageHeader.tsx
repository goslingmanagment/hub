import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { formatUpdated } from "@/lib/format";
import { useScreenFrame } from "./screenFrame.js";

export interface PageFreshness {
  at: string | number | Date;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean | undefined;
}

/** «Обновлено в 23:41, 5 мин назад»: quiet, and it is the refresh button. */
export function PageFresh({ at, onRefresh, refreshing = false }: PageFreshness) {
  const text = refreshing ? "Обновляем…" : formatUpdated(at);
  if (!onRefresh) return <span>{text}</span>;
  return (
    <button type="button" className="page-fresh" disabled={refreshing} onClick={onRefresh} title="Обновить">
      {text}
      <RefreshCw size={14} aria-hidden="true" className={refreshing ? "animate-spin" : ""} />
    </button>
  );
}

function PageWindowLine({ window, fresh }: { window?: ReactNode; fresh?: PageFreshness | undefined }) {
  return (
    <>
      {window}
      {window && fresh ? (typeof window === "string" && window.endsWith(".") ? " " : ". ") : null}
      {fresh && <PageFresh {...fresh} />}
    </>
  );
}

/**
 * What a screen says about itself to the header. Inside a frame it lands in the
 * frame's header: the main button, the dates of the window and when it was
 * updated, and on a deep screen the object's name. On its own it draws the old
 * block. A screen never draws a period or a page chip: the frame does.
 */
export function PageHeader({
  title,
  description,
  actions,
  titleId,
  window,
  fresh,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
  /** The dates shown: «28 окт. – 3 нояб., сравнение с 21–27 окт.». */
  window?: ReactNode;
  fresh?: PageFreshness | undefined;
}) {
  const frame = useScreenFrame();
  const deepTitle = frame?.mode === "deep" && typeof title === "string" ? title : null;

  useEffect(() => {
    if (deepTitle) document.title = `${deepTitle} — Hub`;
  }, [deepTitle]);

  if (!frame) {
    return (
      <header className="page-header">
        <div className="page-header-text">
          {title && <h1 id={titleId} className="page-title">{title}</h1>}
          {description && <p className="page-subtitle">{description}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
        {(window || fresh) && <p className="page-window"><PageWindowLine window={window} fresh={fresh} /></p>}
      </header>
    );
  }

  const { slots, mode } = frame;
  const dates = (window || fresh) && slots.window
    ? createPortal(<PageWindowLine window={window} fresh={fresh} />, slots.window)
    : null;
  if (mode === "inline") {
    return (
      <>
        {(title || description || actions) && (
          <header className="page-header">
            <div className="page-header-text">
              {title && <h2 id={titleId} className="page-inline-title">{title}</h2>}
              {description && <p className="page-subtitle">{description}</p>}
            </div>
            {actions && <div className="page-actions">{actions}</div>}
          </header>
        )}
        {dates}
      </>
    );
  }
  return (
    <>
      {mode === "deep" && title && slots.title && createPortal(<span id={titleId}>{title}</span>, slots.title)}
      {mode === "deep" && description && slots.subtitle && createPortal(description, slots.subtitle)}
      {actions && slots.actions && createPortal(actions, slots.actions)}
      {dates}
    </>
  );
}
