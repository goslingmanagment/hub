import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useTeamShiftReview, useTeamShifts } from "@/api/team";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatCount, formatDuration, formatMills, formatPercent, formatSeconds, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { shiftSpan } from "@/pages/team/TeamShiftsPage";
import { ChatterLink, PageLink } from "@/pages/team/teamLinks";
import { ShiftChats, type ChatsView } from "./ShiftChats.js";
import { ShiftPulse } from "./ShiftPulse.js";
import {
  CHAT_KINDS,
  CHAT_SHOWS,
  CHAT_SORTS,
  PICK_MINUTES,
  REPLY_FAST_SECONDS,
  REPLY_NORM_SECONDS,
  myMessages,
  pulseOf,
  silences,
  summariesOf,
  totalsOf,
  type ChatKindFilter,
  type ChatShow,
  type ChatSort,
} from "./shiftReviewView.js";

/**
 * Команда → Смены → «Разбор смены» (owner, 2026-11-06): one chatter's shift
 * opened up. Its pulse minute by minute, every chat it touched with the whole
 * transcript, and for each message where its text came from. Facts, not
 * grades. `?user=&at=` names the shift; without them the screen lists the
 * shifts of the last week to choose from. What is chosen on the screen — the
 * chat, the list's filters and order, the picked minutes — is in the address
 * too, so a link opens the same place.
 */

const MINUTE_MS = 60_000;
/** The team shifts endpoint reads at most a week. */
const PICKER_HOURS = 7 * 24;
/** A stretch without one message this long is listed under the pulse. */
const SILENCE_MINUTES = 20;

export function reviewHref(userId: number, at: string, keep?: URLSearchParams): string {
  const params = new URLSearchParams({ user: String(userId), at });
  for (const key of ["kind", "show", "sort"]) {
    const value = keep?.get(key);
    if (value) params.set(key, value);
  }
  return `/team/review?${params.toString()}`;
}

function oneOf<T extends string>(values: readonly T[], value: string | null, fallback: T): T {
  return value !== null && (values as readonly string[]).includes(value) ? value as T : fallback;
}

const VIEW_DEFAULTS = { kind: "dialog", show: "all", sort: "messages" } as const;

