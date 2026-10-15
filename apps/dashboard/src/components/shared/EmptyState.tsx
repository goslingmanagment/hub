import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
}

export function EmptyState({ title, description, icon }: EmptyStateProps) {
  return (
    <div className="empty flex flex-col items-center justify-center">
      {icon && <div className="mb-3 text-text-muted">{icon}</div>}
      <p className="empty-title">{title}</p>
      {description && (
        <p className="empty-text">{description}</p>
      )}
    </div>
  );
}
