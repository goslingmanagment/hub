import type { ReactNode } from "react";
import { useLocation, useParams } from "react-router";
import { Badge, Card, EmptyState, ErrorState, LinkButton, Money, Skeleton, StatusDot, Tabs } from "@agency_hub_core/ui";
import { carryParams, personPath, ShiftLink, useBackTarget, type PersonTab } from "@/shared/links";
import { PageChip } from "@/shared/PageChip";
import { PersonAccessPanel } from "@/shared/PersonAccessPanel";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { usePersonCard, type PersonCard, type PersonSummary } from "./data.js";
import { SalesTab } from "./SalesTab.js";
import { ShiftsTab } from "./ShiftsTab.js";
import { WorkTab } from "./WorkTab.js";
import { capitalized, periodWords, ROLE_WORD, statusOf } from "./words.js";
import "./people.css";

const TABS: readonly { tab: PersonTab; label: string }[] = [
  { tab: "work", label: "Работа" },
  { tab: "shifts", label: "Смены" },
  { tab: "sales", label: "Продажи" },
  { tab: "access", label: "Доступ" },
];

/**
 * Человек `/people/:userId` (spec §4.4): one card instead of the console's two
 * («Чаттер» and «Сотрудник»). The header says who it is now — status, role,
 * pages, AI spend of the period; the tabs: Работа (the verdict and the shifts
 * by the hour), Смены (every shift, each opens its review), Продажи (how they
 * sell against the team), Доступ (the owner's only).
 */
export function PersonScreen() {
  const { userId: raw, tab } = useParams();
  const { isOwner } = useMe();
  const location = useLocation();
  const { period, today } = usePeriod();
  const { page } = usePageFilter();
  const id = Number(raw);
  const valid = Number.isInteger(id) && id > 0;
  const current: PersonTab = TABS.find((item) => item.tab === tab && (item.tab !== "access" || isOwner))?.tab ?? "work";
  const fallbackSearch = carryParams(location.search).toString();
  const back = useBackTarget({ to: `/people${fallbackSearch ? `?${fallbackSearch}` : ""}`, label: "Люди" });
  const card = usePersonCard(valid ? id : 0, period, page, today);
  const person = card.person;

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

  const access = current === "access";
  return (
    <>
      <ScreenHeader
        title={person ? person.username : <Skeleton width={160} height={28} />}
        documentTitle={person?.username ?? "Человек"}
        back={back}
        period={!access}
        pageFilter={!access}
        meta={person ? <PersonMeta person={person} periodLabel={periodWords(period)} access={access} page={page} /> : <Skeleton width={320} />}
        updatedAt={card.updatedAt}
        onRefresh={card.refresh}
        refreshing={card.refreshing}
        tabs={(
          <Tabs
            label="Разделы карточки"
            items={TABS.filter((item) => item.tab !== "access" || isOwner).map((item) => ({
              to: personPath(id, location.search, item.tab),
              label: item.label,
              end: true,
            }))}
          />
        )}
      />
      <div className="wb-content">
        {access ? (
          <PersonAccessPanel userId={id} variant="page" onChanged={card.refresh} />
        ) : card.tooLong ? (
          <Card>
            <EmptyState title="Период длиннее 31 дня">Hub считает смены не больше чем за 31 день. Выберите период короче.</EmptyState>
          </Card>
        ) : card.main === "failed" ? (
          <Card><ErrorState onRetry={card.refresh} /></Card>
        ) : (
          <TabBody tab={current} card={card} userId={id} />
        )}
      </div>
    </>
  );
}

function TabBody({ tab, card, userId }: { tab: PersonTab; card: PersonCard; userId: number }) {
  if (tab === "shifts") return <ShiftsTab card={card} userId={userId} />;
  if (tab === "sales") return <SalesTab userId={userId} backLabel={card.person?.username ?? "Человек"} />;
  return <WorkTab card={card} userId={userId} />;
}

/**
 * Who it is now: status (a live shift opens its review), role, pages, AI spend
 * of the period. On «Доступ» the pages and the spend stay out: the pages are
 * edited right below, and the tab has no period.
 */
function PersonMeta({ person, periodLabel, access, page }: { person: PersonSummary; periodLabel: string; access: boolean; page: string | null }) {
  const { status, words } = statusOf(person);
  const parts: ReactNode[] = [];
  if (status === "working" && person.now.onShiftSince) {
    parts.push(
      <ShiftLink key="status" userId={person.userId} startedAt={person.now.onShiftSince} backLabel={person.username} className="people-meta__live" title="Открыть разбор идущей смены">
        <StatusDot tone="success" />
        {capitalized(words)}
      </ShiftLink>,
    );
  } else if (status === "disabled") {
    parts.push(<Badge key="status" tone="off">{capitalized(words)}</Badge>);
  } else if (status === "invited") {
    parts.push(<Badge key="status" tone="info">Ждёт регистрации</Badge>);
  } else if (words) {
    parts.push(<span key="status">{capitalized(words)}</span>);
  }
  if (person.role) parts.push(<span key="role">{ROLE_WORD[person.role]}</span>);
  if (person.pages.length > 0 && !access) {
    parts.push(
      <span key="pages" className="people-meta__pages" aria-label="Страницы">
        {person.pages.map((label) => <PageChip key={label} label={label} selected={label === page} />)}
      </span>,
    );
  }
  if (!access && person.aiSpendMicroUsd !== undefined && !(person.aiSpendMicroUsd === null && person.state === "invited")) {
    parts.push(
      <span key="ai">
        ИИ {periodLabel}: <span className="people-meta__strong">{person.aiSpendMicroUsd === null ? "$0.00" : <Money microUsd={person.aiSpendMicroUsd} />}</span>
      </span>,
    );
  }
  return (
    <div className="people-meta">
      {parts.map((part, index) => (
        <span key={index} style={{ display: "contents" }}>
          {index > 0 && <span className="people-meta__sep" aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}
