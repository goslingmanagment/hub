import type { ReactNode } from "react";

interface StatusPanelProps {
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: "default" | "error";
}

export function StatusPanel({
  title,
  description,
  action,
  tone = "default",
}: StatusPanelProps) {
  const toneClasses = tone === "error"
    ? "border-danger/20 bg-danger/5"
    : "border-border bg-card";

  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-5 py-8 text-center ${toneClasses}`}>
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-xl text-sm text-text-muted">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

