import { CircleCheck, ExternalLink } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import type { Matter, TeamLedgerQuestion } from "@agency_hub_core/contracts";
import { Button, Disclosure, ErrorState, Notice, Skeleton, fanText } from "@agency_hub_core/ui";
import { formatDay, formatDateTime, formatMills, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { partLabel, purposeLabel } from "@agency_hub_core/ui/heldSends";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { postFlagWord } from "@agency_hub_core/ui/shiftReports";
import { customsQuery, heldSendsQuery, saleQuestionsQuery } from "@/shared/decisions";
import { consoleHref } from "@/shared/links";
import { mattersListQuery, mattersWaitingQuery } from "@/shared/matters";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePages } from "@/shared/usePages";
import { ResolveSendModal } from "../decisions/HeldSends";
import { useFanNames, type Custom, type FanRefOnPage, type HeldSend, type KnownFan } from "../decisions/data";
import { WAITING_GROUPS, groupOf, groupOfAnchor, uncheckedWords, waitedFor, waitingSince, type WaitingGroupId } from "./kinds";
import "./waiting.css";

/**
 * «Ждут вас» (ecosystem plan §6, package K): one list of everything that waits
 * for the person — the old sections of «Решения» and «Ждут вас» of the console
 * as kinds of the same list, and the new checks. One line per matter: what it
 * is, what it is about, how long it waits, the one action or the link. The
 * longest waiting first in each group; what only informs stands apart at the
 * end and counts nowhere. A kind whose source did not answer is said once at
 * the top: «не проверено» is never «всё хорошо». The address is today's
 * `/decisions`: its anchors (`#questions`, `#reports`, `#customs`, `#held`,
 * and the console's `#people`, `#ledger`) open the list of that group alone;
 * `?send=` opens a held send's resolve, as before.
 */

const MINUTE = 60_000;

interface Line {
  /** Unique on the screen: the matter's id, or a count row's id (`row:customs`). */
  key: string;
  matter: Matter | null;
  group: WaitingGroupId;
  since: string;
  title: ReactNode;
  about: ReactNode[];
  action: ReactNode;
}

interface Context {
  question: (id: unknown) => TeamLedgerQuestion | undefined;
  custom: (id: unknown) => Custom | undefined;
  held: (id: string) => HeldSend | undefined;
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined;
  openSend: (attemptId: string) => void;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A matter's link: Workboard's own (`/workboard/…`) inside the app, the console's by a page load. */
function GoLink({ link, children = "Открыть" }: { link: string; children?: ReactNode }) {
  if (link.startsWith("/workboard/") || link === "/workboard") {
    const inside = link.slice("/workboard".length) || "/";
    return <Link to={inside} className="wt-go">{children}</Link>;
  }
  return <a href={consoleHref(link)} className="wt-go">{children}</a>;
}

/** A message in Telegram (a question, a post): another site, a new tab. */
function TelegramLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="wt-go">
      {children}
      <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
    </a>
  );
}

function fanWords(fan: KnownFan | undefined, fanRef: string | null, fallback: string | null = null): string | null {
  if (fanRef === null) return fallback;
  return fanText({ name: fan?.name ?? fallback, username: fan?.username ?? null, fanRef });
}

