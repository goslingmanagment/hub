import { Link } from "react-router";
import { Badge, Duration, EmptyState, Facts, LinkButton, Money, Skeleton, Tooltip, type FactItem } from "@agency_hub_core/ui";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import { addDays, moscowToday } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftPauseText } from "@agency_hub_core/ui/shiftLive";
import { shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { perHourMills } from "@/shared/metrics";
import { useMe } from "@/shared/useMe";
import { MyMoneyBlock } from "../my-shifts/MyMoney";
import { PeriodQualityLine } from "../my-shifts/MyQuality";
import { rowsOf, type MyShiftRow } from "../my-shifts/model";
import { MyMatters } from "../waiting/MyMatters";
import { WEEK_DAYS, useToday, useTodayNumbers, useTodayShifts } from "./data";
import { MyPotsBlock } from "./MyPots";
// The quality line's look (`mys-quality`) is «Мои смены»'s own.
import "../my-shifts/my-shifts.css";

/**
 * «Сегодня» of the person who works shifts (products plan §2.3, §3): «От прошлой смены» (a colleague's comment for the
 * next shift on the person's pages, the customs to give), «Моя смена» (the one going on or the last: hours, the sales by
 * the rule and the report's number — two named numbers — and its report), «Ждут вас» (the first lines), «Неделя» (the
 * person's own numbers, the team's average beside the quality ones; never a list of people, never pay), «Мои деньги»
 * (only with the person's switch), «Общак» (the person's own share of the pots, for everyone: base, never pay).
 */

type Today = KernelOperationResponse<"workboardToday">;

/** The report of the shift, in the words of the board (with the switch) or of the old way (the post). */
function ReportState({ row }: { row: MyShiftRow }) {
  const { test } = useMe();
  if (row.hub !== null) {
    const words = row.state === "handed" ? "Сдан" : row.state === "ongoing" ? "Смена идёт" : "Сдайте смену";
    return (
      <div className="today-report">
        <Badge tone={row.state === "handed" ? "success" : row.state === "ongoing" ? "info" : "warning"} bare>{words}</Badge>
        <LinkButton size="sm" variant={row.state === "due" ? "primary" : "secondary"} to={`/report/${row.hub.shiftId}`}>Отчёт</LinkButton>
      </div>
    );
  }
  const words: Record<MyShiftRow["state"], string> = {
    posted: "Пост в «Отчётности» отправлен",
    draft: "Отчёт собран: проверьте его и отправьте пост",
    missing: "Отчёта нет: попросите в чате /smena",
    ongoing: "Смена идёт: отчёт соберут в конце",
    // The test team's reports are none (the ledger does not know it), never «not come».
    unknown: test ? "В тестовой команде отчёты сдают доской" : "Отчёты сейчас не пришли",
    other: row.report?.status ?? "",
    due: "Сдайте смену",
    handed: "Сдан",
  };
  return <p className="today-report__words">{words[row.state]}</p>;
}

function MyShift({ rows, loading, failed }: { rows: readonly MyShiftRow[] | undefined; loading: boolean; failed: boolean }) {
  const row = rows?.find((one) => one.shift !== null) ?? null;
  let body;
  if (loading) body = <Skeleton height={96} radius={8} />;
  else if (failed) body = <p className="ui-muted">Смены не пришли. Спросим Hub снова через минуту.</p>;
  else if (row === null || row.shift === null) {
    body = (
      <EmptyState title="Смен пока нет">
        Смена начнётся сама, когда вы начнёте работать в чатах в расширении ChatGoose.
      </EmptyState>
    );
  } else {
    const shift = row.shift;
    const when = shiftWhen({ startedAt: shift.startedAt, endedAt: shift.endedAt, ongoing: shift.ongoing, workedMinutes: shift.workedMinutes });
    const pause = shiftPauseText(shift);
    body = (
      <>
        <p className="today-shift__when">
          {shift.ongoing ? <>Идёт с {formatTimeOfDay(shift.startedAt)}{pause !== null && `, ${pause}`}</> : <>Последняя: {when.label}</>}
          {" · "}<Duration minutes={shift.workedMinutes} />
          {shift.pages.length > 0 && <span className="ui-muted"> · {shift.pages.join(", ")}</span>}
        </p>
        <dl className="today-shift__sums">
          <div>
            <dt><Tooltip content="Продажи смены по правилу «чья продажа»: так их видит Hub, пока смена не сдана.">По правилу</Tooltip></dt>
            <dd><Money mills={row.ruleMills ?? 0} /></dd>
          </div>
          <div>
            <dt><Tooltip content="Число отчёта: сданного, отправленного поста или собранного черновика. По нему считают деньги.">По отчёту</Tooltip></dt>
            <dd>
              {row.totalMills === null ? <span className="ui-muted">отчёта нет</span> : <Money mills={row.totalMills} strong />}
              {row.preliminary && <span className="ui-muted"> предварительно</span>}
            </dd>
          </div>
        </dl>
        <ReportState row={row} />
      </>
    );
  }
  return (
    <section className="today-card" aria-labelledby="today-shift">
      <h2 className="today-card__title" id="today-shift">
        Моя смена
        <Link className="wt-link today-card__more" to="/shifts/mine">все смены</Link>
      </h2>
      {body}
    </section>
  );
}

function FromLastShift({ today }: { today: Today | undefined }) {
  const handover = today?.handover ?? [];
  const customs = today?.customsToGive ?? [];
  return (
    <section className="today-card" aria-labelledby="today-handover">
      <h2 className="today-card__title" id="today-handover">От прошлой смены</h2>
      {today === undefined ? <Skeleton height={48} radius={8} /> : handover.length === 0 && customs.length === 0 ? (
        <p className="ui-muted">Комментариев к смене нет, кастомов к отдаче нет.</p>
      ) : (
        <ul className="today-list">
          {handover.map((one) => (
            <li key={one.shiftId} className="today-list__row today-list__row--note">
              <span className="today-list__who">{one.person.name}<span className="ui-muted"> · {one.pages.join(", ")} · до {formatTimeOfDay(one.endedAt)}</span></span>
              <span className="today-list__note">«{one.comment}»</span>
            </li>
          ))}
          {customs.length > 0 && (
            <li className="today-list__row">
              <span className="today-list__who">
                {customs.length} {ruPlural(customs.length, "кастом снят", "кастома сняты", "кастомов сняты")}: отдайте фану
              </span>
              <span className="today-list__links">
                {customs.slice(0, 4).map((order) => (
                  <Link key={order.code} className="wt-link" to={`/customs/${order.code}`}>{order.code}{order.fanName ? `, ${order.fanName}` : ""}</Link>
                ))}
                {customs.length > 4 && <Link className="wt-link" to="/customs">ещё {customs.length - 4}</Link>}
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function Week({ rows, loading }: { rows: readonly MyShiftRow[] | undefined; loading: boolean }) {
  const numbers = useTodayNumbers();
  const shifts = (rows ?? []).filter((row) => row.shift !== null);
  const worked = shifts.reduce((sum, row) => sum + (row.workedMinutes ?? 0), 0);
  const rule = shifts.reduce((sum, row) => sum + (row.ruleMills ?? 0), 0);
  const items: FactItem[] = [
    { label: "Смен", value: String(shifts.length) },
    { label: "Часов", value: <Duration minutes={worked} /> },
    { label: "Продажи по правилу", value: <Money mills={rule} />, hint: "Продажи ваших смен по правилу «чья продажа». Суммы отчётов в «Смены → Мои»." },
    { label: "В час", value: perHourMills(rule, worked) === null ? "—" : <Money mills={perHourMills(rule, worked)!} />, hint: "Продажи по правилу за час работы, паузы не считаются." },
  ];
  return (
    <section className="today-card today-card--wide" aria-labelledby="today-week">
      <h2 className="today-card__title" id="today-week">Неделя<span className="today-card__sub"> · последние {WEEK_DAYS} дней</span></h2>
      {loading ? <Skeleton height={56} radius={8} /> : shifts.length === 0 ? (
        <p className="ui-muted">За неделю смен нет.</p>
      ) : (
        <>
          <Facts items={items} layout="stacked" columns={4} label="Неделя" className="today-week__facts" />
          {numbers.data && <PeriodQualityLine answer={numbers.data} />}
        </>
      )}
    </section>
  );
}

/**
 * The person's own day. A leader with no shift of their own this week sees none of it (their «Ждут вас» is «Решить»)
 * but «Общак»: a pot's participants are its page's workers, shifts or not.
 */
export function OwnToday({ leader }: { leader: boolean }) {
  const shifts = useTodayShifts();
  const today = useToday();
  const rows = shifts.data ? rowsOf(shifts.data.rows) : undefined;
  const works = (rows ?? []).some((row) => row.shift !== null);
  const week = { from: addDays(moscowToday(), -(WEEK_DAYS - 1)), to: moscowToday() };
  if (leader && !works) return <div className="today-grid"><div className="today-money"><MyPotsBlock window={week} /></div></div>;
  return (
    <div className="today-grid">
      {leader && <h2 className="today-part">Ваши смены</h2>}
      <FromLastShift today={today.data} />
      <MyShift rows={rows} loading={shifts.isPending} failed={shifts.isError && !shifts.data} />
      {!leader && <div className="today-card"><MyMatters /></div>}
      <Week rows={rows} loading={shifts.isPending} />
      <div className="today-money"><MyMoneyBlock window={week} /></div>
      <div className="today-money"><MyPotsBlock window={week} /></div>
    </div>
  );
}
