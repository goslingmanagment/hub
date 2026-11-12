import { Copy, MoreHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { CustomLookalikeSale, CustomOrder, CustomOrderAction, CustomOrderActionBody, CustomOrderCard, CustomOrderDetailResponse } from "@agency_hub_core/contracts";
import {
  Badge,
  Button,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  KeyValue,
  LinkButton,
  Menu,
  Modal,
  Money,
  Notice,
  PageLabel,
  Section,
  Select,
  Skeleton,
  Textarea,
  TextInput,
  TimeMsk,
  toast,
} from "@agency_hub_core/ui";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useBackState, useBackTarget } from "@/shared/links";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePages } from "@/shared/usePages";
import {
  COLUMNS,
  DOOR_WORDS,
  EVENT_WORDS,
  PAYMENT_KIND_WORDS,
  STATE_TONE,
  STATE_WORDS,
  columnOf,
  deadlineWords,
  fanWords,
  stepFailure,
  telegramHref,
  useCustomBoard,
  useCustomCreate,
  useCustomOrder,
  useCustomStep,
  useDismissSale,
} from "./data";
import "./customs.css";

/**
 * Кастомы (ecosystem plan, package I): every custom order on one board, by
 * step, with its deadline; the order's own page with its card, payments, hints
 * and history, and the steps the viewer may take. The lead (the right «ведёт
 * кастомы») and the owner take every step; a chatter records, pays, gives and
 * cancels their own. Recording is in the fan's panel of the extension or by
 * Gengar's `/tz`; a sale that looks like a custom and has none waits on top.
 */

const BOARD_BACK = { to: "/customs", label: "Кастомы" };

/** Who took the order, by the registry's name; an imported order nobody took, one Gengar wrote alone. */
function acceptorOf(order: Pick<CustomOrder, "acceptedByName" | "origin">): string {
  return order.acceptedByName ?? (order.origin === "import" ? "перенесён" : "Генгар");
}

function StateBadge({ order }: { order: Pick<CustomOrder, "state"> }) {
  const tone = STATE_TONE[order.state];
  return <Badge tone={tone ?? "neutral"}>{STATE_WORDS[order.state]}</Badge>;
}

function Deadline({ order, serverNow }: { order: CustomOrder; serverNow: string }) {
  if (order.state === "given" || order.state === "closed") return <span>отдан <TimeMsk at={order.givenAt ?? order.stateAt} show="date" /></span>;
  if (order.state === "shot") return <span>снят <TimeMsk at={order.stateAt} show="ago" /></span>;
  const words = deadlineWords(order, serverNow);
  if (words === null) return <span className="cus-muted">срок не задан</span>;
  return <span className={words.late ? "cus-late" : undefined}>{words.text}</span>;
}

/** Price and paid in one line: «100$ тир Master + 50$ · оплачено $150.00». */
function PaidLine({ order }: { order: CustomOrder }) {
  return (
    <span className="cus-paid">
      {order.card.price ?? <span className="cus-muted">цена не записана</span>}
      {order.payments > 0 && <> · оплачено <Money mills={order.paidGrossMills} /></>}
    </span>
  );
}

function OrderCard({ order, serverNow }: { order: CustomOrder; serverNow: string }) {
  const back = useBackState("Кастомы");
  const fan = fanWords(order);
  return (
    <Link to={`/customs/${order.code}`} state={back} className="cus-card">
      <span className="cus-card__top">
        <span className={fan.confirmed ? "cus-card__fan" : "cus-card__fan cus-muted"}>{fan.name}</span>
        <span className="cus-card__code">{order.code}</span>
      </span>
      <span className="cus-card__meta">
        {order.pageLabel ? <PageLabel label={order.pageLabel} /> : <span className="cus-muted">страница не подтверждена</span>}
        {(order.state === "partly" || order.state === "revision" || order.state === "refused") && <StateBadge order={order} />}
      </span>
      <span className="cus-card__what">{order.what}</span>
      <PaidLine order={order} />
      <span className="cus-card__foot">
        <Deadline order={order} serverNow={serverNow} />
        <span className="cus-muted">{acceptorOf(order)}</span>
      </span>
    </Link>
  );
}

