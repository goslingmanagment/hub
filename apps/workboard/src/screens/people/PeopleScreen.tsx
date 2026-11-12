import { UserPlus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES } from "@agency_hub_core/contracts";
import { Badge, Button, Card, Delta, Disclosure, Duration, EmptyState, ErrorState, Mark, Money, Notice, PageLabels, Person, Skeleton, Table, Tooltip, readDelta, toast, type Column, type PersonStatus, type SortState } from "@agency_hub_core/ui";
import { formatDay, formatDuration } from "@agency_hub_core/ui/format";
import { LinkReveal, type RevealedLink } from "@/screens/access/LinkReveal";
import { whenWords } from "@/screens/access/when";
import { personCodePath, personPath, useBackState, useRowBackState } from "@/shared/links";
import { formatAiUnedited, formatReplyMedian, formatUnanswered, METRICS, PER_SHIFT_HINT } from "@/shared/metrics";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePages } from "@/shared/usePages";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { Head } from "./Head.js";
import { InvitePerson } from "./InvitePerson.js";
import { ProposalRow, slotSummary } from "./ScheduleTab.js";
import { SlowFailed } from "./SlowFailed.js";
import { usePeopleList, type PeopleList, type PersonNumbers } from "./data.js";
import { lastSeenOf, liveLogins, onPagesOf, unsettledNotes, useCreatePerson, useOpenProposals, useTeamPeople, type RegistryLogin, type RegistryPerson } from "./registry.js";
import { capitalized, periodWords, PERSON_ROLE_WORD, ROLE_WORD, statusOf, versusTitle } from "./words.js";
import "./people.css";
import "./registry.css";

/**
 * Люди: one row per person of the registry (registry.ts), whatever logins
 * they hold — name and code, role, the pages they work, the slot, the state,
 * the last time any of their logins was seen, and the period's numbers of
 * today's list (spec §4.3) summed over the person's logins: money and its
 * change, per hour, how fast they answer, who was left waiting at the end of a
 * shift, how much the AI wrote unedited, what the AI cost. Working people
 * first (without a shift in the period, the last rows); the pending
 * invitations one line under them; «Ушли» folded with a count. The owner also
 * sees what waits (the import's disagreements, the agents' proposals), the
 * agents with their keys, the service records and the logins no person holds,
 * and invites a person here in one call. A team lead sees the people of their
 * pages, and nothing about money but the sales.
 */
