import type { ReactNode } from "react";

interface StatusPanelProps {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Kept for the old callers: no answer from the hub is not an alarm, the words
   *  say what happened and the panel stays quiet. */
  tone?: "default" | "error";
}

/** Empty, no answer, no rights: what is empty, why, what can be done. One button. */
export function StatusPanel({
  title,
  description,
  action,
  tone = "default",
}: StatusPanelProps) {
  return (
    <div className="status-panel empty" role={tone === "error" ? "alert" : undefined}>
      <p className="empty-title">{title}</p>
      {description && (
        <p className="empty-text">{description}</p>
      )}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}

/** No answer is not a zero: the panel says so instead of an empty table. */
export function NoAnswerPanel({ retry }: { retry: () => unknown }) {
  return (
    <StatusPanel
      tone="error"
      title="Hub не ответил"
      description="Числа не пришли. Это не ноль: данные могут быть, просто экран их не получил."
      action={<button type="button" className="btn btn-sm" onClick={() => void retry()}>Повторить</button>}
    />
  );
}
