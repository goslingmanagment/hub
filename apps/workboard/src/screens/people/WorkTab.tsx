import { useMemo, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES, SHIFT_REPORT_MAX_DAYS } from "@agency_hub_core/contracts";
import { millsToNumber, sumMills } from "@agency_hub_core/shared";
import { Button, Card, Delta, Disclosure, Duration, EmptyState, Hint, LinkButton, Money, Section, Skeleton, Tooltip, readDelta } from "@agency_hub_core/ui";
import { formatDuration, formatMills, formatPercent } from "@agency_hub_core/ui/format";
import { addDays } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { carryParams, personPath } from "@/shared/links";
import { formatAiUnedited, formatReplyMedian, formatUnanswered, METRICS, PER_SHIFT_HINT } from "@/shared/metrics";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { usePersonStats, type PeriodQuality, type PeriodWork, type PersonCard } from "./data.js";
import { ShiftRibbon } from "./ShiftRibbon.js";
import { ShiftTable } from "./ShiftTable.js";
import { SlowFailed } from "./SlowFailed.js";
import { capitalized, dayWords, periodWords, sentence, versusTitle } from "./words.js";

/**
 * «Работа» (spec §4.4, D2): the period's verdict in one line — money and its
 * change, per hour, and the review's three numbers as the average per shift —
 * then the shifts by the hour (the owner's favourite picture), then every
 * shift in one table, each row opening its review.
 */
export function WorkTab({ card, userId }: { card: PersonCard; userId: number }) {
  const { period, today } = usePeriod();
  const { isOwner } = useMe();
  const person = card.person;
  const work = person?.work ?? null;

  const days = useMemo(() => {
    const list: string[] = [];
    const last = period.to < today ? period.to : today;
    for (let day = last; day >= period.from; day = addDays(day, -1)) {
      if (card.knownSince === null || day >= card.knownSince) list.push(day);
    }
    return list;
  }, [period.from, period.to, today, card.knownSince]);
  const unknownBefore = card.knownSince !== null && card.knownSince > period.from && card.knownSince <= period.to ? dayWords(card.knownSince) : null;

  if (card.main === "loading" || !person || !work) return <WorkSkeleton card={card} userId={userId} canOpen={isOwner} />;
  if (work.shifts === 0) return <NoShifts card={card} />;

  return (
    <>
      {card.quality === "failed" && <SlowFailed onRetry={card.retryQuality} />}
      <Verdict work={work} quality={person.quality} failed={card.quality === "failed"} username={person.username} />
      <Section
        title="Смены по часам"
        description={isOwner ? "Время московское. Нажмите на смену — откроется её разбор." : "Время московское."}
      >
        <Card>
          <ShiftRibbon
            userId={userId}
            backLabel={person.username}
            shifts={card.shifts}
            visits={card.visits}
            days={days}
            unknownBefore={unknownBefore}
            salesRead={card.salesRead}
            today={today}
            canOpen={isOwner}
          />
        </Card>
      </Section>
      <Section title="Смены" {...(isOwner ? { description: "Числа каждой смены — те же, что в её разборе." } : {})}>
        <ShiftTable card={card} userId={userId} canOpen={isOwner} />
        <Below card={card} userId={userId} />
      </Section>
      <HowItCounts />
    </>
  );
}

/**
 * The verdict of the period (spec §4.4): one line, 16 px — money with its
 * change, per hour, and how the person answers and writes, the average per
 * shift by the review's rules. Under it one quiet line: what the change is
 * against. D14: only the three terms that need a definition are dotted; the
 * note about the money is a plain hint on the sum. E1: under a page filter the
 * money says its page and the averages say they are of every page.
 */
