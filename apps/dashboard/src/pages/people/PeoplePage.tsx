import { UserPlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Badge, Button, Card, Disclosure, EmptyState, ErrorState, PageLabels, Person, Skeleton, Table, toast, type Column, type PersonStatus } from "@agency_hub_core/ui";
import { formatDay } from "@agency_hub_core/ui/format";
import { hubPersonPath } from "@agency_hub_core/contracts";
import { lastSeenOf, liveLogins, slotSummary, unsettledNotes, type RegistryLogin, type RegistryPerson } from "@agency_hub_core/ui/people/registry";
import { whenWords } from "@agency_hub_core/ui/people/when";
import { capitalized, PERSON_ROLE_WORD, PERSON_STATE_WORD, ROLE_WORD } from "@agency_hub_core/ui/people/words";
import { PageHeader } from "@/components/ui/PageHeader";
import { InvitePerson } from "./InvitePerson";
import { LinkReveal, type RevealedLink } from "./LinkReveal";
import { ProposalRow } from "./PersonBlocks";
import { useCreatePerson, useOpenProposals, useTeamPeople, useViewer } from "./registry";
import "./people.css";

/**
 * Hub «Люди» (products plan §2.2, §4.3): the registry of everyone — chatters, team leads, content managers,
 * contractors, agents, service records — one row per person whatever logins they hold: who they are, their role and
 * state, the pages they work, their logins and when any was last seen; what waits about them (the import's
 * disagreements, the agents' proposals). «Пригласить» makes a person with the invitation in one call. The team's work
 * (shifts, sales, quality) is Workboard «Команда»; each card links it. The test owner sees the test team and is never
 * asked for the agents' proposals (Hub refuses them it).
 */
export function PeoplePage() {
  const registry = useTeamPeople();
  const { fullOwner } = useViewer();
  const proposals = useOpenProposals(fullOwner);
  const create = useCreatePerson();
  const [inviting, setInviting] = useState(false);
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);

  const people = registry.data?.people ?? [];
  const humans = people.filter((person) => person.kind === "human");
  const team = humans.filter((person) => person.state !== "left")
    .sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.displayName.localeCompare(b.displayName, "ru"));
  const invited = team.filter((person) => person.state === "invited");
  const left = humans.filter((person) => person.state === "left").sort((a, b) => (b.leftOn ?? "").localeCompare(a.leftOn ?? ""));
  const agents = people.filter((person) => person.kind === "agent");
  const services = people.filter((person) => person.kind === "service");
  const unlinked = (registry.data?.unlinkedLogins ?? []).filter((login) => login.state !== "deleted");
  const proposed = fullOwner ? (proposals.data?.proposals ?? []).filter((one) => one.kind === "create") : [];

  return (
    <>
      <PageHeader
        actions={<Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>Пригласить</Button>}
        fresh={registry.dataUpdatedAt ? {
          at: registry.dataUpdatedAt,
          refreshing: registry.isFetching,
          onRefresh: () => {
            void registry.refetch();
            if (fullOwner) void proposals.refetch();
          },
        } : undefined}
      />
      {registry.isError && !registry.data ? (
        <Card><ErrorState onRetry={() => void registry.refetch()} retrying={registry.isFetching} /></Card>
      ) : (
        <div className="hub-people">
          {proposed.length > 0 && (
            <Card title="Агенты предлагают новых людей" description="Принятое предложение заводит человека в реестр; приглашение и вход вы делаете сами.">
              <ul className="access-list registry-items">{proposed.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} code={proposal.personCode} />)}</ul>
            </Card>
          )}
          <div className="registry-toolbar">
            <span className="registry-toolbar__counts">
              {registry.data ? <Counts team={team.length} invited={invited.length} left={left.length} /> : <Skeleton width={260} />}
            </span>
          </div>
          <Table
            label="Люди"
            className="registry-table"
            columns={COLUMNS}
            rows={team}
            rowKey={(person) => person.code}
            rowHref={(person) => hubPersonPath(person.code)}
            rowQuiet={(person) => person.state === "invited"}
            fit={false}
            align="first-line"
            loading={registry.data === undefined}
            skeletonRows={8}
            skeletonLines={2}
            empty={(
              <EmptyState title="В реестре пока никого" action={<Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>Пригласить</Button>}>
                Пригласите первого человека: он получит ссылку и сам придумает пароль.
              </EmptyState>
            )}
          />
          {left.length > 0 && (
            <Disclosure summary="Ушли" hint={String(left.length)} size="md">
              <div className="people-folded">
                {left.map((person) => <PersonLink key={person.code} person={person} hint={person.leftOn ? `в команде до ${formatDay(person.leftOn)}` : "день ухода не записан"} status="disabled" />)}
              </div>
            </Disclosure>
          )}
          {agents.length > 0 && (
            <Disclosure summary="Агенты" hint={String(agents.length)} size="md">
              <div className="people-folded">
                {agents.map((person) => (
                  <PersonLink
                    key={person.code}
                    person={person}
                    to={hubPersonPath(person.code, "logins")}
                    hint={person.agentKeys.length === 0 ? "ключей нет" : person.agentKeys.map((key) => `${key.name}${key.state === "active" ? "" : ` (${key.state === "revoked" ? "отозван" : "истёк"})`}`).join(", ")}
                  />
                ))}
              </div>
            </Disclosure>
          )}
          {services.length > 0 && (
            <Disclosure summary="Служебные" hint={String(services.length)} size="md">
              <p className="access-text">Записи для служебных и пробных входов: проверки людей их не трогают.</p>
              <div className="people-folded">
                {services.map((person) => <PersonLink key={person.code} person={person} to={hubPersonPath(person.code, "logins")} hint={liveLogins(person).map((login) => login.username).join(", ") || "без входов"} />)}
              </div>
            </Disclosure>
          )}
          {unlinked.length > 0 && (
            <Disclosure summary="Входы без человека" hint={String(unlinked.length)} size="md">
              <p className="access-text">Входы Hub, которых нет ни у кого в реестре. Карточка входа открывает его вход и доступ к страницам.</p>
              <div className="people-folded">
                {unlinked.map((login) => <LoginLink key={login.userId} login={login} />)}
              </div>
            </Disclosure>
          )}
        </div>
      )}
      {inviting && (
        <InvitePerson
          people={people}
          create={create}
          onClose={() => setInviting(false)}
          onCreated={(link) => {
            setInviting(false);
            setRevealed(link);
          }}
          onAdded={(created) => {
            setInviting(false);
            create.reset();
            toast.success(`${created.person.displayName} в реестре`);
          }}
        />
      )}
      {revealed && (
        <LinkReveal
          link={revealed}
          onClose={() => {
            // The secret leaves memory with the window.
            create.reset();
            setRevealed(null);
          }}
        />
      )}
    </>
  );
}

