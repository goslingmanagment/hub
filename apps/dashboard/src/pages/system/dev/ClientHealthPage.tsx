import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { useAdminClientHealth } from "@/api/queries";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { staleDataText } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatDayRange } from "@/lib/format";
import {
  clientHealthPageModel,
  clientHealthRange,
  formatCount,
  type ClientHealthPeriod,
} from "@/pages/dev/clientHealthView";
import { freshOf } from "../shared.js";
import { CRITICAL_COUNTERS, ExtensionCriticalTiles } from "./ExtensionCriticalTiles.js";

const CELL = "muted";
/** A version, a build or a code: never broken across lines; the section scrolls sideways instead. */
const CELL_CODE = "muted whitespace-nowrap sys-code-cell";
const CELL_NUMBER = "num";

/** A section of the page: what it shows in a sentence, how it is counted folded, and its table. */
function Section({ title, description, help, children }: {
  title: string;
  description: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-header">
        <div className="min-w-0 sys-measure">
          <h2 className="card-title">{title}</h2>
          <p className="card-description">{description}</p>
          {help && <Disclosure label="Как это считается" className="mt-2">{help}</Disclosure>}
        </div>
      </div>
      <div className="table-wrap">{children}</div>
    </section>
  );
}

function EmptyRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={columns} className="text-center text-text-secondary">{children}</td>
    </tr>
  );
}

/**
 * The owner's view of the chat extension's health reports (chat-extension
 * H-11c): figures by extension version and ChatSpace build. The hub keeps no
 * person in them, so the page has none to show.
 */
