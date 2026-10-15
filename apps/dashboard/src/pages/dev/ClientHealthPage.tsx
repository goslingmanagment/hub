import { Fragment, useState, type ReactNode } from "react";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { useAdminClientHealth } from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { DevHeader } from "./DevHeader.js";
import {
  CLIENT_HEALTH_PERIODS,
  clientHealthPageModel,
  clientHealthRange,
  clientHealthRangeLabel,
  formatCount,
  type ClientHealthPeriod,
} from "./clientHealthView.js";

const CELL = "muted";
/** A version, a build or a code: never broken across lines; the section scrolls sideways instead. */
const CELL_CODE = "muted whitespace-nowrap";
const CELL_NUMBER = "num";

/** A section of the page: what it shows in a sentence, how to read it under
 *  «Как читать», and its table. */
function Section({ title, description, help, children }: {
  title: string;
  description: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-header">
        <div className="min-w-0 max-w-3xl">
          <h3 className="card-title">{title}</h3>
          <p className="card-description">{description}</p>
          {help && (
            <details className="help mt-2">
              <summary>Как читать</summary>
              <div className="help-body">{help}</div>
            </details>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function EmptyRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={columns} className="py-8 text-center text-text-muted">{children}</td>
    </tr>
  );
}

/**
 * The owner's view of the chat extension's health reports (chat-extension
 * H-11c): figures by extension version and ChatSpace build. The hub keeps no
 * person in them, so the page has none to show.
 */
export function ClientHealthPage() {
  const [period, setPeriod] = useState<ClientHealthPeriod>("7d");
  const range = clientHealthRange(period, toBusinessDate(new Date(), MOSCOW_TIME_ZONE));
  const { data, isLoading, isError, isFetching, refetch } = useAdminClientHealth(range);

  const header = (
    <>
      <DevHeader
        title="Расширение для чата: отчёты о работе"
        description="Пока открыт ChatSpace, расширение раз в 15 минут присылает технический отчёт; Hub хранит только суммы по версиям — без имён сотрудников, страниц и фанов."
      />
      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <FilterButtons
          filters={CLIENT_HEALTH_PERIODS.map(({ key, label }) => ({ key, label }))}
          active={period}
          onChange={(key) => setPeriod(key as ClientHealthPeriod)}
        />
        <p className="text-sm text-text-muted">{clientHealthRangeLabel(range)}, дни по московскому времени</p>
      </div>
    </>
  );
  const retry = (
    <button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn">
      Повторить
    </button>
  );

  if (!data) {
    return (
      <div>
        {header}
        {isLoading
          ? <StatusPanel title="Загружаем отчёты" />
          : <StatusPanel title="Отчёты не загрузились" description="Hub не ответил. Данные не потеряны: попробуйте ещё раз." tone="error" action={retry} />}
      </div>
    );
  }

  const model = clientHealthPageModel(data);

  return (
    <div>
      {header}
      {isError && (
        <div role="alert" className="notice notice-warning mb-4 flex-wrap items-center justify-between">
          <span>Обновить не получилось. Показаны данные прошлой загрузки.</span>
          {retry}
        </div>
      )}

      {model.empty ? (
        <StatusPanel
          title="За этот период отчётов нет"
          description="Отчёты приходят, когда в настройках включены «Расширение для чата: общий выключатель» и «Расширение для чата: отчёты о работе», а сотрудник в расширении согласился отправлять технические замеры."
        />
      ) : (
        <div className="space-y-5">
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
                  <th>Сборка ChatSpace</th>
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
                    <td className={`${CELL_CODE} font-mono text-xs`}>{row.build}</td>
                    <td className={CELL_NUMBER}>{row.reports}</td>
                    <td className={CELL_NUMBER}>{row.failedReports}</td>
                    <td className={`${CELL} font-mono text-xs`}>{row.missing || "—"}</td>
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
                  <th>Сборка ChatSpace</th>
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
                      <th colSpan={7} scope="rowgroup" className="bg-hover-alt text-sm font-semibold text-text-primary">
                        {block.label ?? block.metric}
                        {block.label !== null && <span className="ml-2 font-mono text-xs font-normal text-text-muted">{block.metric}</span>}
                      </th>
                    </tr>
                    {block.rows.map((row) => (
                      <tr key={row.key}>
                        <td className="whitespace-nowrap font-medium">{row.version}</td>
                        <td className={`${CELL_CODE} font-mono text-xs`}>{row.build}</td>
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
                Счётчики вставки, отправки и чтения расширение присылает всегда, даже без событий. Строки без
                названия — прочие коды; те, что начинаются с CG-, — ошибки. Внизу служебные счётчики: что
                расширение не включило в отчёты. Это не ошибки.
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
                {model.counters.length === 0 && <EmptyRow columns={3}>Счётчиков нет.</EmptyRow>}
                {model.counters.map((row) => (
                  <tr key={row.code}>
                    <td>{row.label ?? "—"}</td>
                    <td className={`${CELL_CODE} font-mono text-xs`}>{row.code}</td>
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
