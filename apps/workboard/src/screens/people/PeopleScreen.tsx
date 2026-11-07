import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES } from "@agency_hub_core/contracts";
import { Button, Card, Delta, Disclosure, Duration, EmptyState, ErrorState, Mark, Money, Person, Skeleton, Table, type Column } from "@agency_hub_core/ui";
import { formatDuration } from "@agency_hub_core/ui/format";
import { PersonLink, personPath } from "@/shared/links";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { SlowFailed } from "./SlowFailed.js";
import { changePct, usePeopleList, type PeopleList, type PersonRef, type PersonSummary } from "./data.js";
import { capitalized, periodWords, replyText, ROLE_WORD, shareText, statusOf, versusTitle } from "./words.js";
import "./people.css";

/**
 * Люди (spec §4.3): everyone side by side for the period in one table — now,
 * money and its change, money per hour, how fast they answer, who was left
 * waiting at the end of a shift, how much the AI wrote and what it cost. A row
 * opens the person. People without a shift stand under the table; the
 * switched-off are folded.
 */
export function PeopleScreen() {
  const { period, setPeriod } = usePeriod();
  const { page } = usePageFilter();
  const { isOwner } = useMe();
  const list = usePeopleList(period, page);
  const location = useLocation();
  const columns = useColumns(list, isOwner);
  const noShifts = list.main === "ready" && list.rows.every((row) => !row.work || row.work.shifts === 0);

  return (
    <>
      <ScreenHeader title="Люди" period pageFilter updatedAt={list.updatedAt} onRefresh={list.refresh} refreshing={list.refreshing} />
      <div className="wb-content">
        {list.tooLong ? (
          <Card>
            <EmptyState
              title="Период длиннее 31 дня"
              action={<Button onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать 30 дней</Button>}
            >
              Hub считает смены не больше чем за 31 день. Выберите период короче.
            </EmptyState>
          </Card>
        ) : list.main === "failed" ? (
          <Card><ErrorState onRetry={list.refresh} /></Card>
        ) : (
          <>
            {list.quality === "failed" && <SlowFailed onRetry={list.retryQuality} />}
            <Table
              label="Люди за период"
              columns={columns}
              rows={list.rows}
              rowKey={(row) => String(row.userId)}
              rowHref={(row) => personPath(row.userId, location.search)}
              rowQuiet={(row) => row.state === "disabled" || !row.work || row.work.shifts === 0}
              defaultSort={{ key: "sales", direction: "desc" }}
              loading={list.main === "loading"}
              refreshing={list.refreshing}
              skeletonRows={6}
              empty={(
                <EmptyState
                  title={`${capitalized(periodWords(period))} смен не было`}
                  action={period.days < 30 ? <Button onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать 30 дней</Button> : undefined}
                >
                  Никто не работал в расширении под своим входом{page ? ` на странице ${page}` : ""}.
                </EmptyState>
              )}
            />
            {noShifts && list.rows.length > 0 && (
              <p className="people-note">{capitalized(periodWords(period))} смен не было: в таблице те, кто работал в прошлый период.</p>
            )}
            <Aside list={list} page={page} />
          </>
        )}
        <HowItCounts versus={versusTitle(period)} />
      </div>
    </>
  );
}

/** A number with its change under it. */
function WithDelta({ children, pct, was, title }: { children: ReactNode; pct: number | null; was?: number | null; title: string }) {
  return (
    <span className="people-num">
      <span>{children}</span>
      <Delta pct={pct} was={was ?? null} title={title} />
    </span>
  );
}

function Pending() {
  return <span style={{ display: "inline-flex", justifyContent: "flex-end", width: "100%" }}><Skeleton width={56} /></span>;
}

function Dash({ title }: { title: string }) {
  return <span className="people-dash" title={title}>—</span>;
}

