import { useEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Badge, Card, EmptyState, ErrorState, LinkButton, Notice, Segmented, Skeleton, StatusDot, Tabs } from "@agency_hub_core/ui";
import { whenWords } from "@/screens/access/when";
import { carryParams, personCodePath, ShiftLink, useBackTarget, type PersonTab } from "@/shared/links";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { AccessTab } from "./AccessTab.js";
import { IntakeCard } from "./Intake.js";
import { usePeopleNow, usePersonCard } from "./data.js";
import { lastSeenOf, liveLogins, unsettledNotes, useOwnerCard, useTeamPeople, type RegistryLogin, type RegistryPerson } from "./registry.js";
import { SalesTab } from "./SalesTab.js";
import { ScheduleTab, slotSummary } from "./ScheduleTab.js";
import { WorkTab } from "./WorkTab.js";
import { capitalized, PERSON_ROLE_WORD, PERSON_STATE_WORD, statusOf } from "./words.js";
import "./people.css";
import "./registry.css";

type CardTab = Exclude<PersonTab, "shifts">;

/** The card's tabs: Работа and Продажи as before, «Доступ и входы» (the owner's), «График и условия». */
const TABS: readonly { tab: CardTab; label: string }[] = [
  { tab: "work", label: "Работа" },
  { tab: "sales", label: "Продажи" },
  { tab: "access", label: "Доступ и входы" },
  { tab: "schedule", label: "График и условия" },
];

/**
 * A person of the registry, `/people/<code>`: one card whatever logins the
 * person holds (the owner holds two). Работа and Продажи are one login's
 * numbers — the one the person works under, or the one picked above them
 * (`?login=`); «Доступ и входы» is every login with every control «Доступ»
 * had; «График и условия» is the registry itself: pages, slots, rights, and
 * for the owner the pay terms, the import's disagreements and the agents'
 * proposals. A team lead reads the same card without «Доступ и входы» and
 * without anything about money.
 */
