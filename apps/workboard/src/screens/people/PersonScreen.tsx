import { useEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Badge, Card, EmptyState, ErrorState, LinkButton, Money, Skeleton, StatusDot, Tabs, Tooltip } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { carryParams, personPath, ShiftLink, useBackTarget, type PersonTab } from "@/shared/links";
import { PersonAccessPanel } from "@/shared/PersonAccessPanel";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePages } from "@/shared/usePages";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { usePersonCard, type PersonCard, type PersonSummary } from "./data.js";
import { SalesTab } from "./SalesTab.js";
import { pagesInOrder } from "./ShiftTable.js";
import { WorkTab } from "./WorkTab.js";
import { capitalized, periodShort, ROLE_WORD, statusOf } from "./words.js";
import "./people.css";

/** The card's tabs (D2): the shift table lives in Работа; `/people/:id/shifts` redirects there (app/routes.tsx). */
const TABS: readonly { tab: Exclude<PersonTab, "shifts">; label: string }[] = [
  { tab: "work", label: "Работа" },
  { tab: "sales", label: "Продажи" },
  { tab: "access", label: "Доступ" },
];

/**
 * Человек `/people/:userId` (spec §4.4): one card instead of the console's two
 * («Чаттер» and «Сотрудник»). The header says who it is now — status, role,
 * pages, AI spend of the period — and stays the same on every tab, so the tabs
 * never move; the tabs: Работа (the verdict, the shifts by the hour, every
 * shift), Продажи (how they sell against the team), Доступ (the owner's only).
 */
