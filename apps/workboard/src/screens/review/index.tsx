import { ChevronDown, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { Button, EmptyState, ErrorState, Facts, Hint, LinkButton, Menu, Money, SearchInput, Segmented, Skeleton, collidingFanNames, cx, type FactItem, type MenuEntry } from "@agency_hub_core/ui";
import { formatCount, formatDay, formatDuration, formatMills, formatPercent, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { CHATTER_SHIFT_PAGE_MIN_MESSAGES } from "@agency_hub_core/contracts";
import { REPLY_FAST_SECONDS, REPLY_NORM_SECONDS, shiftQuality } from "@agency_hub_core/ui/shiftReview";
import { carryParams, parseShiftKey, personPath, shiftPath, useBackTarget, type BackTarget } from "@/shared/links";
import { METRICS, UNANSWERED_NOW_LABEL, formatAiUnedited, formatReplyMedian, formatUnanswered } from "@/shared/metrics";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMe } from "@/shared/useMe";
import { ChatList } from "./ChatList.js";
import { useShiftReview, useShiftsAround, type ReviewFilter, type ReviewIndex, type ReviewModel, type ReviewShift } from "./data.js";
import { Evidence } from "./Evidence.js";
import { LOOK, focusOf, ordered } from "./look.js";
import { Pulse } from "./Pulse.js";
import { ShiftStepper } from "./ShiftStepper.js";
import { Transcript } from "./Transcript.js";
import { useReviewParams, type ReviewChange, type ReviewParams } from "./useReviewParams.js";
import "./review.css";

/**
 * Разбор смены (spec §4.2): one chatter's shift opened up, the core of
 * Workboard. One line names the shift, one line of facts under it; then one
 * sheet down to the window's bottom: the pulse of its minutes, the list's
 * filters, the chats and the conversation — and the evidence of a message as a
 * third column beside them (D7). Everything chosen is in the address; ↑ ↓ (J K)
 * step through the chats.
 */

const MINUTE_MS = 60_000;

const FILTER_WORDS: Record<ReviewFilter, string> = {
  look: "Стоит посмотреть",
  unanswered: "Без ответа",
  waited: "Долго ждали",
  paid: "Платные",
  all: "Все",
};

const FILTER_TITLES: Record<ReviewFilter, string> = {
  look: `До ${LOOK.max} чатов с самыми сильными причинами: без ответа к концу смены, ожидание от ${LOOK.waitSeconds / 60} мин, `
    + `покупки от ${formatMills(LOOK.paidMills)}, ИИ без правки во всём чате или ${LOOK.aiRunMin} подряд, один текст ${LOOK.repeatFans} фанам и больше, `
    + `служебный текст ИИ. И ${LOOK.samples} обычных диалога для сравнения`,
  unanswered: "Фан писал в смену, ответа чаттера до конца смены не было",
  waited: `Фан ждал ответа дольше ${REPLY_NORM_SECONDS / 60} мин: с ответом в смену или без него`,
  paid: "Платные сообщения, чаевые или продажи этому фану в смену",
  all: "Все чаты смены по времени",
};

/** «пт, 6 нояб. · 09:16–18:53»; a night shift says both days; a shift going on — since when. */
function whenText(shift: ReviewShift): string {
  const day = (at: number) => new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
  if (shift.ongoing) return `${formatWeekdayDay(shift.start)} · с ${formatTimeOfDay(shift.start)}, идёт`;
  if (day(shift.start) !== day(shift.end)) return `${formatDay(shift.start).replace(/ .*/, "")}–${formatDay(shift.end)} · ${formatTimeOfDay(shift.start)}–${formatTimeOfDay(shift.end)}`;
  return `${formatWeekdayDay(shift.start)} · ${formatTimeOfDay(shift.start)}–${formatTimeOfDay(shift.end)}`;
}

/** The three numbers of the shift are the review's rules and the app's words (D1): the journal and the card say the same. */
function factsOf(index: ReviewIndex): FactItem[] {
  const { shift, totals } = index;
  const quality = shiftQuality(totals);
  const notMine = totals.handedOverUnanswered + totals.colleagueUnanswered;
  const late = shift.ongoing ? 0 : totals.unansweredLate;
  return [
    {
      label: "Продажи",
      strong: true,
      value: <Money mills={shift.salesNetMills} strong />,
      hint: (
        <>
          Продажи на страницах смены после комиссии, пока она их держала, как в «Сменах».
          {shift.chatsNetMills !== shift.salesNetMills && <> В чатах ниже — {formatMills(shift.chatsNetMills)}: остальное купили фаны без переписки в эту смену.</>}
          {totals.ppvSent > 0 && <> Платных сообщений куплено {formatCount(totals.ppvBought)} из {formatCount(totals.ppvSent)}.</>}
        </>
      ),
    },
    {
      label: "Сообщений",
      value: <>{formatCount(totals.messages)}{totals.massMessages > 0 && <span className="review-facts__quiet"> +{formatCount(totals.massMessages)} рассылкой</span>}</>,
      hint: <>Личные сообщения фанам{totals.perHour !== null && <>, {totals.perHour.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} в час без пауз</>}.{totals.massMessages > 0 && <> Рассылки ({formatCount(totals.massMessages)}) никому не отвечают — их здесь не считаем.</>}</>,
    },
    {
      // Not «Все» of the list: that one holds the fans who only waited and the colleagues' chats too.
      label: "Чатов",
      value: formatCount(totals.chats),
      hint: <>Чаты, где чаттер писал в смену{totals.chatsFanSilent > 0 && <>; в {formatCount(totals.chatsFanSilent)} из них фан в смену не писал (приветствия, первые сообщения)</>}. В списке «Все» есть и чаты, где фаны только ждали.</>,
    },
    {
      label: METRICS.reply.label,
      value: formatReplyMedian(quality.replyMedianSeconds),
      hint: (
        <>
          {METRICS.reply.hint}
          {totals.replies > 0 && (
            <> В эту смену {formatCount(totals.replies)} {ruPlural(totals.replies, "ответ", "ответа", "ответов")}: до {REPLY_FAST_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinFast) / totals.replies)}, до {REPLY_NORM_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinNorm) / totals.replies)}.</>
          )}
        </>
      ),
    },
    {
      label: shift.ongoing ? UNANSWERED_NOW_LABEL : METRICS.unanswered.label,
      value: (
        <>
          {formatUnanswered(quality.unansweredAtEnd)}
          {late > 0 && <span className="review-facts__quiet"> · {formatCount(late)} в последние {REPLY_NORM_SECONDS / 60} мин</span>}
        </>
      ),
      hint: (
        <>
          {METRICS.unanswered.hint}
          {totals.unansweredInherited > 0 && <> Из них ждали ещё с прошлых смен: {formatCount(totals.unansweredInherited)}.</>}
          {late > 0 && <> Написали в последние {REPLY_NORM_SECONDS / 60} мин смены: {formatCount(late)} — ответить было почти некогда, но в счёте они есть.</>}
          {totals.waitingSilently > 0 && <> Ещё {formatCount(totals.waitingSilently)} ждали с прошлых смен и в смену не писали — не в счёте.</>}
          {notMine > 0 && <> Ещё {formatCount(notMine)} без ответа после сообщения коллеги — не в счёте.</>}
        </>
      ),
    },
    {
      label: METRICS.aiUnedited.label,
      value: formatAiUnedited(quality.aiUneditedShare),
      hint: (
        <>
          {METRICS.aiUnedited.hint}
          {totals.textMessages > 0 && (
            <>
              {" "}В эту смену {formatCount(totals.aiUnedited)} из {formatCount(totals.textMessages)}. ИИ с правкой — {formatCount(totals.origin.ai - totals.aiUnedited)},
              свой черновик через ИИ — {formatCount(totals.origin.fix)}, сам — {formatCount(totals.origin.own)}.
              {totals.origin.hi > 0 && <> Приветствий Hi — {formatCount(totals.origin.hi)}.</>}
            </>
          )}
        </>
      ),
    },
  ];
}

