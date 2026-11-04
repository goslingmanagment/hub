import { Notice } from "@/components/ui/Notice";
import { formatTimeOfDay } from "@/lib/format";

/** «Не удалось обновить. Показаны данные на 23:15.», or without the time when it is not known. */
export function staleDataText(at?: string | number | Date | undefined): string {
  return at === undefined || at === 0 ? "Не удалось обновить. Показаны прежние данные." : `Не удалось обновить. Показаны данные на ${formatTimeOfDay(at)}.`;
}

/** A read that failed: the same words everywhere. If data were there, they stay. */
export function QueryNotice({ error, stale, retry, at }: {
  error: boolean;
  stale: boolean;
  retry: () => unknown;
  /** When the data on screen were read (`dataUpdatedAt`). */
  at?: string | number | Date | undefined;
}) {
  if (!error) return null;
  return (
    <Notice
      tone="warning"
      role="alert"
      className="mb-3"
      action={<button type="button" className="btn btn-sm" onClick={() => void retry()}>Повторить</button>}
    >
      {stale ? staleDataText(at) : "Hub не ответил. Числа не пришли. Это не ноль."}
    </Notice>
  );
}
