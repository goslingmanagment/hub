import { Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  CUSTOM_PAID_WORD_KINDS,
  customUndoOf, wantedParts,
  type CustomOrderAction, type CustomOrderActionBody, type CustomOrderDetailResponse, type CustomOrderFacts, type CustomPaidWordKind,
} from "@agency_hub_core/contracts";
import {
  Button, Disclosure, Drawer, ErrorState, Field, Modal, Money, Notice, Select, Skeleton, StatusDot, TextInput, TimeMsk, toast,
} from "@agency_hub_core/ui";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import {
  ASKS, Deliveries, EditCardModal, FanForm, RevisionWaits, StepModal, type Ask,
} from "./index";
import { DOOR_WORDS, PAYMENT_KIND_WORDS, eventWords, fanWords, stepFailure, useCustomOrder, useCustomStep } from "./data";
import { UndoButton } from "./facts-banners";
import { FactNode, MoveLine, OrderPrice, reasonOf } from "./facts-row";
import { FACT_STEPS, dueWords, factWords, fanName, toneOf } from "./facts-words";

/**
 * The order's panel of the facts screen (customs facts spec §13), a drawer from the right over the list: the order, why
 * it burns or waits and whose move it is; the four facts, each with who set it and when (from the order's history) and
 * «Отменить» where the viewer may take back what the system or an agent did; the card's text; the history; the three
 * frequent steps. Under «Исправить» the manual steps that stay as a fallback (C4) and the owner's own.
 */

type HistoryItem = CustomOrderDetailResponse["history"][number];

/** The history events behind each fact: the newest says who set it and when. */
const FACT_EVENTS: Record<keyof CustomOrderFacts, readonly string[]> = {
  paid: ["custom_order.payment", "custom_order.paid_word", "custom_order.payment_removed"],
  atModel: ["custom_order.at_model"],
  shot: ["custom_order.shot", "custom_order.delivery", "custom_order.partly", "custom_order.settled", "custom_order.retracted"],
  given: ["custom_order.given", "custom_order.ungiven"],
};

const who = (item: HistoryItem) => item.actor ?? (item.door === "system" ? "Hub сам" : DOOR_WORDS[item.door] ?? item.door);

/** Whether a step's evidence is still on the order: its sale still pays it, its delivery is not taken back. */
function appliedOf(detail: CustomOrderDetailResponse, item: HistoryItem): boolean | null {
  const ref = (key: string) => (typeof item.changes[key] === "string" || typeof item.changes[key] === "number" ? String(item.changes[key]) : null);
  if (item.event === "custom_order.payment" || item.event === "custom_order.recorded") {
    const sale = ref("transactionId");
    return sale === null ? null : detail.payments.some((payment) => payment.transactionRef === sale);
  }
  if (item.event === "custom_order.delivery") {
    const eventRef = ref("eventRef");
    const telegramRef = ref("telegramRef");
    return detail.messages.some((message) => message.kind === "delivery" && message.retractedAt === null
      && (eventRef !== null ? message.eventRef === eventRef : message.telegramRef === telegramRef));
  }
  return null;
}

/** The newest step of these events that the viewer may take back, with its undo. */
function undoAmong(detail: CustomOrderDetailResponse, events: readonly string[]) {
  const may = (action: CustomOrderAction) => detail.actions.includes(action);
  for (const item of [...detail.history].reverse()) {
    if (!events.includes(item.event)) continue;
    const undo = customUndoOf(item, detail.order, appliedOf(detail, item), may);
    if (undo !== null) return { undo, id: item.id };
  }
  return null;
}

/** The step the move asks for, as one button: the card to the model, «снято», «отдан фану». */
const MAIN_BY_STATE: Partial<Record<CustomOrderDetailResponse["order"]["state"], { action: CustomOrderAction; label: string }>> = {
  recorded: { action: "at_model", label: "Карточка у модели" },
  paid: { action: "at_model", label: "Карточка у модели" },
  checked: { action: "at_model", label: "Карточка у модели" },
  at_model: { action: "shot", label: "Снято" },
  partly: { action: "shot", label: "Снято" },
  revision: { action: "shot", label: "Снято" },
  shot: { action: "given", label: "Отдан фану" },
};