export function ClientHealthPage() {
  const { key } = useScreenPeriod("7d");
  const period: ClientHealthPeriod = key === "today" || key === "30d" ? key : "7d";
  const range = clientHealthRange(period, toBusinessDate(new Date(), MOSCOW_TIME_ZONE));
  // The same key as the row of «Ждут вас» at 7 days: one number on both.
  const query = useAdminClientHealth({ ...range, clientName: "chat-extension" });
  const { data, isLoading, isError } = query;

  const header = <PageHeader window={`${formatDayRange(range.from, range.to)}, дни по Москве`} fresh={freshOf(query)} />;
  const retry = <button type="button" onClick={() => void query.refetch()} className="btn btn-sm">Повторить</button>;

  if (!data) {
    return (
      <div className="space-y-6">
        {header}
        {isLoading ? (
          <>
            <StatCardSkeleton count={4} />
            <div className="card"><TableSkeleton rows={4} columns={5} /></div>
          </>
        ) : (
          <>
            <ExtensionCriticalTiles data={undefined} />
            <div className="card">
              <StatusPanel tone="error" title="Hub не ответил" description="Числа не пришли. Это не ноль. Данные не потеряны: попробуйте ещё раз." action={retry} />
            </div>
          </>
        )}
      </div>
    );
  }

  const model = clientHealthPageModel(data);

  const critical = new Set(CRITICAL_COUNTERS.map(([code]) => code));
  const counters = model.counters.filter((row) => !critical.has(row.code));

  return (
    <div className="space-y-6">
      {header}
      {isError && <Notice tone="warning" role="alert" action={retry}>{staleDataText(query.dataUpdatedAt)}</Notice>}
      <ExtensionCriticalTiles data={data} />

      {model.empty ? (
        <div className="card">
          <div className="empty">
            <p className="empty-title">За этот период отчётов нет</p>
            <p className="empty-text">
              Отчёты приходят, когда в настройках включены{" "}
              <Link className="link" to="/system/dev/config#config-chatExtensionEnabled">«Расширение для чата: общий выключатель»</Link> и{" "}
              <Link className="link" to="/system/dev/config#config-chatExtensionHealthIngestEnabled">«Расширение для чата: отчёты о работе»</Link>,
              а сотрудник в расширении согласился отправлять технические замеры.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <Section
            title="Проверка страницы ChatSpace"
            description={<>Всего отчётов: {formatCount(model.reports)}, с ошибкой: {formatCount(model.failedReports)}.</>}
            help={(
              <p>
                При запуске расширение проверяет, что на странице ChatSpace есть всё, на что оно опирается.
                Отчёт с ошибкой значит: чего-то не нашлось, и зависящие от этого функции были выключены.
              </p>
            )}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Версия расширения</th>
                  <th>Версия ChatSpace</th>
                  <th className="num">Отчётов</th>
                  <th className="num">С ошибкой</th>
                  <th>Что не найдено и в скольких отчётах</th>
                </tr>
              </thead>
              <tbody>
                {model.contract.length === 0 && <EmptyRow columns={5}>Отчётов о проверке нет.</EmptyRow>}
                {model.contract.map((row) => (
                  <tr key={row.key}>
                    <td className="whitespace-nowrap font-medium">{row.version}</td>
                    <td className={CELL_CODE}>{row.build}</td>
                    <td className={CELL_NUMBER}>{row.reports}</td>
                    <td className={CELL_NUMBER}>{row.failedReports}</td>
                    <td className={`${CELL} sys-code-cell`}>{row.missing || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="Скорость"
            description="Сколько времени занимают действия расширения, по версиям."
            help={(
              <p>
                Медиана: половина замеров быстрее этого. «95 из 100»: быстрее этого 95 замеров из 100.
                Если замеров меньше {formatCount(model.minGroupSize)}, показано только их число: по нескольким замерам судить нельзя.
              </p>
            )}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Версия расширения</th>
                  <th>Версия ChatSpace</th>
                  <th className="num">Замеров</th>
                  <th className="num">Среднее</th>
                  <th className="num">Медиана</th>
                  <th className="num">95 из 100</th>
                  <th className="num">Самый долгий</th>
                </tr>
              </thead>
              <tbody>
                {model.perf.length === 0 && <EmptyRow columns={7}>Замеров скорости нет.</EmptyRow>}
                {model.perf.map((block) => (
                  <Fragment key={block.key}>
                    <tr>
                      <th colSpan={7} scope="rowgroup" className="sys-rowgroup">
                        {block.label ?? block.metric}
                        {block.label !== null && <span className="sys-code sys-rowgroup-code">{block.metric}</span>}
                      </th>
                    </tr>
                    {block.rows.map((row) => (
                      <tr key={row.key}>
                        <td className="whitespace-nowrap font-medium">{row.version}</td>
                        <td className={CELL_CODE}>{row.build}</td>
                        <td className={CELL_NUMBER}>{row.count}</td>
                        {row.suppressed ? (
                          <td colSpan={4} className={`${CELL_CODE} text-right`}>мало замеров</td>
                        ) : (
                          <>
                            <td className={CELL_NUMBER}>{row.mean}</td>
                            <td className={CELL_NUMBER}>{row.p50}</td>
                            <td className={CELL_NUMBER}>{row.p95}</td>
                            <td className={CELL_NUMBER}>{row.max}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="Счётчики"
            description="Сколько раз за период случилось событие, по всем версиям вместе."
            help={(
              <p>
                Четыре критичных счётчика стоят наверху экрана и здесь не повторяются. Строки без названия — прочие коды;
                те, что начинаются с CG-, — ошибки. Внизу служебные счётчики: что расширение не включило в отчёты. Это не ошибки.
              </p>
            )}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Событие</th>
                  <th>Код</th>
                  <th className="num">Сколько раз</th>
                </tr>
              </thead>
              <tbody>
                {counters.length === 0 && <EmptyRow columns={3}>Счётчиков нет.</EmptyRow>}
                {counters.map((row) => (
                  <tr key={row.code}>
                    <td>{row.label ?? "—"}</td>
                    <td className={CELL_CODE}>{row.code}</td>
                    <td className={CELL_NUMBER}>{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="Сколько расширение держит у себя"
            description="Размер сохранённых данных и журналов расширения и число его элементов на странице ChatSpace."
            help={(
              <p>
                Показано значение, которого не превышают 95 отчётов из 100. Нужно не меньше{" "}
                {formatCount(model.minGroupSize)} отчётов.
              </p>
            )}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Версия расширения</th>
                  <th className="num">Сохранённые данные</th>
                  <th className="num">Журналы</th>
                  <th className="num">Элементов на странице</th>
                </tr>
              </thead>
              <tbody>
                {model.footprint.length === 0 && <EmptyRow columns={4}>Данных о размере нет.</EmptyRow>}
                {model.footprint.map((row) => (
                  <tr key={row.version}>
                    <td className="whitespace-nowrap font-medium">{row.version}</td>
                    <td className={CELL_NUMBER}>{row.caches}</td>
                    <td className={CELL_NUMBER}>{row.logs}</td>
                    <td className={CELL_NUMBER}>{row.domNodes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </div>
      )}
    </div>
  );
}