/** «7 ч 28 мин · mia-1, mia-2» after the title: how long without the pauses, and the pages. */
function TitleExtra({ shift }: { shift: ReviewShift }) {
  return (
    <span className="review-title__extra">
      <Hint
        content={shift.pauseMinutes > 0
          ? `Работа без пауз. Паузы — ${formatDuration(shift.pauseMinutes)}: серые полосы на пульсе.`
          : "Работа без пауз."}
        align="start"
        side="bottom"
      >
        {formatDuration(shift.workedMinutes)}
      </Hint>
      <span aria-hidden> · </span>
      <span>{shift.pages.map((one) => one.pageLabel).join(", ")}</span>
    </span>
  );
}

/** The page filter of a shift with several pages: one menu in the list's row (the app's page filter, `?page=`). */
function PageMenu({ shift, page, onPage }: { shift: ReviewShift; page: string | null; onPage: (page: string | null) => void }) {
  const items: MenuEntry[] = [
    { label: "Все страницы смены", checked: page === null, onSelect: () => onPage(null) },
    { separator: true },
    ...shift.pages.map((one): MenuEntry => ({
      label: one.pageLabel,
      hint: !one.worked && shift.kind === "shift"
        ? "заглядывал"
        : `${formatCount(one.messages)} ${ruPlural(one.messages, "сообщение", "сообщения", "сообщений")}`,
      title: !one.worked && shift.kind === "shift"
        ? `Меньше ${CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений: продажи страницы не в этой смене, здесь только чаты, где писал чаттер`
        : "Сообщений чаттера на странице за смену, рассылки тоже",
      checked: page === one.pageLabel,
      onSelect: () => onPage(one.pageLabel),
    })),
  ];
  return (
    <Menu
      label="Страница"
      items={items}
      align="start"
      renderTrigger={({ ref, ...trigger }) => page === null ? (
        <button ref={ref} type="button" className="ui-chip ui-chip--md" {...trigger}>
          <span className="ui-chip__text">Все страницы</span>
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
        </button>
      ) : (
        <span className="ui-chip ui-chip--md ui-chip--selected">
          <button ref={ref} type="button" className="ui-chip__main" aria-label={`Только чаты ${page}. Выбрать другую страницу`} {...trigger}>
            <span className="ui-chip__text">{page}</span>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="ui-chip__remove" aria-label="Все страницы смены" onClick={() => onPage(null)}>
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </span>
      )}
    />
  );
}