/** The fallback steps under «Исправить», in this order. */
const FIX_STEPS: ReadonlyArray<{ action: CustomOrderAction; label: string }> = [
  { action: "at_model", label: "Карточка у модели" },
  { action: "partly", label: "Сдано частично" },
  { action: "shot", label: "Снято" },
  { action: "refused", label: "Отказ модели" },
  { action: "card", label: "Карточка в Telegram" },
  { action: "hold", label: "На паузу" },
  { action: "close", label: "Закрыть" },
];

/** The owner's word on the payment: paid outside the platform, or shot without payment. */
function PaidWordModal({ detail, onClose }: { detail: CustomOrderDetailResponse; onClose: () => void }) {
  const step = useCustomStep(detail.order.code);
  const [kind, setKind] = useState<CustomPaidWordKind>(detail.order.paidWord?.kind ?? "off_platform");
  const [note, setNote] = useState(detail.order.paidWord?.note ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  const run = (body: CustomOrderActionBody, done: string) => step.mutate(body, {
    onSuccess: () => {
      toast.success(done);
      onClose();
    },
    onError: (error) => setFailure(stepFailure(error)),
  });
  return (
    <Modal
      title="Оплата не через площадку"
      onClose={onClose}
      explicitCloseOnly={step.isPending}
      actions={(
        <>
          {detail.order.paidWord !== null && <Button variant="ghost" disabled={step.isPending} onClick={() => run({ action: "paid_word", word: null }, "Слово владельца убрано")}>Убрать слово</Button>}
          <Button onClick={onClose} disabled={step.isPending}>Отмена</Button>
          <Button variant="primary" loading={step.isPending} onClick={() => run({ action: "paid_word", word: { kind, ...(note.trim() ? { note: note.trim() } : {}) } }, "Сохранено")}>Сохранить</Button>
        </>
      )}
    >
      <div className="cf-form">
        <Field label="Оплата">{(control) => (
          <Select {...control} value={kind} onChange={(event) => setKind(CUSTOM_PAID_WORD_KINDS.find((one) => one === event.target.value) ?? "off_platform")}>
            <option value="off_platform">Оплачен не через площадку</option>
            <option value="gift">Без оплаты</option>
          </Select>
        )}</Field>
        <Field label="Заметка" hint="Например: оплатил переводом.">{(control) => <TextInput {...control} value={note} onChange={(event) => setNote(event.target.value)} />}</Field>
        {failure && <Notice tone="danger">{failure}</Notice>}
      </div>
    </Modal>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="cf-sec">
      <h3 className="cf-sec__title">{title}{aside !== undefined && <span>{aside}</span>}</h3>
      {children}
    </section>
  );
}

function OrderBody({ detail, viewerOwner }: { detail: CustomOrderDetailResponse; viewerOwner: boolean }) {
  const { order } = detail;
  const may = (action: CustomOrderAction) => detail.actions.includes(action);
  const step = useCustomStep(order.code);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [editing, setEditing] = useState(false);
  const [paidWord, setPaidWord] = useState(false);
  const due = dueWords(order);
  const tone = toneOf(order);
  const reason = reasonOf(order);
  const main = MAIN_BY_STATE[order.state];
  const deadlineUndo = undoAmong(detail, ["custom_order.deadline"]);
  const fan = fanWords(order);
  const run = (body: CustomOrderActionBody, done: string) => step.mutate(body, {
    onSuccess: () => toast.success(done),
    onError: (error) => toast.error(stepFailure(error)),
  });
  const copy = () => {
    void navigator.clipboard.writeText(detail.cardText).then(
      () => toast.success("Карточка скопирована"),
      () => toast.error("Не получилось скопировать: выделите текст карточки"),
    );
  };
  const fixSteps = FIX_STEPS.filter((one) => may(one.action) && one.action !== main?.action && ASKS[one.action] !== undefined);
  return (
    <div className="cf-order">
      <div className={`cf-alert cf-alert--${tone}`}>
        <StatusDot tone={tone === "danger" ? "danger" : tone === "warn" ? "warning" : "off"} />
        <div className="cf-alert__text">
          <div><b>{due.big}</b> <span className="cf-muted">{due.small}</span></div>
          {reason !== null && <div>{reason}</div>}
        </div>
        {deadlineUndo !== null && <UndoButton code={order.code} undo={deadlineUndo.undo} undoOf={deadlineUndo.id} label="Вернуть срок" />}
      </div>

      <div className="cf-order__move">
        <MoveLine order={order} />
        {main !== undefined && may(main.action) && ASKS[main.action] !== undefined && (
          <Button variant="primary" onClick={() => setAsk(ASKS[main.action]!)}>{main.label}</Button>
        )}
      </div>
      <RevisionWaits detail={detail} />

      <Section title="Четыре факта">
        <ol className="cf-facts">
          {FACT_STEPS.map((stepOf) => {
            const fact = order.facts[stepOf.key];
            const last = [...detail.history].reverse().find((item) => FACT_EVENTS[stepOf.key].includes(item.event));
            const undo = undoAmong(detail, [...FACT_EVENTS[stepOf.key], ...(stepOf.key === "paid" ? ["custom_order.recorded"] : [])]);
            return (
              <li key={stepOf.key} className={`cf-fact cf-fact--${fact.value}`}>
                <FactNode fact={fact} tone={tone} />
                <div className="cf-fact__text">
                  <div className="cf-fact__label">{stepOf.label}</div>
                  <div className="cf-fact__note">
                    {factWords(stepOf.key, fact, order)}
                    {last !== undefined && fact.value !== "no" && <span className="cf-tag">{who(last)}</span>}
                  </div>
                </div>
                <span className="cf-fact__at">
                  {last !== undefined && fact.value !== "no" && <TimeMsk at={last.at} show="datetime" />}
                  {undo !== null && <UndoButton code={order.code} undo={undo.undo} undoOf={undo.id} />}
                </span>
              </li>
            );
          })}
        </ol>
      </Section>

      <Section title="Что заказал" aside={(
        <span className="cf-sec__acts">
          <Button size="sm" variant="ghost" icon={Copy} onClick={copy}>Скопировать</Button>
          {may("edit") && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Изменить</Button>}
        </span>
      )}>
        <pre className="cf-card-text">{detail.cardText}</pre>
      </Section>

      <Section title="Что происходило">
        <ol className="cf-log">
          {[...detail.history].reverse().map((item) => (
            <li key={item.id}>
              <TimeMsk at={item.at} show="datetime" />
              <span>
                {eventWords(item)}
                <span className="cf-muted"> · {[who(item), item.onBehalfOf ? `за ${item.onBehalfOf}` : null].filter(Boolean).join(", ")}</span>
              </span>
            </li>
          ))}
        </ol>
      </Section>

      <Disclosure size="md" summary="Исправить" hint="если Hub не увидел сам">
        <div className="cf-fix">
          <Section title="Платежи" aside={order.payments > 0 ? <Money mills={order.paidGrossMills} /> : undefined}>
            {detail.payments.length === 0 ? <p className="cf-muted">Продажи не привязаны.</p> : (
              <ul className="cf-list">
                {detail.payments.map((payment) => (
                  <li key={payment.transactionRef} className="cf-list__row">
                    <span>{PAYMENT_KIND_WORDS[payment.kind] ?? payment.kind}</span>
                    <Money mills={payment.grossMills} />
                    <TimeMsk at={payment.at} />
                    {may("unpay") && <Button size="sm" variant="ghost" onClick={() => run({ action: "unpay", transactionRef: payment.transactionRef }, "Оплата убрана")}>Убрать</Button>}
                  </li>
                ))}
              </ul>
            )}
            {may("payment") && detail.paymentSuggestions.length > 0 && (
              <ul className="cf-list">
                {detail.paymentSuggestions.map((payment) => (
                  <li key={payment.transactionRef} className="cf-list__row">
                    <span>Это оплата? {PAYMENT_KIND_WORDS[payment.kind] ?? payment.kind}{payment.note ? <span className="cf-muted"> «{payment.note}»</span> : null}</span>
                    <Money mills={payment.grossMills} />
                    <TimeMsk at={payment.at} />
                    <Button size="sm" onClick={() => run({ action: "payment", transactionRef: payment.transactionRef }, "Оплата привязана")}>Да, это оплата</Button>
                  </li>
                ))}
              </ul>
            )}
            {viewerOwner && may("paid_word") && (
              <div className="cf-fix__row">
                <Button size="sm" onClick={() => setPaidWord(true)}>{order.paidWord !== null ? "Слово владельца об оплате" : "Оплата не через площадку / без оплаты"}</Button>
              </div>
            )}
          </Section>

          {(may("given") || may("ungive")) && (
            <Section title="Отдали фану">
              {may("given") && <Deliveries detail={detail} onGiven={(messageRef) => run({ action: "given", messageRef }, `${order.code} отдан фану`)} pending={step.isPending} />}
              <div className="cf-fix__row">
                {may("given") && <Button size="sm" onClick={() => setAsk(ASKS.given!)}>Отдан, без сообщения</Button>}
                {may("ungive") && <Button size="sm" variant="ghost" onClick={() => run({ action: "ungive" }, `${order.code}: снова «снят»`)}>Не отдан</Button>}
              </div>
            </Section>
          )}

          {!fan.confirmed && may("fan") && (
            <Section title="Фан не подтверждён">
              <FanForm detail={detail} />
            </Section>
          )}

          <div className="cf-fix__row">
            {fixSteps.map((one) => <Button key={one.action} size="sm" onClick={() => setAsk(ASKS[one.action]!)}>{one.label}</Button>)}
            {may("unhold") && <Button size="sm" onClick={() => run({ action: "unhold" }, "Снят с паузы")}>Снять с паузы</Button>}
            {may("issue_clear") && <Button size="sm" onClick={() => run({ action: "issue_clear" }, "Расхождение снято")}>Снять расхождение</Button>}
          </div>
        </div>
      </Disclosure>

      {ask && <StepModal ask={ask} code={order.code} initial={ask.action === "deadline" ? order.deadlineOn ?? "" : ""} parts={wantedParts(order.card)} onClose={() => setAsk(null)} />}
      {editing && <EditCardModal detail={detail} onClose={() => setEditing(false)} />}
      {paidWord && <PaidWordModal detail={detail} onClose={() => setPaidWord(false)} />}
    </div>
  );
}

/** The footer's three steps: the deadline, a revision, the order cancelled. */
function Footer({ detail }: { detail: CustomOrderDetailResponse }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const may = (action: CustomOrderAction) => detail.actions.includes(action);
  return (
    <>
      {may("deadline") && <Button onClick={() => setAsk(ASKS.deadline!)}>Перенести срок</Button>}
      {may("revision") && <Button onClick={() => setAsk(ASKS.revision!)}>Нужна правка</Button>}
      {may("cancel") && <Button variant="ghost" onClick={() => setAsk(ASKS.cancel!)}>Отменить заказ</Button>}
      {ask && <StepModal ask={ask} code={detail.order.code} initial={ask.action === "deadline" ? detail.order.deadlineOn ?? "" : ""} parts={wantedParts(detail.order.card)} onClose={() => setAsk(null)} />}
    </>
  );
}

export function OrderDrawer({ code, viewerOwner, onClose }: { code: string; viewerOwner: boolean; onClose: () => void }) {
  const read = useCustomOrder(code);
  const detail = read.data;
  const status = read.isError ? hubErrorStatus(read.error) : null;
  const missing = status !== null && status >= 400 && status < 500;
  const order = detail?.order;
  return (
    <Drawer
      open
      onClose={onClose}
      title={order ? fanName(order) : code}
      subtitle={order ? [order.code, order.pageLabel ?? "страница не определена", order.card.duration].filter(Boolean).join(" · ") : undefined}
      actions={order ? (
        <span className="cf-drawer-price">
          <b><OrderPrice order={order} /></b>
          {order.card.price && <small>{order.card.price}</small>}
        </span>
      ) : undefined}
      {...(detail && detail.actions.some((action) => action === "deadline" || action === "revision" || action === "cancel") ? { footer: <Footer detail={detail} /> } : {})}
    >
      {read.isPending ? <Skeleton height={320} />
        : missing ? <p className="cf-muted">Заказа {code} нет, или у вас нет доступа к его странице.</p>
        : read.isError || !detail ? <ErrorState onRetry={() => void read.refetch()} retrying={read.isFetching}>Заказ не загрузился: Hub не ответил.</ErrorState>
        : <OrderBody detail={detail} viewerOwner={viewerOwner} />}
    </Drawer>
  );
}
