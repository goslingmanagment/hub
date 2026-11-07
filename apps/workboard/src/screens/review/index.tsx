import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { Button, Chip, EmptyState, ErrorState, Facts, Kbd, LinkButton, Money, SearchInput, Segmented, Skeleton, Tooltip, type FactItem } from "@agency_hub_core/ui";
import { formatCount, formatDay, formatDuration, formatMills, formatPercent, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { CHATTER_SHIFT_PAGE_MIN_MESSAGES } from "@agency_hub_core/contracts";
import { parseShiftKey, personPath, useBackTarget, type BackTarget } from "@/shared/links";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { ChatList } from "./ChatList.js";
import { useShiftReview, type ReviewChatRow, type ReviewFilter, type ReviewIndex, type ReviewModel, type ReviewShift } from "./data.js";
import { Evidence } from "./Evidence.js";
import { Pulse } from "./Pulse.js";
import { REPLY_FAST_SECONDS, REPLY_NORM_SECONDS, waitText } from "./rules.js";
import { ShiftStepper } from "./ShiftStepper.js";
import { Transcript } from "./Transcript.js";
import { useReviewParams, type ReviewChange, type ReviewParams } from "./useReviewParams.js";
import "./review.css";

/**
 * Разбор смены (spec §4.2): one chatter's shift opened up, the core of
 * Workboard. One sticky line names the shift; one line of facts; the pulse of
 * its minutes; then the chats and the conversation fill the rest of the window,
 * so the conversation is in sight at 1440×900 without scrolling. Everything
 * chosen is in the address; ↑ ↓ (J K) step through the chats.
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
  look: "Чаты с причиной посмотреть (без ответа, долгое ожидание, платное, повтор текста, ИИ без правки) и 2 обычных диалога для сравнения",
  unanswered: "Фан писал в смену, ответа чаттера до конца смены не было",
  waited: `Фан ждал ответа дольше ${REPLY_NORM_SECONDS / 60} мин: с ответом в смену или без него`,
  paid: "Платные сообщения, чаевые или продажи этому фану в смену",
  all: "Все чаты смены по времени",
};

/** The order of each list: what to read first. */
function ordered(rows: readonly ReviewChatRow[], filter: ReviewFilter): ReviewChatRow[] {
  const when = (row: ReviewChatRow) => row.firstAt ?? row.waitingSince ?? Number.MAX_SAFE_INTEGER;
  const list = [...rows];
  switch (filter) {
    case "look": return list.sort((a, b) => a.tier - b.tier || b.waitSeconds - a.waitSeconds || b.paidMills - a.paidMills || when(a) - when(b));
    case "unanswered":
    case "waited": return list.sort((a, b) => b.waitSeconds - a.waitSeconds || when(a) - when(b));
    case "paid": return list.sort((a, b) => b.paidMills - a.paidMills || when(a) - when(b));
    case "all": return list.sort((a, b) => when(a) - when(b));
  }
}

/** «чт, 6 нояб. · 09:16–18:53»; a night shift says both days; a shift going on — since when. */
function whenText(shift: ReviewShift): string {
  const day = (at: number) => new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
  if (shift.ongoing) return `${formatWeekdayDay(shift.start)} · с ${formatTimeOfDay(shift.start)}, идёт`;
  if (day(shift.start) !== day(shift.end)) return `${formatDay(shift.start).replace(/ .*/, "")}–${formatDay(shift.end)} · ${formatTimeOfDay(shift.start)}–${formatTimeOfDay(shift.end)}`;
  return `${formatWeekdayDay(shift.start)} · ${formatTimeOfDay(shift.start)}–${formatTimeOfDay(shift.end)}`;
}

function Hint({ children, content }: { children: ReactNode; content: ReactNode }) {
  return <Tooltip content={<span className="review-tip">{content}</span>} side="bottom" align="start"><span className="review-hint">{children}</span></Tooltip>;
}

function factsOf(index: ReviewIndex): FactItem[] {
  const { shift, totals } = index;
  const withText = totals.origin.ai + totals.origin.fix + totals.origin.own;
  const notMine = totals.handedOverUnanswered + totals.colleagueUnanswered;
  return [
    {
      label: "Продажи",
      strong: true,
      value: (
        <Hint content={<>
          Продажи на страницах смены после комиссии, пока она их держала, как в «Сменах».
          {shift.chatsNetMills !== shift.salesNetMills && <> В чатах ниже — {formatMills(shift.chatsNetMills)}: остальное купили фаны без переписки в эту смену.</>}
          {totals.ppvSent > 0 && <> Платных сообщений куплено {formatCount(totals.ppvBought)} из {formatCount(totals.ppvSent)}.</>}
        </>}>
          <Money mills={shift.salesNetMills} strong />
        </Hint>
      ),
    },
    {
      label: "Сообщений",
      value: (
        <Hint content={<>Личные сообщения фанам{totals.perHour !== null && <>, {totals.perHour.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} в час без пауз</>}.{totals.massMessages > 0 && <> Рассылкой ещё {formatCount(totals.massMessages)} — их здесь не считаем.</>}</>}>
          {formatCount(totals.messages)}{totals.massMessages > 0 && <span className="review-facts__quiet"> +{formatCount(totals.massMessages)} рассылкой</span>}
        </Hint>
      ),
    },
    {
      // Not «Все» of the list: that one holds the fans who only waited and the colleagues' chats too.
      label: "Писал в чатах",
      value: (
        <Hint content={<>Чаты, где чаттер писал в смену{totals.chatsFanSilent > 0 && <>; в {formatCount(totals.chatsFanSilent)} из них фан в смену не писал (приветствия, первые сообщения)</>}.</>}>
          {formatCount(totals.chats)}
        </Hint>
      ),
    },
    {
      label: "Ответ, медиана",
      value: (
        <Hint content={totals.replies === 0 ? "Ответов фанам в смену не было." : (
          <>
            {formatCount(totals.replies)} {ruPlural(totals.replies, "ответ", "ответа", "ответов")}: до {REPLY_FAST_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinFast) / totals.replies)}, до {REPLY_NORM_SECONDS / 60} мин — {formatPercent((100 * totals.repliesWithinNorm) / totals.replies)}.
            {totals.repliesToInherited > 0 && <> {formatCount(totals.repliesToInherited)} — ждавшим с прошлых смен: их ожидание считается с начала смены.</>}
          </>
        )}>
          {totals.replyMedianSeconds === null ? "—" : waitText(totals.replyMedianSeconds)}
        </Hint>
      ),
    },
    {
      label: shift.ongoing ? "Ждут ответа сейчас" : "Без ответа к концу",
      value: (
        <Hint content={<>
          Фаны чаттера, писавшие в смену, без ответа {shift.ongoing ? "сейчас" : "до её конца"}.
          {totals.unansweredInherited > 0 && <> Из них ждали ещё с прошлых смен: {formatCount(totals.unansweredInherited)}.</>}
          {totals.unansweredLate > 0 && <> Написали за последние {REPLY_NORM_SECONDS / 60} мин: {formatCount(totals.unansweredLate)}.</>}
          {totals.waitingSilently > 0 && <> Ещё {formatCount(totals.waitingSilently)} ждали с прошлых смен и в смену не писали — не в счёте.</>}
          {notMine > 0 && <> Ещё {formatCount(notMine)} без ответа после сообщения коллеги — не в счёте.</>}
        </>}>
          {formatCount(totals.unanswered)}
          {notMine > 0 && <span className="review-facts__quiet"> +{formatCount(notMine)} у коллег</span>}
        </Hint>
      ),
    },
    {
      label: "Текст из ИИ",
      value: (
        <Hint content={withText === 0 ? "Сообщений с текстом не было." : (
          <>
            {formatCount(totals.origin.ai)} из {formatCount(withText)} сообщений с текстом{totals.origin.copied > 0 && <>, из них вставлено вручную {formatCount(totals.origin.copied)}</>}.
            {" "}Свой черновик, поправленный ИИ, — {formatCount(totals.origin.fix)}; сам — {formatCount(totals.origin.own)}.
            {totals.origin.hi > 0 && <> Приветствия ИИ ({formatCount(totals.origin.hi)}) не в счёте.</>}
          </>
        )}>
          {withText === 0 ? "—" : formatPercent((100 * totals.origin.ai) / withText)}
        </Hint>
      ),
    },
  ];
}

