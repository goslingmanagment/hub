import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { teamShiftReviewQueryOptions, useTeamShiftReview, useTeamShifts } from "@/api/team";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatCount, formatDateTime, formatDay, formatDuration, formatMills, formatPercent, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { shiftSpan } from "@/pages/team/TeamShiftsPage";
import { ChatterLink, PageLink } from "@/pages/team/teamLinks";
import { ShiftChats, type ChatsView } from "./ShiftChats.js";
import { ShiftPulse } from "./ShiftPulse.js";
import { CHATTER_SHIFT_PAGE_MIN_MESSAGES } from "@agency_hub_core/contracts";
import {
  CHAT_KINDS,
  CHAT_SHOWS,
  CHAT_SORTS,
  PICK_MINUTES,
  REPLY_FAST_SECONDS,
  REPLY_NORM_SECONDS,
  chatBusyIn,
  myMessages,
  pulseOf,
  reviewWaits,
  silences,
  summariesOf,
  totalsOf,
  waitText,
  type ChatKindFilter,
  type ChatShow,
  type ChatSort,
} from "./shiftReviewView.js";

/**
 * Команда → Смены → «Разбор смены» (owner, 2026-11-06): one chatter's shift
 * opened up. The totals, every chat it touched with the whole transcript and
 * where each message's text came from, then its pulse minute by minute. Facts,
 * not grades. `?user=&at=` names the shift; without them the screen lists the
 * shifts of the last week to choose from. What is chosen on the screen — the
 * chat, the list's filters and order, the picked minutes — is in the address
 * too, so a link opens the same place.
 */

