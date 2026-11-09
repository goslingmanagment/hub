import type { CSSProperties } from "react";
import { cx } from "./cx.js";

/** A grey block in the shape of what is loading: no shimmer, no text. */
export function Skeleton({ width = "100%", height = 12, radius, className, style }: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return <span aria-hidden className={cx("ui-skel", className)} style={{ width, height, borderRadius: radius, ...style }} />;
}

const LINE_WIDTHS = ["100%", "92%", "78%", "85%", "64%"];

/** A few lines of text that are not here yet. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden className={className} style={{ display: "block" }}>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="ui-skel ui-skel--text" style={{ width: index === lines - 1 ? "48%" : LINE_WIDTHS[index % LINE_WIDTHS.length] }} />
      ))}
    </span>
  );
}

/** A 14 px spinner, in the text's colour: a button waiting for Hub. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return <span role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cx("ui-spinner", className)} />;
}