function Verdict({ work, quality, failed, username }: { work: PeriodWork; quality: PeriodQuality | null | undefined; failed: boolean; username: string }) {
  const { period } = usePeriod();
  const { page } = usePageFilter();
  const versus = versusTitle(period);
  /** The one rule of a change (D13): calm better / worse colours, «было $X» / «впервые» at a small base. `base`: the money behind a rate. */
  const change = (current: number | null, previous: number | null | undefined, base?: number | null) => {
    if (work.previous === null || previous === null || previous === undefined) return null;
    if (readDelta(current ?? 0, previous, { base }).kind === "none") return null;
    return <span className="people-verdict__change">(<Delta current={current ?? 0} previous={previous} base={base} title={versus} />)</span>;
  };
  const pending = quality === undefined && !failed;
  const number = (text: string) => (pending ? <Skeleton width={56} height={16} /> : <b>{text}</b>);
  const term = (key: "reply" | "unanswered" | "aiUnedited", words: string) => <Hint content={<>{METRICS[key].hint} {PER_SHIFT_HINT}</>}>{words}</Hint>;
  const within = quality && quality.replies > 0 ? quality.repliesWithinHour / quality.replies : null;
  const money = <b><Money mills={work.salesNetMills} /></b>;
  const sales = work.overlapNetMills > 0
    ? <Tooltip content={`Из них ${formatMills(work.overlapNetMills)} видны и у коллег: страницу вели двое, а этим фанам никто из них не писал.`}><span>{money}</span></Tooltip>
    : money;

  const notes = [
    work.previous === null
      ? `Сравнить не с чем: за ${period.previousLabel} у Hub нет всей работы ${username}.`
      : sentence(`В скобках — изменение ${versus}`),
    // «99 % быстрее часа» says nothing; only a slip is news.
    within !== null && within < 0.95 ? `${formatPercent(within * 100)} ответов — быстрее часа.` : null,
  ].filter(Boolean).join(" ");

  return (
    <section className="people-verdict" aria-label={`Итог ${periodWords(period)}`}>
      <p className="people-verdict__line">
        <span className="people-verdict__group">
          <span className="people-verdict__part">
            {sales}
            {change(work.salesNetMills, work.previous?.salesNetMills)}
            {" "}за {work.shifts} {ruPlural(work.shifts, "смену", "смены", "смен")}{page ? <> на <span className="people-verdict__page">{page}</span></> : null}, <Duration minutes={work.workedMinutes} />
          </span>
          <Sep />
          <span className="people-verdict__part">
            <b><Money mills={work.perHourMills} /></b> в час{change(work.perHourMills, work.previous?.perHourMills, work.previous?.salesNetMills)}
          </span>
        </span>
        <span className="people-verdict__group">
          {page ? "В среднем за смену, по всем страницам: " : "В среднем за смену: "}
          <span className="people-verdict__part">{term("reply", METRICS.reply.label.toLowerCase())} {number(quality ? formatReplyMedian(quality.replyMedianSeconds) : "—")}</span>
          <Sep />
          <span className="people-verdict__part">{term("unanswered", METRICS.unanswered.label.toLowerCase())} {number(quality ? formatUnanswered(quality.unansweredAtEnd, { average: true }) : "—")}</span>
          <Sep />
          <span className="people-verdict__part">{term("aiUnedited", METRICS.aiUnedited.label)} {number(quality ? formatAiUnedited(quality.aiUneditedShare) : "—")}</span>
        </span>
      </p>
      {notes && <p className="people-verdict__note">{notes}</p>}
    </section>
  );
}

function Sep(): ReactNode {
  return <span className="people-verdict__sep" aria-hidden> · </span>;
}

/** Under the table: work outside shifts; what the shift reports confirmed, once anyone confirms; the page filter's caveat. */
function Below({ card, userId }: { card: PersonCard; userId: number }) {
  const { period, today } = usePeriod();
  const location = useLocation();
  const { stats, inPeriod } = usePersonStats(userId, period, today);
  const { page } = usePageFilter();
  const lines: ReactNode[] = [];

  if (card.visits.length > 0) {
    const minutes = card.visits.reduce((sum, visit) => sum + visit.workedMinutes, 0);
    lines.push(
      <p key="visits" className="people-note">
        Вне смен: {card.visits.length} {ruPlural(card.visits.length, "раз", "раза", "раз")}, {formatDuration(minutes)}. Это меньше смены
        (от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений): в таблицу и в продажи не входит.
      </p>,
    );
  }

  // The shift reports (week 4): shown only once someone confirms a shift — today nobody does.
  const reported = (stats?.shifts ?? []).filter((shift) => inPeriod(shift.date));
  const confirmed = reported.filter((shift) => shift.confirmedNetMills !== null);
  if (confirmed.length > 0) {
    const now = Date.now();
    const waiting = reported.filter((shift) => !shift.ongoing && shift.confirmedNetMills === null && now - Date.parse(shift.startedAt) <= SHIFT_REPORT_MAX_DAYS * 86_400_000).length;
    const sum = millsToNumber(sumMills(confirmed.map((shift) => shift.confirmedNetMills ?? 0)));
    const params = carryParams(location.search).toString();
    lines.push(
      <div key="reports" className="people-idle">
        <span>
          Подтверждено к выплате{page ? " по всем страницам" : ""}: <span className="people-meta__strong">{formatMills(sum)}</span> за {confirmed.length} {ruPlural(confirmed.length, "смену", "смены", "смен")}
          {waiting > 0 && <> · ждут подтверждения: {waiting}</>}
        </span>
        <Link className="people-link" to={`/payouts${params ? `?${params}` : ""}`}>Открыть выплаты →</Link>
      </div>,
    );
  }
  if (page) {
    lines.push(
      <p key="page" className="people-note">
        Фильтр {page} сужает смены и продажи. {METRICS.reply.label}, без ответа к концу и ИИ без правки — по всей смене: Hub пока не делит их по
        страницам.
      </p>,
    );
  }
  if (lines.length === 0) return null;
  return <div className="people-aside people-aside--below">{lines}</div>;
}

