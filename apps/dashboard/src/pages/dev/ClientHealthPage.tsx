import { Fragment, useState, type ReactNode } from "react";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { useAdminClientHealth } from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import {
  CLIENT_HEALTH_PERIODS,
  clientHealthPageModel,
  clientHealthRange,
  clientHealthRangeLabel,
  formatCount,
  type ClientHealthPeriod,
} from "./clientHealthView.js";

const HEAD_CELL = "whitespace-nowrap px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted";
const HEAD_CELL_NUMBER = `${HEAD_CELL} text-right`;
const CELL = "px-4 py-3 text-sm text-text-secondary";
/** A version, a build or a code: never broken across lines; the section scrolls sideways instead. */
const CELL_CODE = `${CELL} whitespace-nowrap`;
const CELL_NUMBER = `${CELL} whitespace-nowrap text-right tabular-nums`;

function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8 overflow-x-auto rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <p className="mt-1 max-w-3xl text-[13px] text-text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function EmptyRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={columns} className="px-4 py-8 text-center text-sm text-text-muted">{children}</td>
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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-extrabold text-text-primary">Расширение для чата: отчёты о работе</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Пока у сотрудника открыт ChatSpace, расширение раз в 15 минут присылает технический отчёт.
          Hub складывает отчёты в почасовые суммы по версиям: имён сотрудников, страниц и фанов в них нет.
        </p>
      </div>
      <div className="ml-auto flex flex-col items-end gap-1">
        <FilterButtons
          filters={CLIENT_HEALTH_PERIODS.map(({ key, label }) => ({ key, label }))}
          active={period}
          onChange={(key) => setPeriod(key as ClientHealthPeriod)}
        />
        <p className="text-xs text-text-muted">{clientHealthRangeLabel(range)}, дни по московскому времени</p>
      </div>
    </div>
  );
  const retry = (
    <button
      type="button"
      onClick={() => void refetch()}
      disabled={isFetching}
      className="rounded-lg border border-border px-3 py-2 text-sm"
    >
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
        <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-dark/50 p-3 text-sm text-text-secondary">
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
        <>
          <Section
            title="Проверка страницы ChatSpace"
            description={(
              <>
                При запуске расширение проверяет, что на странице ChatSpace есть всё, на что оно опирается.
                Отчёт с ошибкой значит: чего-то не нашлось, и зависящие от этого функции были выключены.
                Всего отчётов: {formatCount(model.reports)}, с ошибкой: {formatCount(model.failedReports)}.
              </>
            )}
          >
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  <th className={HEAD_CELL}>Версия расширения</th>
                  <th className={HEAD_CELL}>Сборка ChatSpace</th>
                  <th className={HEAD_CELL_NUMBER}>Отчётов</th>
                  <th className={HEAD_CELL_NUMBER}>С ошибкой</th>
                  <th className={HEAD_CELL}>Что не найдено и в скольких отчётах</th>
                </tr>
              </thead>
              <tbody>
                {model.contract.length === 0 && <EmptyRow columns={5}>Отчётов о проверке нет.</EmptyRow>}
                {model.contract.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <td className={`${CELL_CODE} font-medium text-text-primary`}>{row.version}</td>
                    <td className={`${CELL_CODE} font-mono`}>{row.build}</td>
                    <td className={CELL_NUMBER}>{row.reports}</td>
                    <td className={CELL_NUMBER}>{row.failedReports}</td>
                    <td className={`${CELL} font-mono`}>{row.missing || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="Скорость"
            description={(
              <>
                Медиана: половина замеров быстрее этого. «95 из 100»: быстрее этого 95 замеров из 100.
                Если замеров меньше {formatCount(model.minGroupSize)}, показано только их число: по нескольким замерам судить нельзя.
              </>
            )}
          >
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  <th className={HEAD_CELL}>Версия расширения</th>
                  <th className={HEAD_CELL}>Сборка ChatSpace</th>
                  <th className={HEAD_CELL_NUMBER}>Замеров</th>
                  <th className={HEAD_CELL_NUMBER}>Среднее</th>
                  <th className={HEAD_CELL_NUMBER}>Медиана</th>
                  <th className={HEAD_CELL_NUMBER}>95 из 100</th>
                  <th className={HEAD_CELL_NUMBER}>Самый долгий</th>
                </tr>
              </thead>
              <tbody>
                {model.perf.length === 0 && <EmptyRow columns={7}>Замеров скорости нет.</EmptyRow>}
                {model.perf.map((block) => (
                  <Fragment key={block.key}>
                    <tr className="border-t border-border bg-hover-alt/50">
                      <th colSpan={7} scope="rowgroup" className="px-4 py-2 text-left text-[13px] font-semibold text-text-primary">
                        {block.label ?? block.metric}
                        {block.label !== null && <span className="ml-2 font-mono text-[12px] font-normal text-text-muted">{block.metric}</span>}
                      </th>
                    </tr>
                    {block.rows.map((row) => (
                      <tr key={row.key} className="border-t border-border">
                        <td className={`${CELL_CODE} font-medium text-text-primary`}>{row.version}</td>
                        <td className={`${CELL_CODE} font-mono`}>{row.build}</td>
                        <td className={CELL_NUMBER}>{row.count}</td>
                        {row.suppressed ? (
                          <td colSpan={4} className={`${CELL_CODE} text-right text-text-muted`}>мало замеров</td>
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
            description="Сколько раз за период случилось событие, по всем версиям вместе. Строки с названием расширение присылает всегда, даже когда событий не было; остальные строки — ошибки по коду."
          >
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  <th className={HEAD_CELL}>Событие</th>
                  <th className={HEAD_CELL}>Код</th>
                  <th className={HEAD_CELL_NUMBER}>Сколько раз</th>
                </tr>
              </thead>
              <tbody>
                {model.counters.length === 0 && <EmptyRow columns={3}>Счётчиков нет.</EmptyRow>}
                {model.counters.map((row) => (
                  <tr key={row.code} className="border-t border-border">
                    <td className={`${CELL} text-text-primary`}>{row.label ?? "—"}</td>
                    <td className={`${CELL_CODE} font-mono`}>{row.code}</td>
                    <td className={CELL_NUMBER}>{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="Сколько расширение держит у себя"
            description={(
              <>
                Размер сохранённых данных и журналов расширения и число его собственных элементов на странице ChatSpace.
                Показано значение, которого не превышают 95 отчётов из 100. Нужно не меньше {formatCount(model.minGroupSize)} отчётов.
              </>
            )}
          >
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  <th className={HEAD_CELL}>Версия расширения</th>
                  <th className={HEAD_CELL_NUMBER}>Сохранённые данные</th>
                  <th className={HEAD_CELL_NUMBER}>Журналы</th>
                  <th className={HEAD_CELL_NUMBER}>Элементов на странице</th>
                </tr>
              </thead>
              <tbody>
                {model.footprint.length === 0 && <EmptyRow columns={4}>Данных о размере нет.</EmptyRow>}
                {model.footprint.map((row) => (
                  <tr key={row.version} className="border-t border-border">
                    <td className={`${CELL_CODE} font-medium text-text-primary`}>{row.version}</td>
                    <td className={CELL_NUMBER}>{row.caches}</td>
                    <td className={CELL_NUMBER}>{row.logs}</td>
                    <td className={CELL_NUMBER}>{row.domNodes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}
