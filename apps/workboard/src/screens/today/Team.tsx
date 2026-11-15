import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { isMatterInfoKind, waitingGroupOf, type KernelOperationResponse } from "@agency_hub_core/contracts";
import { Duration, Skeleton } from "@agency_hub_core/ui";
import { formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { ShiftLink } from "@/shared/links";
import { mattersListQuery } from "@/shared/myMatters";
import { useMe } from "@/shared/useMe";
import { COLUMNS, useCustomBoard } from "../customs/data";
import { goLink } from "../waiting/links";
import { MyMatters } from "../waiting/MyMatters";
import { useToday } from "./data";

/**
 * «Сегодня» of whoever leads a team (products plan §2.3, §3): the owner every team (the teams without a lead named at
 * the top: their matters are his), a team lead and a chatter who leads by the records their teams. Who is on a shift,
 * whom the schedule names and is not on one, the reports that wait, what to decide, yesterday's shifts without a note,
 * customs by step, the schedule's gaps of the next three days. A lead's first days: the card «Первый день». Hub cuts
 * all of it to the viewer's teams (`workboardToday`); no money of people anywhere.
 */

type Team = NonNullable<KernelOperationResponse<"workboardToday">["team"]>;

const MINUTE = 60_000;

/** «Что вы решаете» (products plan §11 p.1): everything about the chats' work that is not the agency's money. */
const DECIDES = [
  "Чья продажа, когда чаттеры не договорились",
  "Несогласие чаттера с правкой Генгара",
  "Подмена и опоздание",
  "Вопросы чаттеров: скидка, бесплатная отправка, цена кастома",
  "Карточка кастома и отдача в съёмку",
];

function FirstDay({ team }: { team: Team }) {
  const names = team.teams.map((one) => one.name);
  return (
    <section className="today-card today-card--wide today-first" aria-labelledby="today-first">
      <h2 className="today-card__title" id="today-first">Первый день</h2>
      <div className="today-first__cols">
        <div>
          <h3 className="today-first__head">Ваши команды</h3>
          {names.length === 0 ? <p>Вам пока не назначили команду. Это делает владелец.</p> : <p>{names.join(", ")}</p>}
        </div>
        <div>
          <h3 className="today-first__head">Что вы решаете</h3>
          <ul className="today-first__list">{DECIDES.map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="ui-muted">Общак, «мимо площадки», выплаты и ставки решает владелец.</p>
        </div>
        <div>
          <h3 className="today-first__head">С чего начать</h3>
          <ol className="today-first__list">
            <li><Link className="wt-link" to="/waiting">Ждут вас</Link>: что ждёт вашего слова</li>
            <li><Link className="wt-link" to="/shifts">Смены</Link>: кто работал вчера и как</li>
            <li>Разборы вчерашних смен ниже: заметка чаттеру</li>
          </ol>
        </div>
      </div>
    </section>
  );
}

function TeamCard({ team, owner }: { team: Team["teams"][number]; owner: boolean }) {
  return (
    <section className="today-card" aria-label={`Команда ${team.name}`}>
      <h2 className="today-card__title">
        {team.name}
        {owner && <span className="today-card__sub"> · {team.leadName ? `тимлид ${team.leadName}` : "без тимлида"}</span>}
      </h2>
      <h3 className="today-card__head">Сейчас на смене</h3>
      {team.onShift.length === 0 ? <p className="ui-muted">Сейчас никто не на смене.</p> : (
        <ul className="today-list">
          {team.onShift.map((one) => (
            <li key={`${one.userId}:${one.startedAt}`} className="today-list__row">
              <span className="today-list__who">{one.name}</span>
              <span className="today-list__what">с {formatTimeOfDay(one.startedAt)}{one.pages.length > 0 ? ` · ${one.pages.join(", ")}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {team.absent.length > 0 && (
        <>
          <h3 className="today-card__head today-card__head--bad">По графику должен быть, не вышел</h3>
          <ul className="today-list">
            {team.absent.map((one) => (
              <li key={one.userId} className="today-list__row">
                <span className="today-list__who">{one.name}</span>
                <span className="today-list__what">по графику {one.start}–{one.end}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="today-card__head">График на три дня</h3>
      {team.noSchedule ? (
        <p className="ui-muted">Графика нет. Его ставят в карточке человека, вкладка «График».</p>
      ) : team.gaps.length === 0 ? <p className="ui-muted">Все часы закрыты.</p> : (
        <ul className="today-list">
          {team.gaps.slice(0, 5).map((gap) => (
            <li key={`${gap.day}:${gap.start}`} className="today-list__row">
              <span className="today-list__who">Никого</span>
              <span className="today-list__what">{formatWeekdayDay(`${gap.day}T12:00:00+03:00`)} {gap.start}–{gap.end}</span>
            </li>
          ))}
          {team.gaps.length > 5 && <li className="today-list__row ui-muted">ещё {team.gaps.length - 5} {ruPlural(team.gaps.length - 5, "дыра", "дыры", "дыр")}</li>}
        </ul>
      )}
    </section>
  );
}

/** «Отчёты»: the reports' matters that wait for the viewer (not handed in, to confirm, in dispute), from the one list. */
function Reports() {
  const list = useQuery({ ...mattersListQuery, refetchInterval: MINUTE });
  const reports = (list.data?.matters ?? []).filter((matter) => matter.mine && !isMatterInfoKind(matter.kind) && waitingGroupOf(matter.kind) === "reports");
  return (
    <section className="today-card" aria-labelledby="today-reports">
      <h2 className="today-card__title" id="today-reports">
        Отчёты
        {reports.length > 0 && <Link className="wt-link today-card__more" to="/waiting#reports">все {reports.length}</Link>}
      </h2>
      {list.isLoading ? <Skeleton height={48} radius={8} /> : reports.length === 0 ? <p className="ui-muted">Отчёты в порядке: ничего не ждёт.</p> : (
        <ul className="today-list">
          {reports.slice(0, 4).map((matter) => (
            <li key={matter.id} className="today-list__row">
              <span className="today-list__who">{matter.title}</span>
              <span className="today-list__what">{matter.pageLabels.join(", ")}{matter.link ? <> {goLink(matter.link, "Открыть")}</> : null}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Reviews({ reviews }: { reviews: Team["reviews"] }) {
  return (
    <section className="today-card" aria-labelledby="today-reviews">
      <h2 className="today-card__title" id="today-reviews">Разборы<span className="today-card__sub"> · вчера, без заметки</span></h2>
      {reviews.length === 0 ? <p className="ui-muted">Вчерашних смен без заметки нет.</p> : (
        <ul className="today-list">
          {reviews.slice(0, 6).map((one) => (
            <li key={`${one.userId}:${one.startedAt}`} className="today-list__row">
              <ShiftLink userId={one.userId} startedAt={one.startedAt} backLabel="Сегодня" className="today-list__who wt-link">{one.name}</ShiftLink>
              <span className="today-list__what">{formatTimeOfDay(one.startedAt)}–{formatTimeOfDay(one.endedAt)} · <Duration minutes={one.workedMinutes} />{one.pages.length > 0 ? ` · ${one.pages.join(", ")}` : ""}</span>
            </li>
          ))}
          {reviews.length > 6 && <li className="today-list__row"><Link className="wt-link" to="/shifts">ещё {reviews.length - 6} в «Сменах»</Link></li>}
        </ul>
      )}
    </section>
  );
}

function Customs() {
  const board = useCustomBoard(null);
  const open = COLUMNS.filter((column) => column.id !== "given").map((column) => ({
    column,
    count: (board.data?.orders ?? []).filter((order) => (column.states as readonly string[]).includes(order.state)).length,
  }));
  const total = open.reduce((sum, one) => sum + one.count, 0);
  return (
    <section className="today-card" aria-labelledby="today-customs">
      <h2 className="today-card__title" id="today-customs">
        Кастомы
        <Link className="wt-link today-card__more" to="/customs">доска</Link>
      </h2>
      {board.isPending ? <Skeleton height={48} radius={8} /> : board.isError ? <p className="ui-muted">Заказы не пришли.</p> : total === 0 ? <p className="ui-muted">Открытых заказов нет.</p> : (
        <dl className="today-steps">
          {open.map(({ column, count }) => (
            <div key={column.id} className={count === 0 ? "today-steps__one today-steps__one--none" : "today-steps__one"}>
              <dt>{column.title}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function TeamToday() {
  const today = useToday();
  const { isOwner } = useMe();
  const team = today.data?.team ?? null;
  if (today.isPending) return <div className="today-grid"><Skeleton height={160} radius={12} /><Skeleton height={160} radius={12} /></div>;
  if (team === null) return null;
  const unled = isOwner ? team.teams.filter((one) => one.leadName === null) : [];
  return (
    <div className="today-grid">
      {team.firstDay && <FirstDay team={team} />}
      {unled.length > 0 && (
        <p className="today-unled today-card--wide">
          Без тимлида: {unled.map((one) => one.name).join(", ")}. Их дела решаете вы.
        </p>
      )}
      {team.teams.map((one) => <TeamCard key={one.modelId} team={one} owner={isOwner} />)}
      <div className="today-card"><MyMatters title="Решить" workboardOnly={isOwner} /></div>
      <Reports />
      <Reviews reviews={team.reviews} />
      <Customs />
    </div>
  );
}