/** One line of a matter: the kinds the list knows get their words; any other shows its own title and link. */
function lineOf(matter: Matter, context: Context): Line {
  const evidence = matter.evidence;
  const pages = matter.pageLabels;
  const base: Line = {
    key: String(matter.id),
    matter,
    group: groupOf(matter.kind),
    since: waitingSince(matter),
    title: matter.title,
    about: pages.length > 0 ? [pages.join(", ")] : [],
    action: matter.link ? <GoLink link={matter.link} /> : null,
  };
  switch (matter.kind) {
    case "ledger.sale_question": {
      const question = context.question(evidence.questionId);
      const net = number(evidence.netMills);
      const fan = question?.fanRef ? fanWords(context.fanOf({ pageLabel: question.pageLabel, fanRef: question.fanRef }), question.fanRef, question.fanName) : question?.fanName ?? null;
      return {
        ...base,
        title: question?.question ?? matter.title,
        about: [fan, ...pages, net === null ? "ещё не оплачено" : formatMills(net)].filter((part): part is string => part !== null),
        action: question?.sourceLink ? <TelegramLink href={question.sourceLink}>Сообщение</TelegramLink> : <span className="wt-quiet">ответ в чате Генгара</span>,
      };
    }
    case "ledger.report_post": {
      const day = text(evidence.reportDate);
      const flags = Array.isArray(evidence.flags) ? evidence.flags.filter((flag): flag is string => typeof flag === "string") : [];
      const total = number(evidence.totalMills);
      const telegram = text(evidence.telegram);
      return {
        ...base,
        title: "Пост в «Отчётности» не разобран",
        about: [day ? formatWeekdayDay(`${day}T12:00:00+03:00`) : null, flags.length > 0 ? flags.map(postFlagWord).join(", ") : null, total === null ? null : `в посте ${formatMills(total)}`, ...pages]
          .filter((part): part is string => part !== null),
        action: telegram ? <TelegramLink href={telegram}>Пост</TelegramLink> : null,
      };
    }
    case "ledger.paid_day_changed": {
      const was = number(evidence.postedMills);
      const now = number(evidence.newMills);
      const model = text(evidence.model);
      return {
        ...base,
        about: [was !== null && now !== null ? `было ${formatMills(was)}, стало ${formatMills(now)}` : null, model, "войдёт в выплату после вашего «да» в ledger"]
          .filter((part): part is string => part !== null),
        action: matter.link ? <GoLink link={matter.link}>В выплатах</GoLink> : null,
      };
    }
    case "custom.paid_not_delivered": {
      const custom = context.custom(evidence.customId);
      if (!custom) return base;
      return {
        ...base,
        title: custom.description,
        about: [fanWords(context.fanOf(custom), custom.fanRef), custom.pageLabel, custom.priceMills === null ? null : formatMills(custom.priceMills), `записал ${custom.createdBy}`]
          .filter((part): part is string => part !== null),
        action: <span className="wt-quiet">отметит чаттер</span>,
      };
    }
    case "send.held": {
      const attemptId = text(evidence.attemptId) ?? matter.object?.id ?? "";
      const send = context.held(attemptId);
      const purpose = text(evidence.purpose);
      const sentBy = text(evidence.sentBy);
      const title = send ? `${purposeLabel(send.purpose)}, ${partLabel(send)}` : purpose ? `${purposeLabel(purpose)}: отправка без отчёта` : matter.title;
      return {
        ...base,
        title,
        about: [send ? fanWords(context.fanOf(send), send.fanRef) : null, ...pages, sentBy ? `отправлял ${sentBy}` : null].filter((part): part is string => part !== null),
        action: <Button size="sm" variant="secondary" onClick={() => context.openSend(attemptId)}>Разобрать</Button>,
      };
    }
    case "extension.critical": {
      const total = number(evidence.total);
      return { ...base, about: total === null ? [] : [`${total} за 7 дней`] };
    }
    case "people.login_unlinked": {
      const namesake = evidence.namesake as { name?: unknown; state?: unknown; leftOn?: unknown } | null | undefined;
      const tail = namesake && typeof namesake.name === "string"
        ? `похож на ${namesake.name}${namesake.state === "left" ? `, ${text(namesake.leftOn) ? `ушёл ${formatDay(`${String(namesake.leftOn)}T12:00:00+03:00`)}` : "ушёл"}` : ""}; свяжите вход с человеком или отключите его`
        : "свяжите вход с человеком или отключите его";
      return { ...base, about: [tail] };
    }
    case "people.left_with_access": {
      const logins = Array.isArray(evidence.logins) ? evidence.logins.join(", ") : "";
      const tokens = number(evidence.deviceTokens) ?? 0;
      const keys = Array.isArray(evidence.agentKeys) ? evidence.agentKeys.join(", ") : "";
      return {
        ...base,
        about: [logins ? `входы: ${logins}` : null, tokens > 0 ? `${tokens} ${ruPlural(tokens, "устройство", "устройства", "устройств")}` : null, keys ? `ключи: ${keys}` : null]
          .filter((part): part is string => part !== null),
      };
    }
    case "people.access_idle": {
      const people = Array.isArray(evidence.people) ? (evidence.people as Array<{ name?: unknown; pages?: unknown }>) : [];
      const since = text(evidence.activitySince);
      return {
        ...base,
        about: [
          ...people.map((person) => `${String(person.name ?? "")}: ${Array.isArray(person.pages) ? person.pages.join(", ") : ""}`),
          since ? `работа в расширении известна с ${formatDay(`${since}T12:00:00+03:00`)}` : null,
        ].filter((part): part is string => part !== null),
      };
    }
    case "ledger.check": {
      const summary = text(evidence.summary);
      return { ...base, about: summary ? [summary] : [], action: <span className="wt-quiet">в ledger</span> };
    }
    case "ledger.sheet_column": {
      const tabs = Array.isArray(evidence.tabs) ? (evidence.tabs as Array<{ model?: unknown; tab?: unknown; lastColumn?: unknown }>) : [];
      return {
        ...base,
        about: tabs.map((tab) => `${String(tab.model)}/${String(tab.tab)}: ${text(tab.lastColumn) ? `последняя колонка ${formatDay(`${String(tab.lastColumn)}T12:00:00+03:00`)}` : "колонок нет"}`),
        action: <span className="wt-quiet">добавьте блок недели</span>,
      };
    }
    case "ledger.off_platform": {
      const net = number(evidence.netMills);
      const saidBy = text(evidence.saidBy);
      const telegram = text(evidence.telegram);
      return {
        ...base,
        about: [net === null ? "сумма не названа" : formatMills(net), saidBy ? `со слов ${saidBy}` : null, ...pages].filter((part): part is string => part !== null),
        action: telegram ? <TelegramLink href={telegram}>Сообщение</TelegramLink> : <span className="wt-quiet">в ledger</span>,
      };
    }
    default:
      return base;
  }
}

