import { Notice } from "@/components/ui/Notice";

/** A read that failed: the same words everywhere. If data were there, they stay. */
export function QueryNotice({ error, stale, retry }: {
  error: boolean;
  stale: boolean;
  retry: () => unknown;
}) {
  if (!error) return null;
  return (
    <Notice
      tone="warning"
      role="alert"
      className="mb-3"
      action={<button type="button" className="btn btn-sm" onClick={() => void retry()}>Повторить</button>}
    >
      {stale ? "Не удалось обновить. Показаны прежние данные." : "Hub не ответил. Числа не пришли. Это не ноль."}
    </Notice>
  );
}
