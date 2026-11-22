import { Minimize2, Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { CustomBoardOrder, CustomOrdersBoardResponse } from "@agency_hub_core/contracts";
import { Button, Chip, cx, EmptyState, ErrorState, Money, Notice, SearchInput, Segmented, Skeleton, StatusDot, Tooltip } from "@agency_hub_core/ui";
import { formatAgo, formatDateTimeMsk } from "@agency_hub_core/ui/format";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { Tiles } from "@/shared/Tiles";
import { useMe } from "@/shared/useMe";
import { boardNumbers, readFailure, telegramHref, useCustomBoard, useCustomDone } from "./data";
import { ChangesBanner, FindingsBanner } from "./facts-banners";
import { CalendarView } from "./facts-calendar";
import { OrderDrawer } from "./facts-order";
import { FactChainHead, OrderRow } from "./facts-row";
import { GROUPS, byDue, groupOf, isMine, matchesSearch, sumOf } from "./facts-words";
import { RecordFromSaleModal } from "./index";
import "./facts.css";

/**
 * Кастомы, the facts screen (customs facts spec §13; behind the live switch `customsFacts`): every live order with its
 * four facts — paid, at the model, shot, given — read by Hub from where people work, and whose move it is. On top the
 * three numbers, the findings of a custom with no order and what changed by itself; then «Сроки» (by how soon the fan
 * must have it) or «Календарь». A row opens the order's panel; `?order=K-123` is that panel's address (`/customs/K-123`
 * leads there). The model filter, «Только мой ход» and the view live in the address too.
 *
 * In the extension's frame over the site (`frame`, the launcher's «Кастомы», frame.tsx) the same screen: its session is
 * the extension's device token, a narrow one (the orders of the person's own pages, whatever the role; no finding: a
 * finding is resolved with the password); «Записать кастом» stays the fan panel's (the frame reads no page list), and
 * «Свернуть» folds the frame away. Only while the facts are on: off, the frame shows the column board (frame.tsx).
 */

/** The screen in the extension's frame: how it folds away there. */
export interface CustomsFrame {
  collapse: () => void;
}

const DONE_GROUPS = [
  { id: "given", title: "Отдано, ждём слово фана", hint: "закроется само через 72 часа без жалобы" },
  { id: "closed", title: "Закрыто за месяц" },
] as const;

/** «Сверено 12 мин назад»: when the reader last checked the sources; red when it is late. */
function Verified({ verified }: { verified: CustomOrdersBoardResponse["verified"] }) {
  if (verified === undefined) return null;
  const hint = (
    <>
      Переписки, чаты и продажи сверяет читатель каждые 30 минут{verified.readerAt ? `: последний раз ${formatDateTimeMsk(verified.readerAt)}` : ""}.
      {verified.nightlyAt ? ` Ночная сверка: ${formatDateTimeMsk(verified.nightlyAt)}.` : ""}
      {verified.readerStale ? " Читатель опаздывает: данные могут отставать." : ""}
    </>
  );
  return (
    <Tooltip content={hint} side="bottom" align="start">
      <span className={cx("cf-verified", verified.readerStale && "cf-verified--stale")}>
        <StatusDot tone={verified.readerStale ? "danger" : "success"} />
        {verified.readerAt === null ? "Ещё не сверялось" : `Сверено ${formatAgo(verified.readerAt)}`}
      </span>
    </Tooltip>
  );
}

/** The three numbers with their sums. */
function Numbers({ orders }: { orders: readonly CustomBoardOrder[] }) {
  const numbers = boardNumbers(orders);
  const value = (count: number, tone: "bad" | "warn" | null, sum: number) => (
    <span className="cf-num">
      <span className={cx(count > 0 && tone !== null && `cf-num--${tone}`)}>{count}</span>
      {count > 0 && <small><Money mills={sum} /></small>}
    </span>
  );
  return (
    <div className="cf-numbers">
      <Tiles
        label="Кастомы в цифрах"
        tiles={[
          { label: "В работе", value: value(numbers.live.length, null, sumOf(numbers.live)), hint: "Заказы, которые фан ещё не получил: от записи до «отдан». Сумма — по договорённой цене." },
          { label: "Горят", value: value(numbers.burning.length, "bad", sumOf(numbers.burning)), hint: "Срок прошёл больше суток назад, снятое не отправлено 12 часов, фан спросил, где заказ, или источники расходятся. На паузе не горит." },
          { label: "Сняты и не отданы фану", value: value(numbers.shotNotGiven.length, "warn", sumOf(numbers.shotNotGiven)), hint: "Модель всё сдала, фан ещё не получил." },
        ]}
      />
    </div>
  );
}

/**
 * A group's head over its cards: the name on the left, the four steps' labels right over the cards' dots (the owner,
 * 2026-11-22: a separate column header read as not belonging to the cards), the sum over the prices.
 */
function GroupHead({ title, count, hint, dot, sum, folded, steps }: {
  title: string; count: number | null; hint?: string | undefined; dot?: "danger" | "warn" | undefined; sum: ReactNode; folded?: boolean; steps?: boolean;
}) {
  return (
    <summary className={steps ? "cf-ghead cf-ghead--steps" : "cf-ghead"}>
      <span className="cf-ghead__lead">
        <span className="cf-ghead__name">
          {dot !== undefined && <StatusDot tone={dot === "danger" ? "danger" : "warning"} />}
          {title}
          {count !== null && <span className="cf-ghead__n">{count}</span>}
        </span>
        {hint !== undefined && <span className="cf-ghead__hint">{hint}</span>}
      </span>
      {steps && <FactChainHead />}
      <span className="cf-ghead__sum">
        {folded && <span className="cf-ghead__show">Показать</span>}
        {sum}
      </span>
    </summary>
  );
}

/** «Отдано, ждём слово фана» and «Закрыто за месяц», folded: read when one of them is opened. */
function DoneGroups({ counts, keep, onOpen }: { counts: CustomOrdersBoardResponse["done"]; keep: (order: CustomBoardOrder) => boolean; onOpen: (code: string) => void }) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const done = useCustomDone(opened.size > 0);
  return (
    <>
      {DONE_GROUPS.map((group) => {
        const total = counts[group.id];
        const orders = done.data ? done.data[group.id].filter(keep) : null;
        const open = opened.has(group.id);
        if (total === 0) return null;
        return (
          <details
            key={group.id}
            className="cf-group"
            open={open}
            onToggle={(event) => {
              const now = (event.currentTarget as HTMLDetailsElement).open;
              setOpened((before) => {
                const next = new Set(before);
                if (now) next.add(group.id);
                else next.delete(group.id);
                return next;
              });
            }}
          >
            <GroupHead
              title={group.title}
              count={orders?.length ?? total}
              hint={"hint" in group ? group.hint : undefined}
              sum={orders !== null ? <Money mills={sumOf(orders)} muted /> : null}
              folded={!open}
              steps={open}
            />
            {open && (done.isPending ? <Skeleton height={96} /> : done.isError || orders === null ? <p className="cf-muted cf-empty">Не загрузилось: Hub не ответил.</p> : (
              <ul className="cf-rows">{orders.map((order) => <OrderRow key={order.id} order={order} onOpen={onOpen} />)}</ul>
            ))}
          </details>
        );
      })}
    </>
  );
}

