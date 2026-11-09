import { ChevronDown, RotateCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { Button, EmptyState, ErrorState, LinkButton, Menu, Money, SearchInput, Segmented, Skeleton, Spinner, Tooltip, collidingFanNames, cx, type MenuEntry } from "@agency_hub_core/ui";
import { formatAgo, formatCount, formatDay, formatMills, formatPercent, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { mondayOf } from "@agency_hub_core/ui/moscow";
import { withPeriod } from "@agency_hub_core/ui/period";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { CHATTER_SHIFT_PAGE_MIN_MESSAGES } from "@agency_hub_core/contracts";
import { REPLY_FAST_SECONDS, REPLY_NORM_SECONDS, shiftQuality } from "@agency_hub_core/ui/shiftReview";
import { shiftWhen, type ShiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { carryParams, parseShiftKey, personPath, shiftPath, useBackState, useBackTarget, type BackTarget } from "@/shared/links";
import { METRICS, UNANSWERED_NOW_LABEL, formatAiUnedited, formatReplyMedian, formatUnanswered } from "@/shared/metrics";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePeriod } from "@/shared/usePeriod";
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
 * Workboard. The page scrolls: the title bar (it sticks), the shift's numbers
 * as a row of tiles and its pulse on one quiet sheet; then the working sheet —
 * the list's filters, the chats, the conversation and the evidence of a message
 * as a third column (D7) — as tall as the window under the bar: the wheel over
 * it first docks it under the bar, then scrolls inside. Everything chosen is in
 * the address; ↑ ↓ (J K) step through the chats.
 *
 * Two scopes (spec r3, E1): the tiles and the pulse are the whole shift, never
 * narrowed; the list is narrowed by the page, the minutes picked on the pulse
 * and the search, its counts following them. `?font=system` shows the screen
 * in the system's font (for comparing pictures).
 */

const MINUTE_MS = 60_000;

const FILTER_WORDS: Record<ReviewFilter, string> = {
  look: "Стоит посмотреть",
  unanswered: "Без ответа",
  waited: "Долго ждали",
  paid: "Платные",
  all: "Все",
};

const FILTER_HINTS: Record<ReviewFilter, string> = {
  look: `До ${LOOK.max} чатов с сильными причинами: без ответа, ожидание от ${LOOK.waitSeconds / 60} мин, покупки от ${formatMills(LOOK.paidMills)}, `
    + `ИИ без правки подряд, один текст многим. И ${LOOK.samples} обычных для сравнения`,
  unanswered: "Фан писал в смену и не дождался ответа",
  waited: `Фан ждал ответа дольше ${REPLY_NORM_SECONDS / 60} мин`,
  paid: "Платные сообщения, чаевые или продажи в смену",
  all: "Все чаты смены по времени",
};

/** A list with nothing in it, the rest of the shift untouched: what that means. */
const FILTER_EMPTY: Record<ReviewFilter, string> = {
  look: "Смотреть особенно не на что",
  unanswered: "Без ответа к концу смены никого",
  waited: `Никто не ждал ответа дольше ${REPLY_NORM_SECONDS / 60} мин`,
  paid: "Платных сообщений, чаевых и продаж в смену не было",
  all: "В смене нет чатов",
};

/** The shift's one label and duration (D12): the same words as the journal, the card and the payouts. */
function whenOf(shift: ReviewShift): ShiftWhen {
  return shiftWhen({ startedAt: shift.startedAt, endedAt: shift.endedAt, ongoing: shift.ongoing, workedMinutes: shift.workedMinutes });
}

interface Tile {
  label: string;
  value: ReactNode;
  /** The definition, 1–2 short sentences on hover. */
  hint: string;
}

/**
 * The shift's numbers (D1): the same three quality numbers as the journal and the card, the sales, the messages and
 * the time worked. A number and its label; its definition only on hover.
 */
function tilesOf(index: ReviewIndex, when: ShiftWhen): Tile[] {
  const { shift, totals } = index;
  const quality = shiftQuality(totals);
  const late = shift.ongoing ? 0 : totals.unansweredLate;
  const percent = (part: number) => formatPercent((100 * part) / Math.max(1, totals.replies));
  return [
    {
      label: "Продажи",
      value: <Money mills={shift.salesNetMills} />,
      hint: [
        "Продажи страниц смены после комиссии, пока она их держала.",
        totals.ppvSent > 0 ? `Платных куплено ${formatCount(totals.ppvBought)} из ${formatCount(totals.ppvSent)}.` : "",
      ].join(" ").trim(),
    },
    {
      label: "Сообщений",
      value: formatCount(totals.messages),
      hint: [
        `Личные сообщения фанам${totals.perHour !== null ? `, ${totals.perHour.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} в час` : ""}.`,
        totals.massMessages > 0 ? `Рассылки (${formatCount(totals.massMessages)}) не в счёте.` : "",
      ].join(" ").trim(),
    },
    {
      label: METRICS.reply.label,
      value: formatReplyMedian(quality.replyMedianSeconds),
      hint: totals.replies > 0
        ? `Половина ответов быстрее, половина медленнее. До ${REPLY_FAST_SECONDS / 60} мин — ${percent(totals.repliesWithinFast)}, до ${REPLY_NORM_SECONDS / 60} мин — ${percent(totals.repliesWithinNorm)}.`
        : "Половина ответов быстрее, половина медленнее. Ответов в смену не было.",
    },
    {
      label: shift.ongoing ? UNANSWERED_NOW_LABEL : METRICS.unanswered.label,
      value: formatUnanswered(quality.unansweredAtEnd),
      hint: [
        "Фаны, которые писали в смену и не дождались ответа до её конца.",
        late > 0 ? `${formatCount(late)} из них — в последние ${REPLY_NORM_SECONDS / 60} мин.` : "",
      ].join(" ").trim(),
    },
    {
      label: METRICS.aiUnedited.label,
      value: formatAiUnedited(quality.aiUneditedShare),
      hint: totals.textMessages > 0
        ? `Текст ИИ ушёл фану как есть: ${formatCount(totals.aiUnedited)} из ${formatCount(totals.textMessages)} сообщений с текстом. Hi не в счёте.`
        : "Текст ИИ ушёл фану как есть. Hi не в счёте.",
    },
    {
      label: "Отработано",
      value: when.worked ?? "—",
      hint: [when.withPauses ? `${when.withPauses}.` : "", shift.pauseMinutes > 0 ? "Паузы — серые полосы на пульсе." : ""].join(" ").trim() || "Время работы без пауз.",
    },
  ];
}

function Tiles({ tiles }: { tiles: readonly Tile[] }) {
  return (
    <div className="review-tiles" role="list" aria-label="Смена в цифрах">
      {tiles.map((tile) => (
        <Tooltip key={tile.label} content={tile.hint} align="start" side="bottom" className="review-tile__tip">
          <div className="review-tile" role="listitem">
            <span className="review-tile__label">{tile.label}</span>
            <span className="review-tile__value">{tile.value}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * A shift going on is read every 2 min: when it was read, in the title's row (M11) — short, so the facts keep their
 * one line and the title its row; the words are the button that reads it now, the rest is in the hint.
 */
function LiveRefresh({ updatedAt, onRefresh, refreshing }: { updatedAt: number; onRefresh: () => void; refreshing: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!updatedAt) return null;
  return (
    <Tooltip content={`Обновлено в ${formatTimeOfDay(updatedAt)}, ${formatAgo(updatedAt, Math.max(now, updatedAt))}. Смена идёт: Hub читается каждые 2 мин, нажмите — прочитать сейчас.`} align="end">
      <button type="button" className="review-live" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? <Spinner /> : <RotateCw size={14} strokeWidth={1.75} aria-hidden />}
        {refreshing ? "обновляем…" : `обновлено ${formatTimeOfDay(updatedAt)}`}
      </button>
    </Tooltip>
  );
}

/**
 * The page filter of a shift with several pages: one menu in the list's row (the app's page filter, `?page=`).
 * It narrows the chats only (E1): the tiles and the pulse stay the whole shift — said in its hint.
 */
function PageMenu({ shift, page, onPage }: { shift: ReviewShift; page: string | null; onPage: (page: string | null) => void }) {
  const items: MenuEntry[] = [
    { label: "Все страницы", checked: page === null, onSelect: () => onPage(null) },
    { separator: true },
    ...shift.pages.map((one): MenuEntry => ({
      label: one.pageLabel,
      hint: !one.worked && shift.kind === "shift"
        ? "мало сообщений"
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
        <button ref={ref} type="button" className="ui-chip ui-chip--md review-pick" {...trigger}>
          <span className="ui-chip__text">Все страницы</span>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
        </button>
      ) : (
        <span className="ui-chip ui-chip--md ui-chip--selected review-pick">
          <button ref={ref} type="button" className="ui-chip__main" aria-label={`Только чаты ${page}. Выбрать другую страницу`} {...trigger}>
            <span className="ui-chip__text review-page-text">{page}</span>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="ui-chip__remove" aria-label="Чаты всех страниц смены" onClick={() => onPage(null)}>
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </span>
      )}
    />
  );
}

/** `?font=system`: the screen in the system's font, for comparing pictures. */
function useFontClass(): string | null {
  const location = useLocation();
  return new URLSearchParams(location.search).get("font") === "system" ? "review-content--system" : null;
}

function Loading({ back }: { back: BackTarget }) {
  const font = useFontClass();
  return (
    <>
      <ScreenHeader title={<Skeleton width={320} height={24} radius={6} />} documentTitle="Разбор смены" back={back} />
      <div className={cx("wb-content review-content", font)} aria-busy="true">
        <section className="review-overview">
          <div className="review-tiles">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="review-tile"><Skeleton width={72} height={14} radius={4} /><Skeleton width={96} height={24} radius={6} /></div>
            ))}
          </div>
          <div className="review-pulse"><Skeleton height={281} radius={6} /></div>
        </section>
        <div className="review-sheet">
          <div className="review-toolbar"><Skeleton width={560} height={32} radius={8} /></div>
          <div className="review-split">
            <div className="review-chats review-chats--loading">
              {Array.from({ length: 7 }, (_, index) => (
                <div key={index} className="review-chat-skeleton"><Skeleton width="60%" height={16} radius={4} /><Skeleton width="80%" height={14} radius={4} /></div>
              ))}
            </div>
            <div className="review-transcript review-transcript--loading">
              {[220, 320, 180, 360, 260].map((width, index) => (
                <div key={index} className={index % 2 === 0 ? "review-skeleton-msg" : "review-skeleton-msg review-skeleton-msg--page"}><Skeleton width={width} height={48} radius={12} /></div>
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
      <span className="review-title__name">{name ?? "Разбор смены"}</span>
      <span className="review-title__when">{when}</span>
    </span>
  );
  const body = kind === "missing" ? (
    <EmptyState
      title="Смены нет"
      action={nearest
        ? <LinkButton to={shiftPath(userId, nearest.startedAt, location.search)} state={location.state}>Ближайшая смена: {shiftWhen(nearest).label}</LinkButton>
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
  const when = whenOf(shift);
  useWeekOfShift(when.payDay);
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
    // The focus goes back to the bubble that opened it.
    if (ref !== null) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"] .review-bubble`)?.focus());
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
  const showAll = () => {
    search("");
    update({ span: null, page: null, show: "all", chat: null, msg: null });
  };
  const empty = emptyOf({ narrowed, query: query.trim(), span: spanMs, page: pageOn ? params.page : null, show, inBase: base.length, onClearSearch: () => search(""), onShowAll: showAll, onAll: () => update({ show: "all", chat: null, msg: null }) });
  const ownMessages = transcript?.chat.messages.filter((message) => message.mine !== null) ?? [];
  const font = useFontClass();
  const sheet = useDockingSheet();
  const toPerson = useBackState(`${shift.username}, ${when.days}`);

  const title = (
    <span className="review-title">
      <Link className="review-title__name review-title__link" to={personPath(shift.userId, location.search)} state={toPerson}>{shift.username}</Link>
      <span className="review-title__when">{when.days} {when.time}</span>
    </span>
  );
  // Rare honest notes: the archive does not hold every message yet, or a visit, not a shift.
  const notes: string[] = [];
  if (shift.kind === "visit") notes.push("это заход, а не смена");
  if (shift.unarchived > 0) notes.push(`${formatCount(shift.unarchived)} сообщ. ещё нет в архиве`);
  if (shift.deleted > 0) notes.push(`${formatCount(shift.deleted)} сообщ. удалены после отправки`);

  return (
    <>
      <ScreenHeader
        title={title}
        documentTitle={`${shift.username}, ${formatDay(shift.start)} — Разбор смены`}
        back={back}
        actions={(
          <span className="review-actions">
            {shift.ongoing && <LiveRefresh updatedAt={updatedAt} onRefresh={onRefresh} refreshing={refreshing} />}
            <ShiftStepper shift={shift} />
          </span>
        )}
      />
      <div className={cx("wb-content review-content", font)}>
        <section className="review-overview" aria-label="Вся смена">
          <Tiles tiles={tilesOf(index, when)} />
          {notes.length > 0 && <p className="review-notes">{notes.join(" · ")}</p>}
          <Pulse
            minutes={index.minutes}
            sales={index.sales}
            pauses={shift.pauses}
            start={shift.start}
            end={shift.end}
            ongoing={shift.ongoing}
            span={spanMs}
            onSpan={setSpan}
          />
        </section>
        <div ref={sheet} className="review-sheet">
          <div className="review-toolbar">
            <Segmented
              label="Какие чаты"
              value={show}
              onChange={(value) => update({ show: value, chat: null, msg: null })}
              options={(Object.keys(FILTER_WORDS) as ReviewFilter[]).map((value) => ({ value, label: FILTER_WORDS[value], count: counts[value], hint: FILTER_HINTS[value] }))}
            />
            {shift.pages.length > 1 && <PageMenu shift={shift} page={pageOn ? params.page : null} onPage={(page) => update({ page, chat: null, msg: null })} />}
            {spanMs && (
              <span className="ui-chip ui-chip--md ui-chip--selected review-pick review-span">
                <span className="ui-chip__text">{formatTimeOfDay(spanMs.from)}–{formatTimeOfDay(spanMs.to)}</span>
                <button type="button" className="ui-chip__remove" aria-label="Вся смена" onClick={() => setSpan(null)}>
                  <X size={14} strokeWidth={2} aria-hidden />
                </button>
              </span>
            )}
            <span className="review-toolbar__search">
              <SearchInput value={query} onChange={search} placeholder="Фан или слово" slashShortcut width={200} />
            </span>
          </div>
          {list.length === 0 || !active || !transcript ? (
            <div className="review-split review-split--empty">
              <EmptyState title={empty.title} action={empty.action}>{empty.text}</EmptyState>
            </div>
          ) : (
            <div className={cx("review-split", evidenceMessage && "has-evidence")}>
              <ChatList
                rows={list}
                show={show}
                activeKey={active.key}
                outsideKey={outside?.key ?? null}
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
                  shiftStart={shift.start}
                  position={{ index: ownMessages.findIndex((message) => message.ref === evidenceMessage.ref), count: ownMessages.length }}
                  onStep={stepMessage}
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

/**
 * The working sheet is as tall as the window under the title bar. The wheel over it first brings it up under the bar
 * (the page scrolls), then scrolls the list or the conversation inside it; in a narrow window the page scrolls as usual.
 */
function useDockingSheet() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sheet = ref.current;
    if (!sheet) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY <= 0 || event.ctrlKey || window.innerWidth <= 1100) return;
      const bar = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--wb-bar")) || 72;
      const left = sheet.getBoundingClientRect().top - bar;
      if (left <= 1) return;
      event.preventDefault();
      window.scrollBy({ top: Math.min(left, event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY) });
    };
    sheet.addEventListener("wheel", onWheel, { passive: false });
    return () => sheet.removeEventListener("wheel", onWheel);
  }, []);
  return ref;
}

/**
 * The period follows the shift (M6): a review opened (or stepped to) outside the
 * address's period puts the week of the shift's day there, so «Карточка», the
 * menu and «←» without a state open the dates that hold this shift.
 */
function useWeekOfShift(payDay: string) {
  const { period } = usePeriod();
  const location = useLocation();
  const navigate = useNavigate();
  const inside = payDay >= period.from && payDay <= period.to;
  useEffect(() => {
    if (inside) return;
    const next = withPeriod(new URLSearchParams(location.search), { kind: "week", monday: mondayOf(payDay) });
    void navigate({ search: `?${next.toString()}` }, { replace: true, state: location.state });
  }, [inside, payDay, location.search, location.state, navigate]);
}

/** What an empty list says: what narrowed it, and the one way back. */
function emptyOf({ narrowed, query, span, page, show, inBase, onClearSearch, onShowAll, onAll }: {
  narrowed: boolean;
  query: string;
  span: { from: number; to: number } | null;
  page: string | null;
  show: ReviewFilter;
  /** Chats left after the page, the minutes and the search, before the list's own choice. */
  inBase: number;
  onClearSearch: () => void;
  onShowAll: () => void;
  onAll: () => void;
}): { title: string; text: string; action: ReactNode } {
  if (narrowed) {
    const parts: string[] = [];
    if (query !== "") parts.push(`поиск «${query}»`);
    if (span) parts.push(`время ${formatTimeOfDay(span.from)}–${formatTimeOfDay(span.to)}`);
    if (page) parts.push(`страница ${page}`);
    if (show !== "all" && inBase > 0) parts.push(`отбор «${FILTER_WORDS[show]}»`);
    if (parts.length === 1 && query !== "") {
      return { title: `Нет чатов со словами «${query}»`, text: "Поиск идёт по именам фанов и текстам всей смены.", action: <Button onClick={onClearSearch}>Очистить поиск</Button> };
    }
    return { title: "Таких чатов нет", text: `Список сужают: ${parts.join(", ")}.`, action: <Button onClick={onShowAll}>Показать все чаты смены</Button> };
  }
  if (inBase > 0) return { title: FILTER_EMPTY[show], text: "Остальные чаты смены — в «Все».", action: <Button onClick={onAll}>Все чаты · {formatCount(inBase)}</Button> };
  return { title: "В смене нет чатов", text: "Чаттер в эту смену никому не писал, и фаны его страниц не ждали ответа.", action: null };
}