/** Under the title: how long, the pages (a page narrows the chats), what is missing from the screen. */
function Meta({ shift, page, onPage }: { shift: ReviewShift; page: string | null; onPage: (page: string | null) => void }) {
  const notes: string[] = [];
  if (shift.kind === "visit") notes.push("это заход, а не смена");
  if (shift.unarchived > 0) notes.push(`${formatCount(shift.unarchived)} сообщ. чаттера ещё нет в архиве — их нет и здесь`);
  if (shift.deleted > 0) notes.push(`${formatCount(shift.deleted)} сообщ. удалены после отправки — их здесь нет`);
  return (
    <span className="review-meta">
      <span>{shift.ongoing ? "идёт" : "работал"} {formatDuration(shift.workedMinutes)}{shift.pauseMinutes > 0 && <>, паузы {formatDuration(shift.pauseMinutes)}</>}</span>
      {shift.pages.length === 1 && (
        <span className="review-meta__pages">
          <span className="review-page review-page--static" title={`${formatCount(shift.pages[0]!.messages)} ${ruPlural(shift.pages[0]!.messages, "сообщение", "сообщения", "сообщений")} чаттера, рассылки тоже`}>{shift.pages[0]!.pageLabel}</span>
        </span>
      )}
      {shift.pages.length > 1 && (
        <span className="review-meta__pages" role="group" aria-label="Страницы смены: нажмите, чтобы оставить чаты одной страницы">
          {shift.pages.map((one) => (
            <button
              key={one.pageLabel}
              type="button"
              className={page === one.pageLabel ? "review-page is-on" : "review-page"}
              aria-pressed={page === one.pageLabel}
              onClick={() => onPage(page === one.pageLabel ? null : one.pageLabel)}
              title={`${one.pageLabel}: ${formatCount(one.messages)} ${ruPlural(one.messages, "сообщение", "сообщения", "сообщений")} чаттера, рассылки тоже.${!one.worked && shift.kind === "shift" ? ` Меньше ${CHATTER_SHIFT_PAGE_MIN_MESSAGES}: продажи страницы не в этой смене, здесь только чаты, где писал чаттер.` : ""} ${page === one.pageLabel ? "Нажмите, чтобы показать все страницы." : "Нажмите, чтобы оставить чаты только этой страницы."}`}
            >
              {one.pageLabel}
              {!one.worked && shift.kind === "shift" && <span className="review-page__count">заглядывал</span>}
            </button>
          ))}
        </span>
      )}
      {notes.length > 0 && <span className="review-meta__note">{notes.join(" · ")}</span>}
    </span>
  );
}