function RecordFromSaleModal({ sale, onClose }: { sale: CustomLookalikeSale; onClose: () => void }) {
  const create = useCustomCreate();
  const navigate = useNavigate();
  const back = useBackState("Кастомы");
  const [task, setTask] = useState("");
  const [price, setPrice] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const submit = () => {
    if (task.trim() === "" || create.isPending) return;
    const card: CustomOrderCard = { task: task.trim(), ...(price.trim() ? { price: price.trim() } : {}) };
    create.mutate({ transactionRef: sale.transactionRef, card }, {
      onSuccess: (detail) => {
        toast.success(`Записан ${detail.order.code}`);
        navigate(`/customs/${detail.order.code}`, { state: back });
      },
      onError: (error) => setFailure(stepFailure(error)),
    });
  };
  return (
    <Modal
      title="Записать кастом"
      onClose={onClose}
      explicitCloseOnly={create.isPending || task !== ""}
      actions={(
        <>
          <Button onClick={onClose} disabled={create.isPending}>Отмена</Button>
          <Button variant="primary" loading={create.isPending} disabled={task.trim() === ""} onClick={submit}>Записать</Button>
        </>
      )}
    >
      <div className="cus-form">
        <p className="cus-muted">Фан, страница и оплата возьмутся из продажи: <Money mills={sale.grossMills} />, <TimeMsk at={sale.at} />. Карточку для модели потом можно дописать.</p>
        <Field label="Что снять">{(control) => <Textarea {...control} rows={4} value={task} onChange={(event) => setTask(event.target.value)} />}</Field>
        <Field label="Цена, как договорились" hint="Например: 100$ тир Master + 50$">{(control) => <TextInput {...control} value={price} onChange={(event) => setPrice(event.target.value)} />}</Field>
        {failure && <Notice tone="danger">{failure}</Notice>}
      </div>
    </Modal>
  );
}

function Lookalikes({ sales, highlight }: { sales: readonly CustomLookalikeSale[]; highlight: string | null }) {
  const dismiss = useDismissSale();
  const [recording, setRecording] = useState<CustomLookalikeSale | null>(null);
  if (sales.length === 0) return null;
  const list = (
    <ul className="cus-sales">
      {sales.map((sale) => (
        <li key={sale.transactionRef} className={sale.transactionRef === highlight ? "cus-sale cus-sale--picked" : "cus-sale"}>
          <span className="cus-sale__who">
            <span>{sale.fan ? (sale.fan.displayName ?? sale.fan.username ?? `фан ·${sale.fan.fanRef.slice(-4)}`) : "фан не известен"}</span>
            <PageLabel label={sale.pageLabel} />
          </span>
          <span className="cus-sale__what">{sale.kind === "tier" ? `Подписка: ${sale.detail ?? "тир с кастомом"}` : `Чаевые: «${sale.detail ?? ""}»`}</span>
          <Money mills={sale.grossMills} />
          <TimeMsk at={sale.at} />
          <span className="cus-sale__actions">
            <Button size="sm" variant="primary" onClick={() => setRecording(sale)}>Записать</Button>
            <Button size="sm" loading={dismiss.isPending && dismiss.variables === sale.transactionRef} onClick={() => dismiss.mutate(sale.transactionRef, {
              onSuccess: () => toast.success("Отмечено: не кастом"),
              onError: (error) => toast.error(stepFailure(error)),
            })}>Не кастом</Button>
          </span>
        </li>
      ))}
    </ul>
  );
  const hint = "Тир с кастомом или чаевые с запиской про кастом. Запишите заказ или отметьте «Не кастом».";
  return (
    <>
      {sales.length > 3 && highlight === null ? (
        <Disclosure size="md" summary="Похоже на кастом без заказа" hint={String(sales.length)}>
          <p className="cus-muted">{hint}</p>
          {list}
        </Disclosure>
      ) : (
        <Section title={<>Похоже на кастом без заказа <span className="cus-count">{sales.length}</span></>} description={hint}>{list}</Section>
      )}
      {recording && <RecordFromSaleModal sale={recording} onClose={() => setRecording(null)} />}
    </>
  );
}

