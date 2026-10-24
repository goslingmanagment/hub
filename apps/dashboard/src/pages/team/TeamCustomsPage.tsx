import { useTeamCustoms } from "@/api/team";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime, formatMills } from "@/lib/format";

/**
 * Chat Memory week 4: the open customs of the pages the viewer reaches
 * (`teamCustoms`) — ordered or paid and not delivered, the oldest payment first.
 */

const HEAD = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const CELL = "px-3 py-2 align-top text-text-secondary xl:px-4";
const STATE_LABELS: Readonly<Record<string, string>> = { ordered: "ждёт оплаты", paid: "оплачен, не отдан" };

/** Whole days since `iso`, «сегодня» for less than one. */
export function daysSince(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days < 1 ? "сегодня" : `${days} дн`;
}

export function TeamCustomsPage() {
  const { data, isLoading, isFetching, refetch } = useTeamCustoms();
  const header = (
    <p className="mb-5 max-w-3xl text-sm text-text-secondary">
      Кастомы, которые заказаны или оплачены, но ещё не отданы фану. Чаттеры отмечают оплату и «отдали» в карточке фана в
      расширении; как модель снимает — по-прежнему в Telegram.
    </p>
  );
  if (!data) {
    return (
      <div>
        {header}
        {isLoading ? <TableSkeleton rows={4} columns={6} /> : (
          <StatusPanel
            title="Кастомы не загрузились"
            description="Hub не ответил. Попробуйте ещё раз."
            tone="error"
            action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
          />
        )}
      </div>
    );
  }
  if (data.customs.length === 0) {
    return <div>{header}<StatusPanel title="Открытых кастомов нет" description="Все записанные кастомы отданы или отменены." /></div>;
  }
  return (
    <div>
      {header}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={HEAD}>Страница</th>
              <th className={HEAD}>Что заказано</th>
              <th className={HEAD}>Цена</th>
              <th className={HEAD}>Состояние</th>
              <th className={HEAD}>Ждёт</th>
              <th className={HEAD}>Записал</th>
            </tr>
          </thead>
          <tbody>
            {data.customs.map((custom) => (
              <tr key={custom.id} className="border-b border-border last:border-b-0">
                <td className={`${CELL} font-medium text-text-primary`}>{custom.pageLabel}</td>
                <td className={CELL}>{custom.description}</td>
                <td className={CELL}>{custom.priceMills === null ? "—" : formatMills(custom.priceMills)}</td>
                <td className={CELL}>{STATE_LABELS[custom.state] ?? custom.state}</td>
                <td className={CELL}>{daysSince(custom.paidAt ?? custom.createdAt)}</td>
                <td className={CELL}>{custom.createdBy} <span className="text-text-muted">· {formatDateTime(custom.createdAt)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