export function PersonCard({ code }: { code: string }) {
  const { tab } = useParams();
  const { isOwner } = useMe();
  const location = useLocation();
  const list = useTeamPeople();
  const owner = useOwnerCard(code, isOwner);
  const fallbackSearch = carryParams(location.search).toString();
  const back = useBackTarget({ to: `/people${fallbackSearch ? `?${fallbackSearch}` : ""}`, label: "Люди" });
  const fromList = list.data?.people.find((one) => one.code === code) ?? null;
  const person = owner.data?.person ?? fromList;
  // A team lead's card is a human's: agents and service records are the owner's to see.
  const hidden = person !== null && !isOwner && person.kind !== "human";
  const tabs = TABS.filter((item) => item.tab !== "access" || isOwner);
  const current: CardTab = tabs.find((item) => item.tab === tab)?.tab ?? "work";
  useOpenFirst(hidden ? null : person, tab === undefined, isOwner);

  const missing = !person && list.data !== undefined && (!isOwner || owner.isError || owner.data !== undefined);
  if (missing || hidden) {
    return (
      <>
        <ScreenHeader title="Человек" back={back} />
        <div className="wb-content">
          <Card>
            <EmptyState title="Нет такого человека" action={<LinkButton to={back.to}>К людям</LinkButton>}>
              В реестре людей нет записи с кодом «{code}».
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
        updatedAt={isOwner ? owner.dataUpdatedAt || list.dataUpdatedAt : list.dataUpdatedAt}
        onRefresh={refresh}
        refreshing={list.isFetching || owner.isFetching}
        tabs={(
          <Tabs
            label="Разделы карточки"
            items={tabs.map((item) => ({
              to: item.tab === "work" ? workPath(code, location.search, tab === undefined) : personCodePath(code, location.search, item.tab),
              label: item.label,
              end: true,
            }))}
          />
        )}
      />
      <div className="wb-content">
        {person && isOwner && current !== "schedule" && <WaitingNotice person={person} />}
        {isOwner && owner.data && <IntakeCard card={owner.data} />}
        {!person ? <Card><Skeleton height={240} /></Card>
          : current === "access" ? <AccessTab person={person} onChanged={refresh} />
            : current === "schedule" ? <ScheduleTab person={person} card={owner.data} cardFailed={owner.isError} onRetry={() => void owner.refetch()} isOwner={isOwner} />
              : <Work person={person} tab={current} />}
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
 * Р8 of the card: someone with nothing in Работа opens where their things are —
 * no login (a content manager, a contractor): «График и условия»; an agent or
 * a service record: their keys; an invite not accepted, or nobody of the chats
 * (no chatter login): «Доступ и входы». Once per person, only on the bare address.
 */
function useOpenFirst(person: RegistryPerson | null, bare: boolean, isOwner: boolean) {
  const navigate = useNavigate();
  const location = useLocation();
  const decided = useRef<string | null>(null);
  useEffect(() => {
    if (!person || decided.current === person.code) return;
    decided.current = person.code;
    if (!bare) return;
    const logins = liveLogins(person);
    const first: CardTab = logins.length === 0 ? (isOwner && person.kind !== "human" ? "access" : "schedule")
      : person.state === "invited" || !logins.some((login) => login.role === "chatter") ? (isOwner ? "access" : "schedule")
        : "work";
    if (first !== "work") navigate(personCodePath(person.code, location.search, first), { replace: true, state: location.state });
  }, [person, bare, isOwner, navigate, location.search, location.state]);
}

/** The owner's: what waits on this person, one line with the way to it. */
function WaitingNotice({ person }: { person: RegistryPerson }) {
  const location = useLocation();
  const notes = unsettledNotes(person);
  const proposals = person.openProposals;
  if (notes === 0 && proposals === 0) return null;
  const parts = [
    notes > 0 ? `расхождения импорта: ${notes}` : null,
    proposals > 0 ? `предложения агентов: ${proposals}` : null,
  ].filter(Boolean).join(", ");
  return (
    <Notice tone="info" action={<LinkButton size="sm" to={personCodePath(person.code, location.search, "schedule")}>Разобрать</LinkButton>}>
      Ждут вас: {parts}.
    </Notice>
  );
}

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
 * Who it is now, one line on every tab: the shift going on (it opens its
 * review) or the registry's state, the role, the code, the working pages, the
 * slot and the last time any of the logins was seen.
 */
function PersonMeta({ person }: { person: RegistryPerson }) {
  const { isOwner } = useMe();
  const logins = liveLogins(person);
  const { now, known } = usePeopleNow(logins.map((login) => login.userId));
  const parts: ReactNode[] = [];
  const shiftLogin = now.onShiftSince ? logins.find((login) => login.role === "chatter") ?? logins[0] : undefined;
  if (now.onShiftSince && shiftLogin && isOwner) {
    const { words } = statusOf({ state: "active", disabledAt: null, now });
    parts.push(
      <ShiftLink key="status" userId={shiftLogin.userId} startedAt={now.onShiftSince} backLabel={person.displayName} className="people-meta__live" title="Открыть разбор идущей смены">
        <StatusDot tone="success" />
        {capitalized(words)}
      </ShiftLink>,
    );
  } else if (now.onShiftSince) {
    const { words } = statusOf({ state: "active", disabledAt: null, now });
    parts.push(<span key="status" className="people-meta__live"><StatusDot tone="success" />{capitalized(words)}</span>);
  } else if (!known && logins.length > 0) {
    parts.push(<Skeleton key="status" width={110} />);
  } else {
    parts.push(
      <Badge key="status" tone={person.state === "left" ? "off" : person.state === "invited" ? "info" : "neutral"} bare>
        {capitalized(PERSON_STATE_WORD[person.state] ?? person.state)}
      </Badge>,
    );
  }
  parts.push(<span key="role">{PERSON_ROLE_WORD[person.role] ?? person.role}</span>);
  parts.push(<code key="code" className="registry-code">{person.code}</code>);
  if (person.workingPages.length > 0) {
    const labels = person.workingPages.map((page) => page.pageLabel);
    parts.push(<span key="pages" className="ui-page">{labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 2).join(", ")} и ещё ${labels.length - 2}`}</span>);
  }
  const slot = slotSummary(person);
  if (slot.hours) parts.push(<span key="slot">{slot.hours} по Москве{slot.days ? `, ${slot.days}` : ""}</span>);
  const seen = lastSeenOf(person);
  if (logins.length > 0) parts.push(<span key="seen">{seen ? `в сети ${whenWords(seen)}` : "входов не было"}</span>);
  return (
    <div className="people-meta">
      {parts.map((part, index) => (
        <span key={index} className="people-meta__part">
          {index > 0 && <span className="people-meta__sep" aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}
