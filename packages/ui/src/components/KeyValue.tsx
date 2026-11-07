import type { ReactNode } from "react";
import { cx } from "./cx.js";

/** Properties of one object: a label column and the values. No value: «—». */
export function KeyValue({ items, className }: { items: readonly { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cx("ui-kv", className)}>
      {items.map((item, index) => (
        <div key={index} style={{ display: "contents" }}>
          <dt>{item.label}</dt>
          <dd>{item.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
