import type { ReactNode } from "react";

export function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-sm text-text-secondary">{label}</div>
      {children}
    </label>
  );
}