function LineRow({ line, now }: { line: Line; now: number }) {
  // A page the title already names is not said twice.
  const about = typeof line.title === "string" ? line.about.filter((part) => typeof part !== "string" || !(line.title as string).includes(part)) : line.about;
  return (
    <li className="wt-line">
      <div className="wt-line__main">
        <span className="wt-line__title">{line.title}</span>
        {about.length > 0 && (
          <span className="wt-line__about">
            {about.map((part, index) => (
              <Fragment key={index}>
                {index > 0 && <span aria-hidden className="wt-dot"> · </span>}
                <span>{part}</span>
              </Fragment>
            ))}
          </span>
        )}
      </div>
      <span className="wt-line__age" title={`С ${formatDateTime(line.since, { yearUnlessCurrent: true })}`}>{waitedFor(line.since, now)}</span>
      <span className="wt-line__go">{line.action}</span>
    </li>
  );
}

/** A long group shows its longest waiting lines and the rest on a press. */
const GROUP_SHOWN = 10;

function Group({ id, title, lines, now }: { id: WaitingGroupId; title: string; lines: readonly Line[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, GROUP_SHOWN);
  return (
    <section className="wt-group" id={id} aria-labelledby={`wt-${id}`}>
      <h2 className="wt-group__title" id={`wt-${id}`}>
        {title}
        <span className="wt-group__count">{lines.length}</span>
      </h2>
      <ul className="wt-lines">
        {shown.map((line) => <LineRow key={line.key} line={line} now={now} />)}
      </ul>
      {shown.length < lines.length && (
        <button type="button" className="wt-link wt-more" onClick={() => setAll(true)}>
          показать ещё {lines.length - shown.length}
        </button>
      )}
    </section>
  );
}

/** Whom a matter waits for, as the line of «Ждут других» says it. */
const ROLE_WORD: Readonly<Record<string, string>> = { owner: "владелец", team_lead: "тимлид", chatter: "чаттеры" };
function whoseWord(matter: Matter): string {
  return matter.owner.kind === "user" ? matter.owner.username || `вход №${matter.owner.userId}` : ROLE_WORD[matter.owner.role] ?? matter.owner.role;
}

/** The group a «Ждут вас» row of a count (no matter behind it: the custom orders' number) stands in. */
const COUNT_ROW_GROUP: Readonly<Record<string, WaitingGroupId>> = { customs: "customs" };

/** «Ждут вас»'s rows that are a count, not matters (the orders paid or shot and not given), as lines of the list. */
function countLines(rows: ReadonlyArray<{ id: string; label: string; count: number | null; to: string; matterIds: readonly number[] }>, now: number): Line[] {
  return rows.filter((row) => row.matterIds.length === 0 && row.count !== null && row.count > 0).map((row) => ({
    key: `row:${row.id}`,
    matter: null,
    group: COUNT_ROW_GROUP[row.id] ?? "other",
    since: new Date(now).toISOString(),
    title: `${row.label}: ${row.count}`,
    about: [],
    action: <GoLink link={row.to}>Открыть доску</GoLink>,
  }));
}

export function WaitingScreen() {
  const { isOwner } = useMe();
  const { page, setPage } = usePageFilter();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const pages = usePages();
  const list = useQuery({ ...mattersListQuery, refetchInterval: MINUTE });
  // The rows of «Ждут вас»: a row that is a count without matters (the custom orders) is a line here too.
  const rows = useQuery({ ...mattersWaitingQuery(), refetchInterval: MINUTE });
  const matters = list.data?.matters ?? [];
  const has = (kind: string) => matters.some((matter) => matter.kind === kind);
  const attemptId = search.get("send");

  // What a line needs beyond its matter: the question's words, the custom's order, the held send itself.
  const questions = useQuery({ ...saleQuestionsQuery, enabled: isOwner && has("ledger.sale_question"), refetchInterval: 5 * MINUTE });
  const customs = useQuery({ ...customsQuery, enabled: has("custom.paid_not_delivered"), refetchInterval: MINUTE });
  const held = useQuery({ ...heldSendsQuery({ limit: 100, offset: 0 }), enabled: has("send.held") || attemptId !== null, refetchInterval: MINUTE });
  const fans: FanRefOnPage[] = [
    ...(questions.data?.owner ?? []).flatMap((question) => (question.fanRef === null || question.pageLabel === "" ? [] : [{ pageLabel: question.pageLabel, fanRef: question.fanRef }])),
    ...(customs.data?.customs ?? []).filter((custom) => custom.state === "paid"),
    ...(held.data?.items ?? []),
  ];
  const fanOf = useFanNames(fans);

  const setSend = (value: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete("send");
    else next.set("send", value);
    return next;
  });
  const context: Context = {
    question: (id) => questions.data?.owner.find((one) => one.id === id),
    custom: (id) => customs.data?.customs.find((one) => one.id === id),
    held: (id) => held.data?.items.find((one) => one.attemptId === id),
    fanOf,
    openSend: (id) => setSend(id),
  };
  // The open resolve keeps the record it was opened with while Hub answers (as on «Решения»).
  const lastSend = useRef<HeldSend | null>(null);
  const foundSend = attemptId ? held.data?.items.find((one) => one.attemptId === attemptId) : undefined;
  if (foundSend) lastSend.current = foundSend;
  const openSend = foundSend ?? (attemptId && lastSend.current?.attemptId === attemptId ? lastSend.current : undefined);
  const platformOf = (label: string) => pages.data?.find((one) => one.label === label)?.platform;

  const onPage = (matter: Matter) => page === null || matter.pageLabels.length === 0 || matter.pageLabels.includes(page);
  const now = list.data ? Date.parse(list.data.serverNow) : Date.now();
  // What waits for the viewer themself is the list; what waits for someone else is oversight below, counted nowhere.
  const mine = matters.filter((matter) => matter.mine);
  const lines = [...mine.filter(onPage).map((matter) => lineOf(matter, context)), ...(page === null ? countLines(rows.data?.rows ?? [], now) : [])];
  const elsewhere = page === null ? 0 : mine.filter((matter) => !onPage(matter) && groupOf(matter.kind) !== "info").length;
  const only = groupOfAnchor(location.hash);
  const shown = only === null ? lines : lines.filter((line) => line.group === only);
  const groups = WAITING_GROUPS.map((group) => ({
    ...group,
    lines: shown.filter((line) => line.group === group.id).sort((left, right) => left.since.localeCompare(right.since) || left.key.localeCompare(right.key)),
  })).filter((group) => group.lines.length > 0);
  const others = matters.filter((matter) => !matter.mine && onPage(matter))
    .map((matter) => {
      const line = lineOf(matter, context);
      return { ...line, about: [`ждёт: ${whoseWord(matter)}`, ...line.about] };
    })
    .filter((line) => only === null || line.group === only)
    .sort((left, right) => left.since.localeCompare(right.since) || left.key.localeCompare(right.key));
  const waiting = groups.filter((group) => group.id !== "info");
  const info = groups.find((group) => group.id === "info");
  const waitingCount = waiting.reduce((sum, group) => sum + group.lines.length, 0);
  const unchecked = uncheckedWords((list.data?.kinds ?? []).filter((kind) => kind.checked === "no").map((kind) => kind.kind));
  const onlyTitle = only === null ? null : WAITING_GROUPS.find((group) => group.id === only)?.title ?? null;

  // A link with an anchor lands at its group once the list has answered (the old screen's sections did the same).
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (list.isLoading || location.hash === "" || jumped.current === location.key) return;
    jumped.current = location.key;
    window.scrollTo({ top: 0 });
  }, [list.isLoading, location.hash, location.key]);

  const meta = list.isLoading ? <Skeleton width={260} /> : (
    <>
      {onlyTitle !== null ? (
        <>
          Только «{onlyTitle}» ·{" "}
          <button type="button" className="wt-link" onClick={() => navigate({ search: location.search, hash: "" }, { replace: true })}>показать всё</button>
        </>
      ) : waitingCount + (info?.lines.length ?? 0) > 0 ? "Сначала то, что ждёт дольше. Время московское" : null}
      {elsewhere > 0 && (
        <>
          {" · "}
          <button type="button" className="wt-link" onClick={() => setPage(null)}>
            ещё {elsewhere} на других страницах
          </button>
        </>
      )}
    </>
  );

  return (
    <>
      <ScreenHeader
        title="Ждут вас"
        pageFilter
        meta={meta}
        updatedAt={list.dataUpdatedAt}
        stale={list.isRefetchError}
        onRefresh={() => void list.refetch()}
        refreshing={list.isFetching}
      />
      <div className="wb-content wt-content">
        {list.isLoading ? (
          <div className="wt-sheet" aria-busy>
            {[0, 1, 2].map((key) => <div key={key} className="wt-line wt-line--skeleton"><Skeleton width="60%" /><Skeleton width={48} /><span /></div>)}
          </div>
        ) : list.isError && !list.data ? (
          <ErrorState onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <>
            {unchecked.length > 0 && (
              <Notice tone="warning" className="wt-unchecked">
                Не удалось проверить: {unchecked.join(", ")}. Это не ноль: там может что-то ждать.
              </Notice>
            )}
            {waitingCount === 0 ? (
              <p className="wt-none">
                <CircleCheck size={18} strokeWidth={1.75} aria-hidden />
                {onlyTitle !== null ? `В «${onlyTitle}» ничего не ждёт вас` : page !== null ? `На ${page} ничего не ждёт вас` : "Ничего не ждёт вас"}
              </p>
            ) : (
              <div className="wt-sheet">
                {waiting.map((group) => <Group key={group.id} id={group.id} title={group.title} lines={group.lines} now={now} />)}
              </div>
            )}
            {info && (
              <div className="wt-sheet wt-sheet--info">
                <Group id="info" title={info.title} lines={info.lines} now={now} />
              </div>
            )}
            {others.length > 0 && (
              <Disclosure size="md" className="wt-others" summary={`Ждут других: ${others.length}`} hint="в ваше число не входят">
                <div className="wt-sheet wt-sheet--info">
                  <ul className="wt-lines">
                    {others.map((line) => <LineRow key={line.key} line={line} now={now} />)}
                  </ul>
                </div>
              </Disclosure>
            )}
          </>
        )}
      </div>
      {openSend && held.data && (
        <ResolveSendModal
          key={openSend.attemptId}
          item={openSend}
          serverNow={held.data.serverNow}
          platform={platformOf(openSend.pageLabel)}
          fan={fanOf(openSend)}
          onClose={() => setSend(null)}
        />
      )}
    </>
  );
}
