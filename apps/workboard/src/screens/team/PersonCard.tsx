import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Card, EmptyState, ErrorState, LinkButton, Segmented, Skeleton, StatusDot, Tabs, toast } from "@agency_hub_core/ui";
import { PersonMeta as PersonMetaLine } from "@agency_hub_core/ui/people/PersonMeta";
import { hubPersonPath } from "@agency_hub_core/ui/people/paths";
import { TeamRolesCard, type TeamRoleChange } from "@agency_hub_core/ui/people/TeamRoles";
import { capitalized, statusOf } from "@agency_hub_core/ui/people/words";
import { carryParams, hubHref, personCodePath, ShiftLink, useBackTarget, type PersonTab } from "@/shared/links";
import { kernel } from "@/shared/hub";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { IntakeCard } from "./Intake.js";
import { usePeopleNow, usePersonCard } from "./data.js";
import { liveLogins, useOwnerCard, useTeamPeople, type RegistryLogin, type RegistryPerson } from "./registry.js";
import { SalesTab } from "./SalesTab.js";
import { ScheduleTab } from "./ScheduleTab.js";
import { WorkTab } from "./WorkTab.js";
import "./people.css";

/** The card's tabs: Работа, Продажи, «График и условия» (the schedule, working pages and, for the owner, the pay terms). */
const TABS: readonly { tab: PersonTab; label: string }[] = [
  { tab: "work", label: "Работа" },
  { tab: "sales", label: "Продажи" },
  { tab: "schedule", label: "График и условия" },
];

/**
 * A person of the team at work, `/team/<code>`: one card whatever logins the
 * person holds (the owner holds two). Работа and Продажи are one login's
 * numbers — the one the person works under, or the one picked above them
 * (`?login=`); «График и условия» is how the person works: pages, slots, and
 * for the owner the pay terms; a team lead also gives «ведёт кастомы» and
 * «видит команду» on their models there. Who the person is and what they may
 * (logins, page access, rights, the agents' proposals) is Hub «Люди»: the
 * owner's link «Доступ и входы в Hub» opens it. A team lead reads the same
 * card without anything about money.
 */
export function PersonCard({ code }: { code: string }) {
  const { tab } = useParams();
  const { isOwner } = useMe();
  const location = useLocation();
  const list = useTeamPeople();
  const owner = useOwnerCard(code, isOwner);
  const fallbackSearch = carryParams(location.search).toString();
  const back = useBackTarget({ to: `/team${fallbackSearch ? `?${fallbackSearch}` : ""}`, label: "Команда" });
  const fromList = list.data?.people.find((one) => one.code === code) ?? null;
  const person = owner.data?.person ?? fromList;
  // «Команда» is the team at work: agents and service records are Hub's (the registry), never here.
  const hidden = person !== null && person.kind !== "human";
  const current: PersonTab = TABS.find((item) => item.tab === tab)?.tab ?? "work";
  useOpenFirst(hidden ? null : person, tab === undefined);

  const missing = !person && list.data !== undefined && (!isOwner || owner.isError || owner.data !== undefined);
  if (missing || hidden) {
    return (
      <>
        <ScreenHeader title="Человек" back={back} />
        <div className="wb-content">
          <Card>
            <EmptyState title="Нет такого человека" action={<LinkButton to={back.to}>К команде</LinkButton>}>
              В команде нет человека с кодом «{code}».
            </EmptyState>
          </Card>
        </div>
      </>
    );
  }
  if (!person && list.isError && (!isOwner || owner.isError)) {
    return (
      <>
        <ScreenHeader title="Человек" back={back} />
        <div className="wb-content"><Card><ErrorState onRetry={() => { void list.refetch(); void owner.refetch(); }} /></Card></div>
      </>
    );
  }

  const refresh = () => {
    void list.refetch();
    if (isOwner) void owner.refetch();
  };

  return (
    <>
      <ScreenHeader
        title={person ? person.displayName : <Skeleton width={160} height={28} />}
        documentTitle={person?.displayName ?? "Человек"}
        back={back}
        period
        pageFilter
        meta={person ? <PersonMeta person={person} /> : <Skeleton width={320} />}
        actions={isOwner ? (
          <a className="access-link" href={hubHref(hubPersonPath(code, "logins"))}>
            Доступ и входы в Hub <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
          </a>
        ) : undefined}
        updatedAt={isOwner ? owner.dataUpdatedAt || list.dataUpdatedAt : list.dataUpdatedAt}
        onRefresh={refresh}
        refreshing={list.isFetching || owner.isFetching}
        tabs={(
          <Tabs
            label="Разделы карточки"
            items={TABS.map((item) => ({
              to: item.tab === "work" ? workPath(code, location.search, tab === undefined) : personCodePath(code, location.search, item.tab),
              label: item.label,
              end: true,
            }))}
          />
        )}
      />
      <div className="wb-content">
        {isOwner && owner.data && <IntakeCard card={owner.data} />}
        {!person ? <Card><Skeleton height={240} /></Card>
          : current === "schedule" ? <ScheduleTab person={person} card={owner.data} cardFailed={owner.isError} onRetry={() => void owner.refetch()} isOwner={isOwner} />
            : <Work person={person} tab={current} />}
        {person && current === "schedule" && !isOwner && <LeadTeamRoles person={person} />}
      </div>
    </>
  );
}

