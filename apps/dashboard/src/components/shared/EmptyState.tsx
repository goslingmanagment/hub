import { Link } from "react-router";

export function EmptyState({
  message,
  actionLabel,
  actionTo,
}: {
  message: string;
  actionLabel?: string;
  actionTo?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <p className="text-zinc-400">{message}</p>
      {actionLabel && actionTo && (
        <Link to={actionTo} className="mt-3 text-sm text-blue-400 hover:underline">
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
