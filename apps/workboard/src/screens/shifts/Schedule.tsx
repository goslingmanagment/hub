import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { Button, Card, EmptyState, ErrorState, Person, PageLabels, SkeletonText } from "@agency_hub_core/ui";
import { formatWeekdayDay } from "@agency_hub_core/ui/format";
import { slotWords } from "@agency_hub_core/ui/people/words";
import { kernel } from "@/shared/hub";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { ShiftsTabs } from "@/shared/ShiftsTabs";
import { useMe } from "@/shared/useMe";
import { useTeamPeople } from "../team/teamPeople";
import { useToday } from "../today/data";
import { AskModal, type AskStart } from "../waiting/Questions";
import "./shifts.css";

/**
 * «Смены → График» (products plan §2.3, package W): the standing schedule of the viewer's teams, read — each team
 * (a model) with its people, their slot by Moscow time and the pages it is for, on a day's strip; for whoever leads,
 * the hours of the next three days no slot covers (`workboardToday`); the approved swaps of the days ahead («подмена:
 * не выйдет Алекс, выйдет Оля», `teamSwaps`). The schedule is the people registry's (the «whose sale» rule reads the same slots); the
 * owner changes the standing one on the person's card. «Попросить подмену» on one's own slot (a lead on any of the team's)
 * and «Предложить сетку» (a lead, to the owner) are questions (products plan §4.6). Hub cuts the people to the teams.
 */

type TeamPerson = KernelOperationResponse<"teamPeople">["people"][number];
type Slot = NonNullable<TeamPerson["schedule"]>;

const DAY_MINUTES = 1440;

/** A slot on the day's strip: one bar, or two when it crosses midnight. */
function Strip({ slots }: { slots: readonly Slot[] }) {
  const bars = slots.flatMap((slot) => {
    const end = slot.endMinute <= slot.startMinute ? slot.endMinute + DAY_MINUTES : slot.endMinute;
    const parts = end > DAY_MINUTES ? [[slot.startMinute, DAY_MINUTES], [0, end - DAY_MINUTES]] : [[slot.startMinute, end]];
    return parts.map(([from, to]) => ({ key: `${slot.id}:${from}`, left: (from! / DAY_MINUTES) * 100, width: ((to! - from!) / DAY_MINUTES) * 100 }));
  });
  return (
    <span className="sched-strip" aria-hidden>
      {[6, 12, 18].map((hour) => <span key={hour} className="sched-strip__tick" style={{ left: `${(hour / 24) * 100}%` }} />)}
      {bars.map((bar) => <span key={bar.key} className="sched-strip__bar" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />)}
    </span>
  );
}

interface Team {
  slug: string;
  name: string;
  people: Array<{ person: TeamPerson; pages: string[]; slots: Slot[] }>;
}

/** The teams of the people the viewer reads: a person is in the team of each model of their working pages. */
function teamsOf(people: readonly TeamPerson[]): Team[] {
  const teams = new Map<string, Team>();
  for (const person of people) {
    if (person.kind !== "human" || person.state === "left") continue;
    const models = new Map<string, { name: string; pages: string[] }>();
    for (const page of person.workingPages) {
      const model = models.get(page.modelSlug) ?? { name: page.modelName, pages: [] };
      model.pages.push(page.pageLabel);
      models.set(page.modelSlug, model);
    }
    for (const [slug, model] of models) {
      const team = teams.get(slug) ?? { slug, name: model.name, people: [] };
      // The person's every-page slot, and a page's own line of this team's pages where it differs.
      const own = person.pageSchedules.filter((slot) => slot.pageLabel !== null && model.pages.includes(slot.pageLabel));
      const slots = [...(person.schedule ? [person.schedule] : []), ...own];
      team.people.push({ person, pages: model.pages, slots });
      teams.set(slug, team);
    }
  }
  return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map((team) => ({ ...team, people: team.people.sort((a, b) => (a.slots[0]?.startMinute ?? DAY_MINUTES) - (b.slots[0]?.startMinute ?? DAY_MINUTES)) }));
}

function SlotLine({ slot }: { slot: Slot }) {
  const words = slotWords(slot);
  return (
    <span className="sched-slot">
      <span className="sched-slot__hours">{words.hours}</span>
      <span className="ui-muted"> · {words.days}{slot.pageLabel ? ` · только ${slot.pageLabel}` : ""}</span>
    </span>
  );
}

