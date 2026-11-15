import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Navigate, useLocation, useParams } from "react-router";
import { Card, EmptyState, ErrorState, LinkButton, Skeleton, Tabs, toast } from "@agency_hub_core/ui";
import { PersonMeta } from "@agency_hub_core/ui/people/PersonMeta";
import { HUB_PERSON_TABS, hubPersonPath, teamPersonHref, type HubPersonTab } from "@agency_hub_core/contracts";
import { liveLogins, personOfLogin, type RegistryPerson } from "@agency_hub_core/ui/people/registry";
import { TeamRolesCard } from "@agency_hub_core/ui/people/TeamRoles";
import { formatDay } from "@agency_hub_core/ui/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { workboardHere } from "@/lib/navigation";
import { AccessTab, TestRealmNote } from "./AccessTab";
import { PersonAccess } from "./PersonAccess";
import { DecidedBlock, PersonBlock, PersonModal, RightsBlock, WaitingBlock } from "./PersonBlocks";
import { useOwnerCard, useSetTeamRole, useTeamPeople, useTeamRoles, useViewer } from "./registry";
import "./people.css";

/** The card's tabs (products plan §2.2): who the person is and what they may. Their work is Workboard «Команда». */
const TAB_LABEL: Readonly<Record<HubPersonTab, string>> = {
  person: "Человек",
  logins: "Входы и устройства",
  pages: "Доступ к страницам",
  teams: "Команды и права",
  history: "История",
};

const TABS: ReadonlySet<string> = new Set(HUB_PERSON_TABS);

/**
 * `/people/:ref[/:tab]` in Hub. A code (`/people/alex`) is the person's card. A number is a login's address (the old
 * links of a person's access, `/people/12/logins`): it lands on the card of the person holding that login, with the
 * same tab; a login no person holds keeps a card of its own (its logins and pages), so nothing it had goes out of reach.
 */
export function PersonPage() {
  const { ref = "", tab } = useParams();
  const current: HubPersonTab = tab && TABS.has(tab) ? (tab as HubPersonTab) : "person";
  if (!/^\d+$/.test(ref)) return <PersonCard code={ref} tab={current} />;
  return <LoginAddress userId={Number(ref)} tab={current} />;
}

function LoginAddress({ userId, tab }: { userId: number; tab: HubPersonTab }) {
  const location = useLocation();
  const list = useTeamPeople();
  if (list.data === undefined && !list.isError) return <Card><Skeleton height={240} /></Card>;
  const people = list.data?.people ?? [];
  const person = personOfLogin(people, userId);
  if (person) return <Navigate replace to={{ pathname: hubPersonPath(person.code, tab), search: location.search }} />;
  if (people.some((one) => one.code === String(userId))) return <PersonCard code={String(userId)} tab={tab} />;
  return <LoginCard userId={userId} tab={tab === "pages" ? "pages" : "logins"} />;
}

/**
 * A person of the registry (products plan §4.3): one card whatever logins the person holds. «Человек» is the record
 * and what waits about it; «Входы и устройства» and «Доступ к страницам» every login with every control Workboard's
 * «Доступ» had; «Команды и права» the narrow rights and the team records; «История» what was decided. The person's
 * work — shifts, sales, the schedule and the pay terms — is Workboard «Команда»: the link «Работа в Workboard».
 */
function PersonCard({ code, tab }: { code: string; tab: HubPersonTab }) {
  const list = useTeamPeople();
  const owner = useOwnerCard(code);
  const [editing, setEditing] = useState(false);
  const fromList = list.data?.people.find((one) => one.code === code) ?? null;
  const person = owner.data?.person ?? fromList;
  const refresh = () => {
    void list.refetch();
    void owner.refetch();
  };

  if (!person && list.data !== undefined && (owner.isError || owner.data !== undefined)) {
    return (
      <>
        <PageHeader title="Человек" />
        <Card>
          <EmptyState title="Нет такого человека" action={<LinkButton to="/people">К людям</LinkButton>}>
            В реестре людей нет записи с кодом «{code}».
          </EmptyState>
        </Card>
      </>
    );
  }
  if (!person && list.isError && owner.isError) {
    return (
      <>
        <PageHeader title="Человек" />
        <Card><ErrorState onRetry={refresh} /></Card>
      </>
    );
  }

  const works = person !== null && person.kind === "human" && liveLogins(person).length > 0;
  return (
    <>
      <PageHeader
        title={person?.displayName ?? "Человек"}
        actions={works ? (
          <a className="access-link" href={workboardHere(teamPersonHref(code))}>
            Работа в Workboard <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
          </a>
        ) : undefined}
        fresh={owner.dataUpdatedAt ? { at: owner.dataUpdatedAt, onRefresh: refresh, refreshing: list.isFetching || owner.isFetching } : undefined}
      />
      <div className="hub-person">
        {person ? <PersonMeta person={person} /> : <Skeleton width={320} />}
        <Tabs
          label="Разделы карточки"
          items={HUB_PERSON_TABS.map((item) => ({ to: hubPersonPath(code, item), label: TAB_LABEL[item], end: true }))}
        />
        {!person ? <Card><Skeleton height={240} /></Card> : (
          <>
            {tab === "person" && (
              <div className="registry-tab">
                {owner.data && <WaitingBlock person={owner.data.person} proposals={owner.data.proposals} />}
                <div className="people-grid">
                  <PersonBlock person={person} onEdit={() => setEditing(true)} />
                  <WorkPagesNote person={person} />
                </div>
              </div>
            )}
            {(tab === "logins" || tab === "pages") && <AccessTab person={person} part={tab} onChanged={refresh} />}
            {tab === "teams" && <TeamsTab person={person} />}
            {tab === "history" && <HistoryTab person={person} proposals={owner.data?.proposals ?? null} failed={owner.isError} />}
          </>
        )}
      </div>
      {editing && person && <PersonModal person={person} onClose={() => setEditing(false)} />}
    </>
  );
}

