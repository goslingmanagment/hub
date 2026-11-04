import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { useTeamCustoms } from "@/api/team";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatCount, formatDateTime, formatMills } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { customOverdue } from "@/lib/statusWords";
import { FanLink, PageLink } from "./teamLinks.js";

/**
 * Команда → Продажи → Кастомы: what fans ordered or paid for and has not been
 * delivered (`teamCustoms`). Read-only: chatters change a custom in the fan's
 * card in the extension. The server sends every page; a chosen page narrows here.
 */

type Custom = KernelOperationResponse<"teamCustoms">["customs"][number];

/** A custom paid longer ago than this is overdue. An assumption of the audit, not the owner's rule: one place to change it. */
export const CUSTOM_OVERDUE_DAYS = 7;
/** The most rows `teamCustoms` answers. */
const CUSTOMS_LIMIT = 200;
const DAY_MS = 86_400_000;

/** «сегодня», «3 дня» since `iso`. */
export function daysSince(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / DAY_MS);
  return days < 1 ? "сегодня" : `${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

function Table({ customs, now, paid }: { customs: readonly Custom[]; now: number; paid: boolean }) {
  const { pages } = useDashboardShell();
  const platformOf = (label: string) => pages.find((page) => page.label === label)?.platform ?? "fansly";
  return (
    <div className="table-wrap">
      <table className="data-table customs-table">
        <colgroup>
          <col className="customs-col-page" />
          <col className="customs-col-fan" />
          <col />
          <col className="customs-col-price" />
          <col className="customs-col-wait" />
          <col className="customs-col-who" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Страница</th>
            <th scope="col">Фан</th>
            <th scope="col">Что заказано</th>
            <th scope="col" className="num">Цена</th>
            <th scope="col">Ждёт</th>
            <th scope="col">Чаттер</th>
          </tr>
        </thead>
        <tbody>
          {customs.map((custom) => {
            const since = paid && custom.paidAt ? custom.paidAt : custom.createdAt;
            const overdue = paid && custom.paidAt ? Math.floor((now - Date.parse(custom.paidAt)) / DAY_MS) - CUSTOM_OVERDUE_DAYS : 0;
            const known = custom.state === "paid" || custom.state === "ordered";
            return (
              <tr key={custom.id} className="align-top">
                <td className="whitespace-nowrap"><PageLink label={custom.pageLabel} /></td>
                <td className="whitespace-nowrap"><FanLink pageLabel={custom.pageLabel} platform={platformOf(custom.pageLabel)} fanRef={custom.fanRef} /></td>
                <td className="team-text-cell">{custom.description}</td>
                <td className="num">{custom.priceMills === null ? "—" : formatMills(custom.priceMills)}</td>
                <td className="whitespace-nowrap">
                  {known ? daysSince(since, now) : <span className="team-muted">{custom.state}</span>}
                  {overdue > 0 && <span className="team-sub"><StatusBadge status={customOverdue(overdue)} bare /></span>}
                </td>
                <td className="whitespace-nowrap">
                  <span className="font-medium">{custom.createdBy}</span>
                  <span className="team-sub">записал {formatDateTime(custom.createdAt)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Group({ id, title, description, customs, now, paid }: { id: string; title: string; description: string; customs: readonly Custom[]; now: number; paid: boolean }) {
  return (
    <section className="card" aria-labelledby={id}>
      <header className="card-header">
        <div>
          <h2 id={id} className="card-title">{title} <span className="team-count">{formatCount(customs.length)}</span></h2>
          <p className="card-description">{description}</p>
        </div>
      </header>
      <Table customs={customs} now={now} paid={paid} />
    </section>
  );
}

export function TeamCustomsPage() {
  const filter = usePageFilter();
  const page = filter.page;
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useTeamCustoms();
  const all = data?.customs ?? [];
  const shown = all.filter((custom) => page === null || custom.pageLabel === page);
  const now = data ? Date.parse(data.serverNow) : Date.now();
  const paid = shown.filter((custom) => custom.state === "paid");
  const ordered = shown.filter((custom) => custom.state === "ordered");
  const other = shown.filter((custom) => custom.state !== "paid" && custom.state !== "ordered");
  const elsewhere = all.length - shown.length;

  return (
    <div className="team-screen">
      <PageHeader fresh={data ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined} />
      {data && <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />}
      {page !== null && elsewhere > 0 && (
        <Notice action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}>
          Показана только {page}. На других страницах ещё {elsewhere} {ruPlural(elsewhere, "кастом", "кастома", "кастомов")}.
        </Notice>
      )}
      {!data ? (
        isLoading ? <TableSkeleton rows={4} columns={6} /> : <NoAnswerPanel retry={refetch} />
      ) : shown.length === 0 ? (
        page !== null
          ? <StatusPanel title={`На ${page} открытых кастомов нет`} action={elsewhere > 0 ? <button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button> : undefined} />
          : <StatusPanel title="Открытых кастомов нет" description="Все записанные кастомы отданы или отменены." />
      ) : (
        <>
          {paid.length > 0 && (
            <Group
              id="customs-paid"
              title="Оплачены, не отданы"
              description="Чаттеры отмечают оплату и «отдали» в карточке фана в расширении; как модель снимает — по-прежнему в Telegram."
              customs={paid}
              now={now}
              paid
            />
          )}
          {ordered.length > 0 && (
            <Group id="customs-ordered" title="Ждут оплаты" description="Считается от записи: здесь ждут фана, а не команду." customs={ordered} now={now} paid={false} />
          )}
          {other.length > 0 && (
            <Group id="customs-other" title="Другое состояние" description="Состояние, которого эта версия консоли не знает: показано как есть." customs={other} now={now} paid={false} />
          )}
          {all.length >= CUSTOMS_LIMIT && <p className="team-note">Показаны первые {CUSTOMS_LIMIT}.</p>}
        </>
      )}
      <Disclosure>
        <p>
          Открытый кастом — заказан или оплачен и не отдан. В утреннем отчёте и в «Ждут вас» считаются только оплаченные:
          заказанные без оплаты ждут фана. Просрочен — оплачен больше {CUSTOM_OVERDUE_DAYS} дней назад.
        </p>
      </Disclosure>
    </div>
  );
}