function Loading({ back }: { back: BackTarget }) {
  return (
    <>
      <ScreenHeader title={<Skeleton width={260} height={28} radius={6} />} documentTitle="Разбор смены" back={back} meta={<Skeleton width={360} height={20} radius={6} />} />
      <div className="wb-content review-content" aria-busy="true">
        <div className="review-facts review-facts--loading">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} width={index === 0 ? 150 : 120} height={22} radius={6} />)}
        </div>
        <div className="review-panes">
          <div className="review-pulse"><Skeleton height={78} radius={6} /></div>
          <div className="review-toolbar"><Skeleton width={620} height={36} radius={8} /></div>
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

function Problem({ back, status, retry, retrying, userId, search }: { back: BackTarget; status: number | null; retry: () => void; retrying: boolean; userId: number; search: string }) {
  const body = status === 404 || status === 400
    ? (
      <EmptyState title="Смены нет" action={<LinkButton to={personPath(userId, search, "shifts")}>Смены этого человека</LinkButton>}>
        В это время у этого человека не было смены в расширении. Откройте смену из списка.
      </EmptyState>
    )
    : status === 403
      ? <EmptyState title="Разбор смены — только для владельца">В нём тексты ИИ и черновики чаттеров: Hub показывает их только владельцу.</EmptyState>
      : <ErrorState onRetry={retry} retrying={retrying} />;
  return (
    <>
      <ScreenHeader title="Разбор смены" back={back} />
      <div className="wb-content">{body}</div>
    </>
  );
}

export function ReviewScreen() {
  const { userId: rawUser, shiftStart } = useParams();
  const userId = Number(rawUser);
  const at = parseShiftKey(shiftStart);
  const back = useBackTarget({ to: "/shifts", label: "Смены" });
  if (!Number.isInteger(userId) || userId <= 0 || at === null) {
    return (
      <>
        <ScreenHeader title="Разбор смены" back={back} />
        <div className="wb-content">
          <EmptyState title="Смена не найдена в адресе" action={<LinkButton to="/shifts">К сменам</LinkButton>}>Откройте смену из журнала смен или со страницы человека.</EmptyState>
        </div>
      </>
    );
  }
  return <Review key={`${userId}:${at}`} userId={userId} at={at} back={back} />;
}