export function CustomsBoardScreen() {
  const { page } = usePageFilter();
  const [search] = useSearchParams();
  const board = useCustomBoard(page);
  const data = board.data;
  const leads = data?.leads ?? [];
  const meta = leads.length > 0 ? `Ведёт кастомы: ${leads.join(", ")}` : "Ведущий кастомов не назначен";

  let body: ReactNode;
  if (board.isPending) {
    body = <Skeleton height={320} />;
  } else if (board.isError || !data) {
    body = <ErrorState onRetry={() => void board.refetch()} retrying={board.isFetching}>Заказы не загрузились: Hub не ответил.</ErrorState>;
  } else {
    const byColumn = new Map(COLUMNS.map((column) => [column.id, [] as CustomOrder[]]));
    for (const order of data.orders) {
      const column = columnOf(order);
      if (column !== null) byColumn.get(column)!.push(order);
    }
    // In a column: the late first, then the nearest deadline, then the longest waiting; the given — the newest first.
    for (const [id, orders] of byColumn) {
      orders.sort(id === "given"
        ? (left, right) => (right.givenAt ?? right.stateAt).localeCompare(left.givenAt ?? left.stateAt)
        : (left, right) => (right.overdueDays ?? 0) - (left.overdueDays ?? 0)
          || (left.deadlineOn ?? "9999").localeCompare(right.deadlineOn ?? "9999")
          || left.stateAt.localeCompare(right.stateAt));
    }
    const card = search.get("card");
    body = (
      <>
        {card && (
          <Notice tone="warning" title="Карточка из Telegram без заказа">
            <a href={telegramHref(card)} target="_blank" rel="noreferrer">Открыть карточку</a>. Найдите её заказ на доске и привяжите на его странице («Карточка в Telegram»), или запишите заказ.
          </Notice>
        )}
        <Lookalikes sales={data.lookalikes} highlight={search.get("sale")} />
        {data.orders.length === 0 ? (
          <EmptyState title="Заказов пока нет">
            Кастом записывают в расширении («Записать кастом» в панели фана) или через Генгара командой /tz. Здесь он появится сразу.
          </EmptyState>
        ) : (
          <div className="cus-board" role="list" aria-label="Заказы по шагам">
            {COLUMNS.map((column) => {
              const orders = byColumn.get(column.id)!;
              return (
                <section key={column.id} className="cus-col" role="listitem" aria-label={column.title}>
                  <h2 className="cus-col__title">{column.title} <span className="cus-count">{orders.length}</span></h2>
                  {orders.length === 0 ? <p className="cus-col__empty">{column.empty}</p> : orders.map((order) => <OrderCard key={order.id} order={order} serverNow={data.serverNow} />)}
                </section>
              );
            })}
          </div>
        )}
        {data.capped && <p className="cus-muted">Показаны первые 500 заказов.</p>}
      </>
    );
  }

  return (
    <>
      <ScreenHeader
        title="Кастомы"
        pageFilter
        meta={meta}
        {...(data ? { updatedAt: board.dataUpdatedAt } : {})}
        onRefresh={() => void board.refetch()}
        refreshing={board.isFetching}
        stale={board.isError && board.data !== undefined}
      />
      <div className="wb-content cus">{body}</div>
    </>
  );
}

// ── The order ───────────────────────────────────────────────────────────────

