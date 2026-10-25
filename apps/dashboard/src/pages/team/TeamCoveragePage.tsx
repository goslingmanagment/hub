import { useSearchParams } from "react-router";
import type { TeamEmptyHoursResponse, TeamGreetingsResponse } from "@agency_hub_core/contracts";
import { useTeamEmptyHours, useTeamGreetings } from "@/api/team";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime, formatMills } from "@/lib/format";

/**
 * Chat Memory week 6 (week-6.md §В–Г), «Команда → Покрытие»: who the team
 * leaves waiting. Read-only; the owner and team leads. A guide, not a basis
 * for pay.
 */

const RANGES = [
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
] as const;

const HOW_EMPTY_HOURS_WORK = [
  "Час пустой, если фаны в нём писали, а на этой странице ни одной минуты никто из команды не был на смене: расширение "
    + "ChatGoose открыто, и человек что-то делал на странице не больше часа назад. Расширение, забытое открытым на ночь, "
    + "смены не делает. Считается с первой смены страницы в расширении: раньше Hub не отличит пустой час от работы с "
    + "телефона или из старой версии.",
  "«Ждали больше часа» — после сообщения в пустой час личный ответ пришёл позже чем через час или его ещё нет (рассылка "
    + "Fansly и один текст пяти и больше фанам за час ответом не считаются). Траты — net фана на этой странице за последние "
    + "30 дней: это кто ждал, а не потерянные деньги.",
];

const HOW_GREETINGS_WORK = [
  "Новые подписчики — подписки, начавшиеся за период, у фанов, которые раньше ничего не покупали на странице и не "
    + "переписывались с ней: продление и возвращение не считаются. Сообщение страницы в первые 2 минуты после подписки "
    + "без автора из команды — автоприветствие. Личное приветствие — первое сообщение за 24 часа после подписки, "
    + "написанное чаттером или пришедшее позже 2 минут, не рассылка Fansly и не один текст пяти и больше фанам за час.",
  "«Ответили за час» — фан написал в течение часа после личного приветствия. «Купили за 7 дней» — любая покупка, кроме "
    + "подписки, в 7 дней после подписки: отдельно у поприветствованных лично и у остальных. У подписавшихся в последние "
    + "7 дней срок ещё идёт.",
  "Рассылки — массовые сообщения Fansly и один текст пяти и больше фанам за час (так выглядят рассылки OnlyMonster), "
    + "одна строка на текст и день. «Ответили» — фан написал в 24 часа после неё, «купили» — любая покупка, кроме "
    + "подписки, за 7 дней; у платной — купил ли фан её саму: Hub связал покупку с ней, или фан купил сообщение по её "
    + "цене за 7 дней, и до покупки ему не приходило другое платное по той же цене.",
];

const HEAD = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const NUM_HEAD = "whitespace-nowrap px-3 py-2 text-right text-xs font-medium text-text-muted xl:px-4";
const CELL = "px-3 py-2 align-top text-text-secondary xl:px-4";
const NUM = "whitespace-nowrap px-3 py-2 align-top text-right tabular-nums text-text-secondary xl:px-4";

type EmptyHoursPage = TeamEmptyHoursResponse["pages"][number];

function hourCellClass(count: number, max: number): string {
  if (count === 0) return "text-text-muted";
  return count * 2 > max ? "bg-accent/35 font-medium text-text-primary" : "bg-accent/15 text-text-primary";
}