/** «Сроки»: one row per order, by how soon the fan must have it. */
function DueView({ orders, board, keep, onOpen, mine }: {
  orders: readonly CustomBoardOrder[]; board: CustomOrdersBoardResponse; keep: (order: CustomBoardOrder) => boolean; onOpen: (code: string) => void; mine: boolean;
}) {
  const groups = GROUPS.map((group) => ({ ...group, orders: orders.filter((order) => groupOf(order) === group.id).sort(byDue) }))
    .filter((group) => group.orders.length > 0);
  return (
    <div className="cf-table">
      {groups.length === 0 && (
        <p className="cf-muted cf-empty">{mine ? "Заказов с вашим ходом нет. Снимите «Только мой ход», чтобы увидеть все." : "Заказов в работе нет."}</p>
      )}
      {groups.map((group) => (
        <details key={group.id} className="cf-group" open>
          <GroupHead title={group.title} count={group.orders.length} hint={group.hint} dot={group.dot} sum={<Money mills={sumOf(group.orders)} muted />} steps />
          <ul className="cf-rows">{group.orders.map((order) => <OrderRow key={order.id} order={order} onOpen={onOpen} />)}</ul>
        </details>
      ))}
      {/* A given order waiting for the fan's word and a closed one are nobody's move: no part of «Только мой ход». */}
      {!mine && <DoneGroups counts={board.done} keep={keep} onOpen={onOpen} />}
    </div>
  );
}

