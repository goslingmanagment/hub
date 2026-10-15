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
    ? "border-danger/25 bg-danger-soft"
    : "border-border bg-card";

  return (
    <div className={`rounded-xl border px-5 py-10 text-center ${toneClasses}`}>
      <p className="empty-title">{title}</p>
      {description && (
        <p className="empty-text">{description}</p>
      )}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}