/** Empty hours by Moscow hour of day: one cell per hour, 00–23. */
function HourStrip({ byHour }: { byHour: readonly number[] }) {
  const max = Math.max(...byHour);
  return (
    <div className="grid grid-cols-12 gap-px overflow-hidden rounded border border-border bg-border text-center text-[11px] tabular-nums sm:grid-cols-24">
      {byHour.map((count, hour) => (
        <div key={hour} title={`${String(hour).padStart(2, "0")}:00 МСК — пустых часов: ${count}`} className="bg-card">
          <div className={`px-0.5 py-1 ${hourCellClass(count, max)}`}>
            <div className="text-[10px] text-text-muted">{String(hour).padStart(2, "0")}</div>
            {count === 0 ? "·" : count}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyHoursTable({ pages }: { pages: readonly EmptyHoursPage[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            <th className={HEAD}>Страница</th>
            <th className={NUM_HEAD}>Часов с фанами</th>
            <th className={NUM_HEAD}>Пустых</th>
            <th className={NUM_HEAD}>Фанов писали · платящих</th>
            <th className={NUM_HEAD}>Ждали больше часа · их траты за 30 дн.</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => (
            <tr key={page.pageLabel} className="border-b border-border last:border-b-0">
              <td className={CELL}>
                <div className="font-medium text-text-primary">{page.pageLabel}</div>
                <div className="text-xs text-text-muted">
                  {page.shiftsSince === null ? "смен в расширении ещё не было" : `смены в расширении с ${formatDateTime(page.shiftsSince)}`}
                </div>
                {page.shiftsSince !== null && page.emptyHours > 0 && (
                  <div className="mt-2 min-w-[18rem]"><HourStrip byHour={page.emptyByHour} /></div>
                )}
              </td>
              {page.shiftsSince === null
                ? <td className={`${CELL} text-text-muted`} colSpan={4}>—</td>
                : (
                  <>
                    <td className={NUM}>{page.hoursWithFans}</td>
                    <td className={`${NUM} font-medium text-text-primary`}>
                      {page.emptyHours}
                      {page.hoursWithFans > 0 && <span className="font-normal text-text-muted"> · {Math.round((100 * page.emptyHours) / page.hoursWithFans)} %</span>}
                    </td>
                    <td className={NUM}>{page.fans} <span className="text-text-muted">· {page.payers}</span></td>
                    <td className={NUM}>
                      {page.waitedOverHour}
                      {page.waitedOverHour > 0 && <span className="text-text-muted"> · {formatMills(page.waitedNetMills)}</span>}
                    </td>
                  </>
                )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyHoursSection({ days }: { days: number }) {
  const { data, isLoading, isFetching, refetch } = useTeamEmptyHours(days);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Пустые часы</h2>
        <details className="help mt-1">
          <summary>Как это считается</summary>
          <div className="help-body">
            {HOW_EMPTY_HOURS_WORK.map((line) => <p key={line}>{line}</p>)}
          </div>
        </details>
      </div>
      {!data
        ? (isLoading
          ? <TableSkeleton rows={4} columns={5} />
          : (
            <StatusPanel
              title="Пустые часы не загрузились"
              description="Hub не ответил. Попробуйте ещё раз."
              tone="error"
              action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
            />
          ))
        : data.pages.length === 0
          ? <StatusPanel title="Фаны не писали" description="За это время ни на одну страницу не пришло сообщений." />
          : <EmptyHoursTable pages={data.pages} />}
    </section>
  );
}

type GreetingsPage = TeamGreetingsResponse["pages"][number];
type Broadcast = TeamGreetingsResponse["broadcasts"][number];

function share(part: number, whole: number): string {
  return whole === 0 ? "—" : `${Math.round((100 * part) / whole)} %`;
}

/** "8 мин", "3 ч 45 мин". */
function delayOf(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, "0")} мин`;
}

function GreetingsTable({ pages }: { pages: readonly GreetingsPage[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            <th className={HEAD}>Страница</th>
            <th className={NUM_HEAD}>Новых подписчиков</th>
            <th className={NUM_HEAD}>Автоприветствие</th>
            <th className={NUM_HEAD}>Лично за 24 ч · медиана</th>
            <th className={NUM_HEAD}>Ответили за час</th>
            <th className={NUM_HEAD}>Купили за 7 дн.</th>
            <th className={NUM_HEAD}>Рассылки</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => {
            const notGreeted = page.newSubscribers - page.greeted;
            return (
              <tr key={page.pageLabel} className="border-b border-border last:border-b-0">
                <td className={`${CELL} whitespace-nowrap`}>
                  <div className="font-medium text-text-primary">{page.pageLabel}</div>
                  {page.recent > 0 && <div className="text-xs text-text-muted">7 дней ещё идут у {page.recent}</div>}
                </td>
                <td className={`${NUM} font-medium text-text-primary`}>{page.newSubscribers}</td>
                <td className={NUM}>{share(page.autoWelcomed, page.newSubscribers)}</td>
                <td className={NUM}>
                  {page.greeted} <span className="text-text-muted">· {share(page.greeted, page.newSubscribers)} · {delayOf(page.greetingMedianSeconds)}</span>
                </td>
                <td className={NUM}>{page.repliedWithinHour} <span className="text-text-muted">· {share(page.repliedWithinHour, page.greeted)}</span></td>
                <td className={NUM}>
                  <div>лично {share(page.boughtGreeted, page.greeted)} <span className="text-text-muted">· {page.boughtGreeted} из {page.greeted}</span></div>
                  <div>без {share(page.boughtNotGreeted, notGreeted)} <span className="text-text-muted">· {page.boughtNotGreeted} из {notGreeted}</span></div>
                </td>
                <td className={NUM}>
                  {page.broadcasts.sent === 0 ? "—" : (
                    <>
                      <div>{page.broadcasts.deliveries} доставок</div>
                      <div className="text-text-muted">
                        ответили {share(page.broadcasts.replied, page.broadcasts.deliveries)} · купили {page.broadcasts.bought}
                      </div>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BroadcastsTable({ broadcasts }: { broadcasts: readonly Broadcast[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            <th className={HEAD}>Когда · страница</th>
            <th className={HEAD}>Текст</th>
            <th className={NUM_HEAD}>Цена</th>
            <th className={NUM_HEAD}>Доставок</th>
            <th className={NUM_HEAD}>Ответили за 24 ч</th>
            <th className={NUM_HEAD}>Купили за 7 дн.</th>
          </tr>
        </thead>
        <tbody>
          {broadcasts.map((cast) => (
            <tr key={`${cast.pageLabel}:${cast.sentAt}:${cast.priceMills ?? 0}`} className="border-b border-border last:border-b-0">
              <td className={`${CELL} whitespace-nowrap`}>
                {formatDateTime(cast.sentAt)}
                <div className="text-xs text-text-muted">{cast.pageLabel} · {cast.massMessage ? "рассылка Fansly" : "один текст многим"}</div>
              </td>
              <td className={`${CELL} min-w-[16rem] max-w-md`}>
                <span className="line-clamp-2">{cast.preview || <span className="text-text-muted">без текста</span>}</span>
                {cast.files > 0 && <span className="text-xs text-text-muted">файлов: {cast.files}</span>}
              </td>
              <td className={NUM}>{cast.priceMills === null ? "—" : formatMills(cast.priceMills)}</td>
              <td className={NUM}>{cast.deliveries}</td>
              <td className={NUM}>{cast.replied} <span className="text-text-muted">· {share(cast.replied, cast.deliveries)}</span></td>
              <td className={NUM}>
                {cast.bought}
                {cast.priceMills !== null && <span className="text-text-muted"> · эту: {cast.ppvBought}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GreetingsSection({ days }: { days: number }) {
  const { data, isLoading, isFetching, refetch } = useTeamGreetings(days);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Приветствия и рассылки</h2>
        <details className="help mt-1">
          <summary>Как это считается</summary>
          <div className="help-body">
            {HOW_GREETINGS_WORK.map((line) => <p key={line}>{line}</p>)}
          </div>
        </details>
      </div>
      {!data
        ? (isLoading
          ? <TableSkeleton rows={4} columns={7} />
          : (
            <StatusPanel
              title="Приветствия не загрузились"
              description="Hub не ответил. Попробуйте ещё раз."
              tone="error"
              action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
            />
          ))
        : data.pages.length === 0
          ? <StatusPanel title="Новых подписчиков и рассылок нет" description="За это время никто не подписался и рассылок не было." />
          : (
            <>
              <GreetingsTable pages={data.pages} />
              {data.broadcasts.length > 0 && (
                <>
                  <h3 className="mt-2 text-sm font-semibold text-text-primary">Рассылки</h3>
                  <BroadcastsTable broadcasts={data.broadcasts} />
                </>
              )}
            </>
          )}
    </section>
  );
}

export function TeamCoveragePage() {
  const [search, setSearch] = useSearchParams();
  const range = RANGES.some((item) => item.key === search.get("days")) ? search.get("days")! : "7";
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="max-w-3xl text-sm text-text-secondary">
          Кого команда оставляет ждать: часы без чаттера, когда фаны писали; новые подписчики без личного приветствия;
          отвечают ли на рассылки. Это ориентир, а не основание для оплаты.
        </p>
        <div className="mt-4">
          <FilterButtons
            filters={RANGES.map(({ key, label }) => ({ key, label }))}
            active={range}
            onChange={(key) => setSearch((current) => {
              const next = new URLSearchParams(current);
              next.set("days", key);
              return next;
            })}
          />
        </div>
      </div>
      <EmptyHoursSection days={Number(range)} />
      <GreetingsSection days={Number(range)} />
    </div>
  );
}
