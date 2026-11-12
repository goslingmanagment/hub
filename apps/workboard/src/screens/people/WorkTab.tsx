import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES } from "@agency_hub_core/contracts";
import { Button, Card, Delta, Disclosure, Duration, EmptyState, LinkButton, Money, Section, Skeleton, Tooltip, readDelta } from "@agency_hub_core/ui";
import { formatDuration, formatMills, formatPercent } from "@agency_hub_core/ui/format";
import { addDays } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath } from "@/shared/links";
import { formatAiUnedited, formatReplyMedian, formatUnanswered, METRICS, PER_SHIFT_HINT } from "@/shared/metrics";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { type PeriodQuality, type PeriodWork, type PersonCard } from "./data.js";
import { ShiftRibbon } from "./ShiftRibbon.js";
import { ShiftTable } from "./ShiftTable.js";
import { Tiles, TilesSkeleton, type Tile } from "@/shared/Tiles";
import { SlowFailed } from "./SlowFailed.js";
import { capitalized, dayWords, periodWords, versusTitle } from "./words.js";

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
        description={isOwner ? "Время московское. Нажмите на смену, чтобы открыть её разбор." : "Время московское."}
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
      <Section title="Смены" {...(isOwner ? { description: "Числа каждой смены те же, что в её разборе." } : {})}>
        <ShiftTable card={card} userId={userId} canOpen={isOwner} />
        <Below card={card} />
      </Section>
      <HowItCounts />
    </>
  );
}

/**
 * The verdict of the period (spec §4.4) as the review's row of numbers: money
 * and per hour with their change under them, the shifts and the time worked,
 * then how the person answers and writes — the average per shift by the
 * review's rules. Each definition, what the change is against and the page
 * filter's caveat are in the tile's hint, not on the page.
 */
function Verdict({ work, quality, failed, username }: { work: PeriodWork; quality: PeriodQuality | null | undefined; failed: boolean; username: string }) {
  const { period } = usePeriod();
  const { page } = usePageFilter();
  const versus = versusTitle(period);
  /** The one rule of a change (D13): calm better / worse colours, «было $X» / «впервые» at a small base. `base`: the money behind a rate. */
  const change = (current: number | null, previous: number | null | undefined, base?: number | null) => {
    if (work.previous === null || previous === null || previous === undefined) return undefined;
    if (readDelta(current ?? 0, previous, { base }).kind === "none") return undefined;
    return <Delta current={current ?? 0} previous={previous} base={base} title={versus} />;
  };
  const pending = quality === undefined && !failed;
  const number = (text: string) => (pending ? <Skeleton width={72} height={24} radius={6} /> : text);
  const within = quality && quality.replies > 0 ? quality.repliesWithinHour / quality.replies : null;
  const against = work.previous === null ? `Сравнить не с чем: за ${period.previousLabel} у Hub нет всей работы ${username}.` : `Под числом изменение ${versus}.`;
  const allPages = page ? " По всей смене, на всех её страницах." : "";
  const tiles: Tile[] = [
    {
      label: page ? `Продажи, ${page}` : "Продажи",
      value: <Money mills={work.salesNetMills} />,
      sub: change(work.salesNetMills, work.previous?.salesNetMills),
      hint: [
        "Продажи после комиссии на страницах, где человек писал в смену.",
        work.overlapNetMills > 0 ? `Из них ${formatMills(work.overlapNetMills)} видны и у коллег: страницу вели двое, а этим фанам никто из них не писал.` : "",
        against,
      ].filter(Boolean).join(" "),
    },
    {
      label: "В час",
      value: <Money mills={work.perHourMills} />,
      sub: change(work.perHourMills, work.previous?.perHourMills, work.previous?.salesNetMills),
      hint: `Продажи на отработанное время без пауз. ${against}`,
    },
    {
      label: "Смен",
      value: String(work.shifts),
      sub: <Duration minutes={work.workedMinutes} />,
      hint: "Смены периода и время работы в них без пауз.",
    },
    {
      label: METRICS.reply.label,
      value: number(quality ? formatReplyMedian(quality.replyMedianSeconds) : "—"),
      sub: "в среднем за смену",
      hint: [METRICS.reply.hint, PER_SHIFT_HINT, within !== null && within < 0.95 ? `${formatPercent(within * 100)} ответов быстрее часа.` : "", allPages].filter(Boolean).join(" "),
    },
    {
      label: METRICS.unanswered.label,
      value: number(quality ? formatUnanswered(quality.unansweredAtEnd, { average: true }) : "—"),
      sub: "в среднем за смену",
      hint: [METRICS.unanswered.hint, PER_SHIFT_HINT, allPages].filter(Boolean).join(" "),
    },
    {
      label: METRICS.aiUnedited.label,
      value: number(quality ? formatAiUnedited(quality.aiUneditedShare) : "—"),
      sub: "в среднем за смену",
      hint: [METRICS.aiUnedited.hint, PER_SHIFT_HINT, allPages].filter(Boolean).join(" "),
    },
  ];
  return (
    <section className="people-verdict" aria-label={`Итог ${periodWords(period)}`}>
      <Tiles tiles={tiles} label={`Итог ${periodWords(period)}`} />
    </section>
  );
}

/** Under the table: work outside shifts; the page filter's caveat. */
function Below({ card }: { card: PersonCard }) {
  const { page } = usePageFilter();
  const lines: ReactNode[] = [];

  if (card.visits.length > 0) {
    const minutes = card.visits.reduce((sum, visit) => sum + visit.workedMinutes, 0);
    lines.push(
      <p key="visits" className="people-note">
        <Tooltip content={`Работа меньше смены (от ${formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и ${CHATTER_SHIFT_MIN_MESSAGES} сообщений): в таблицу и в продажи не входит. На ленте это тонкая линия.`} align="start">
          <span>Вне смен: {card.visits.length} {ruPlural(card.visits.length, "раз", "раза", "раз")}, {formatDuration(minutes)}</span>
        </Tooltip>
      </p>,
    );
  }

  if (page) {
    lines.push(
      <p key="page" className="people-note">
        Фильтр {page} сужает смены и продажи. {METRICS.reply.label}, без ответа к концу и ИИ без правки считаются по всей смене: Hub пока не делит их по
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
          Смена: работа в расширении под своим входом, от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений,
          конец после часа без действий. Ночная смена подписана обоими днями («вс, 1–2 нояб. 21:00–05:49»), а в сетке «Смен» и в
          выплатах стоит в дне, где прошла большая её часть. Длительность: время работы без пауз.
        </p>
        <p>Продажи: деньги после комиссии площадки на страницах, где человек писал в смене. Это ориентир, а не основание для оплаты.</p>
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
    : `Смена: работа в расширении под своим входом, от ${formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и ${CHATTER_SHIFT_MIN_MESSAGES} сообщений.`;
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
        <TilesSkeleton sub />
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