export function ScheduleScreen() {
  const people = useTeamPeople();
  const today = useToday();
  const { role, leadsTeam, isOwner, user } = useMe();
  const swaps = useQuery({ queryKey: ["team-swaps"], queryFn: () => kernel.teamSwaps(), staleTime: 60_000 });
  const [asking, setAsking] = useState<AskStart | null>(null);
  const meCode = (people.data?.people ?? []).find((person) => person.logins.some((login) => login.userId === user?.id))?.code ?? null;
  // A lead asks a swap for anyone of the team; anyone else for their own slot. The owner decides, he does not ask.
  const mayAskFor = (code: string) => !isOwner && (code === meCode || leadsTeam);
  const teams = useMemo(() => teamsOf(people.data?.people ?? []), [people.data]);
  const gapsOf = (name: string) => today.data?.team?.teams.find((team) => team.name === name) ?? null;

  let body;
  if (people.isPending) body = <Card><SkeletonText lines={6} /></Card>;
  else if (people.isError && !people.data) body = <ErrorState onRetry={() => void people.refetch()} retrying={people.isFetching} />;
  else if (teams.length === 0) {
    body = (
      <EmptyState title={role === "chatter" ? "Вас пока не добавили в команду модели" : "Команд пока нет"}>
        Команда — это люди, которые работают на страницах модели. Их рабочие страницы ставит владелец в Hub, в «Людях».
      </EmptyState>
    );
  } else {
    body = teams.map((team) => {
      const lead = gapsOf(team.name);
      const teamPages = new Set(team.people.flatMap((one) => one.pages));
      const ofTeam = (swaps.data?.swaps ?? []).filter((swap) => swap.pages.some((page) => teamPages.has(page)));
      return (
        <Card
          key={team.slug}
          title={team.name}
          padding="none"
          className="sched-team"
          actions={leadsTeam && !isOwner ? (
            <Button size="sm" variant="ghost" onClick={() => setAsking({ kind: "schedule", pageLabel: [...teamPages][0]! })}>Предложить сетку</Button>
          ) : undefined}
        >
          <ul className="sched-rows">
            <li className="sched-row sched-row--head" aria-hidden>
              <span />
              <span />
              <span className="sched-hours">{["00", "06", "12", "18", "24"].map((hour) => <span key={hour}>{hour}</span>)}</span>
            </li>
            {team.people.map(({ person, pages, slots }) => (
              <li key={person.id} className="sched-row">
                <span className="sched-row__who"><Person name={person.displayName} hint={<PageLabels labels={pages} />} /></span>
                <span className="sched-row__slots">
                  {slots.length === 0 ? <span className="ui-muted">графика нет</span> : slots.map((slot) => <SlotLine key={slot.id} slot={slot} />)}
                  {slots.length > 0 && mayAskFor(person.code) && (
                    <button
                      type="button"
                      className="wt-link sched-row__ask"
                      onClick={() => setAsking({
                        kind: "swap",
                        swap: {
                          pageLabels: pages, start: slots[0]!.start, end: slots[0]!.end,
                          ...(person.code === meCode ? {} : { absentPersonCode: person.code, absentName: person.displayName }),
                        },
                      })}
                    >
                      Попросить подмену
                    </button>
                  )}
                </span>
                <Strip slots={slots} />
              </li>
            ))}
          </ul>
          {ofTeam.length > 0 && (
            <ul className="sched-swaps">
              {ofTeam.map((swap) => (
                <li key={swap.questionId}>
                  <Link className="wt-link" to={`/waiting?question=${swap.questionId}#asks`}>
                    подмена: не выйдет {swap.absent.name}, выйдет {swap.cover.name}
                  </Link>
                  <span className="ui-muted"> · {formatWeekdayDay(`${swap.date}T12:00:00+03:00`)} {swap.start}–{swap.end} · {swap.pages.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
          {lead !== null && !lead.noSchedule && (
            <p className="sched-gaps">
              {lead.gaps.length === 0 ? "Следующие три дня все часы закрыты."
                : <>Никого по графику: {lead.gaps.map((gap) => `${formatWeekdayDay(`${gap.day}T12:00:00+03:00`)} ${gap.start}–${gap.end}`).join("; ")}.</>}
            </p>
          )}
        </Card>
      );
    });
  }

  return (
    <>
      <ScreenHeader title="Смены" meta={<span>Постоянная сетка по московскому времени. Её меняет владелец в карточке человека, вкладка «График».</span>} />
      <div className="wb-content shifts">
        <ShiftsTabs />
        {body}
      </div>
      {asking && <AskModal start={asking} onClose={() => setAsking(null)} />}
    </>
  );
}