/**
 * The working pages, read here: the pages a person works make their teams (products package T); they are changed with
 * the schedule in Workboard «Команда» → «График и условия», where they belong to the work.
 */
function WorkPagesNote({ person }: { person: RegistryPerson }) {
  if (person.kind !== "human") return null;
  return (
    <Card
      title={<>Рабочие страницы <span className="access-count">{person.workingPages.length}</span></>}
      description="Команды человека: модели его рабочих страниц. Меняют вместе с графиком в Workboard."
      actions={liveLogins(person).length > 0 || person.workingPages.length > 0 ? (
        <a className="access-link" href={workboardHere(teamPersonHref(person.code, "schedule"))}>
          График и условия <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
        </a>
      ) : undefined}
    >
      {person.workingPages.length === 0 ? <p className="access-text">Рабочих страниц нет.</p> : (
        <ol className="registry-order registry-order--read">
          {person.workingPages.map((page, index) => (
            <li key={page.pageLabel} className="registry-order__row">
              <span className="registry-order__place">{index + 1}</span>
              <span className="ui-page">{page.pageLabel}</span>
              <span className="access-hint">{page.modelName}{index === 0 ? " · основная" : ""}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** «Команды и права»: the narrow rights beside the role, and the team records by model (packages/ui TeamRoles.tsx). */
function TeamsTab({ person }: { person: RegistryPerson }) {
  const roles = useTeamRoles();
  const set = useSetTeamRole(person.code);
  return (
    <div className="registry-tab">
      <div className="people-grid">
        <RightsBlock person={person} canEdit />
      </div>
      <TeamRolesCard
        person={person}
        roles={roles.data}
        failed={roles.isError}
        retrying={roles.isFetching}
        onRetry={() => void roles.refetch()}
        saving={set.isPending ? set.variables : null}
        onSet={(change) => set.mutate(change, { onError: () => toast.error("Не сохранилось. Попробуйте ещё раз.") })}
        title="Команды"
      />
      {person.kind === "human" && person.state === "left" && <p className="people-note">Человек ушёл: записи команд у ушедших не ведут.</p>}
    </div>
  );
}

/** «История»: when the person came and left, the logins that were deleted, and what was settled and decided about them. */
function HistoryTab({ person, proposals, failed }: { person: RegistryPerson; proposals: RegistryProposals; failed: boolean }) {
  const deleted = person.logins.filter((login) => login.state === "deleted");
  return (
    <div className="registry-tab">
      <Card title="Запись">
        <ul className="access-list access-list--quiet">
          {person.onboarding.length > 0 && (
            <li className="access-list__row">
              <span className="access-list__main">
                Оформление: {person.onboarding.map((step) => `${step.step}${step.doneAt ? ` ${formatDay(step.doneAt)}` : " (нет)"}`).join(", ")}
              </span>
            </li>
          )}
          <li className="access-list__row">
            <span className="access-list__main">
              {person.state === "left" ? (person.leftOn ? `Ушёл ${formatDay(person.leftOn)}` : "Ушёл, день не записан") : "В команде"}
            </span>
          </li>
          {deleted.length > 0 && (
            <li className="access-list__row">
              <span className="access-list__main">Удалённые входы: {deleted.map((login) => login.username).join(", ")}. Их история работы осталась за человеком.</span>
            </li>
          )}
        </ul>
      </Card>
      {proposals ? <DecidedBlock person={person} proposals={proposals} /> : failed ? (
        <p className="people-note">Карточка владельца не пришла: решённые предложения не показаны.</p>
      ) : <Card><Skeleton height={80} /></Card>}
    </div>
  );
}

type RegistryProposals = Parameters<typeof DecidedBlock>[0]["proposals"] | null;

/**
 * The card of a LOGIN no person of the registry holds (`/people/:userId`): a test or service login, or one not linked
 * yet. Its sign-in, devices and pages, as a person's; its numbers are Workboard's («Работа в Workboard»).
 */
function LoginCard({ userId, tab }: { userId: number; tab: "logins" | "pages" }) {
  const list = useTeamPeople();
  const { fullOwner } = useViewer();
  const login = list.data?.unlinkedLogins.find((one) => one.userId === userId) ?? null;
  return (
    <>
      <PageHeader
        title={login?.username ?? "Вход"}
        actions={(
          <a className="access-link" href={workboardHere(teamPersonHref(userId))}>
            Работа в Workboard <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
          </a>
        )}
      />
      <div className="hub-person">
        <p className="people-note">Вход Hub, которого нет ни у кого в реестре людей.</p>
        <Tabs
          label="Разделы карточки"
          items={(["logins", "pages"] as const).map((item) => ({ to: hubPersonPath(userId, item), label: TAB_LABEL[item], end: true }))}
        />
        {fullOwner
          ? <PersonAccess userId={userId} variant="page" part={tab} onChanged={() => void list.refetch()} onDeleted={() => void list.refetch()} />
          : <TestRealmNote />}
      </div>
    </>
  );
}