const CARD_FIELDS: ReadonlyArray<{ key: keyof CustomOrderCard & string; label: string; long?: boolean }> = [
  { key: "price", label: "Оплата" },
  { key: "duration", label: "Длительность" },
  { key: "task", label: "Описание задания", long: true },
  { key: "photos", label: "Фото", long: true },
  { key: "clothes", label: "Одежда", long: true },
  { key: "face", label: "Лицо" },
  { key: "notes", label: "Заметки", long: true },
  { key: "name", label: "Имя в видео" },
  { key: "urgency", label: "Срочность" },
  { key: "deadlineNote", label: "Сроки словами" },
];

type Ask = { action: CustomOrderAction; title: string; field?: "note" | "reason" | "telegram" | "date"; required?: boolean; confirm: string; hint?: string };

const ASKS: Partial<Record<CustomOrderAction, Ask>> = {
  at_model: { action: "at_model", title: "Карточка у модели", field: "telegram", confirm: "У модели", hint: "Ссылка на карточку в группе модели, если есть: так сдачу найдут сами." },
  deadline: { action: "deadline", title: "Срок", field: "date", confirm: "Сохранить" },
  partly: { action: "partly", title: "Сдано частично", field: "note", confirm: "Сдано частично", hint: "Что пришло и что ещё ждём." },
  shot: { action: "shot", title: "Снято", confirm: "Снято" },
  revision: { action: "revision", title: "Правка", field: "note", confirm: "Отправить в правку", hint: "Что исправить." },
  refused: { action: "refused", title: "Отказ модели", field: "reason", required: true, confirm: "Отказ модели", hint: "Почему модель отказалась." },
  close: { action: "close", title: "Закрыть заказ", confirm: "Закрыть" },
  cancel: { action: "cancel", title: "Отменить заказ", field: "reason", confirm: "Отменить заказ", hint: "Оплаты вернутся в подсказки: их сможет взять другой заказ." },
  card: { action: "card", title: "Карточка в Telegram", field: "telegram", required: true, confirm: "Привязать" },
};

/**
 * The row of steps: the step's main action filled, one or two frequent ones beside it, the rare ones in «Ещё».
 * What is main and frequent goes by the order's state; nothing the viewer may do is left out.
 */
type RowItem = CustomOrderAction | "copy";
const ROW_BY_STATE: Partial<Record<CustomOrder["state"], { main: CustomOrderAction | null; frequent: readonly RowItem[] }>> = {
  recorded: { main: "at_model", frequent: ["copy", "deadline"] },
  paid: { main: "at_model", frequent: ["copy", "deadline"] },
  at_model: { main: "shot", frequent: ["partly", "deadline"] },
  partly: { main: "shot", frequent: ["partly", "deadline"] },
  revision: { main: "shot", frequent: ["partly", "deadline"] },
  refused: { main: "at_model", frequent: ["copy"] },
  shot: { main: null, frequent: ["revision"] },
  given: { main: "close", frequent: ["revision"] },
};
const ROW_ORDER: readonly RowItem[] = ["copy", "at_model", "shot", "partly", "revision", "close", "deadline", "card", "refused", "cancel"];

const STEP_LABEL: Partial<Record<CustomOrderAction, string>> = {
  at_model: "У модели",
  shot: "Снято",
  partly: "Сдано частично",
  revision: "Правка",
  close: "Закрыть",
  deadline: "Срок",
  card: "Карточка в Telegram",
  refused: "Отказ модели",
  cancel: "Отменить заказ",
};

function bodyOf(ask: Ask, value: string): CustomOrderActionBody | null {
  const text = value.trim();
  if (ask.required && text === "") return null;
  switch (ask.action) {
    case "at_model": return text === "" ? { action: "at_model" } : { action: "at_model", telegramRef: text };
    case "card": return { action: "card", telegramRef: text };
    case "deadline": return { action: "deadline", deadlineOn: text === "" ? null : text };
    case "partly": return text === "" ? { action: "partly" } : { action: "partly", note: text };
    case "revision": return text === "" ? { action: "revision" } : { action: "revision", note: text };
    case "refused": return { action: "refused", reason: text };
    case "cancel": return text === "" ? { action: "cancel" } : { action: "cancel", reason: text };
    case "shot": return { action: "shot" };
    case "close": return { action: "close" };
    default: return null;
  }
}