function Loading({ back }: { back: BackTarget }) {
  return (
    <>
      <ScreenHeader
        fill
        title={<Skeleton width={420} height={28} radius={6} />}
        documentTitle="Разбор смены"
        back={back}
        meta={(
          <span className="review-facts review-facts--loading">
            {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} width={index === 0 ? 140 : 120} height={20} radius={6} />)}
          </span>
        )}
      />
      <div className="wb-content review-content" aria-busy="true">
        <div className="review-panes">
          <div className="review-pulse"><Skeleton height={74} radius={6} /></div>
          <div className="review-toolbar"><Skeleton width={640} height={36} radius={8} /></div>
          <div className="review-split">
            <div className="review-chats review-chats--loading">
              {Array.from({ length: 7 }, (_, index) => (
                <div key={index} className="review-chat-skeleton"><Skeleton width="60%" height={18} radius={4} /><Skeleton width="85%" height={16} radius={4} /></div>
              ))}
            </div>
            <div className="review-transcript review-transcript--loading">
              {[220, 320, 180, 360, 260].map((width, index) => (
                <div key={index} className={index % 2 === 0 ? "review-skeleton-msg" : "review-skeleton-msg review-skeleton-msg--page"}><Skeleton width={width} height={56} radius={12} /></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * No review to show: no shift there, a team lead (the review is the owner's),
 * or Hub did not answer. The header still names whose shift and when, from the
 * address and the week's shifts; «Смены нет» offers the nearest one.
 */
function Problem({ back, kind, retry, retrying, userId, at }: {
  back: BackTarget;
  kind: "missing" | "owner-only" | "error";
  retry: () => void;
  retrying: boolean;
  userId: number;
  at: string;
}) {
  const location = useLocation();
  const around = useShiftsAround(at, kind !== "error");
  const own = (around.data?.shifts ?? []).filter((one) => one.userId === userId);
  const name = own[0]?.username ?? null;
  const target = Date.parse(at);
  const nearest = [...own].sort((a, b) => Math.abs(Date.parse(a.startedAt) - target) - Math.abs(Date.parse(b.startedAt) - target))[0] ?? null;
  const when = `${formatWeekdayDay(at)}, ${formatTimeOfDay(at)}`;
  const title = (
    <span className="review-title">
      <span>{name ?? "Разбор смены"}</span>
      <span className="review-title__when">{when}</span>
    </span>
  );
  const body = kind === "missing" ? (
    <EmptyState
      title="Смены нет"
      action={nearest
        ? <LinkButton to={shiftPath(userId, nearest.startedAt, location.search)} state={location.state}>Ближайшая смена: {formatWeekdayDay(nearest.startedAt)}, {formatTimeOfDay(nearest.startedAt)}</LinkButton>
        : <LinkButton to={personPath(userId, location.search)}>Смены {name ?? "этого человека"}</LinkButton>}
    >
      {`В ${when} у ${name ?? "этого человека"} не было смены в расширении.`}
    </EmptyState>
  ) : kind === "owner-only" ? (
    <EmptyState title="Разбор смены — только для владельца">В нём тексты ИИ и черновики чаттеров: Hub показывает их только владельцу.</EmptyState>
  ) : (
    <ErrorState onRetry={retry} retrying={retrying} />
  );
  return (
    <>
      <ScreenHeader title={title} documentTitle={name ? `${name}, ${formatDay(at)} — Разбор смены` : "Разбор смены"} back={back} />
      <div className="wb-content">{body}</div>
    </>
  );
}

export function ReviewScreen() {
  const { userId: rawUser, shiftStart } = useParams();
  const location = useLocation();
  const userId = Number(rawUser);
  const at = parseShiftKey(shiftStart);
  // Straight from an address: «←» goes to Смены of the same period and page.
  const carried = carryParams(location.search).toString();
  const back = useBackTarget({ to: carried ? `/shifts?${carried}` : "/shifts", label: "Смены" });
  if (!Number.isInteger(userId) || userId <= 0 || at === null) {
    return (
      <>
        <ScreenHeader title="Разбор смены" back={back} />
        <div className="wb-content">
          <EmptyState title="Смена не найдена в адресе" action={<LinkButton to={back.to}>К сменам</LinkButton>}>Откройте смену из журнала смен или со страницы человека.</EmptyState>
        </div>
      </>
    );
  }
  return <Review key={`${userId}:${at}`} userId={userId} at={at} back={back} />;
}

function Review({ userId, at, back }: { userId: number; at: string; back: BackTarget }) {
  const me = useMe();
  // The review is the owner's (Hub answers 403 to anyone else): a team lead is not sent to ask.
  const owner = me.isOwner;
  const { query, model } = useShiftReview(userId, at, owner);
  const [params, update] = useReviewParams();
  if (me.role !== null && !owner) return <Problem back={back} kind="owner-only" retry={() => undefined} retrying={false} userId={userId} at={at} />;
  if (!model) {
    if (query.isError) {
      const status = hubErrorStatus(query.error);
      return (
        <Problem
          back={back}
          kind={status === 404 || status === 400 ? "missing" : status === 403 ? "owner-only" : "error"}
          retry={() => void query.refetch()}
          retrying={query.isFetching}
          userId={userId}
          at={at}
        />
      );
    }
    return <Loading back={back} />;
  }
  return <Loaded model={model} params={params} update={update} back={back} updatedAt={query.dataUpdatedAt} refreshing={query.isFetching} onRefresh={() => void query.refetch()} />;
}

function Loaded({ model, params, update, back, updatedAt, refreshing, onRefresh }: {
  model: ReviewModel;
  params: ReviewParams;
  update: (change: ReviewChange) => void;
  back: BackTarget;
  updatedAt: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { index } = model;
  const { shift } = index;
  // The page narrows the chats only where the shift has more than one page.
  const pageOn = params.page !== null && shift.pages.length > 1 && shift.pages.some((one) => one.pageLabel === params.page);

  const spanMs = params.span === null ? null : {
    from: Math.max(shift.start, shift.start + params.span.from * MINUTE_MS),
    to: Math.min(shift.end, shift.start + params.span.to * MINUTE_MS),
  };
  const spanFrom = spanMs?.from ?? null;
  const spanTo = spanMs?.to ?? null;
  const busy = useMemo(() => (spanFrom === null || spanTo === null ? null : model.busyIn(spanFrom, spanTo)), [model, spanFrom, spanTo]);
  // The search field types into its own state at once and writes the address after it: the
  // address catches up a moment later, and a fast typist must not lose letters to it.
  const [query, setQuery] = useState(params.q);
  const written = useRef(params.q);
  useEffect(() => {
    if (params.q === written.current) return;
    // While the field has the focus it leads: the address is only catching up with it.
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.type === "search") return;
    written.current = params.q;
    setQuery(params.q);
  }, [params.q]);
  // Words search the whole shift: typing moves to «Все», clearing goes back to the list it left.
  const before = useRef<ReviewFilter | null>(null);
  const search = (value: string) => {
    const change: ReviewChange = { q: value, chat: null, msg: null };
    if (value.trim() !== "" && query.trim() === "" && params.show !== "all") {
      before.current = params.show;
      change.show = "all";
    } else if (value.trim() === "" && before.current !== null) {
      change.show = before.current;
      before.current = null;
    }
    setQuery(value);
    written.current = value;
    update(change);
  };
  const matching = useMemo(() => model.matching(query), [model, query]);

  // Every count follows what narrows the list: the page, the search, the picked minutes.
  const base = useMemo(() => index.chats.filter((row) => (!pageOn || row.pageLabel === params.page)
    && (matching === null || matching.has(row.key))
    && (busy === null || busy.has(row.key))), [index.chats, pageOn, params.page, matching, busy]);
  const counts = useMemo(() => {
    const out = { look: 0, unanswered: 0, waited: 0, paid: 0, all: 0 } satisfies Record<ReviewFilter, number>;
    for (const row of base) for (const filter of Object.keys(out) as ReviewFilter[]) if (row.in[filter]) out[filter] += 1;
    return out;
  }, [base]);
  // «Стоит посмотреть» with nothing in it opens on «Все».
  const show: ReviewFilter = params.show === "look" && counts.look === 0 && params.chat === null ? "all" : params.show;
  const shown = useMemo(() => ordered(base.filter((row) => row.in[show]), show), [base, show]);
  // A chat named in the address that the list does not hold stays open, on top, said so.
  const outside = params.chat !== null && !shown.some((row) => row.key === params.chat)
    ? index.chats.find((row) => row.key === params.chat) ?? null
    : null;
  const list = outside ? [outside, ...shown] : shown;
  const found = list.findIndex((row) => row.key === params.chat);
  const activeIndex = found >= 0 ? found : 0;
  const active = list[activeIndex] ?? null;
  const transcript = active ? model.transcript(active.key) : null;
  const evidenceMessage = transcript && params.msg !== null
    ? transcript.chat.messages.find((message) => message.ref === params.msg && message.mine !== null) ?? null
    : null;
  // Two fans of one name in this shift: their logins go beside the names (D6).
  const colliding = useMemo(() => collidingFanNames(index.chats.flatMap((row) => (row.fanRef ? [{ name: row.fanDisplayName, username: row.fanUsername, fanRef: row.fanRef }] : []))), [index.chats]);

  // Where the keys stand now: set on every render and at once on every step, so fast presses
  // (a held key) never read a list position the address has not caught up with yet.
  const cursor = useRef<{ chat: string | null; msg: string | null }>({ chat: null, msg: null });
  cursor.current = { chat: active?.key ?? null, msg: evidenceMessage?.ref ?? null };
  const rowsRef = useRef(list);
  rowsRef.current = list;
  const go = (chat: string, msg: string | null) => {
    cursor.current = { chat, msg };
    update({ chat, msg });
  };
  const step = (delta: 1 | -1) => {
    const rows = rowsRef.current;
    const next = rows[Math.max(0, rows.findIndex((row) => row.key === cursor.current.chat)) + delta];
    if (next) go(next.key, null);
  };
  // With the evidence open the keys walk the chatter's messages of the chat instead.
  const stepMessage = (delta: 1 | -1) => {
    const { chat, msg } = cursor.current;
    if (chat === null || msg === null) return;
    const own = model.transcript(chat)?.chat.messages.filter((message) => message.mine !== null) ?? [];
    const next = own[own.findIndex((message) => message.ref === msg) + delta];
    if (next) go(chat, next.ref);
  };
  const stepRef = useRef(step);
  stepRef.current = (delta: 1 | -1) => (cursor.current.msg !== null ? stepMessage(delta) : step(delta));
  // ↑ ↓, J K and ← → walk the chats, unless the keys are typing somewhere or a menu holds them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const delta = event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "j" || event.key === "J" || event.key === "о" ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "k" || event.key === "K" || event.key === "л" ? -1
          : 0;
      if (delta === 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog'][aria-modal='true'], [role='slider']")) return;
      event.preventDefault();
      stepRef.current(delta);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const closeEvidence = () => {
    const ref = cursor.current.msg;
    if (active) go(active.key, null);
    // The focus goes back to the line that opened it.
    if (ref !== null) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"] .review-origin`)?.focus());
  };

  const setSpan = (span: { from: number; to: number } | null) => update({
    span: span === null ? null : {
      from: Math.max(0, Math.floor((span.from - shift.start) / MINUTE_MS)),
      to: Math.max(1, Math.ceil((Math.min(span.to, shift.end) - shift.start) / MINUTE_MS)),
    },
    chat: null,
    msg: null,
  });
  const narrowed = query.trim() !== "" || params.span !== null || pageOn;
  const pageWords = shift.pages.length === 2 ? "обе страницы" : "все страницы";

  const title = (
    <span className="review-title">
      <span>{shift.username}</span>
      <span className="review-title__when">{whenText(shift)}</span>
      <TitleExtra shift={shift} />
    </span>
  );
  const notes: string[] = [];
  if (shift.kind === "visit") notes.push("это заход, а не смена");
  if (shift.unarchived > 0) notes.push(`${formatCount(shift.unarchived)} сообщ. чаттера ещё нет в архиве — их нет и здесь`);
  if (shift.deleted > 0) notes.push(`${formatCount(shift.deleted)} сообщ. удалены после отправки — их здесь нет`);
  const meta = (
    <span className="review-meta">
      <Facts items={factsOf(index)} className="review-facts" label="Смена в цифрах" />
      {notes.length > 0 && <span className="review-meta__quiet">{notes.join(" · ")}</span>}
    </span>
  );

  return (
    <>
      <ScreenHeader
        fill
        title={title}
        documentTitle={`${shift.username}, ${formatDay(shift.start)} — Разбор смены`}
        back={back}
        actions={<ShiftStepper shift={shift} />}
        meta={meta}
        // A finished shift is read once and does not change; one going on is read every 2 min and can be read now.
        {...(shift.ongoing ? { updatedAt, onRefresh, refreshing } : {})}
      />
      <div className="wb-content review-content">
        <div className="review-panes">
          <Pulse
            minutes={index.minutes}
            sales={index.sales}
            pauses={shift.pauses}
            start={shift.start}
            end={shift.end}
            ongoing={shift.ongoing}
            span={spanMs}
            silences={index.silences}
            scope={pageOn ? { words: "цифры и пульс — вся смена", hint: `Цифры над пульсом и сам пульс — за всю смену, ${pageWords}. Чаты ниже — только ${params.page}.` } : null}
            onSpan={setSpan}
          />
          <div className="review-toolbar">
            <Segmented
              label="Какие чаты"
              value={show}
              onChange={(value) => update({ show: value, chat: null, msg: null })}
              options={(Object.keys(FILTER_WORDS) as ReviewFilter[]).map((value) => ({ value, label: FILTER_WORDS[value], count: counts[value], title: FILTER_TITLES[value] }))}
            />
            {shift.pages.length > 1 && <PageMenu shift={shift} page={pageOn ? params.page : null} onPage={(page) => update({ page, chat: null, msg: null })} />}
            <span className="review-toolbar__search">
              <SearchInput value={query} onChange={search} placeholder="Фан или слово" slashShortcut width={240} />
            </span>
          </div>
          {list.length === 0 || !active || !transcript ? (
            <div className="review-split review-split--empty">
              <EmptyState
                title={narrowed ? "Таких чатов нет" : "В смене нет чатов"}
                action={narrowed ? <Button onClick={() => { search(""); update({ span: null, page: null, show: "all", chat: null }); }}>Показать все чаты смены</Button> : undefined}
              >
                {narrowed ? "Отбор слишком узкий: поиск, время на пульсе или страница." : "Чаттер в эту смену никому не писал, и фаны его страниц не ждали ответа."}
              </EmptyState>
            </div>
          ) : (
            <div className={cx("review-split", evidenceMessage && "has-evidence")}>
              <ChatList
                rows={list}
                activeKey={active.key}
                outsideKey={outside?.key ?? null}
                showPage={shift.pages.length > 1 && !pageOn}
                ongoing={shift.ongoing}
                shiftStart={shift.start}
                colliding={colliding}
                query={query}
                snippet={model.snippet}
                onPick={(key) => update({ chat: key, msg: null })}
              />
              <Transcript
                shift={shift}
                transcript={transcript}
                row={active}
                colliding={colliding}
                position={{ index: activeIndex, count: list.length }}
                onStep={step}
                span={spanMs}
                focus={focusOf(active, show)}
                query={query}
                openMessage={evidenceMessage?.ref ?? null}
                onEvidence={(ref) => go(active.key, cursor.current.msg === ref ? null : ref)}
              />
              {evidenceMessage && (
                <Evidence
                  transcript={transcript}
                  message={evidenceMessage}
                  onStep={(ref) => go(active.key, ref)}
                  onClose={closeEvidence}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