/** «Работа» from another tab is the explicit `/people/<code>/work`, so the bare address alone may open another tab first. */
function workPath(code: string, search: string, bare: boolean): string {
  const path = personCodePath(code, search);
  if (bare) return path;
  const [pathname, query] = path.split("?");
  return `${pathname}/work${query ? `?${query}` : ""}`;
}

/**
 * Р8 of the card: someone with nothing in Работа — no login (a content manager, a contractor), an invite not
 * accepted, nobody of the chats (no chatter login) — opens on «График и условия». Once per person, only on the bare
 * address.
 */
function useOpenFirst(person: RegistryPerson | null, bare: boolean) {
  const navigate = useNavigate();
  const location = useLocation();
  const decided = useRef<string | null>(null);
  useEffect(() => {
    if (!person || decided.current === person.code) return;
    decided.current = person.code;
    if (!bare) return;
    const logins = liveLogins(person);
    const quiet = logins.length === 0 || person.state === "invited" || !logins.some((login) => login.role === "chatter");
    if (quiet) navigate(personCodePath(person.code, location.search, "schedule"), { replace: true, state: location.state });
  }, [person, bare, navigate, location.search, location.state]);
}

/**
 * «Команды и права» for a team lead (products package T): «ведёт кастомы» and «видит команду» on the lead's models, by
 * the shared card (packages/ui people/TeamRoles.tsx). The owner gives every record in Hub «Люди».
 */
function LeadTeamRoles({ person }: { person: RegistryPerson }) {
  const queryClient = useQueryClient();
  const read = useQuery({ queryKey: TEAM_ROLES_KEY, queryFn: () => kernel.teamRoles() });
  const set = useMutation({
    mutationFn: (change: TeamRoleChange) => kernel.teamRoleSet({ body: { personCode: person.code, ...change } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: TEAM_ROLES_KEY }),
    onError: () => toast.error("Не сохранилось. Попробуйте ещё раз."),
  });
  return (
    <TeamRolesCard
      person={person}
      roles={read.data}
      failed={read.isError}
      retrying={read.isFetching}
      onRetry={() => void read.refetch()}
      saving={set.isPending ? set.variables : null}
      onSet={(change) => set.mutate(change)}
      kinds={["customs", "view"]}
    />
  );
}

const TEAM_ROLES_KEY = ["team", "roles"] as const;

