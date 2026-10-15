import type { ReactNode } from "react";

/** One labelled form field: the label above, the control, an optional hint
 *  below. The label wraps the control, so a click on the words focuses it;
 *  the hint stays outside, so it is not read as part of the field's name. */
export function Field({
  children,
  label,
  hint,
}: {
  children: ReactNode;
  label: string;
  hint?: ReactNode | undefined;
}) {
  return (
    <div className="min-w-0">
      <label className="block">
        <span className="field-label">{label}</span>
        {children}
      </label>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
