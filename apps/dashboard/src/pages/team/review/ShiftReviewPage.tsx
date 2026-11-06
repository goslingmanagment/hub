import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useTeamShiftReview, useTeamShifts } from "@/api/team";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatCount, formatDuration, formatMills, formatPercent, formatSeconds } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { shiftSpan } from "@/pages/team/TeamShiftsPage";
import { ChatterLink, PageLink } from "@/pages/team/teamLinks";
import { ShiftChats } from "./ShiftChats.js";
import { ShiftPulse } from "./ShiftPulse.js";
import { PICK_MINUTES, REPLY_NORM_SECONDS, myMessages, pulseOf, silences, summariesOf, totalsOf } from "./shiftReviewView.js";

/**
 * Команда → Смены → «Разбор смены» (owner, 2026-11-06): one chatter's shift
 * opened up. Its pulse minute by minute, every chat it touched with the whole
 * transcript, and for each message where its text came from. Facts, not
 * grades. `?user=&at=` names the shift; without them the screen lists the
 * shifts of the last two days to choose from.
 */

const MINUTE_MS = 60_000;
const PICKER_HOURS = 48;
/** A stretch without one message this long is listed under the pulse. */
const SILENCE_MINUTES = 20;

export function reviewHref(userId: number, at: string): string {
  return `/team/review?${new URLSearchParams({ user: String(userId), at }).toString()}`;
}