function HowItCounts() {
  return (
    <Disclosure summary="Как это считается">
      <div className="people-help">
        <p>
          Смена — работа в расширении под своим входом: от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений,
          конец — час без действий. Ночная смена подписана обоими днями («вс, 1–2 нояб. 21:00–05:49»), а в сетке «Смен» и в
          выплатах стоит в дне, где прошла большая её часть. Длительность — время работы без пауз.
        </p>
        <p>Продажи — деньги после комиссии площадки на страницах, где человек писал в смене. Это ориентир, а не основание для оплаты.</p>
        <p><b>{METRICS.reply.label}.</b> {METRICS.reply.hint}</p>
        <p><b>{METRICS.unanswered.label}.</b> {METRICS.unanswered.hint}</p>
        <p><b>{METRICS.aiUnedited.label}.</b> {METRICS.aiUnedited.hint}</p>
        <p>{PER_SHIFT_HINT}</p>
      </div>
    </Disclosure>
  );
}

/** A period without shifts, said for the person's state: not signed up yet, switched off, or simply not working. */
function NoShifts({ card }: { card: PersonCard }) {
  const { period, setPeriod } = usePeriod();
  const { isOwner } = useMe();
  const location = useLocation();
  const person = card.person!;
  const before = person.work?.previous ?? null;
  const toAccess = isOwner ? <LinkButton to={personPath(person.userId, location.search, "access")}>Доступ</LinkButton> : undefined;
  const longer = period.spec.kind !== "days" || period.days < 30
    ? <Button onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать 30 дней</Button>
    : undefined;
  if (person.state === "invited") {
    return (
      <Card>
        <EmptyState title="Приглашение ещё не принято" action={toAccess}>
          Когда {person.username} задаст пароль по ссылке и поработает в расширении, здесь появятся смены.
        </EmptyState>
      </Card>
    );
  }
  const earlier = before && before.shifts > 0
    ? `До этого, ${period.previousLabel}: ${before.shifts} ${ruPlural(before.shifts, "смена", "смены", "смен")}, продажи ${formatMills(before.salesNetMills)}.`
    : `Смена — работа в расширении под своим входом: от ${formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и ${CHATTER_SHIFT_MIN_MESSAGES} сообщений.`;
  if (person.state === "disabled") {
    return (
      <Card>
        <EmptyState title={`${capitalized(periodWords(period))} смен не было: доступ отключён`} action={longer}>{earlier}</EmptyState>
      </Card>
    );
  }
  return (
    <Card>
      <EmptyState title={`${capitalized(periodWords(period))} смен не было`} action={longer}>{earlier}</EmptyState>
    </Card>
  );
}

function WorkSkeleton({ card, userId, canOpen }: { card: PersonCard; userId: number; canOpen: boolean }) {
  return (
    <>
      <section className="people-verdict" aria-busy>
        <p className="people-verdict__line"><Skeleton width={720} height={20} /></p>
        <p className="people-verdict__note"><Skeleton width={480} /></p>
      </section>
      <Section title="Смены по часам" description="Время московское.">
        <Card>
          <div className="people-ribbon-skeleton" aria-hidden>
            {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} width="100%" height={20} />)}
          </div>
        </Card>
      </Section>
      <Section title="Смены">
        <ShiftTable card={{ ...card, main: "loading" }} userId={userId} canOpen={canOpen} />
      </Section>
    </>
  );
}
