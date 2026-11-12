import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router";
import { Card, Count, Money, Person, Section, Skeleton, TimeMsk, Tooltip } from "@agency_hub_core/ui";
import { formatDay, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { addDays, moscowDayOf, moscowToday } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftDurationHint } from "@agency_hub_core/ui/shiftWhen";
import { ShiftLink, personPath, shiftPath, useBackState } from "@/shared/links";
import { UNANSWERED_NOW_LABEL } from "@/shared/metrics";
import { useMe } from "@/shared/useMe";
import { usePeopleIndex } from "@/shared/people";
import { useNowOnShift, type NowShift } from "./data.js";

/**
 * «Сейчас на смене» (spec §4.1.2), independent of the period: one compact row
 * per running shift — who, where, since when, what it sold so far, how many
 * messages, how many fans wait now. The row opens the live review (the owner;
 * a team lead, who has no review, gets the person's card). Nobody on a shift:
 * one muted line with the last shift's end, which opens that shift.
 */
export function NowOnShift({ page, only = null }: { page: string | null; only?: ReadonlySet<number> | null }) {
  const read = useNowOnShift(page);
  const { sales } = read;
  const people = usePeopleIndex();
  // «Мои смены» of the owner: their own shifts alone. Each named by its person.
  const shown = read.state && only ? { ...read.state, shifts: read.state.shifts.filter((shift) => only.has(shift.userId)), last: read.state.last && only.has(read.state.last.userId) ? read.state.last : null } : read.state;
  const state = shown && {
    ...shown,
    shifts: shown.shifts.map((shift) => ({ ...shift, username: people.nameOf(shift.userId, shift.username) })),
    last: shown.last && { ...shown.last, username: people.nameOf(shown.last.userId, shown.last.username) },
  };
  const { isOwner } = useMe();
  const location = useLocation();
  const { back } = useBackState("Смены");

  if (!state) {
    if (sales.isError) {
      // No button of its own: the read repeats by itself every minute, and the screen's «Повторить» asks again too.
      return (
        <p className="shifts-now-line">
          <span aria-hidden className="shifts-now-line__dot" />
          <span>Не удалось узнать, кто сейчас на смене. Спросим Hub снова через минуту.</span>
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
    const ended = last ? endedWords(last.endedAt) : null;
    return (
      <p className="shifts-now-line">
        <span aria-hidden className="shifts-now-line__dot" />
        <span>
          Сейчас никто не на смене{page ? ` на ${page}` : ""}
          {last && (
            <>
              <span className="shifts-now-line__sep" aria-hidden>·</span>
              {"последняя смена — "}
              {isOwner ? (
                <ShiftLink userId={last.userId} startedAt={last.startedAt} backLabel="Смены" className="shifts-now-line__link">
                  {last.username}, закончилась {ended}
                </ShiftLink>
              ) : (
                <>{last.username}, закончилась {ended}</>
              )}
            </>
          )}
        </span>
      </p>
    );
  }

  return (
    <Section title="Сейчас на смене" actions={<span className="shifts-card-note">Обновляется раз в минуту</span>}>
      <Card padding="none">
        <ul className="shifts-now">
          {state.shifts.map((shift) => (
            <li key={shift.key}>
              <Link
                to={isOwner ? shiftPath(shift.userId, shift.startedAt, location.search) : personPath(shift.userId, location.search)}
                state={{ back }}
                className="shifts-now__row"
                aria-label={`${shift.username}: ${isOwner ? "открыть разбор идущей смены" : "открыть карточку"}`}
              >
                <NowRow shift={shift} />
                <ChevronRight size={18} strokeWidth={1.75} aria-hidden className="shifts-now__go" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}

/**
 * When the last shift ended, as the owner reads it after midnight: «в 18:53»
 * today, «вчера в 18:53», else «7 нояб. в 18:53».
 */
function endedWords(endedAt: string): string {
  const day = moscowDayOf(endedAt);
  const today = moscowToday();
  const time = formatTimeOfDay(endedAt);
  if (day === today) return `в ${time}`;
  if (day === addDays(today, -1)) return `вчера в ${time}`;
  return `${formatDay(day)} в ${time}`;
}

function NowRow({ shift }: { shift: NowShift }) {
  return (
    <>
      <span className="shifts-now__who">
        <Person name={shift.username} status="working" hint={shift.pages.length > 0 ? shift.pages.join(", ") : "—"} />
      </span>
      <span className="shifts-now__since">
        <span className="shifts-now__line">
          с <TimeMsk at={shift.startedAt} show="time" />
          <span className="shifts-now__sep" aria-hidden>·</span>
          {/* D12: the time worked so far; with the pauses only on hover. */}
          <Tooltip content={shiftDurationHint(shift.when) ?? shift.when.label} align="start">
            <span className="ui-muted">{shift.when.worked} работы</span>
          </Tooltip>
        </span>
        {shift.idle !== null && (
          <Tooltip content={`${shift.idle}. ${shift.idleHint}`} align="start">
            {/* One word on the line — «нет связи» (the extension closed) says more than «без действий»; both in the hint. */}
            <span className="shifts-now__idle">{shift.idle.split(" · ").find((part) => part.startsWith("нет связи")) ?? shift.idle.split(" · ")[0]}</span>
          </Tooltip>
        )}
      </span>
      <span className="shifts-now__fact">
        <Money mills={shift.salesNetMills} strong />
        <span className="shifts-now__unit">продажи</span>
      </span>
      <span className="shifts-now__fact">
        <Count value={shift.messages} />
        <span className="shifts-now__unit">{ruPlural(shift.messages, "сообщение", "сообщения", "сообщений")}</span>
      </span>
      <span className="shifts-now__fact">
        {shift.waitingNow === undefined ? (
          <Skeleton width={96} />
        ) : shift.waitingNow === null ? (
          <span className="ui-muted">ждут ответа: —</span>
        ) : (
          <Tooltip content={`${UNANSWERED_NOW_LABEL}: фаны чаттера, которые написали в эту смену и ещё не получили ответа. То же число, что в разборе идущей смены.`} align="end">
            {shift.waitingNow === 0 ? (
              <span className="shifts-now__unit">никто не ждёт ответа</span>
            ) : (
              <span className="shifts-now__waiting">
                <Count value={shift.waitingNow} />
                <span className="shifts-now__unit">{ruPlural(shift.waitingNow, "ждёт ответа", "ждут ответа", "ждут ответа")}</span>
              </span>
            )}
          </Tooltip>
        )}
      </span>
    </>
  );
}