function ShiftPicker() {
  const [now] = useState(() => Date.now());
  const params = useMemo(() => ({ from: new Date(now - PICKER_HOURS * 3_600_000).toISOString(), to: new Date(now).toISOString() }), [now]);
  const query = useTeamShifts(params);
  const shifts = query.data?.shifts ?? [];
  return (
    <div className="team-screen">
      <PageHeader description="Выберите смену: пульс по минутам, все чаты с перепиской и откуда взят текст каждого сообщения." />
      <section className="card" aria-labelledby="review-pick">
        <header className="card-header"><h2 id="review-pick" className="card-title">Смены за двое суток</h2></header>
        {query.isLoading ? <TableSkeleton rows={6} columns={4} /> : query.isError ? <NoAnswerPanel retry={query.refetch} /> : shifts.length === 0 ? (
          <div className="empty"><p className="empty-title">За двое суток смен не было</p></div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Чаттер</th>
                  <th scope="col">Смена</th>
                  <th scope="col">Страницы</th>
                  <th scope="col" className="num">Сообщения</th>
                  <th scope="col"><span className="sr-only">Разбор</span></th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((shift) => (
                  <tr key={`${shift.userId}:${shift.startedAt}`}>
                    <td><ChatterLink userId={shift.userId} username={shift.username} /></td>
                    <td className="whitespace-nowrap">{shiftSpan(shift)}</td>
                    <td>{shift.pages.filter((page) => page.messages > 0).map((page, index) => <span key={page.pageLabel}>{index > 0 && ", "}<PageLink label={page.pageLabel} /></span>)}</td>
                    <td className="num">{formatCount(shift.authoredMessages)}</td>
                    <td><Link to={reviewHref(shift.userId, shift.startedAt)} className="btn btn-sm">Разобрать</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function ShiftReviewPage() {
  const [search] = useSearchParams();
  const user = Number(search.get("user"));
  const at = search.get("at");
  const params = Number.isInteger(user) && user > 0 && at !== null && !Number.isNaN(Date.parse(at)) ? { userId: user, at } : null;
  if (params === null) return <ShiftPicker />;
  return <ShiftReview key={`${params.userId}:${params.at}`} userId={params.userId} at={params.at} />;
}

function ShiftReview({ userId, at }: { userId: number; at: string }) {
  const query = useTeamShiftReview({ userId, at });
  const [picked, setPicked] = useState<number | null>(null);
  const data = query.data;
  const derived = useMemo(() => {
    if (!data) return null;
    const mine = myMessages(data);
    const pulse = pulseOf(data);
    return { mine, pulse, totals: totalsOf(data, mine), summaries: summariesOf(data), silent: silences(pulse, SILENCE_MINUTES) };
  }, [data]);

  const back = <Link to="/team/review" className="btn">Другая смена</Link>;
  if (query.isLoading) {
    return <div className="team-screen" aria-busy="true"><PageHeader actions={back} /><TableSkeleton rows={8} columns={4} /></div>;
  }
  if (query.isError || !data || !derived) {
    const missing = (query.error as { status?: number } | null)?.status === 404;
    return (
      <div className="team-screen">
        <PageHeader actions={back} />
        {missing
          ? <StatusPanel title="Смены нет" description="В это время у этого человека не было смены в расширении." action={<Link to="/team/review" className="btn btn-sm">К списку смен</Link>} />
          : <NoAnswerPanel retry={query.refetch} />}
      </div>
    );
  }

  const { shift } = data;
  const { totals, pulse, summaries, silent } = derived;
  const start = Date.parse(shift.startedAt);
  const end = Date.parse(shift.endedAt);
  const pauses = shift.pauses.map((pause) => ({ from: Date.parse(pause.from), to: Date.parse(pause.to) }));
  const pickedRange = picked === null ? null : { from: picked - PICK_MINUTES * MINUTE_MS, to: picked + PICK_MINUTES * MINUTE_MS };
  const withText = totals.origin.ai + totals.origin.fix + totals.origin.own;
  const share = (part: number) => (withText === 0 ? "—" : formatPercent((100 * part) / withText));

  const actions = (
    <>
      {data.previousAt && <Link to={reviewHref(userId, data.previousAt)} className="btn">← Прошлая смена</Link>}
      {data.nextAt && <Link to={reviewHref(userId, data.nextAt)} className="btn">Следующая →</Link>}
      {back}
    </>
  );

  return (
    <div className="team-screen">
      <PageHeader actions={actions} fresh={{ at: query.dataUpdatedAt, onRefresh: () => void query.refetch(), refreshing: query.isFetching }} />
      <div className="sr-who">
        <h2 className="sr-who-name"><ChatterLink userId={userId} username={shift.username} /></h2>
        <p className="sr-who-line">
          {shiftSpan(shift)}
          {" · "}{shift.pages.map((page, index) => <span key={page.pageLabel}>{index > 0 && ", "}<PageLink label={page.pageLabel} /></span>)}
          {" · "}отработано {formatDuration(shift.workedMinutes)}
          {shift.kind === "visit" && " · это заход, не смена"}
        </p>
      </div>

      <StatGrid>
        <Stat
          label="Сообщений фанам"
          value={formatCount(totals.messages)}
          meta={<>в {formatCount(totals.chats)} {ruPlural(totals.chats, "чате", "чатах", "чатах")}{totals.perHour !== null && <> · {totals.perHour.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} в час</>}{totals.massMessages > 0 && <> · рассылкой ещё {formatCount(totals.massMessages)}</>}</>}
        />
        <Stat
          label="Ответ фану, медиана"
          value={totals.replyMedianSeconds === null ? "—" : formatSeconds(totals.replyMedianSeconds)}
          meta={totals.replies === 0 ? "ответов не было" : (
            <>до {REPLY_NORM_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinNorm) / totals.replies)} из {formatCount(totals.replies)}{totals.longestReplySeconds !== null && <> · дольше всех {formatSeconds(totals.longestReplySeconds)}</>}</>
          )}
        />
        <Stat
          label="Остались без ответа"
          value={formatCount(totals.unanswered)}
          meta={<>написали в смену, ответа до конца не было{totals.inherited > 0 && <> · с прошлых смен ждали {formatCount(totals.inherited)}, ответили {formatCount(totals.inheritedAnswered)}</>}</>}
        />
        <Stat
          label="Текст из ИИ"
          value={share(totals.origin.ai)}
          meta={<>{formatCount(totals.origin.ai)} сообщ.{totals.origin.copied > 0 && <>, из них мимо кнопки {formatCount(totals.origin.copied)}</>} · Fix своего {share(totals.origin.fix)} · сам {share(totals.origin.own)}</>}
        />
      </StatGrid>
      <StatGrid>
        <Stat
          label="Фаны писали"
          value={formatCount(totals.fansWrote)}
          meta={<>{ruPlural(totals.fansWrote, "чат", "чата", "чатов")}, {formatCount(totals.fanMessages)} {ruPlural(totals.fanMessages, "сообщение", "сообщения", "сообщений")}</>}
        />
        <Stat
          label="Паузы"
          value={shift.pauses.length === 0 ? "—" : formatDuration(pauses.reduce((sum, pause) => sum + Math.round((pause.to - pause.from) / MINUTE_MS), 0))}
          meta={<>{formatCount(shift.pauses.length)} {ruPlural(shift.pauses.length, "пауза", "паузы", "пауз")}{silent.length > 0 && <> · без сообщений {SILENCE_MINUTES}+ мин: {formatCount(silent.length)} раз</>}</>}
        />
        <Stat
          label="Повторы и метки"
          value={formatCount(totals.repeated)}
          meta={<>сообщений, чей текст ушёл и другим фанам{totals.marked > 0 && <> · с метками (тире, кириллица, служебный текст) {formatCount(totals.marked)}</>}</>}
        />
        <Stat
          label="PPV и деньги"
          value={`${formatCount(totals.ppvBought)} / ${formatCount(totals.ppvSent)}`}
          meta={<>куплено из отправленных · фаны смены принесли {formatMills(totals.shiftNetMills)}</>}
        />
      </StatGrid>

      <section className="card" aria-labelledby="review-pulse">
        <header className="card-header">
          <h2 id="review-pulse" className="card-title">Пульс смены</h2>
          {silent.length > 0 && (
            <p className="card-description">
              Без сообщений: {silent.slice(0, 4).map((one, index) => (
                <span key={one.from}>{index > 0 && ", "}<button type="button" className="link" onClick={() => setPicked(one.from + (one.to - one.from) / 2)}>{formatDuration(one.minutes)}</button></span>
              ))}{silent.length > 4 && ` и ещё ${silent.length - 4}`}
            </p>
          )}
        </header>
        <div className="card-body">
          <ShiftPulse pulse={pulse} start={start} end={end} pauses={pauses} picked={picked} onPick={setPicked} />
        </div>
      </section>

      <section className="card" aria-labelledby="review-chats">
        <header className="card-header">
          <h2 id="review-chats" className="card-title">Чаты смены</h2>
          <p className="card-description">
            Клик по пометке у сообщения показывает ближайший текст ИИ и черновик. «ИИ» — 70 % слов и больше взяты из текста ИИ этого чата.
            {data.unarchived > 0 && ` ${formatCount(data.unarchived)} сообщ. ещё нет в архиве — их нет и здесь.`}
          </p>
        </header>
        <div className="card-body">
          <ShiftChats data={data} summaries={summaries} picked={pickedRange} onClearPick={() => setPicked(null)} />
        </div>
      </section>
    </div>
  );
}