export function PersonScreen() {
  const { userId: raw, tab } = useParams();
  const { isOwner } = useMe();
  const location = useLocation();
  const { period, today } = usePeriod();
  const { page } = usePageFilter();
  const id = Number(raw);
  const valid = Number.isInteger(id) && id > 0;
  const current = TABS.find((item) => item.tab === tab && (item.tab !== "access" || isOwner))?.tab ?? "work";
  const fallbackSearch = carryParams(location.search).toString();
  const back = useBackTarget({ to: `/people${fallbackSearch ? `?${fallbackSearch}` : ""}`, label: "Люди" });
  const card = usePersonCard(valid ? id : 0, period, page, today);
  const person = card.person;
  useOpenAccessFirst(card, id, tab === undefined && isOwner);

  if (!valid || (card.missing && !person)) {
    return (
      <>
        <ScreenHeader title="Человек" back={back} />
        <div className="wb-content">
          <Card>
            <EmptyState title="Нет такого человека" action={<LinkButton to={back.to}>К людям</LinkButton>}>
              Этот аккаунт удалён или не работал на ваших страницах.
            </EmptyState>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <ScreenHeader
        title={person ? person.username : <Skeleton width={160} height={28} />}
        documentTitle={person?.username ?? "Человек"}
        back={back}
        period
        pageFilter
        meta={person ? <PersonMeta person={person} periodLabel={periodShort(period)} statusKnown={card.nowKnown} /> : <Skeleton width={320} />}
        updatedAt={card.updatedAt}
        onRefresh={card.refresh}
        refreshing={card.refreshing}
        tabs={(
          <Tabs
            label="Разделы карточки"
            items={TABS.filter((item) => item.tab !== "access" || isOwner).map((item) => ({
              to: item.tab === "work" ? workPath(id, location.search, tab === undefined) : personPath(id, location.search, item.tab),
              label: item.label,
              end: true,
            }))}
          />
        )}
      />
      <div className="wb-content">
        {current === "access" ? (
          <PersonAccessPanel userId={id} variant="page" onChanged={card.refresh} />
        ) : card.tooLong ? (
          <Card>
            <EmptyState title="Период длиннее 31 дня">Hub считает смены не больше чем за 31 день. Выберите период короче.</EmptyState>
          </Card>
        ) : card.main === "failed" ? (
          <Card><ErrorState onRetry={card.refresh} /></Card>
        ) : current === "sales" ? (
          <SalesTab userId={id} name={person?.username ?? "Человек"} />
        ) : (
          <WorkTab card={card} userId={id} />
        )}
      </div>
    </>
  );
}

/**
 * «Работа» from another tab is the explicit `/people/:id/work`: the bare address
 * may open Доступ first (below), the explicit one never does — so «Работа»
 * pressed, «←» back to it and the browser's «Назад» all stay on it. On the bare
 * address itself the tab links there, so it is the current one.
 */
function workPath(userId: number, search: string, bare: boolean): string {
  const path = personPath(userId, search);
  if (bare) return path;
  const [pathname, query] = path.split("?");
  return `${pathname}/work${query ? `?${query}` : ""}`;
}

/**
 * Р8: someone whose card has nothing in Работа — an invite not accepted, an
 * owner or a team lead without a shift in the period or before it — opens on
 * Доступ, where their actions are. Once per person: «Работа» pressed later stays.
 */
function useOpenAccessFirst(card: PersonCard, userId: number, bare: boolean) {
  const navigate = useNavigate();
  const location = useLocation();
  const decided = useRef<number | null>(null);
  const person = card.person;
  const known = person !== null && person.state !== null && person.work !== null;
  const accessFirst = known && (person.state === "invited"
    || (person.role !== "chatter" && person.role !== null && person.work!.shifts === 0 && !(person.work!.previous?.shifts)));
  useEffect(() => {
    if (!known || decided.current === userId) return;
    decided.current = userId;
    if (bare && accessFirst) navigate(personPath(userId, location.search, "access"), { replace: true, state: location.state });
  }, [known, accessFirst, bare, userId, navigate, location.search, location.state]);
}

/**
 * Who it is now — the same line on every tab, one line high (Р2): status (a
 * live shift opens its review), role, pages as quiet text («mia-1, mia-2 и
 * ещё 6», the rest on hover), the AI spend of the period.
 */
function PersonMeta({ person, periodLabel, statusKnown }: { person: PersonSummary; periodLabel: string; statusKnown: boolean }) {
  const { status, words } = statusOf(person);
  const { isOwner } = useMe();
  const parts: ReactNode[] = [];
  if (status === "working" && person.now.onShiftSince && isOwner) {
    parts.push(
      <ShiftLink key="status" userId={person.userId} startedAt={person.now.onShiftSince} backLabel={person.username} className="people-meta__live" title="Открыть разбор идущей смены">
        <StatusDot tone="success" />
        {capitalized(words)}
      </ShiftLink>,
    );
  } else if (status === "working") {
    parts.push(<span key="status" className="people-meta__live"><StatusDot tone="success" />{capitalized(words)}</span>);
  } else if (status === "disabled") {
    parts.push(<Badge key="status" tone="off" bare>{capitalized(words)}</Badge>);
  } else if (status === "invited") {
    parts.push(<Badge key="status" tone="info" bare>Ждёт регистрации</Badge>);
  } else if (!statusKnown) {
    // The status comes with «who is on shift now»: hold its place, so the role and the pages do not jump right.
    parts.push(<Skeleton key="status" width={150} />);
  } else if (words) {
    parts.push(<span key="status">{capitalized(words)}</span>);
  }
  if (person.role) parts.push(<span key="role">{ROLE_WORD[person.role]}</span>);
  if (person.pages.length > 0) parts.push(<MetaPages key="pages" pages={person.pages} />);
  if (person.aiSpendMicroUsd !== undefined && !(person.aiSpendMicroUsd === null && person.state === "invited")) {
    parts.push(
      <span key="ai">
        Траты на ИИ {periodLabel}: <span className="people-meta__strong">{person.aiSpendMicroUsd === null ? "$0.00" : <Money microUsd={person.aiSpendMicroUsd} />}</span>
      </span>,
    );
  }
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

/**
 * The person's pages as quiet text, by name: up to three; more — «mia-1, mia-2
 * и ещё 6»; every page the viewer has — «все 9 страниц». The rest on hover,
 * one page a line, never broken inside a name.
 */
function MetaPages({ pages }: { pages: readonly string[] }) {
  const all = usePages().data;
  const sorted = pagesInOrder(pages);
  const list = (names: readonly string[]) => (
    <span className="people-pages-tip">{names.map((name) => <span key={name}>{name}</span>)}</span>
  );
  const everyPage = all !== undefined && all.length > 3 && all.every((one) => pages.includes(one.label));
  if (everyPage) {
    return (
      <Tooltip content={list(sorted)}>
        <span className="people-meta__more" tabIndex={0}>все {sorted.length} {ruPlural(sorted.length, "страница", "страницы", "страниц")}</span>
      </Tooltip>
    );
  }
  if (sorted.length <= 3) return <span className="ui-page">{sorted.join(", ")}</span>;
  const shown = sorted.slice(0, 2);
  const rest = sorted.slice(2);
  return (
    <span>
      <span className="ui-page">{shown.join(", ")}</span>{" "}
      <Tooltip content={list(rest)}>
        <span className="people-meta__more" tabIndex={0}>и ещё {rest.length}</span>
      </Tooltip>
    </span>
  );
}
