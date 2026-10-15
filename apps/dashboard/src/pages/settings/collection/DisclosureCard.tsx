import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * A card whose header opens and closes its body — for the secondary blocks
 * of Collection and System › OnlyFans API (jobs, journal, diagnostics). The
 * body stays mounted while closed, so its state (a draft, a pending review)
 * survives a collapse.
 */
export function DisclosureCard(props: {
  title: ReactNode;
  description?: ReactNode | undefined;
  /** Short text or a badge shown on the right of the header. */
  meta?: ReactNode | undefined;
  defaultOpen?: boolean | undefined;
  headingId?: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <details
      className="card group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-[var(--radius-card)] px-5 py-4 hover:bg-hover-alt group-open:rounded-b-none group-open:border-b group-open:border-border [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <h3 id={props.headingId} className="card-title">{props.title}</h3>
          {props.description && <p className="card-description">{props.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {props.meta && <span className="hidden text-sm text-text-secondary sm:inline">{props.meta}</span>}
          <ChevronDown size={18} aria-hidden="true" className="text-text-muted transition-transform group-open:rotate-180" />
        </div>
      </summary>
      {props.children}
    </details>
  );
}