function StepModal({ ask, code, initial, onClose }: { ask: Ask; code: string; initial: string; onClose: () => void }) {
  const step = useCustomStep(code);
  const [value, setValue] = useState(initial);
  const [failure, setFailure] = useState<string | null>(null);
  const body = bodyOf(ask, value);
  const submit = () => {
    if (body === null || step.isPending) return;
    step.mutate(body, {
      onSuccess: () => {
        toast.success(`${code}: ${ask.confirm.toLowerCase()}`);
        onClose();
      },
      onError: (error) => setFailure(stepFailure(error)),
    });
  };
  return (
    <Modal
      title={ask.title}
      size={ask.field ? "form" : "confirm"}
      onClose={onClose}
      explicitCloseOnly={step.isPending}
      actions={(
        <>
          <Button onClick={onClose} disabled={step.isPending}>Отмена</Button>
          <Button variant={ask.action === "cancel" || ask.action === "refused" ? "danger" : "primary"} loading={step.isPending} disabled={body === null} onClick={submit}>{ask.confirm}</Button>
        </>
      )}
    >
      <div className="cus-form">
        {ask.field === "date" && <Field label="До какого дня, по Москве">{(control) => <TextInput {...control} type="date" value={value} onChange={(event) => setValue(event.target.value)} />}</Field>}
        {ask.field === "telegram" && <Field label="Ссылка на сообщение в Telegram" hint={ask.hint}>{(control) => <TextInput {...control} placeholder="https://t.me/c/…" value={value} onChange={(event) => setValue(event.target.value)} />}</Field>}
        {(ask.field === "note" || ask.field === "reason") && <Field label={ask.field === "reason" ? "Причина" : "Что именно"} hint={ask.hint}>{(control) => <Textarea {...control} rows={3} value={value} onChange={(event) => setValue(event.target.value)} />}</Field>}
        {!ask.field && <p>Отметить заказ {code}: «{ask.confirm}»?</p>}
        {failure && <Notice tone="danger">{failure}</Notice>}
      </div>
    </Modal>
  );
}

function EditCardModal({ detail, onClose }: { detail: CustomOrderDetailResponse; onClose: () => void }) {
  const step = useCustomStep(detail.order.code);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(CARD_FIELDS.map((field) => [field.key, String(detail.order.card[field.key] ?? "")])));
  const [failure, setFailure] = useState<string | null>(null);
  const submit = () => {
    const card: Record<string, unknown> = { ...detail.order.card };
    for (const field of CARD_FIELDS) {
      const value = (draft[field.key] ?? "").trim();
      if (value === "") delete card[field.key];
      else card[field.key] = value;
    }
    step.mutate({ action: "edit", card: card as CustomOrderCard }, {
      onSuccess: () => {
        toast.success("Карточка сохранена");
        onClose();
      },
      onError: (error) => setFailure(stepFailure(error)),
    });
  };
  return (
    <Modal
      title={`Карточка ${detail.order.code}`}
      size="wide"
      onClose={onClose}
      explicitCloseOnly
      actions={(
        <>
          <Button onClick={onClose} disabled={step.isPending}>Отмена</Button>
          <Button variant="primary" loading={step.isPending} onClick={submit}>Сохранить</Button>
        </>
      )}
    >
      <div className="cus-form cus-form--grid">
        {CARD_FIELDS.map((field) => (
          <Field key={field.key} label={field.label} className={field.long ? "cus-form__wide" : undefined}>
            {(control) => field.long
              ? <Textarea {...control} rows={field.key === "task" ? 6 : 3} value={draft[field.key] ?? ""} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />
              : <TextInput {...control} value={draft[field.key] ?? ""} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />}
          </Field>
        ))}
        {failure && <Notice tone="danger">{failure}</Notice>}
      </div>
    </Modal>
  );
}

