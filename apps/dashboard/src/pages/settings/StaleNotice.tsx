import { staleDataText } from "@/components/shared/QueryNotice";
import { Notice } from "@/components/ui/Notice";

/** «Не удалось обновить. Показаны данные на 23:15.» with «Повторить»: the data stay. */
export function StaleNotice({ at, retry, extra }: { at: number | string | undefined; retry: () => unknown; extra?: string }) {
  return (
    <Notice
      tone="warning"
      role="alert"
      action={<button type="button" className="btn btn-sm" onClick={() => void retry()}>Повторить</button>}
    >
      {staleDataText(at)}{extra ? ` ${extra}` : ""}
    </Notice>
  );
}