function useColumns(list: PeopleList, isOwner: boolean): Column<PersonSummary>[] {
  const { period } = usePeriod();
  const versus = versusTitle(period);
  const { team } = list;
  return useMemo(() => {
    const quality = (row: PersonSummary, show: (value: NonNullable<PersonSummary["quality"]>) => ReactNode) => {
      if (!row.work || row.work.shifts === 0) return <Dash title="Смен не было" />;
      if (row.quality === undefined) return list.quality === "failed" ? <Dash title="Hub не ответил" /> : <Pending />;
      if (row.quality === null) return <Dash title="Смена ещё идёт: числа будут после её конца" />;
      return show(row.quality);
    };
    const columns: Column<PersonSummary>[] = [
      {
        key: "who",
        header: "Человек",
        sortValue: (row) => row.username,
        cell: (row) => {
          const { status, words } = statusOf(row);
          const hint = [row.role && row.role !== "chatter" ? ROLE_WORD[row.role] : "", words].filter(Boolean).join(" · ");
          return <Person name={row.username} status={status} {...(hint ? { hint } : {})} />;
        },
      },
      {
        key: "shifts",
        header: "Смены",
        numeric: true,
        title: "Смен за период и сколько в них работы",
        sortValue: (row) => row.work?.shifts ?? 0,
        cell: (row) => !row.work || row.work.shifts === 0
          ? <span className="people-num"><span className="people-dash">0</span><span className="people-num__sub">смен не было</span></span>
          : (
            <span className="people-num">
              <span>{row.work.shifts}</span>
              <span className="people-num__sub"><Duration minutes={row.work.workedMinutes} /></span>
            </span>
          ),
      },
      {
        key: "sales",
        header: "Продажи",
        numeric: true,
        title: "Деньги после комиссии площадки за смены периода",
        sortValue: (row) => row.work?.salesNetMills ?? 0,
        cell: (row) => {
          const work = row.work;
          if (!work) return <Dash title="Смен не было" />;
          const gone = work.shifts === 0 && (work.previous?.salesNetMills ?? 0) > 0;
          return (
            <WithDelta pct={changePct(work.salesNetMills, work.previous?.salesNetMills)} was={gone ? work.previous!.salesNetMills : null} title={versus}>
              <Money mills={work.salesNetMills} strong />
            </WithDelta>
          );
        },
      },
      {
        key: "hour",
        header: "В час",
        numeric: true,
        title: "Продажи на час работы",
        sortValue: (row) => row.work?.perHourMills ?? null,
        cell: (row) => {
          const work = row.work;
          if (!work || work.perHourMills === null) return <Dash title="Смен не было" />;
          return (
            <WithDelta pct={changePct(work.perHourMills, work.previous?.perHourMills)} title={versus}>
              <Money mills={work.perHourMills} />
            </WithDelta>
          );
        },
      },
      {
        key: "reply",
        header: "Ответ, медиана",
        numeric: true,
        title: "Половина ответов ждущим фанам — быстрее этого",
        sortValue: (row) => row.quality?.replyMedianSeconds ?? null,
        sortFirst: "desc",
        cell: (row) => quality(row, (value) => {
          const text = replyText(value.replyMedianSeconds);
          const slow = value.replyMedianSeconds !== null && team.replyMedianSeconds !== null && list.rows.length >= 3
            && value.replyMedianSeconds >= 2 * team.replyMedianSeconds && value.replyMedianSeconds >= 120;
          return slow ? <Mark title={`Вдвое дольше середины команды (${replyText(team.replyMedianSeconds)})`}>{text}</Mark> : text;
        }),
      },
      {
        key: "waiting",
        header: "Без ответа в конце",
        numeric: true,
        title: "Сколько фанов ждали ответа, когда смена кончилась: в среднем за смену",
        sortValue: (row) => row.quality?.waitingAtEnd ?? null,
        sortFirst: "desc",
        cell: (row) => quality(row, (value) => {
          const many = team.waitingAtEnd !== null && list.rows.length >= 3 && value.waitingAtEnd >= 3 && value.waitingAtEnd >= 2 * Math.max(team.waitingAtEnd, 1);
          return many ? <Mark title={`Вдвое больше середины команды (${team.waitingAtEnd})`}>{value.waitingAtEnd}</Mark> : value.waitingAtEnd;
        }),
      },
      {
        key: "ai",
        header: "Доля ИИ",
        numeric: true,
        title: "Сообщения, написанные кнопками Reply и Fix расширения, из всех",
        sortValue: (row) => row.quality?.aiShare ?? null,
        cell: (row) => quality(row, (value) => shareText(value.aiShare)),
      },
    ];
    if (isOwner) {
      columns.push({
        key: "spend",
        header: "Траты на ИИ",
        numeric: true,
        title: "Сколько стоили запросы человека к ИИ за дни периода, по всем страницам",
        sortValue: (row) => row.aiSpendMicroUsd ?? null,
        cell: (row) => {
          if (row.aiSpendMicroUsd === undefined) return list.spend === "failed" ? <Dash title="Hub не ответил" /> : <Pending />;
          return row.aiSpendMicroUsd === null ? <Dash title="Запросов к ИИ не было" /> : <Money microUsd={row.aiSpendMicroUsd} />;
        },
      });
    }
    return columns;
  }, [isOwner, list.quality, list.spend, list.rows.length, team.replyMedianSeconds, team.waitingAtEnd, versus]);
}