/** The login whose numbers Работа and Продажи show by default: a working one, a chatter's first. */
function defaultLogin(logins: readonly RegistryLogin[]): RegistryLogin | null {
  const rank = (login: RegistryLogin) => (login.state === "active" ? 0 : login.state === "invited" ? 1 : 2) * 3 + (login.role === "chatter" ? 0 : login.role === "team_lead" ? 1 : 2);
  return [...logins].sort((a, b) => rank(a) - rank(b) || a.userId - b.userId)[0] ?? null;
}

function Work({ person, tab }: { person: RegistryPerson; tab: "work" | "sales" }) {
  const [search, setSearch] = useSearchParams();
  const logins = liveLogins(person);
  const asked = Number(search.get("login"));
  const login = logins.find((one) => one.userId === asked) ?? defaultLogin(logins);
  if (!login) {
    return (
      <Card>
        <EmptyState title="Смен и продаж нет">
          У {person.displayName} нет входа в Hub: смены считаются только по работе в расширении под своим входом.
        </EmptyState>
      </Card>
    );
  }
  return (
    <>
      {logins.length > 1 && (
        <div className="registry-login-pick">
          <span className="access-hint">Числа входа</span>
          <Segmented
            label="Чей вход"
            size="sm"
            value={String(login.userId)}
            onChange={(value) => setSearch((current) => {
              const next = new URLSearchParams(current);
              next.set("login", value);
              return next;
            }, { replace: true })}
            options={logins.map((one) => ({ value: String(one.userId), label: one.username, hint: `${ROLE_OF[one.role] ?? one.role}${one.state === "active" ? "" : `, ${LOGIN_STATE[one.state] ?? one.state}`}` }))}
          />
        </div>
      )}
      <LoginWork key={login.userId} userId={login.userId} name={person.displayName} tab={tab} />
    </>
  );
}

const ROLE_OF: Readonly<Record<string, string>> = { owner: "вход владельца", team_lead: "тимлид", chatter: "чаттер" };
const LOGIN_STATE: Readonly<Record<string, string>> = { invited: "ждёт регистрации", disabled: "отключён", deleted: "удалён" };

function LoginWork({ userId, name, tab }: { userId: number; name: string; tab: "work" | "sales" }) {
  const { period, today } = usePeriod();
  const { page } = usePageFilter();
  const card = usePersonCard(userId, period, page, today);
  if (card.tooLong) {
    return <Card><EmptyState title="Период длиннее 31 дня">Hub считает смены не больше чем за 31 день. Выберите период короче.</EmptyState></Card>;
  }
  if (card.main === "failed") return <Card><ErrorState onRetry={card.refresh} /></Card>;
  return tab === "sales" ? <SalesTab userId={userId} name={name} /> : <WorkTab card={card} userId={userId} />;
}

/**
 * Who it is now, one line on every tab (packages/ui people/PersonMeta.tsx): the shift going on (it opens its review
 * for the owner) or the registry's state, then the role, the code, the pages, the slot, when any login was seen.
 */
function PersonMeta({ person }: { person: RegistryPerson }) {
  const { isOwner } = useMe();
  const logins = liveLogins(person);
  const { now, known } = usePeopleNow(logins.map((login) => login.userId));
  const shiftLogin = now.onShiftSince ? logins.find((login) => login.role === "chatter") ?? logins[0] : undefined;
  let status;
  if (now.onShiftSince && shiftLogin && isOwner) {
    const { words } = statusOf({ state: "active", disabledAt: null, now });
    status = (
      <ShiftLink key="status" userId={shiftLogin.userId} startedAt={now.onShiftSince} backLabel={person.displayName} className="people-meta__live" title="Открыть разбор идущей смены">
        <StatusDot tone="success" />
        {capitalized(words)}
      </ShiftLink>
    );
  } else if (now.onShiftSince) {
    const { words } = statusOf({ state: "active", disabledAt: null, now });
    status = <span key="status" className="people-meta__live"><StatusDot tone="success" />{capitalized(words)}</span>;
  } else if (!known && logins.length > 0) {
    status = <Skeleton key="status" width={110} />;
  }
  return <PersonMetaLine person={person} {...(status ? { status } : {})} />;
}
