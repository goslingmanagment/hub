import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES } from "@agency_hub_core/contracts";
import { Button, Card, Count, Delta, Disclosure, Duration, EmptyState, Facts, LinkButton, Money, Skeleton, type FactItem } from "@agency_hub_core/ui";
import { formatDuration, formatMills } from "@agency_hub_core/ui/format";
import { addDays } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath } from "@/shared/links";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { changePct, type PersonCard, type PeriodQuality } from "./data.js";
import { ShiftRibbon } from "./ShiftRibbon.js";
import { SlowFailed } from "./SlowFailed.js";
import { capitalized, dayWords, periodWords, replyText, shareOf, shareText, versusTitle } from "./words.js";

/**
 * «Работа» (spec §4.4): the verdict of the period in one strip — money and its
 * change, per hour, shifts, how fast the person answers, who was left waiting
 * at the end, how much the AI wrote — and the shifts by the hour, each bar
 * opening its review.
 */
export function WorkTab({ card, userId }: { card: PersonCard; userId: number }) {
  const { period, today } = usePeriod();
  const { page } = usePageFilter();
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

  if (card.main === "loading" || !person || !work) return <WorkSkeleton />;

  if (work.shifts === 0) return <NoShifts card={card} />;

  const versus = versusTitle(period);
  const quality = person.quality;
  const change = (current: number | null, previous: number | null | undefined) => (work.previous === null
    ? <span className="people-dash">не с чем сравнить</span>
    : <Delta pct={changePct(current, previous)} title={versus} />);
  const items: FactItem[] = [
    {
      label: "Продажи",
      value: <Money mills={work.salesNetMills} />,
      meta: change(work.salesNetMills, work.previous?.salesNetMills),
      strong: true,
    },
    {
      label: "В час",
      value: <Money mills={work.perHourMills} />,
      meta: change(work.perHourMills, work.previous?.perHourMills),
    },
    {
      label: ruPlural(work.shifts, "Смена", "Смены", "Смен"),
      value: <Count value={work.shifts} />,
      meta: <><Duration minutes={work.workedMinutes} /> работы</>,
    },
    ...qualityFacts(quality, card.quality === "failed"),
  ];

  return (
    <>
      {card.quality === "failed" && <SlowFailed onRetry={card.retryQuality} />}
      <section className="people-verdict" aria-label="Итог периода">
        <Facts layout="stacked" items={items} label={`Итог ${periodWords(period)}`} />
        <p className="people-verdict__note">
          {work.previous === null
            ? `Сравнить не с чем: за ${period.previousLabel} у Hub нет всей работы ${person.username}.`
            : `Изменения — ${versus}.`}
          {page && ` Ответ, «без ответа в конце» и доля ИИ — по всем страницам: Hub пока не делит их по страницам.`}
          {work.overlapNetMills > 0 && ` Из продаж ${formatMills(work.overlapNetMills)} видны и у коллег: страницу вели двое, а этим фанам никто из них не писал.`}
        </p>
      </section>
      <Card title="Смены по часам" description="Время московское. Нажмите на смену — откроется её разбор.">
        <ShiftRibbon
          userId={userId}
          backLabel={person.username}
          shifts={card.shifts}
          visits={card.visits}
          days={days}
          unknownBefore={unknownBefore}
          salesRead={card.salesRead}
          today={today}
        />
      </Card>
      <Disclosure summary="Как это считается">
        <div className="people-help">
          <p>
            Смена — работа в расширении под своим входом: от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений,
            конец — час без действий. Смена относится к дню, на который пришлась большая её часть.
          </p>
          <p>Продажи — деньги после комиссии площадки на страницах, где человек писал в смене. Это ориентир, а не основание для оплаты.</p>
          <p>
            Ответ, медиана — половина ответов ждущим фанам быстрее этого. Без ответа в конце — сколько фанов ждали ответа, когда смена
            кончилась. Доля ИИ — сообщения, написанные кнопками Reply и Fix.
          </p>
        </div>
      </Disclosure>
    </>
  );
}

function qualityFacts(quality: PeriodQuality | null | undefined, failed: boolean): FactItem[] {
  const pending = quality === undefined && !failed;
  const value = (text: ReactNode) => (pending ? <Skeleton width={72} height={28} /> : text);
  const within = quality ? shareOf(quality.repliesWithinHour, quality.replies) : null;
  const composed = quality?.composed;
  return [
    {
      label: "Ответ, медиана",
      value: value(quality ? replyText(quality.replyMedianSeconds) : "—"),
      meta: pending ? undefined : within === null ? "ответов не было" : `за час — ${shareText(within)}`,
      title: "Половина ответов ждущим фанам — быстрее этого",
    },
    {
      label: "Без ответа в конце",
      value: value(quality ? quality.waitingAtEnd : "—"),
      meta: pending ? undefined : "в среднем за смену",
      title: "Сколько фанов ждали ответа, когда смена кончилась",
    },
    {
      label: "Доля ИИ",
      value: value(quality ? shareText(quality.aiShare) : "—"),
      meta: pending || !composed || !quality || quality.messages === 0
        ? undefined
        : `Reply ${shareText(shareOf(composed.reply, quality.messages))} · Fix ${shareText(shareOf(composed.fix, quality.messages))}`,
      title: "Сообщения, написанные кнопками Reply и Fix расширения, из всех",
    },
  ];
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

function WorkSkeleton() {
  return (
    <>
      <section className="people-verdict" aria-busy>
        <Facts
          layout="stacked"
          items={Array.from({ length: 6 }, () => ({ label: <Skeleton width={96} />, value: <Skeleton width={96} height={28} />, meta: <Skeleton width={120} /> }))}
        />
      </section>
      <Card title="Смены по часам" description="Время московское. Нажмите на смену — откроется её разбор.">
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }} aria-hidden>
          {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} width="100%" height={20} />)}
        </div>
      </Card>
    </>
  );
}