export function PeopleScreen() {
  const { period, setPeriod } = usePeriod();
  const { page } = usePageFilter();
  const { isOwner } = useMe();
  const numbers = usePeopleList(period, page);
  const registry = useTeamPeople();
  const visible = usePages();
  const proposals = useOpenProposals(isOwner);
  const create = useCreatePerson();
  const [inviting, setInviting] = useState(false);
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);
  const location = useLocation();
  const [sort, setSort] = useListSort();
  const rowState = useRowBackState("Люди");

  const people = registry.data?.people ?? [];
  // A team lead's list is their pages' people (Hub gives a lead only their pages); the owner's, everyone.
  const leadPages = isOwner ? null : new Set((visible.data ?? []).map((one) => one.label));
  const shown = people.filter((person) => {
    const own = numbers.combine(liveLogins(person).map((login) => login.userId));
    const worked = own.work !== null && own.work.shifts + (own.work.previous?.shifts ?? 0) > 0;
    if (!onPagesOf(person, leadPages, worked)) return false;
    // Under a page filter: who works that page, or worked on it in the period.
    return page === null || worked || person.workingPages.some((one) => one.pageLabel === page);
  });
  const humans = shown.filter((person) => person.kind === "human");
  // The table is for who works shifts: every chatter (a week without a shift is information too) and anyone else
  // who had a shift in the period. The rest of the team (the owner, team leads, content managers, contractors) folds below.
  const team: Row[] = humans
    .filter((person) => person.state === "working" || person.state === "set_up")
    .map((person) => ({ person, numbers: numbers.combine(liveLogins(person).map((login) => login.userId)) }));
  const rows = team.filter((row) => row.person.role === "chatter" || (row.numbers.work?.shifts ?? 0) > 0);
  const others = team.filter((row) => !rows.includes(row)).map((row) => row.person)
    .sort((a, b) => (OTHERS_ORDER[a.role] ?? 9) - (OTHERS_ORDER[b.role] ?? 9) || a.displayName.localeCompare(b.displayName, "ru"));
  const invited = humans.filter((person) => person.state === "invited");
  const left = humans.filter((person) => person.state === "left").sort((a, b) => (b.leftOn ?? "").localeCompare(a.leftOn ?? ""));
  const agents = isOwner ? shown.filter((person) => person.kind === "agent") : [];
  const services = isOwner ? shown.filter((person) => person.kind === "service") : [];
  const unlinked = isOwner ? (registry.data?.unlinkedLogins ?? []).filter((login) => login.state !== "deleted") : [];
  const proposed = isOwner ? (proposals.data?.proposals ?? []).filter((one) => one.kind === "create") : [];

  const columns = useColumns(numbers, isOwner, page);
  const sorted = useMemo(() => sortedRows(rows, columns, sort), [rows, columns, sort]);
  const firstOff = sorted.find(isQuiet);
  const noShifts = numbers.main === "ready" && rows.length > 0 && rows.every(isQuiet);

  return (
    <>
      <ScreenHeader
        title="Люди"
        period
        pageFilter
        meta={numbers.comparable ? undefined : <NothingToCompare knownSince={numbers.knownSince} />}
        updatedAt={registry.dataUpdatedAt && numbers.updatedAt ? Math.min(registry.dataUpdatedAt, numbers.updatedAt) : registry.dataUpdatedAt || numbers.updatedAt}
        stale={numbers.stale || registry.isRefetchError}
        onRefresh={() => {
          numbers.refresh();
          void registry.refetch();
          if (isOwner) void proposals.refetch();
        }}
        refreshing={numbers.refreshing || registry.isFetching}
      />
      <div className="wb-content">
        {registry.isError && !registry.data ? (
          <Card><ErrorState onRetry={() => void registry.refetch()} retrying={registry.isFetching} /></Card>
        ) : (
          <>
            {proposed.length > 0 && (
              <Card title="Агенты предлагают новых людей" description="Принятое предложение заводит человека в реестр; приглашение и вход вы делаете сами.">
                <ul className="access-list registry-items">{proposed.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} code={proposal.personCode} />)}</ul>
              </Card>
            )}
            {numbers.tooLong && (
              <Notice tone="warning" action={<Button size="sm" onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать 30 дней</Button>}>
                Hub считает смены не больше чем за 31 день: числа периода не показаны.
              </Notice>
            )}
            {numbers.main === "failed" && (
              <Notice tone="warning" role="alert" action={<Button size="sm" onClick={numbers.refresh}>Повторить</Button>}>Числа периода не пришли. Это не ноль: Hub их не прислал.</Notice>
            )}
            {numbers.quality === "failed" && <SlowFailed onRetry={numbers.retryQuality} />}
            <div className="registry-toolbar">
              <span className="registry-toolbar__counts">
                {registry.data ? <TeamCounts working={team.length} invited={invited.length} left={left.length} /> : <Skeleton width={260} />}
              </span>
              {isOwner && <Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>Пригласить</Button>}
            </div>
            <Table
              label="Люди за период"
              className="people-table registry-table"
              columns={columns}
              rows={sorted}
              rowKey={(row) => row.person.code}
              rowHref={(row) => personCodePath(row.person.code, location.search)}
              rowState={rowState}
              rowQuiet={isQuiet}
              // The spare width goes to «Человек» (its second line uses it), not shared out between the numbers.
              fit={false}
              rowClassName={(row) => (row === firstOff && row !== sorted[0] ? "people-row--off" : undefined)}
              sort={sort}
              onSortChange={setSort}
              align="first-line"
              loading={registry.data === undefined}
              refreshing={numbers.refreshing}
              skeletonRows={8}
              skeletonLines={2}
              empty={(
                <EmptyState
                  title={page ? `На ${page} никто не работает` : "В команде пока никого"}
                  action={isOwner && !page ? <Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>Пригласить</Button> : undefined}
                >
                  {page ? "Ни у кого это не рабочая страница, и смен на ней за период не было." : "Пригласите первого человека: он получит ссылку и сам придумает пароль."}
                </EmptyState>
              )}
            />
            {noShifts && <p className="people-note">{capitalized(periodWords(period))} смен не было.</p>}
            {invited.length > 0 && (
              <div className="people-idle">
                <span className="people-idle__label">Ждут регистрации:</span>
                {invited.map((person) => <CodeLink key={person.code} person={person} hint={inviteHint(person)} status="invited" />)}
              </div>
            )}
            {others.length > 0 && (
              <Disclosure summary="Остальные" hint={String(others.length)} size="md">
                <p className="access-text">Кто в команде, но без смен за период: владелец, тимлиды, контент-менеджеры, подрядчики.</p>
                <div className="people-folded">
                  {others.map((person) => <CodeLink key={person.code} person={person} hint={otherHint(person)} />)}
                </div>
              </Disclosure>
            )}
            {left.length > 0 && (
              <Disclosure summary="Ушли" hint={String(left.length)} size="md">
                <div className="people-folded">
                  {left.map((person) => <CodeLink key={person.code} person={person} hint={person.leftOn ? `в команде до ${formatDay(person.leftOn)}` : "день ухода не записан"} status="disabled" />)}
                </div>
              </Disclosure>
            )}
            {agents.length > 0 && (
              <Disclosure summary="Агенты" hint={String(agents.length)} size="md">
                <div className="people-folded">
                  {agents.map((person) => (
                    <CodeLink
                      key={person.code}
                      person={person}
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
                  {services.map((person) => <CodeLink key={person.code} person={person} hint={liveLogins(person).map((login) => login.username).join(", ") || "без входов"} />)}
                </div>
              </Disclosure>
            )}
            {unlinked.length > 0 && (
              <Disclosure summary="Входы без человека" hint={String(unlinked.length)} size="md">
                <p className="access-text">Входы Hub, которых нет ни у кого в реестре. Карточка входа открывает его смены и доступ.</p>
                <div className="people-folded">
                  {unlinked.map((login) => <LoginLink key={login.userId} login={login} />)}
                </div>
              </Disclosure>
            )}
            {page && (
              <p className="people-note">
                Фильтр {page} сужает смены и продажи. Ответ, без ответа к концу, ИИ без правки и траты на ИИ считаются по всем страницам: Hub
                пока не делит их по страницам.
              </p>
            )}
          </>
        )}
        <HowItCounts versus={versusTitle(period)} />
      </div>
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
            toast.success(`${created.person.displayName} в команде`);
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

interface Row {
  person: RegistryPerson;
  numbers: PersonNumbers;
}

/** «Сравнить не с чем: Hub пишет смены с 24 окт.» instead of the dates compared with, when nobody has a window before. */
function NothingToCompare({ knownSince }: { knownSince: string | null }) {
  return <span>Сравнить не с чем{knownSince ? `: Hub записывает смены с ${formatDay(knownSince)}` : ": у Hub нет прошлого периода"}</span>;
}

/** «12 в команде · 1 ждёт регистрации · 3 ушли», of the people on screen. */
function TeamCounts({ working, invited, left }: { working: number; invited: number; left: number }) {
  const parts = [
    `${working} в команде`,
    invited > 0 ? `${invited} ${invited === 1 ? "ждёт" : "ждут"} регистрации` : null,
    left > 0 ? `${left} ${left === 1 ? "ушёл" : "ушли"}` : null,
  ].filter(Boolean);
  return <>{parts.join(" · ")}</>;
}

/** The order of «Остальные»: the owner, then team leads, content managers, contractors, anyone else. */
const OTHERS_ORDER: Readonly<Record<string, number>> = { owner: 0, team_lead: 1, chatter: 2, content_manager: 3, contractor: 4 };

/** «Тимлид · в сети 2 ч назад», «Подрядчик · без входа в Hub». */
function otherHint(person: RegistryPerson): string {
  const seen = lastSeenOf(person);
  const where = liveLogins(person).length === 0 ? "без входа в Hub" : seen ? `в сети ${whenWords(seen)}` : "входов не было";
  return `${PERSON_ROLE_WORD[person.role] ?? person.role} · ${where}`;
}

/** «nika.t · чаттер»: the login waiting for its password. */
function inviteHint(person: RegistryPerson): string {
  const waiting = person.logins.find((login) => login.state === "invited");
  return [waiting?.username ?? (person.logins.length === 0 ? "без входа" : null), PERSON_ROLE_WORD[person.role]?.toLowerCase()].filter(Boolean).join(" · ");
}

/** A person's name that opens their card; «←» of the card comes back here. */
function CodeLink({ person, hint, status = "away" }: { person: RegistryPerson; hint: string; status?: PersonStatus }) {
  const location = useLocation();
  const state = useBackState("Люди");
  return (
    <Link to={personCodePath(person.code, location.search)} state={state} className="ui-quiet-link">
      <Person name={person.displayName} status={status} hint={hint} />
    </Link>
  );
}

/** A login no person holds: its own card (`/people/<userId>`). */
function LoginLink({ login }: { login: RegistryLogin }) {
  const location = useLocation();
  const state = useBackState("Люди");
  const words = [
    ROLE_WORD[login.role],
    login.state === "invited" ? "ждёт регистрации" : login.state === "disabled" ? "доступ отключён" : login.lastSeenAt ? `в сети ${whenWords(login.lastSeenAt)}` : "входов не было",
  ].join(" · ");
  return (
    <Link to={personPath(login.userId, location.search)} state={state} className="ui-quiet-link">
      <Person name={login.username} status={login.state === "disabled" ? "disabled" : login.state === "invited" ? "invited" : "away"} hint={words} />
    </Link>
  );
}

const SORT_KEYS = new Set(["who", "shifts", "sales", "hour", "reply", "unanswered", "ai", "spend"]);
const DEFAULT_SORT: SortState = { key: "sales", direction: "desc" };

/** The order in the address (`?sort=reply&dir=desc`): «←» from a person comes back to the same order. */
function useListSort(): [SortState, (next: SortState) => void] {
  const [search, setSearch] = useSearchParams();
  const key = search.get("sort");
  const sort: SortState = key && SORT_KEYS.has(key) ? { key, direction: search.get("dir") === "asc" ? "asc" : "desc" } : DEFAULT_SORT;
  const setSort = (next: SortState) => setSearch((current) => {
    const updated = new URLSearchParams(current);
    if (next.key === DEFAULT_SORT.key && next.direction === DEFAULT_SORT.direction) {
      updated.delete("sort");
      updated.delete("dir");
    } else {
      updated.set("sort", next.key);
      updated.set("dir", next.direction);
    }
    return updated;
  }, { replace: true });
  return [sort, setSort];
}

/** A row that did not work the period: no shift in it. */
function isQuiet(row: Row): boolean {
  return !row.numbers.work || row.numbers.work.shifts === 0;
}

/** The rows in the chosen order; the quiet ones always last, under a line (spec §4.3): they are not compared with the working ones. */
function sortedRows(rows: readonly Row[], columns: readonly Column<Row>[], sort: SortState): Row[] {
  const value = columns.find((column) => column.key === sort.key)?.sortValue;
  const factor = sort.direction === "asc" ? 1 : -1;
  const byValue = (left: Row, right: Row) => {
    if (!value) return 0;
    const a = value(left);
    const b = value(right);
    const aMissing = a === null || a === undefined;
    const bMissing = b === null || b === undefined;
    // Missing values stay last in both directions.
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, "ru") * factor;
    return (Number(a) - Number(b)) * factor;
  };
  const off = (row: Row) => (isQuiet(row) ? 1 : 0);
  return [...rows].sort((left, right) => off(left) - off(right) || byValue(left, right) || left.person.displayName.localeCompare(right.person.displayName, "ru"));
}

/** A number with its change under it; nothing under it when there is nothing to compare with. */
function WithDelta({ children, change }: { children: ReactNode; change: ReactNode }) {
  return (
    <span className="people-num">
      <span>{children}</span>
      {change}
    </span>
  );
}

function Pending() {
  return <span className="people-pending"><Skeleton width={56} /></span>;
}

function Dash({ hint }: { hint: string }) {
  return <Tooltip content={hint} align="end"><span className="people-dash">—</span></Tooltip>;
}

/** A column of a quality number: its label says «в среднем за смену»; its hint, what it counts. */
function qualityHint(key: keyof typeof METRICS): ReactNode {
  return <>{METRICS[key].hint} {PER_SHIFT_HINT}</>;
}

function useColumns(list: PeopleList, isOwner: boolean, page: string | null): Column<Row>[] {
  const { period } = usePeriod();
  const versus = versusTitle(period);
  const { team, comparable } = list;
  const loading = list.main === "loading";
  // Outliers are marked only among three or more people with numbers (as before the registry).
  const crowd = list.rows.filter((row) => row.quality).length >= 3;
  return useMemo(() => {
    /**
     * The change against the window before, by the one rule of Delta (D13): calm better / worse colours as on «Смены»,
     * «было $X» / «впервые» at a small base; nothing when there is nothing to compare with. `base`: the money behind a rate.
     */
    const change = (current: number | null, previous: number | null | undefined, base?: number | null) => {
      if (!comparable || previous === null || previous === undefined) return null;
      if (readDelta(current ?? 0, previous, { base }).kind === "none") return null;
      return <Delta current={current ?? 0} previous={previous} base={base} title={versus} />;
    };
    const quality = (row: Row, show: (value: NonNullable<PersonNumbers["quality"]>) => ReactNode) => {
      if (loading) return <Pending />;
      if (!row.numbers.work || row.numbers.work.shifts === 0) return <Dash hint="Смен не было" />;
      if (row.numbers.quality === undefined) return list.quality === "failed" ? <Dash hint="Hub не ответил" /> : <Pending />;
      if (row.numbers.quality === null) return <Dash hint="Смена ещё идёт: числа будут после её конца" />;
      return show(row.numbers.quality);
    };
    const perShift = page ? ["в среднем за смену", "все страницы"] : "в среднем за смену";
    const onPage = page ? { sub: page } : {};
    const columns: Column<Row>[] = [
      {
        key: "who",
        header: <Head lines={["Человек"]} sub="страницы · график по Москве" />,
        headerWrap: false,
        grow: true,
        sortValue: (row) => row.person.displayName,
        cell: (row) => {
          const { person, numbers } = row;
          const notes = isOwner ? unsettledNotes(person) : 0;
          const proposals = isOwner ? person.openProposals : 0;
          const slot = slotSummary(person);
          const going = numbers.now.onShiftSince ? statusOf({ state: "active", disabledAt: null, now: numbers.now }).words : null;
          // Line 2, one line: the shift going on now (green) and the working pages, then the slot. The rest is the card's.
          // A slot that does not fit whole is left out of the row (registry.css), never cut to a stub.
          const head: ReactNode[] = [
            going ? <span key="live" className="registry-who__live">{going}</span> : null,
            person.workingPages.length > 0 ? <PageLabels key="pages" labels={person.workingPages.map((one) => one.pageLabel)} max={3} className="registry-who__pages" /> : null,
          ].filter((part) => part !== null);
          const marks = notes > 0 || proposals > 0 ? (
            <>
              {notes > 0 && <Badge tone="warning" className="registry-mark">расхождения: {notes}</Badge>}
              {proposals > 0 && <Badge tone="info" className="registry-mark">{proposals === 1 ? "предложение агента" : `предложения агентов: ${proposals}`}</Badge>}
            </>
          ) : undefined;
          return (
            <Person
              name={person.displayName}
              status={going ? "working" : "away"}
              nameEnd={marks}
              hint={head.length === 0 && !slot.main ? undefined : (
                <span className="registry-who__line">
                  {head.length > 0 && (
                    <span className="registry-who__head">
                      {head.map((part, index) => <span key={index}>{index > 0 && <span className="registry-who__sep" aria-hidden>·</span>}{part}</span>)}
                    </span>
                  )}
                  {slot.main && (
                    <span className="registry-who__tail">{head.length > 0 && <span className="registry-who__sep" aria-hidden>·</span>}{slot.main}</span>
                  )}
                </span>
              )}
              className="registry-who"
            />
          );
        },
      },
      {
        key: "shifts",
        header: "Смены",
        numeric: true,
        sortValue: (row) => row.numbers.work?.shifts ?? 0,
        cell: (row) => loading ? <Pending /> : !row.numbers.work || row.numbers.work.shifts === 0
          ? <span className="people-dash">0</span>
          : (
            <span className="people-num">
              <span>{row.numbers.work.shifts}</span>
              <span className="people-num__sub"><Duration minutes={row.numbers.work.workedMinutes} /></span>
            </span>
          ),
      },
      {
        key: "sales",
        header: <Head lines={["Продажи"]} {...onPage} />,
        headerWrap: false,
        numeric: true,
        sortValue: (row) => row.numbers.work?.salesNetMills ?? 0,
        cell: (row) => {
          if (loading) return <Pending />;
          const work = row.numbers.work;
          if (!work) return <Dash hint="Смен не было" />;
          return (
            <WithDelta change={change(work.salesNetMills, work.previous?.salesNetMills)}>
              <Money mills={work.salesNetMills} strong />
            </WithDelta>
          );
        },
      },
      {
        key: "hour",
        header: <Head lines={["В час"]} {...onPage} />,
        headerWrap: false,
        numeric: true,
        sortValue: (row) => row.numbers.work?.perHourMills ?? null,
        cell: (row) => {
          if (loading) return <Pending />;
          const work = row.numbers.work;
          if (!work || work.perHourMills === null) return <Dash hint="Смен не было" />;
          return (
            <WithDelta change={change(work.perHourMills, work.previous?.perHourMills, work.previous?.salesNetMills)}>
              <Money mills={work.perHourMills} />
            </WithDelta>
          );
        },
      },
      {
        key: "reply",
        header: <Head lines={[METRICS.reply.label]} sub={perShift} />,
        headerWrap: false,
        numeric: true,
        hint: qualityHint("reply"),
        sortValue: (row) => row.numbers.quality?.replyMedianSeconds ?? null,
        sortFirst: "desc",
        cell: (row) => quality(row, (value) => {
          const text = formatReplyMedian(value.replyMedianSeconds);
          const slow = crowd && value.replyMedianSeconds !== null && team.replyMedianSeconds !== null
            && value.replyMedianSeconds >= 2 * team.replyMedianSeconds && value.replyMedianSeconds >= 120;
          return slow ? <Mark hint={`Вдвое дольше середины команды (${formatReplyMedian(team.replyMedianSeconds)})`}>{text}</Mark> : text;
        }),
      },
      {
        key: "unanswered",
        header: <Head lines={[METRICS.unanswered.label]} sub={perShift} />,
        headerWrap: false,
        numeric: true,
        hint: qualityHint("unanswered"),
        sortValue: (row) => row.numbers.quality?.unansweredAtEnd ?? null,
        sortFirst: "desc",
        cell: (row) => quality(row, (value) => {
          const text = formatUnanswered(value.unansweredAtEnd, { average: true });
          const many = crowd && value.unansweredAtEnd !== null && team.unansweredAtEnd !== null
            && value.unansweredAtEnd >= 3 && value.unansweredAtEnd >= 2 * Math.max(team.unansweredAtEnd, 1);
          return many ? <Mark hint={`Вдвое больше середины команды (${formatUnanswered(team.unansweredAtEnd, { average: true })})`}>{text}</Mark> : text;
        }),
      },
      {
        key: "ai",
        header: <Head lines={[METRICS.aiUnedited.label]} sub={perShift} />,
        headerWrap: false,
        numeric: true,
        hint: qualityHint("aiUnedited"),
        sortValue: (row) => row.numbers.quality?.aiUneditedShare ?? null,
        sortFirst: "desc",
        cell: (row) => quality(row, (value) => formatAiUnedited(value.aiUneditedShare)),
      },
    ];
    if (isOwner) {
      columns.push({
        key: "spend",
        header: <Head lines={["Траты", "на ИИ"]} {...(page ? { sub: "все страницы" } : {})} />,
        headerWrap: false,
        numeric: true,
        hint: "Сколько стоили запросы человека к ИИ за дни периода, по всем страницам и всем его входам",
        sortValue: (row) => row.numbers.aiSpendMicroUsd ?? null,
        sortFirst: "desc",
        cell: (row) => {
          if (row.numbers.aiSpendMicroUsd === undefined) return list.spend === "failed" ? <Dash hint="Hub не ответил" /> : <Pending />;
          return row.numbers.aiSpendMicroUsd === null ? <Dash hint="Запросов к ИИ не было" /> : <Money microUsd={row.numbers.aiSpendMicroUsd} />;
        },
      });
    }
    return columns;
  }, [isOwner, list.quality, list.spend, loading, crowd, comparable, team.replyMedianSeconds, team.unansweredAtEnd, versus, page]);
}

function HowItCounts({ versus }: { versus: string }) {
  return (
    <Disclosure summary="Как это считается" className="people-help">
      <p>
        Строка: человек из реестра людей, со всеми его входами в Hub; числа его входов складываются. График, рабочие страницы и
        условия меняют в карточке человека, во вкладке «График и условия».
      </p>
      <p>
        Смена: работа в расширении под своим входом, от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений,
        конец после часа без действий. Точка рядом с именем тоже по сменам, не по открытому расширению. «В сети»: последний раз,
        когда работал любой вход человека.
      </p>
      <p>
        Продажи: деньги после комиссии площадки за смены, на страницах, где человек писал. Если страницу вели двое, продажа у того,
        кто последним писал фану; если не писал никто, она видна у обоих. Поэтому строки «Итого» нет: сумма была бы больше настоящей.
      </p>
      <p><b>{METRICS.reply.label}.</b> {METRICS.reply.hint}</p>
      <p><b>{METRICS.unanswered.label}.</b> {METRICS.unanswered.hint}</p>
      <p><b>{METRICS.aiUnedited.label}.</b> {METRICS.aiUnedited.hint}</p>
      <p>{PER_SHIFT_HINT} Изменение {versus}; это ориентир, а не основание для оплаты.</p>
    </Disclosure>
  );
}