function Review({ userId, at, back }: { userId: number; at: string; back: BackTarget }) {
  const { query, model } = useShiftReview(userId, at);
  const [params, update] = useReviewParams();
  const location = useLocation();
  if (!model) {
    if (query.isError) {
      return <Problem back={back} status={hubErrorStatus(query.error)} retry={() => void query.refetch()} retrying={query.isFetching} userId={userId} search={location.search} />;
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
  const location = useLocation();
  const { index } = model;
  const { shift } = index;
  const pageKnown = params.page !== null && shift.pages.some((one) => one.pageLabel === params.page);

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
  const search = (value: string) => {
    setQuery(value);
    written.current = value;
    update({ q: value, chat: null, msg: null });
  };
  const matching = useMemo(() => model.matching(query), [model, query]);

  // Every count follows what narrows the list: the page, the search, the picked minutes.
  const base = useMemo(() => index.chats.filter((row) => (!pageKnown || row.pageLabel === params.page)
    && (matching === null || matching.has(row.key))
    && (busy === null || busy.has(row.key))), [index.chats, pageKnown, params.page, matching, busy]);
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

  const setSpan = (span: { from: number; to: number } | null) => update({
    span: span === null ? null : {
      from: Math.max(0, Math.floor((span.from - shift.start) / MINUTE_MS)),
      to: Math.max(1, Math.ceil((Math.min(span.to, shift.end) - shift.start) / MINUTE_MS)),
    },
    chat: null,
    msg: null,
  });
  const narrowed = query.trim() !== "" || params.span !== null || pageKnown;
  const multiPage = shift.pages.length > 1 && !pageKnown;

  const title = (
    <span className="review-title">
      <Link to={personPath(shift.userId, location.search)} state={{ back: { to: `${location.pathname}${location.search}`, label: "Разбор" } }} className="ui-quiet-link" title={`Карточка ${shift.username}`}>{shift.username}</Link>
      <span className="review-title__when">{whenText(shift)}</span>
    </span>
  );

  return (
    <>
      <ScreenHeader
        title={title}
        documentTitle={`${shift.username}, ${formatDay(shift.start)} — Разбор смены`}
        back={back}
        actions={<ShiftStepper shift={shift} />}
        meta={<Meta shift={shift} page={pageKnown ? params.page : null} onPage={(page) => update({ page, chat: null, msg: null })} />}
        updatedAt={updatedAt}
        // A finished shift is read once; one going on is read every 2 min and can be read now.
        {...(shift.ongoing ? { onRefresh } : {})}
        refreshing={refreshing}
      />
      <div className="wb-content review-content">
        <Facts items={factsOf(index)} className="review-facts" label="Смена в цифрах" />
        <div className={evidenceMessage ? "review-panes has-evidence" : "review-panes"}>
          <Pulse
            minutes={index.minutes}
            sales={index.sales}
            pauses={shift.pauses}
            start={shift.start}
            end={shift.end}
            ongoing={shift.ongoing}
            span={spanMs}
            silences={index.silences}
            onSpan={setSpan}
          />
          <div className="review-toolbar">
            <Segmented
              label="Какие чаты"
              value={show}
              onChange={(value) => update({ show: value, chat: null, msg: null })}
              options={(Object.keys(FILTER_WORDS) as ReviewFilter[]).map((value) => ({ value, label: FILTER_WORDS[value], count: counts[value], title: FILTER_TITLES[value] }))}
            />
            <SearchInput value={query} onChange={search} placeholder="Фан или слово" slashShortcut width={240} />
            {spanMs !== null && (
              <Chip size="md" selected onRemove={() => setSpan(null)} removeLabel="Показать всю смену" title="Выбрано на пульсе">
                {formatTimeOfDay(spanMs.from)}–{formatTimeOfDay(spanMs.to)}
              </Chip>
            )}
            {params.page !== null && (
              <Chip size="md" selected onRemove={() => update({ page: null, chat: null })} removeLabel="Все страницы смены" title={pageKnown ? "Только чаты этой страницы" : "Этой страницы нет в смене"}>
                {pageKnown ? params.page : `${params.page} — нет в этой смене`}
              </Chip>
            )}
            <span className="review-toolbar__keys" aria-hidden><Kbd>↑</Kbd><Kbd>↓</Kbd> соседний чат</span>
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
            <div className="review-split">
              <ChatList
                rows={list}
                activeKey={active.key}
                outsideKey={outside?.key ?? null}
                showPage={multiPage}
                ongoing={shift.ongoing}
                shiftStart={shift.start}
                onPick={(key) => update({ chat: key, msg: null })}
              />
              <Transcript
                shift={shift}
                transcript={transcript}
                row={active}
                position={{ index: activeIndex, count: list.length }}
                onStep={step}
                span={spanMs}
                query={query}
                openMessage={evidenceMessage?.ref ?? null}
                onEvidence={(ref) => go(active.key, cursor.current.msg === ref ? null : ref)}
              />
            </div>
          )}
        </div>
      </div>
      {evidenceMessage && transcript && (
        <Evidence
          transcript={transcript}
          message={evidenceMessage}
          username={shift.username}
          onStep={(ref) => go(active!.key, ref)}
          onClose={() => go(active!.key, null)}
        />
      )}
    </>
  );
}