/** Working first, then set up, then waiting for the password. */
const STATE_ORDER: Readonly<Record<string, number>> = { working: 0, set_up: 1, invited: 2 };
const ROLE_ORDER: Readonly<Record<string, number>> = { owner: 0, team_lead: 1, chatter: 2, content_manager: 3, contractor: 4 };

/** «12 в реестре · 1 ждёт регистрации · 3 ушли». */
function Counts({ team, invited, left }: { team: number; invited: number; left: number }) {
  const parts = [
    `${team} в команде`,
    invited > 0 ? `${invited} ${invited === 1 ? "ждёт" : "ждут"} регистрации` : null,
    left > 0 ? `${left} ${left === 1 ? "ушёл" : "ушли"}` : null,
  ].filter(Boolean);
  return <>{parts.join(" · ")}</>;
}

/** «Чаттер · nika.t ждёт регистрации», «Тимлид · в сети 2 ч назад», «Подрядчик · без входа в Hub». */
function loginsWords(person: RegistryPerson): string {
  const logins = liveLogins(person);
  if (logins.length === 0) return "без входа в Hub";
  const waiting = logins.find((login) => login.state === "invited");
  if (waiting) return `${waiting.username} ждёт регистрации`;
  const seen = lastSeenOf(person);
  return `${logins.map((login) => login.username).join(", ")} · ${seen ? `в сети ${whenWords(seen)}` : "входов не было"}`;
}

const COLUMNS: Column<RegistryPerson>[] = [
  {
    key: "who",
    header: "Человек",
    grow: true,
    cell: (person) => {
      const notes = unsettledNotes(person);
      const marks = notes > 0 || person.openProposals > 0 ? (
        <>
          {notes > 0 && <Badge tone="warning" className="registry-mark">расхождения: {notes}</Badge>}
          {person.openProposals > 0 && <Badge tone="info" className="registry-mark">{person.openProposals === 1 ? "предложение агента" : `предложения агентов: ${person.openProposals}`}</Badge>}
        </>
      ) : undefined;
      return (
        <Person
          name={person.displayName}
          status={person.state === "invited" ? "invited" : "away"}
          nameEnd={marks}
          hint={`${PERSON_ROLE_WORD[person.role] ?? person.role} · ${person.code}`}
          className="registry-who"
        />
      );
    },
  },
  {
    key: "state",
    header: "Состояние",
    nowrap: true,
    cell: (person) => capitalized(PERSON_STATE_WORD[person.state] ?? person.state),
  },
  {
    key: "pages",
    header: "Рабочие страницы",
    cell: (person) => person.workingPages.length === 0 ? <span className="people-dash">—</span> : <PageLabels labels={person.workingPages.map((one) => one.pageLabel)} max={3} />,
  },
  {
    key: "slot",
    header: "График по Москве",
    nowrap: true,
    cell: (person) => slotSummary(person).main ?? <span className="people-dash">—</span>,
  },
  {
    key: "logins",
    header: "Входы",
    cell: (person) => <span className="access-hint">{loginsWords(person)}</span>,
  },
];

/** A person's name that opens their card here. */
function PersonLink({ person, hint, status = "away", to }: { person: RegistryPerson; hint: ReactNode; status?: PersonStatus; to?: string }) {
  return (
    <Link to={to ?? hubPersonPath(person.code)} className="ui-quiet-link">
      <Person name={person.displayName} status={status} hint={hint} />
    </Link>
  );
}

/** A login no person holds: its own card (`/people/<userId>/logins`). */
function LoginLink({ login }: { login: RegistryLogin }) {
  const words = [
    ROLE_WORD[login.role],
    login.state === "invited" ? "ждёт регистрации" : login.state === "disabled" ? "доступ отключён" : login.lastSeenAt ? `в сети ${whenWords(login.lastSeenAt)}` : "входов не было",
  ].join(" · ");
  return (
    <Link to={hubPersonPath(login.userId, "logins")} className="ui-quiet-link">
      <Person name={login.username} status={login.state === "disabled" ? "disabled" : login.state === "invited" ? "invited" : "away"} hint={words} />
    </Link>
  );
}
