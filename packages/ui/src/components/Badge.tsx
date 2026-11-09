import type { ReactNode } from "react";
import { cx } from "./cx.js";

/**
 * The six tones of a state (design-language §2.5) and a plain label:
 * - success: works, done — a green dot, no ground;
 * - warning: worth a look, not urgent — amber ground;
 * - danger: broken, a person must act — red ground;
 * - off: switched off, empty, unknown — a hollow ring, grey ground;
 * - info: going its own way, nothing to do — a grey dot;
 * - accent: waits for the owner — ink;
 * - neutral: a label, not a state («VIP») — no dot.
 */
export type Tone = "success" | "warning" | "danger" | "off" | "info" | "accent";

export function Badge({ tone, bare = false, title, className, children }: {
  tone?: Tone | "neutral";
  /** The dot and the word without the ground: for tight rows. */
  bare?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const kind = tone ?? "neutral";
  return (
    <span title={title} className={cx("ui-badge", kind !== "neutral" && `ui-badge--${kind}`, bare && "ui-badge--bare", className)}>
      {kind !== "neutral" && <span aria-hidden className="ui-badge__dot" />}
      {children}
    </span>
  );
}

/** An 8 px dot of a tone; the word next to it says the same (colour never speaks alone). */
export function StatusDot({ tone, label }: { tone: Tone; label?: string }) {
  return <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label} className={cx("ui-dot", `ui-dot--${tone}`)} />;
}

/** The number of what waits for the owner (the menu's count). `quiet`: a count, not a call. */
export function CountBadge({ value, quiet = false, label }: { value: number; quiet?: boolean; label?: string }) {
  return (
    <span className={cx("ui-count", quiet && "ui-count--quiet")} aria-label={label} title={label}>
      {value > 99 ? "99+" : value.toLocaleString("ru-RU")}
    </span>
  );
}
