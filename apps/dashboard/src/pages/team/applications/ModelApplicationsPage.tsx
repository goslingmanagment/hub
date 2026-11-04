import { Link, useNavigate } from "react-router";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { useModelApplications } from "@/api/modelApplications";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatCount, formatDateTime, formatMomentAgo } from "@/lib/format";
import { isPlainRowClick } from "@/lib/rowClick";
import { MODEL_APPLICATION_STATUS } from "@/lib/statusWords";

/**
 * Команда → Анкеты: the agency site's model questionnaire, followed live (every
 * 5 s while open). A row is one filling (its page reports it while the model
 * types) or a sent questionnaire; it opens the answers. The owner's only.
 */

type Item = KernelOperationResponse<"adminModelApplications">["items"][number];

/** «Отправлена №12». */
export function applicationStatusWord(item: Pick<Item, "status" | "applicationId">) {
  const word = MODEL_APPLICATION_STATUS[item.status];
  return item.status === "sent" && item.applicationId !== null
    ? { ...word, word: `${word.word} №${item.applicationId}` }
    : word;
}

export function ModelApplicationsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useModelApplications();
  const header = <PageHeader fresh={data ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined} />;

  if (!data) {
    return (
      <div className="team-screen">
        {header}
        {isLoading ? <TableSkeleton rows={6} columns={6} /> : <NoAnswerPanel retry={refetch} />}
      </div>
    );
  }

  const now = Date.parse(data.serverNow);
  const filling = data.items.filter((item) => item.status === "filling").length;
  const open = (event: React.MouseEvent<HTMLElement>, ref: string) => {
    if (isPlainRowClick(event)) navigate(`/team/applications/${ref}`);
  };

  return (
    <div className="team-screen">
      {header}
      <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />
      {data.items.length === 0 ? (
        <StatusPanel title="Анкет пока нет" description="Как только модель начнёт заполнять анкету на сайте, она появится здесь." />
      ) : (
        <section className="card" aria-labelledby="applications-list">
          <header className="card-header">
            <div>
              <h2 id="applications-list" className="card-title">
                Анкеты <span className="team-count">{formatCount(data.items.length)}</span>
              </h2>
              <p className="card-description">
                {filling > 0 ? `Сейчас заполняют: ${formatCount(filling)}.` : "Сейчас никто не заполняет."}
              </p>
            </div>
          </header>
          <div className="table-wrap">
            <table className="data-table team-sticky-first">
              <thead>
                <tr>
                  <th scope="col">Имя</th>
                  <th scope="col" className="num">Заполнено</th>
                  <th scope="col">Раздел</th>
                  <th scope="col">Начала</th>
                  <th scope="col">Обновлено</th>
                  <th scope="col">Статус</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.ref} className="team-row-link" onClick={(event) => open(event, item.ref)}>
                    <td>
                      <Link to={`/team/applications/${item.ref}`} className="team-link font-medium">
                        {item.name ?? "Без имени"}
                      </Link>
                    </td>
                    <td className="num whitespace-nowrap">{item.filled} из {item.total}</td>
                    <td className="team-text-cell">{item.section ?? <span className="team-muted">—</span>}</td>
                    <td className="muted whitespace-nowrap">{formatDateTime(item.startedAt, { yearUnlessCurrent: true })}</td>
                    <td className="muted whitespace-nowrap">{formatMomentAgo(item.updatedAt, now)}</td>
                    <td className="status-col"><StatusBadge status={applicationStatusWord(item)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Disclosure>
        <p>
          Страница анкеты на сайте присылает, сколько заполнено, раздел и имя, пока модель печатает. «Бросила» — не
          отправлена и 30 минут без изменений; если модель вернётся, статус снова станет «Заполняет». О начале и
          о брошенной анкете приходит сообщение в Telegram. Показаны последние 200.
        </p>
      </Disclosure>
    </div>
  );
}