function FanForm({ detail }: { detail: CustomOrderDetailResponse }) {
  const pages = usePages();
  const step = useCustomStep(detail.order.code);
  const [pageLabel, setPageLabel] = useState(detail.order.pageLabel ?? "");
  const [fan, setFan] = useState(detail.order.buyer ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  const submit = () => step.mutate({ action: "fan", pageLabel, fan: fan.trim() }, {
    onSuccess: () => toast.success("Фан подтверждён"),
    onError: (error) => setFailure(stepFailure(error)),
  });
  return (
    <div className="cus-fan-form">
      <Field label="Страница">{(control) => (
        <Select {...control} value={pageLabel} onChange={(event) => setPageLabel(event.target.value)}>
          <option value="">Выберите страницу</option>
          {(pages.data ?? []).map((page) => <option key={page.label} value={page.label}>{page.label}</option>)}
        </Select>
      )}</Field>
      <Field label="Фан" hint="Ссылка на профиль, ник или номер">{(control) => <TextInput {...control} value={fan} onChange={(event) => setFan(event.target.value)} />}</Field>
      <Button loading={step.isPending} disabled={pageLabel === "" || fan.trim() === ""} onClick={submit}>Подтвердить</Button>
      {failure && <Notice tone="danger">{failure}</Notice>}
    </div>
  );
}

function Deliveries({ detail, onGiven, pending }: { detail: CustomOrderDetailResponse; onGiven: (messageRef: string) => void; pending: boolean }) {
  if (detail.deliverySuggestions.length === 0) return null;
  return (
    <ul className="cus-list">
      {detail.deliverySuggestions.map((message) => (
        <li key={message.messageRef} className="cus-list__row">
          <TimeMsk at={message.at} />
          <span>{message.mediaCount} медиа{message.priceMills ? <>, цена <Money mills={message.priceMills} /></> : ", бесплатно"}</span>
          <Button size="sm" variant="primary" loading={pending} onClick={() => onGiven(message.messageRef)}>Отдали: это он</Button>
        </li>
      ))}
    </ul>
  );
}

function OrderBody({ detail }: { detail: CustomOrderDetailResponse }) {
  const { order, serverNow, actions } = detail;
  const may = (action: CustomOrderAction) => actions.includes(action);
  const step = useCustomStep(order.code);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [editing, setEditing] = useState(false);
  const fan = fanWords(order);
  const deadline = deadlineWords(order, serverNow);
  const row = ROW_BY_STATE[order.state] ?? { main: null, frequent: [] };
  const allowed = (item: RowItem) => item === "copy" || (may(item) && ASKS[item] !== undefined);
  const main = row.main !== null && allowed(row.main) ? row.main : null;
  const frequent = row.frequent.filter(allowed);
  const rest = ROW_ORDER.filter((item) => allowed(item) && item !== main && !frequent.includes(item));
  const run = (body: CustomOrderActionBody, done: string) => step.mutate(body, {
    onSuccess: () => toast.success(done),
    onError: (error) => toast.error(stepFailure(error)),
  });
  const copy = () => {
    void navigator.clipboard.writeText(detail.cardText).then(
      () => toast.success("Карточка скопирована: вставьте её в группу модели"),
      () => toast.error("Не получилось скопировать: выделите текст карточки ниже"),
    );
  };

  return (
    <>
      <div className="cus-facts">
        <StateBadge order={order} />
        <span className="cus-muted">с <TimeMsk at={order.stateAt} /></span>
        {order.stateNote && <span>{order.stateNote}</span>}
        {deadline && <span className={deadline.late ? "cus-late" : undefined}>{deadline.text}</span>}
      </div>
      <div className="cus-actions">
        {main !== null && <Button variant="primary" onClick={() => setAsk(ASKS[main]!)}>{STEP_LABEL[main]}</Button>}
        {frequent.map((item) => item === "copy"
          ? <Button key="copy" icon={Copy} onClick={copy}>Скопировать карточку</Button>
          : <Button key={item} onClick={() => setAsk(ASKS[item]!)}>{STEP_LABEL[item]}</Button>)}
        {rest.length > 0 && (
          <Menu
            label="Ещё"
            trigger="button"
            triggerIcon={MoreHorizontal}
            items={rest.map((item) => item === "copy"
              ? { label: "Скопировать карточку", icon: Copy, onSelect: copy }
              : { label: STEP_LABEL[item]!, onSelect: () => setAsk(ASKS[item]!), danger: item === "cancel" || item === "refused" })}
          />
        )}
      </div>

      {may("given") && (order.state === "shot" ? (
        <Section title="Отдайте фану" description={detail.deliverySuggestions.length > 0 ? "Медиа, которые страница отправила этому фану после оплаты. Отметьте сообщение, которым отдали кастом." : "Как только медиа уйдёт фану в чате, оно появится здесь: отметьте его."}>
          <Deliveries detail={detail} onGiven={(messageRef) => run({ action: "given", messageRef }, `${order.code} отдан фану`)} pending={step.isPending} />
        </Section>
      ) : detail.deliverySuggestions.length > 0 && (
        <Disclosure size="md" summary="Уже отдали фану?">
          <Deliveries detail={detail} onGiven={(messageRef) => run({ action: "given", messageRef }, `${order.code} отдан фану`)} pending={step.isPending} />
        </Disclosure>
      ))}

      <div className="cus-grid">
        <Section title="Карточка" actions={may("edit") ? <Button size="sm" onClick={() => setEditing(true)}>Изменить</Button> : undefined}>
          <KeyValue items={[
            { label: "Фан", value: fan.confirmed ? fan.name : <span className="cus-muted">не подтверждён: {fan.name}</span> },
            { label: "Страница", value: order.pageLabel ? <PageLabel label={order.pageLabel} /> : <span className="cus-muted">не подтверждена</span> },
            ...CARD_FIELDS.filter((field) => order.card[field.key] !== undefined).map((field) => ({
              label: field.label, value: <span className="cus-pre">{String(order.card[field.key])}</span>,
            })),
            { label: "Принял", value: order.acceptedByName ?? (order.origin === "import" ? "перенесён из старых карточек" : "Генгар") },
          ]} />
          <Disclosure size="md" summary="Текст карточки для модели">
            <pre className="cus-card-text">{detail.cardText}</pre>
          </Disclosure>
          {detail.sourceText && (
            <Disclosure size="md" summary="Как карточка выглядела в Telegram">
              <pre className="cus-card-text">{detail.sourceText}</pre>
            </Disclosure>
          )}
          {order.telegramRefs.length > 0 && (
            <p className="cus-links">Карточки в Telegram: {order.telegramRefs.map((ref, index) => <a key={ref} href={telegramHref(ref)} target="_blank" rel="noreferrer">{index + 1}</a>)}</p>
          )}
        </Section>

        <div className="cus-side">
          {!fan.confirmed && may("fan") && (
            <Section title="Фан не подтверждён" description="Укажите страницу и фана: тогда Hub подскажет оплату и сообщение, которым отдали.">
              <FanForm detail={detail} />
            </Section>
          )}
          <Section title={detail.payments.length > 0 ? <>Платежи · <Money mills={order.paidGrossMills} /></> : "Платежи"}>
            {detail.payments.length === 0 ? <p className="cus-muted">Продажи ещё не привязаны.</p> : (
              <ul className="cus-list">
                {detail.payments.map((payment) => (
                  <li key={payment.transactionRef} className="cus-list__row">
                    <span>{PAYMENT_KIND_WORDS[payment.kind] ?? payment.kind}</span>
                    <Money mills={payment.grossMills} strong hint={<>после комиссии <Money mills={payment.netMills} /></>} />
                    <TimeMsk at={payment.at} />
                    {may("unpay") && <Button size="sm" variant="ghost" onClick={() => run({ action: "unpay", transactionRef: payment.transactionRef }, "Оплата убрана")}>Убрать</Button>}
                  </li>
                ))}
              </ul>
            )}
            {may("payment") && detail.paymentSuggestions.length > 0 && (
              <>
                <h3 className="cus-sub">Это оплата?</h3>
                <ul className="cus-list">
                  {detail.paymentSuggestions.map((payment) => (
                    <li key={payment.transactionRef} className="cus-list__row">
                      <span>{PAYMENT_KIND_WORDS[payment.kind] ?? payment.kind}{payment.note ? <span className="cus-muted"> «{payment.note}»</span> : null}</span>
                      <Money mills={payment.grossMills} />
                      <TimeMsk at={payment.at} />
                      <Button size="sm" onClick={() => run({ action: "payment", transactionRef: payment.transactionRef }, "Оплата привязана")}>Да, это оплата</Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>
          {detail.messages.length > 0 && (
            <Section title="В группе модели">
              <ul className="cus-list">
                {detail.messages.map((message) => (
                  <li key={`${message.eventRef ?? message.telegramRef}:${message.ordinal}`} className="cus-list__row cus-list__row--text">
                    {message.telegramRef === null
                      ? <span>{message.at ? <TimeMsk at={message.at} /> : "сообщение"}</span>
                      : <a href={telegramHref(message.telegramRef)} target="_blank" rel="noreferrer">{message.at ? <TimeMsk at={message.at} /> : "сообщение"}</a>}
                    <span>
                      {message.author ? `${message.author}: ` : ""}{message.excerpt ?? ({ repost: "копия карточки", delivery: "сдача", revision: "правка", confirmation: "подтверждение", note: "заметка" })[message.kind]}
                      {message.retractedAt !== null && <span className="cus-muted"> · отозвана</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="История">
            <ol className="cus-history">
              {detail.history.map((item, index) => (
                <li key={index}>
                  <TimeMsk at={item.at} />
                  <span>{EVENT_WORDS[item.event] ?? item.event}</span>
                  <span className="cus-muted">{[item.actor ?? (item.door === "system" ? null : "кто-то"), item.onBehalfOf ? `за ${item.onBehalfOf}` : null, DOOR_WORDS[item.door] ?? item.door].filter(Boolean).join(", ")}</span>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </div>

      {ask && <StepModal ask={ask} code={order.code} initial={ask.action === "deadline" ? order.deadlineOn ?? "" : ""} onClose={() => setAsk(null)} />}
      {editing && <EditCardModal detail={detail} onClose={() => setEditing(false)} />}
    </>
  );
}

export function CustomOrderScreen() {
  const { code = "" } = useParams();
  const order = useCustomOrder(code);
  const back = useBackTarget(BOARD_BACK);
  const data = order.data;
  const title = data ? `${data.order.code} · ${data.order.what}` : code;
  const status = order.isError ? hubErrorStatus(order.error) : null;
  // A 404 is an order that does not exist or is not the viewer's (Hub answers both alike); only no answer is «Hub не ответил».
  const missing = status !== null && status >= 400 && status < 500;
  return (
    <>
      <ScreenHeader
        title={title}
        documentTitle={data ? `${data.order.code} — Кастомы` : "Кастомы"}
        back={back}
        meta={data ? <>{data.order.model ?? "Модель не известна"} · записан <TimeMsk at={data.order.createdAt} show="date" /></> : undefined}
        {...(data ? { updatedAt: order.dataUpdatedAt, onRefresh: () => void order.refetch(), refreshing: order.isFetching } : {})}
      />
      <div className="wb-content cus">
        {order.isPending ? <Skeleton height={320} />
          : missing ? (
            <EmptyState title="Заказ не найден" action={<LinkButton to="/customs">К доске «Кастомы»</LinkButton>}>
              Заказа {code} нет, или у вас нет доступа к его странице.
            </EmptyState>
          )
          : order.isError || !data ? <ErrorState onRetry={() => void order.refetch()} retrying={order.isFetching}>Заказ не загрузился: Hub не ответил.</ErrorState>
          : <OrderBody detail={data} />}
      </div>
    </>
  );
}
