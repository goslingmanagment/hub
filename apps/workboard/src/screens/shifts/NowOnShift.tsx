import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router";
import { Button, Card, Count, Duration, Money, Person, Skeleton, TimeMsk } from "@agency_hub_core/ui";
import { moscowDayOf, moscowToday } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath, shiftPath, type BackTarget } from "@/shared/links";
import { useMe } from "@/shared/useMe";
import { useNowOnShift, type NowShift } from "./data.js";

/**
 * «Сейчас на смене» (spec §4.1.2), independent of the period: one compact row
 * per running shift — who, where, since when, what it sold so far, how many
 * messages, how many fans wait now. The row opens the live review (the owner;
 * a team lead, who has no review, gets the person's shifts). Nobody on a shift:
 * one muted line with the last shift's end.
 */
export function NowOnShift({ page }: { page: string | null }) {
  const { state, sales } = useNowOnShift(page);
  const { isOwner } = useMe();
  const location = useLocation();
  const back: BackTarget = { to: `${location.pathname}${location.search}`, label: "Смены" };

  if (!state) {
    if (sales.isError) {
      return (
        <p className="shifts-now-line">
          <span aria-hidden className="shifts-now-line__dot" />
          <span>Не удалось узнать, кто сейчас на смене.</span>
          <Button size="sm" variant="ghost" loading={sales.isFetching} onClick={() => void sales.refetch()}>
            {sales.isFetching ? "Повторяем…" : "Повторить"}
          </Button>
        </p>
      );
    }
    return (
      <p className="shifts-now-line" aria-busy>
        <span aria-hidden className="shifts-now-line__dot" />
        <Skeleton width={360} />
      </p>
    );
  }

  if (state.shifts.length === 0) {
    const last = state.last;
    return (
      <p className="shifts-now-line">
        <span aria-hidden className="shifts-now-line__dot" />
        <span>
          Сейчас никто не на смене{page ? ` на ${page}` : ""}
          {last && (
            <>
              <span className="shifts-now-line__sep" aria-hidden>·</span>
              последняя смена — {last.username}, закончилась {moscowDayOf(last.endedAt) === moscowToday() ? "в " : ""}
              <TimeMsk at={last.endedAt} show={moscowDayOf(last.endedAt) === moscowToday() ? "time" : "datetime"} />
            </>
          )}
        </span>
      </p>
    );
  }

  return (
    <Card
      title="Сейчас на смене"
      padding="none"
      actions={<span className="shifts-card-note">Обновляется раз в минуту</span>}
    >
      <ul className="shifts-now">
        {state.shifts.map((shift) => (
          <li key={shift.key}>
            <Link
              to={isOwner ? shiftPath(shift.userId, shift.startedAt, location.search) : personPath(shift.userId, location.search, "shifts")}
              state={{ back }}
              className="shifts-now__row"
              aria-label={`${shift.username}: ${isOwner ? "открыть разбор идущей смены" : "открыть смены"}`}
            >
              <NowRow shift={shift} />
              <ChevronRight size={18} strokeWidth={1.75} aria-hidden className="shifts-now__go" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NowRow({ shift }: { shift: NowShift }) {
  return (
    <>
      <span className="shifts-now__who">
        <Person name={shift.username} status="working" hint={shift.pages.length > 0 ? shift.pages.join(", ") : "—"} />
      </span>
      <span className="shifts-now__since">
        с <TimeMsk at={shift.startedAt} show="time" />
        <span className="ui-muted"> · идёт <Duration minutes={shift.sinceMinutes} /></span>
      </span>
      <span className="shifts-now__fact">
        <Money mills={shift.salesNetMills} strong />
        <span className="shifts-now__unit">продажи</span>
      </span>
      <span className="shifts-now__fact">
        <Count value={shift.messages} />
        <span className="shifts-now__unit">{ruPlural(shift.messages, "сообщение", "сообщения", "сообщений")}</span>
      </span>
      <span className="shifts-now__fact" title="Фаны, чьё сообщение сейчас последнее в чате">
        {shift.waitingNow === undefined ? (
          <Skeleton width={96} />
        ) : shift.waitingNow === null ? (
          <span className="ui-muted">ждут ответа: —</span>
        ) : shift.waitingNow === 0 ? (
          <span className="shifts-now__unit">никто не ждёт ответа</span>
        ) : (
          <>
            <Count value={shift.waitingNow} />
            <span className="shifts-now__unit">{ruPlural(shift.waitingNow, "ждёт ответа", "ждут ответа", "ждут ответа")}</span>
          </>
        )}
      </span>
    </>
  );
}