export function CustomsFactsScreen({ frame }: { frame?: CustomsFrame } = {}) {
  const me = useMe();
  // The frame's device token reads as a narrow session, whatever `me` answers for a token.
  const narrow = frame !== undefined || me.narrow;
  const [search, setSearch] = useSearchParams();
  const board = useCustomBoard(null);
  const data = board.data;
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(() => search.get("record") === "1");

  const param = (key: string) => search.get(key);
  const setParams = (changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setSearch(next, { replace });
  };
  const view = param("view") === "calendar" ? "calendar" : "due";
  const model = param("model");
  const mine = param("mine") === "1";
  const openCode = param("order");
  const openOrder = (code: string) => setParams({ order: code });
  const closeRecording = () => {
    setRecording(false);
    if (search.has("record")) setParams({ record: null, page: null, fan: null }, true);
  };

  const models = useMemo(() => [...new Set((data?.orders ?? []).map((order) => order.model).filter((name): name is string => name !== null))].sort(), [data]);
  const viewer = { userId: data?.viewer.userId ?? null, owner: data?.viewer.owner ?? false };
  const keep = (order: CustomBoardOrder) => (model === null || order.model === model) && (!mine || isMine(order, viewer)) && matchesSearch(order, text);
  const orders = (data?.orders ?? []).filter(keep);

  let body: ReactNode;
  if (board.isPending) {
    body = <Skeleton height={480} />;
  } else if (board.isError || !data) {
    body = <ErrorState onRetry={() => void board.refetch()} retrying={board.isFetching}>{readFailure(board.error)}</ErrorState>;
  } else {
    const card = param("card");
    // A matter «Кастом без заказа» links to its finding (`?finding=<id>`): the block opens on it.
    const finding = /^[1-9]\d{0,18}$/u.test(param("finding") ?? "") ? Number(param("finding")) : null;
    body = (
      <>
        <Numbers orders={data.orders.filter((order) => model === null || order.model === model)} />
        <div className="cf-toolbar">
          <div className="cf-toolbar__left" role="group" aria-label="Фильтр">
            <Chip size="md" selected={model === null} onClick={() => setParams({ model: null })}>Все модели</Chip>
            {models.map((name) => <Chip key={name} size="md" selected={model === name} onClick={() => setParams({ model: model === name ? null : name })}>{name}</Chip>)}
            <span className="cf-toolbar__gap" />
            <Chip size="md" selected={mine} onClick={() => setParams({ mine: mine ? null : "1" })}>Только мой ход</Chip>
            <SearchInput value={text} onChange={setText} placeholder="Фан или K-код" width={220} />
          </div>
          <Segmented
            label="Вид"
            value={view}
            onChange={(next) => setParams({ view: next === "calendar" ? "calendar" : null })}
            options={[{ value: "due", label: "Сроки" }, { value: "calendar", label: "Календарь" }]}
          />
        </div>
        {card && (
          <Notice tone="warning" title="Карточка из Telegram без заказа">
            <a href={telegramHref(card)} target="_blank" rel="noreferrer">Открыть карточку</a>. Найдите её заказ и привяжите в его панели («Исправить» → «Карточка в Telegram»), или запишите заказ.
          </Notice>
        )}
        <div className="cf-banners">
          <FindingsBanner summary={data.findings} narrow={narrow} orders={data.orders} defaultOpen={param("sale") !== null} focus={finding} onOpenOrder={openOrder} />
          <ChangesBanner summary={data.changes} onOpenOrder={openOrder} />
        </div>
        {data.orders.length === 0 && data.done.given === 0 && data.done.closed === 0 ? (
          <EmptyState title="Заказов пока нет">
            {frame
              ? "Кастом записывают в панели фана («Записать кастом»), в Workboard или через Генгара командой /tz. Здесь он появится сразу."
              : "Кастом записывают здесь («Записать кастом»), в панели фана расширения или через Генгара командой /tz. Здесь он появится сразу."}
          </EmptyState>
        ) : view === "calendar" ? (
          <CalendarView orders={orders} serverNow={data.serverNow} onOpen={openOrder} />
        ) : (
          <DueView orders={orders} board={data} keep={keep} onOpen={openOrder} mine={mine} />
        )}
        {data.capped && <p className="cf-muted">Показаны первые 500 заказов.</p>}
      </>
    );
  }

  return (
    <>
      <ScreenHeader
        title="Кастомы"
        actions={frame
          ? <Button icon={Minimize2} onClick={frame.collapse}>Свернуть</Button>
          : <Button variant="primary" icon={Plus} onClick={() => setRecording(true)}>Записать кастом</Button>}
        meta={data ? <Verified verified={data.verified} /> : undefined}
        {...(data ? { updatedAt: board.dataUpdatedAt } : {})}
        onRefresh={() => void board.refetch()}
        refreshing={board.isFetching}
        stale={board.isError && board.data !== undefined}
      />
      <div className="wb-content cf">{body}</div>
      {openCode !== null && <OrderDrawer code={openCode} viewerOwner={data?.viewer.owner ?? false} onClose={() => setParams({ order: null })} />}
      {recording && !frame && (
        <RecordFromSaleModal
          {...(param("page") ? { page: param("page")! } : {})}
          {...(param("fan") ? { fan: param("fan")! } : {})}
          onRecorded={(code) => {
            setRecording(false);
            setParams({ record: null, page: null, fan: null, order: code });
          }}
          onClose={closeRecording}
        />
      )}
    </>
  );
}