function ShiftPicker() {
  const [now] = useState(() => Date.now());
  const params = useMemo(() => ({ from: new Date(now - PICKER_HOURS * 3_600_000).toISOString(), to: new Date(now).toISOString() }), [now]);
  const query = useTeamShifts(params);
  const shifts = query.data?.shifts ?? [];
  return (
    <div className="team-screen">
      <PageHeader description="Выберите смену: пульс по минутам, все чаты с перепиской и откуда взят текст каждого сообщения." />
      <section className="card" aria-labelledby="review-pick">
        <header className="card-header"><h2 id="review-pick" className="card-title">Смены за неделю</h2></header>
        {query.isLoading ? <TableSkeleton rows={6} columns={4} /> : query.isError ? <NoAnswerPanel retry={query.refetch} /> : shifts.length === 0 ? (
          <div className="empty"><p className="empty-title">За неделю смен не было</p></div>
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
  const [search, setSearch] = useSearchParams();
  const data = query.data;
  const derived = useMemo(() => {
    if (!data) return null;
    const mine = myMessages(data);
    const pulse = pulseOf(data);
    const summaries = summariesOf(data);
    return { mine, pulse, totals: totalsOf(data, mine, summaries), summaries, silent: silences(pulse, SILENCE_MINUTES) };
  }, [data]);

  /** Writes the chosen view into the address; a default value leaves the address. */
  const update = useCallback((change: Record<string, string | null>) => {
    setSearch((before) => {
      const next = new URLSearchParams(before);
      for (const [key, value] of Object.entries(change)) {
        if (value === null || value === (VIEW_DEFAULTS as Record<string, string>)[key]) next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace: true });
  }, [setSearch]);

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
  const pauseMinutes = pauses.reduce((sum, pause) => sum + Math.round((pause.to - pause.from) / MINUTE_MS), 0);

  // `pick=<from>-<to>`: minutes from the shift's start.
  const pickMatch = /^(\d+)-(\d+)$/.exec(search.get("pick") ?? "");
  const picked = pickMatch === null ? null : {
    from: Math.max(start, start + Number(pickMatch[1]) * MINUTE_MS),
    to: Math.min(end, start + Number(pickMatch[2]) * MINUTE_MS),
  };
  const pickedRange = picked !== null && picked.from < picked.to ? picked : null;
  const setPicked = (range: { from: number; to: number } | null) => update({
    pick: range === null ? null : `${Math.max(0, Math.floor((range.from - start) / MINUTE_MS))}-${Math.ceil((range.to - start) / MINUTE_MS)}`,
  });
  const pickAround = (minute: number) => setPicked({ from: Math.max(start, minute - PICK_MINUTES * MINUTE_MS), to: Math.min(end, minute + PICK_MINUTES * MINUTE_MS) });

  const pageParam = search.get("page");
  const view: ChatsView = {
    chat: search.get("chat"),
    kind: oneOf<ChatKindFilter>(CHAT_KINDS, search.get("kind"), VIEW_DEFAULTS.kind),
    show: oneOf<ChatShow>(CHAT_SHOWS, search.get("show"), VIEW_DEFAULTS.show),
    sort: oneOf<ChatSort>(CHAT_SORTS, search.get("sort"), VIEW_DEFAULTS.sort),
    page: shift.pages.some((page) => page.pageLabel === pageParam) ? pageParam : null,
  };
  const onView = (change: Partial<ChatsView>) => update(change as Record<string, string | null>);
  const showChats = (change: Partial<ChatsView>) => {
    onView(change);
    document.getElementById("review-chats")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  // Hi greetings are not replies in a conversation: the share is of the rest.
  const withText = totals.origin.ai + totals.origin.fix + totals.origin.own;
  const share = (part: number) => (withText === 0 ? "—" : formatPercent((100 * part) / withText));
  const inheritedWaiting = totals.inherited - totals.inheritedAnswered;

  const actions = (
    <>
      {data.previousAt && <Link to={reviewHref(userId, data.previousAt, search)} className="btn">← Прошлая смена</Link>}
      {data.nextAt && <Link to={reviewHref(userId, data.nextAt, search)} className="btn">Следующая →</Link>}
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
          {pauseMinutes > 0 && <> · паузы {formatDuration(pauseMinutes)}</>}
          {totals.ppvSent > 0 && <> · PPV куплено {formatCount(totals.ppvBought)} из {formatCount(totals.ppvSent)}</>}
          {totals.shiftNetMills > 0 && <> · фаны смены принесли {formatMills(totals.shiftNetMills)}</>}
          {shift.kind === "visit" && " · это заход, не смена"}
        </p>
      </div>

      <StatGrid>
        <Stat
          label="Сообщений фанам"
          value={formatCount(totals.messages)}
          meta={<>
            в {formatCount(totals.chats)} {ruPlural(totals.chats, "чате", "чатах", "чатах")}
            {totals.touches > 0 && <>, из них в {formatCount(totals.touches)} — только его сообщение</>}
            {" · "}фаны писали в {formatCount(totals.fansWrote)}
            {totals.perHour !== null && <> · {totals.perHour.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} в час</>}
            {totals.massMessages > 0 && <> · рассылкой ещё {formatCount(totals.massMessages)}</>}
          </>}
        />
        <Stat
          label="Ответ фану, медиана"
          value={totals.replyMedianSeconds === null ? "—" : formatSeconds(totals.replyMedianSeconds)}
          meta={totals.replies === 0 ? "ответов не было" : (
            <>
              до {REPLY_FAST_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinFast) / totals.replies)}, до {REPLY_NORM_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinNorm) / totals.replies)} из {formatCount(totals.replies)}
              {totals.repliesToInherited > 0 && <> · в т.ч. {formatCount(totals.repliesToInherited)} ждавшим с прошлых смен, их ожидание — с начала смены</>}
            </>
          )}
        />
        <Stat
          label="Без ответа в смену"
          value={formatCount(totals.unanswered)}
          meta={<>
            написали в смену, ответа до конца не было
            {totals.inherited > 0 && (
              <> · с прошлых смен ждали {formatCount(totals.inherited)}, ответили {formatCount(totals.inheritedAnswered)}
                {inheritedWaiting > 0 && <>, ждут ещё <button type="button" className="link" onClick={() => showChats({ kind: "all", show: "inherited", chat: null })}>{formatCount(inheritedWaiting)}</button></>}
              </>
            )}
          </>}
        />
        <Stat
          label="Текст из ИИ, без Hi"
          value={share(totals.origin.ai)}
          meta={<>
            {formatCount(totals.origin.ai)} сообщ.{totals.origin.copied > 0 && <>, из них вставлено руками {formatCount(totals.origin.copied)}</>}
            {" · "}Fix своего {share(totals.origin.fix)} · не из ИИ хаба {share(totals.origin.own)}
            {totals.origin.hi > 0 && <> · Hi-приветствий ещё {formatCount(totals.origin.hi)}</>}
          </>}
        />
      </StatGrid>

      <section className="card" aria-labelledby="review-pulse">
        <header className="card-header">
          <h2 id="review-pulse" className="card-title">Пульс смены</h2>
          {silent.length > 0 && (
            <p className="card-description">
              Без сообщений {SILENCE_MINUTES}+ мин: {silent.slice(0, 4).map((one, index) => (
                <span key={one.from}>{index > 0 && ", "}<button type="button" className="link" onClick={() => setPicked({ from: one.from, to: one.to })}>{formatDuration(one.minutes)} с {formatTimeOfDay(one.from)}</button></span>
              ))}{silent.length > 4 && ` и ещё ${silent.length - 4}`}
            </p>
          )}
        </header>
        <div className="card-body">
          <ShiftPulse pulse={pulse} start={start} end={end} pauses={pauses} picked={pickedRange} onPick={pickAround} />
        </div>
      </section>

      <section className="card" aria-labelledby="review-chats-title" id="review-chats">
        <header className="card-header">
          <h2 id="review-chats-title" className="card-title">Чаты смены</h2>
          <p className="card-description">
            Клик по пометке у сообщения — текст ИИ и черновик рядом. ← и → — соседний чат.
            {data.unarchived > 0 && ` ${formatCount(data.unarchived)} сообщ. ещё нет в архиве — их нет и здесь.`}
          </p>
        </header>
        <div className="card-body">
          <ShiftChats data={data} summaries={summaries} picked={pickedRange} onClearPick={() => setPicked(null)} view={view} onView={onView} />
        </div>
      </section>
    </div>
  );
}