function Aside({ list, page }: { list: PeopleList; page: string | null }) {
  if (list.main !== "ready") return null;
  const { idle, disabled } = list;
  if (idle.length === 0 && disabled.length === 0 && !page) return null;
  return (
    <div className="people-aside">
      {idle.length > 0 && (
        <div className="people-idle">
          <span className="people-idle__label">{page ? `Без смен на ${page}:` : "Без смен за период:"}</span>
          {idle.map((person) => <IdlePerson key={person.userId} person={person} />)}
        </div>
      )}
      {disabled.length > 0 && (
        <Disclosure summary="Отключённые" hint={String(disabled.length)} size="md">
          <div className="people-folded">
            {disabled.map((person) => <IdlePerson key={person.userId} person={person} />)}
          </div>
        </Disclosure>
      )}
      {page && (
        <p className="people-note">
          Смены и продажи — только по странице {page}. Ответ, «без ответа в конце», доля и траты ИИ — по всем страницам: Hub пока не делит их по страницам.
        </p>
      )}
    </div>
  );
}

function IdlePerson({ person }: { person: PersonRef }) {
  const { status, words } = statusOf({ state: person.state, disabledAt: person.disabledAt, now: { onShiftSince: null, lastSeenAt: null } });
  const role = ROLE_WORD[person.role].toLowerCase();
  const hint = person.state === "active" ? role : words;
  return <PersonLink userId={person.userId} name={person.username} status={status} hint={hint} backLabel="Люди" />;
}

function HowItCounts({ versus }: { versus: string }) {
  return (
    <Disclosure summary="Как это считается" className="people-help">
      <p>
        Смена — работа в расширении под своим входом: от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений,
        конец — час без действий.
      </p>
      <p>
        Продажи — деньги после комиссии площадки за смены, на страницах, где человек писал. Если страницу вели двое, продажа у того,
        кто последним писал фану; если не писал никто, она видна у обоих. Поэтому строки «Итого» нет: сумма была бы больше настоящей.
      </p>
      <p>
        Ответ, медиана — половина ответов ждущим фанам быстрее этого. Без ответа в конце — сколько фанов ждали ответа, когда смена
        кончилась, в среднем за смену. Доля ИИ — сообщения, написанные кнопками Reply и Fix.
      </p>
      <p>Изменение — {versus}. Это ориентир, а не основание для оплаты.</p>
    </Disclosure>
  );
}