const MINUTE_MS = 60_000;
/** The team shifts endpoint reads at most a week. */
const PICKER_HOURS = 7 * 24;
/** A stretch without one message this long, pauses aside, is listed over the pulse. */
const SILENCE_MINUTES = 20;
/** At most this many of them, the longest. */
const SILENCES_SHOWN = 4;

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
  const [search, setSearch] = useSearchParams();
  const params = useMemo(() => ({ from: new Date(now - PICKER_HOURS * 3_600_000).toISOString(), to: new Date(now).toISOString() }), [now]);
  const query = useTeamShifts(params);
  const all = query.data?.shifts ?? [];
  const people = [...new Map(all.map((shift) => [shift.userId, shift.username])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const who = Number(search.get("who"));
  const shifts = all.filter((shift) => !Number.isInteger(who) || who <= 0 || shift.userId === who);
  // By the Moscow day each shift began, newest first, as the list comes.
  const days: Array<{ day: string; shifts: typeof shifts }> = [];
  for (const shift of shifts) {
    const day = formatDay(shift.startedAt);
    const last = days.at(-1);
    if (last && last.day === day) last.shifts.push(shift);
    else days.push({ day, shifts: [shift] });
  }
  const table = shifts.length === 0 ? (
    <div className="empty"><p className="empty-title">{all.length === 0 ? "За неделю смен не было" : "У этого человека за неделю смен не было"}</p></div>
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
        {days.map((group) => (
          <tbody key={group.day}>
            <tr className="sr-day-row"><th scope="rowgroup" colSpan={5}>{group.day}</th></tr>
            {group.shifts.map((shift) => (
              <tr key={`${shift.userId}:${shift.startedAt}`}>
                <td><ChatterLink userId={shift.userId} username={shift.username} /></td>
                <td className="whitespace-nowrap"><Link to={reviewHref(shift.userId, shift.startedAt)} className="team-link">{shiftSpan(shift)}</Link></td>
                <td>{shift.pages.filter((page) => page.messages > 0).map((page, index) => <span key={page.pageLabel}>{index > 0 && ", "}<PageLink label={page.pageLabel} /></span>)}</td>
                <td className="num">{formatCount(shift.authoredMessages)}</td>
                <td><Link to={reviewHref(shift.userId, shift.startedAt)} className="btn btn-sm">Разобрать</Link></td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
  return (
    <div className="team-screen">
      <PageHeader description="Выберите смену: все чаты с перепиской, откуда взят текст каждого сообщения, пульс по минутам." />
      <section className="card" aria-labelledby="review-pick">
        <header className="card-header sr-pick-head">
          <h2 id="review-pick" className="card-title">Смены за неделю</h2>
          {people.length > 1 && (
            <select
              className="select w-auto"
              aria-label="Чаттер"
              value={Number.isInteger(who) && who > 0 ? String(who) : ""}
              onChange={(event) => setSearch(event.target.value === "" ? {} : { who: event.target.value }, { replace: true })}
            >
              <option value="">Все чаттеры</option>
              {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
        </header>
        {query.data
          ? <><QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />{table}</>
          : query.isError ? <NoAnswerPanel retry={query.refetch} /> : <TableSkeleton rows={6} columns={4} />}
      </section>
    </div>
  );
}

export function ShiftReviewPage() {
  const [search] = useSearchParams();
  const user = Number(search.get("user"));
  const raw = search.get("at");
  // Any moment the browser reads goes to the server as a full ISO instant: a hand-cut link still finds its shift, or says there is none.
  const parsed = raw === null ? Number.NaN : Date.parse(raw);
  if (!Number.isInteger(user) || user <= 0 || Number.isNaN(parsed)) return <ShiftPicker />;
  const at = new Date(parsed).toISOString();
  return <ShiftReview key={`${user}:${at}`} userId={user} at={at} />;
}

function ShiftReview({ userId, at }: { userId: number; at: string }) {
  const query = useTeamShiftReview({ userId, at });
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const data = query.data;
  const derived = useMemo(() => {
    if (!data) return null;
    const mine = myMessages(data);
    const waits = reviewWaits(data);
    const pulse = pulseOf(data, waits);
    const summaries = summariesOf(data, waits);
    const pauses = data.shift.pauses.map((pause) => ({ from: Date.parse(pause.from), to: Date.parse(pause.to) }));
    const silent = silences(pulse, pauses, SILENCE_MINUTES)
      .sort((a, b) => (b.minutes - b.pauseMinutes) - (a.minutes - a.pauseMinutes))
      .slice(0, SILENCES_SHOWN)
      .sort((a, b) => a.from - b.from);
    return { mine, waits, pulse, pauses, totals: totalsOf(data, mine, summaries, waits), summaries, silent };
  }, [data]);

  // The shifts before and after are read as soon as this one is here: stepping through them does not wait.
  const previousAt = data?.previousAt ?? null;
  const nextAt = data?.nextAt ?? null;
  useEffect(() => {
    for (const target of [previousAt, nextAt]) {
      if (target !== null) void queryClient.prefetchQuery(teamShiftReviewQueryOptions({ userId, at: target }));
    }
  }, [queryClient, userId, previousAt, nextAt]);

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

  const back = <Link to={`/team/review?who=${userId}`} className="btn">Другая смена</Link>;
  if (!data || !derived) {
    if (!query.isError) {
      return <div className="team-screen" aria-busy="true"><PageHeader actions={back} /><TableSkeleton rows={8} columns={4} /></div>;
    }
    const status = (query.error as { status?: number } | null)?.status;
    return (
      <div className="team-screen">
        <PageHeader actions={back} />
        {status === 404 || status === 400
          ? <StatusPanel title="Смены нет" description="В это время у этого человека не было смены в расширении." action={<Link to="/team/review" className="btn btn-sm">К списку смен</Link>} />
          : <NoAnswerPanel retry={query.refetch} />}
      </div>
    );
  }

  const { shift } = data;
  const { totals, pulse, pauses, summaries, waits, silent } = derived;
  const start = Date.parse(shift.startedAt);
  const end = Date.parse(shift.endedAt);
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
  const pickedChats = pickedRange === null ? 0 : summaries.filter((summary) => chatBusyIn(summary.chat, waits, pickedRange.from, pickedRange.to)).length;

  const pageParam = search.get("page");
  const view: ChatsView = {
    chat: search.get("chat"),
    kind: oneOf<ChatKindFilter>(CHAT_KINDS, search.get("kind"), VIEW_DEFAULTS.kind),
    show: oneOf<ChatShow>(CHAT_SHOWS, search.get("show"), VIEW_DEFAULTS.show),
    sort: oneOf<ChatSort>(CHAT_SORTS, search.get("sort"), VIEW_DEFAULTS.sort),
    page: shift.pages.some((page) => page.pageLabel === pageParam) ? pageParam : null,
  };
  const onView = (change: Partial<ChatsView>) => update(change as Record<string, string | null>);
  const toChats = () => document.getElementById("review-chats")?.scrollIntoView({ block: "start", behavior: "smooth" });

  const chatsNetMills = data.chats.reduce((sum, chat) => sum + chat.shiftNetMills, 0);
  // Hi greetings are not replies in a conversation: the share is of the rest.
  const withText = totals.origin.ai + totals.origin.fix + totals.origin.own;
  const ongoing = shift.ongoing;
  const neighbour = (target: string | null, label: string, none: string) => (target
    ? <Link to={reviewHref(userId, target, search)} className="btn" title={`Смена с ${formatDateTime(target)}`}>{label}</Link>
    : <button type="button" className="btn" disabled title={none}>{label}</button>);

  const actions = (
    <>
      <span className="sr-bar-who">{shift.username} · {shiftSpan(shift)}</span>
      {neighbour(data.previousAt, "← Прошлая", "Прошлой смены за 3 дня до этой нет")}
      {neighbour(data.nextAt, "Следующая →", "Следующей смены пока нет")}
      {back}
    </>
  );

  return (
    <div className="team-screen">
      <PageHeader actions={actions} fresh={{ at: query.dataUpdatedAt, onRefresh: () => void query.refetch(), refreshing: query.isFetching }} />
      <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />
      <div className="sr-who">
        <h2 className="sr-who-name"><ChatterLink userId={userId} username={shift.username} /></h2>
        <p className="sr-who-line">
          {shiftSpan(shift)}
          {" · "}отработано {formatDuration(shift.workedMinutes)}
          {pauseMinutes > 0 && <> · паузы {formatDuration(pauseMinutes)}</>}
          {totals.ppvSent > 0 && <> · PPV куплено {formatCount(totals.ppvBought)} из {formatCount(totals.ppvSent)}</>}
          {shift.salesNetMills > 0 && (
            <span title="Продажи на страницах смены, пока смена их держала, как в «Заработке»: и фанам, которых нет в чатах ниже">
              {" · "}продажи смены {formatMills(shift.salesNetMills)}{chatsNetMills !== shift.salesNetMills && <>, в чатах ниже {formatMills(chatsNetMills)}</>}
            </span>
          )}
          {shift.kind === "visit" && " · это заход, не смена"}
        </p>
        <p className="sr-who-line sr-who-pages">
          <span className="team-faint">Сообщений по страницам: </span>
          {shift.pages.map((page, index) => (
            <span key={page.pageLabel}>
              {index > 0 && ", "}<PageLink label={page.pageLabel} /> {formatCount(page.messages)}
              {!page.worked && shift.kind === "shift" && (
                <span className="team-faint" title={`Меньше ${CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений: продажи страницы не в этой смене, в разборе — только чаты, где писал чаттер`}>
                  {" "}(меньше {CHATTER_SHIFT_PAGE_MIN_MESSAGES} — продажи не в смене)
                </span>
              )}
            </span>
          ))}
        </p>
      </div>

      <StatGrid>
        <Stat
          label="Сообщений фанам"
          value={formatCount(totals.messages)}
          meta={<>
            в {formatCount(totals.chats)} {ruPlural(totals.chats, "чате", "чатах", "чатах")}
            {totals.chatsFanSilent > 0 && <>, из них в {formatCount(totals.chatsFanSilent)} фан в смену не писал</>}
            {totals.perHour !== null && <> · {totals.perHour.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} в час без пауз</>}
            {totals.massMessages > 0 && <> · рассылкой ещё {formatCount(totals.massMessages)}</>}
          </>}
        />
        <Stat
          label="Ответ фану, медиана"
          value={totals.replyMedianSeconds === null ? "—" : waitText(totals.replyMedianSeconds)}
          meta={totals.replies === 0 ? "ответов не было" : (
            <>
              {formatCount(totals.replies)} {ruPlural(totals.replies, "ответ", "ответа", "ответов")}: до {REPLY_FAST_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinFast) / totals.replies)}, до {REPLY_NORM_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinNorm) / totals.replies)}
              {totals.repliesToInherited > 0 && <> · {formatCount(totals.repliesToInherited)} — ждавшим с прошлых смен, их ожидание — с начала смены</>}
            </>
          )}
        />
        <Stat
          label={ongoing ? "Ждут ответа сейчас" : "Без ответа к концу смены"}
          value={formatCount(totals.unanswered)}
          meta={<>
            фанов, писавших в смену
            {totals.unansweredInherited > 0 && <>, из них ждали ещё с прошлых смен {formatCount(totals.unansweredInherited)}</>}
            {totals.unansweredLate > 0 && <> · написали за последние {REPLY_NORM_SECONDS / 60} мин смены: {formatCount(totals.unansweredLate)}</>}
            {totals.handedOverUnanswered > 0 && <> · ещё {formatCount(totals.handedOverUnanswered)} без ответа после сообщения коллеги — не в счёте</>}
          </>}
        />
        <Stat
          label="Текст из ИИ, без Hi"
          value={withText === 0 ? "—" : formatPercent((100 * totals.origin.ai) / withText)}
          meta={<>
            {formatCount(totals.origin.ai)} из {formatCount(withText)} сообщ. с текстом{totals.origin.copied > 0 && <>, из них без кнопки {formatCount(totals.origin.copied)}</>}
            {" · "}Fix своего {formatCount(totals.origin.fix)} · с ИИ не совпало {formatCount(totals.origin.own)}
            {totals.origin.hi > 0 && <> · Hi ещё {formatCount(totals.origin.hi)}</>}
          </>}
        />
      </StatGrid>

      <section className="card team-anchor" aria-labelledby="review-chats-title" id="review-chats">
        <header className="card-header">
          <h2 id="review-chats-title" className="card-title">Чаты смены</h2>
          <p className="card-description">
            ← и → — соседний чат.
            {data.unarchived > 0 && ` ${formatCount(data.unarchived)} сообщ. чаттера ещё нет в архиве — их нет и здесь.`}
            {data.deleted > 0 && ` ${formatCount(data.deleted)} сообщ. удалены после отправки — их здесь нет.`}
          </p>
        </header>
        <div className="card-body">
          <ShiftChats
            data={data}
            summaries={summaries}
            waits={waits}
            picked={pickedRange}
            onClearPick={() => setPicked(null)}
            onReset={() => update({ show: null, page: null, chat: null, pick: null })}
            view={view}
            onView={onView}
          />
        </div>
      </section>

      <section className="card" aria-labelledby="review-pulse">
        <header className="card-header">
          <h2 id="review-pulse" className="card-title">Пульс смены</h2>
          {silent.length > 0 && (
            <p className="card-description">
              Без сообщений {SILENCE_MINUTES}+ мин, паузы не в счёт: {silent.map((one, index) => (
                <span key={one.from}>{index > 0 && ", "}<button type="button" className="link" onClick={() => { setPicked({ from: one.from, to: one.to }); toChats(); }}>
                  {formatDuration(one.minutes)} с {formatTimeOfDay(one.from)}{one.pauseMinutes > 0 && `, из них пауза ${formatDuration(one.pauseMinutes)}`}
                </button></span>
              ))}
            </p>
          )}
        </header>
        <div className="card-body">
          <ShiftPulse pulse={pulse} start={start} end={end} pauses={pauses} picked={pickedRange} ongoing={ongoing} onPick={pickAround} />
          {pickedRange !== null && (
            <p className="sr-picked">
              Выбрано {formatTimeOfDay(pickedRange.from)}–{formatTimeOfDay(pickedRange.to)}: в эти минуты {formatCount(pickedChats)} {ruPlural(pickedChats, "чат", "чата", "чатов")}, список выше сужен до них.
              {" "}<button type="button" className="link" onClick={toChats}>К чатам ↑</button>
              {" · "}<button type="button" className="link" onClick={() => setPicked(null)}>Снять</button>
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
