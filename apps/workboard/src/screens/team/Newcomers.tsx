import { Check } from "lucide-react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { KernelOperationResponse, PersonStartStepId } from "@agency_hub_core/contracts";
import { Badge, Card, Duration, EmptyState, ErrorState, SkeletonText, cx } from "@agency_hub_core/ui";
import { formatDay, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { kernel } from "@/shared/hub";
import { ShiftLink } from "@/shared/links";
import { formatAiUnedited, formatReplyMedian, formatUnanswered } from "@/shared/metrics";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { TeamTabs } from "./TeamTabs";
import "./people.css";

/**
 * «Команда → Новички» (products plan §2.3, §3, package W): each newcomer's first week — the steps of «Начало» as Hub
 * sees them, the first shifts with their quality beside the team's norm and whether the lead wrote a note on the
 * review. A newcomer two days on one step is the team lead's matter in «Ждут вас» («Новички»). The owner every team,
 * a lead theirs (Hub answers `teamNewcomers`). No money of people.
 */

type Newcomer = KernelOperationResponse<"teamNewcomers">["newcomers"][number];

const STEP_WORDS: Readonly<Record<PersonStartStepId, string>> = {
  install: "Расширение",
  extension: "Вход в расширение",
  pages: "Страница",
  activity: "Первая работа",
  payout: "Куда платить",
};

export function useNewcomers() {
  return useQuery({ queryKey: ["team", "newcomers"], queryFn: () => kernel.teamNewcomers(), staleTime: 60_000, refetchInterval: 5 * 60_000 });
}

function Steps({ person }: { person: Newcomer }) {
  const start = person.start;
  if (start === null) return <p className="ui-muted">Входа ещё нет: приглашение не открыто.</p>;
  return (
    <ol className="nc-steps">
      {start.steps.map((step) => (
        <li key={step.step} className={cx("nc-step", step.done && "nc-step--done", start.current === step.step && "nc-step--now")}>
          {step.done ? <Check size={14} strokeWidth={2} aria-hidden /> : <span className="nc-step__dot" aria-hidden />}
          {STEP_WORDS[step.step]}
        </li>
      ))}
    </ol>
  );
}

function Shifts({ person }: { person: Newcomer }) {
  if (person.shifts.length === 0) {
    return <p className="ui-muted">{person.firstActiveAt === null ? "Смен ещё нет." : `Работает с ${formatDay(person.firstActiveAt)}, смены ещё не было.`}</p>;
  }
  const team = person.team;
  return (
    <table className="nc-shifts">
      <thead>
        <tr>
          <th>Смена</th>
          <th>Отработано</th>
          <th>Ответ, медиана</th>
          <th>Без ответа к концу</th>
          <th>ИИ без правки</th>
          <th>Разбор</th>
        </tr>
      </thead>
      <tbody>
        {person.shifts.map((shift) => (
          <tr key={shift.startedAt}>
            <td>{formatWeekdayDay(shift.startedAt)} {formatTimeOfDay(shift.startedAt)}{shift.ongoing ? " – сейчас" : `–${formatTimeOfDay(shift.endedAt)}`}</td>
            <td><Duration minutes={shift.workedMinutes} /></td>
            <td>{shift.quality ? formatReplyMedian(shift.quality.replyMedianSeconds) : "—"}</td>
            <td>{shift.quality ? formatUnanswered(shift.quality.unansweredAtEnd) : "—"}</td>
            <td>{shift.quality ? formatAiUnedited(shift.quality.aiUneditedShare) : "—"}</td>
            <td>
              <ShiftLink userId={shift.userId} startedAt={shift.startedAt} backLabel="Новички" className="wt-link">
                {shift.noted ? "заметка есть" : "открыть"}
              </ShiftLink>
            </td>
          </tr>
        ))}
        {team && (
          <tr className="nc-shifts__norm">
            <td>Норма команды</td>
            <td />
            <td>{formatReplyMedian(team.replyMedianSeconds)}</td>
            <td>{formatUnanswered(team.unansweredAtEnd, { average: true })}</td>
            <td>{formatAiUnedited(team.aiUneditedShare)}</td>
            <td />
          </tr>
        )}
      </tbody>
    </table>
  );
}

function stateWords(person: Newcomer): { text: string; tone: "warning" | "info" | "success" } {
  if (person.start?.stuck) return { text: "стоит больше двух суток", tone: "warning" };
  if (person.state === "invited") return { text: "приглашён", tone: "info" };
  if (person.state === "set_up") return { text: "готовится к первой смене", tone: "info" };
  return { text: "первая неделя", tone: "success" };
}

export function NewcomersScreen() {
  const read = useNewcomers();
  const people = read.data?.newcomers ?? [];
  let body;
  if (read.isPending) body = <Card><SkeletonText lines={6} /></Card>;
  else if (read.isError && !read.data) body = <ErrorState onRetry={() => void read.refetch()} retrying={read.isFetching} />;
  else if (people.length === 0) {
    body = (
      <EmptyState title="Новичков нет">
        Новичок появится здесь, когда владелец пригласит человека в вашу команду, и пробудет его первую неделю работы.
      </EmptyState>
    );
  } else {
    body = people.map((person) => {
      const state = stateWords(person);
      return (
        <Card
          key={person.code}
          className="nc-card"
          title={<Link className="wt-link" to={`/team/${encodeURIComponent(person.code)}`}>{person.name}</Link>}
          description={person.teams.length > 0 ? person.teams.join(", ") : "Команды ещё нет: рабочие страницы даёт владелец"}
          actions={<Badge tone={state.tone}>{state.text}</Badge>}
        >
          <h3 className="nc-head">Начало{person.start ? ` · ${person.start.done} из ${person.start.total}` : ""}</h3>
          <Steps person={person} />
          <h3 className="nc-head">Первые смены</h3>
          <Shifts person={person} />
        </Card>
      );
    });
  }
  return (
    <>
      <ScreenHeader title="Команда" tabs={<TeamTabs />} meta={<span>Первая неделя каждого новичка. Новичок, который стоит на шаге больше двух суток, ждёт вас в «Ждут вас».</span>} />
      <div className="wb-content nc">{body}</div>
    </>
  );
}
