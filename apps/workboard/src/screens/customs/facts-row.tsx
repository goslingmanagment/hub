import type { CustomBoardOrder, CustomFact } from "@agency_hub_core/contracts";
import { cx, Money } from "@agency_hub_core/ui";
import { FACT_STEPS, dueWords, factWords, fanName, initialsOf, moveWords, toneOf, type FactsOrder, type Tone } from "./facts-words";

/**
 * One order of the facts screen (customs facts spec §13): a row of «Сроки» and of «Расписание», on a hairline like the
 * other Workboard lists — its deadline, the fan with the order's code, the four facts as four dots on a line, whose move
 * it is and the price. The whole row opens the order's panel.
 */

/** A fact as a dot: filled — proven, a ring with a halo — the step that is next, hollow — not yet, half — partly, red — a conflict. */
function nodeClass(fact: CustomFact, tone: Tone): string {
  return cx("cf-node", `cf-node--${fact.value}`, fact.value === "wait" && tone !== "calm" && `cf-node--${tone}`);
}

export function FactChain({ order }: { order: FactsOrder }) {
  const tone = toneOf(order);
  return (
    <span className="cf-chain" role="img" aria-label={FACT_STEPS.map((step) => `${step.label}: ${factWords(step.key, order.facts[step.key], order)}`).join("; ")}>
      {FACT_STEPS.map((step) => <i key={step.key} className={nodeClass(order.facts[step.key], tone)} />)}
    </span>
  );
}

/** The fact as a dot alone (the order's panel lists them top to bottom). */
export function FactNode({ fact, tone }: { fact: CustomFact; tone: Tone }) {
  return <i className={nodeClass(fact, tone)} aria-hidden />;
}

/** The labels of the four dots, over the column. */
export function FactChainHead() {
  return (
    <span className="cf-chain cf-chain--head">
      {FACT_STEPS.map((step) => <span key={step.key}>{step.short}</span>)}
    </span>
  );
}

/** What the order is worth: the agreed total; while it is not named, what came, quiet; else a dash. */
export function OrderPrice({ order }: { order: Pick<CustomBoardOrder, "priceMills" | "paidGrossMills"> }) {
  if (order.priceMills !== null) return <Money mills={order.priceMills} />;
  if (order.paidGrossMills > 0) return <Money mills={order.paidGrossMills} muted hint="Получено; цена заказа не названа" />;
  return <span className="cf-muted">—</span>;
}

/** «Имя: что сделать». */
export function MoveLine({ order }: { order: FactsOrder }) {
  const move = moveWords(order);
  if (move.who === null) return <span className="cf-move cf-move--none">{move.what ?? "ход ни за кем"}</span>;
  return <span className="cf-move"><b>{move.who}</b>{move.what ? `: ${move.what}` : ""}</span>;
}

/** The circle of the fan's initials, its ring the order's tone. */
export function FanCircle({ order }: { order: FactsOrder }) {
  const tone = toneOf(order);
  return <span className={cx("cf-ava", tone !== "calm" && `cf-ava--${tone}`)} aria-hidden>{initialsOf(fanName(order))}</span>;
}

/** The fan's nick with the order's code, and under it the page and the volume. */
export function FanCell({ order }: { order: CustomBoardOrder }) {
  return (
    <span className="cf-fan">
      <span className="cf-fan__l1">
        <span className="cf-fan__name">{fanName(order)}</span>
        <span className="cf-code">{order.code}</span>
      </span>
      <span className="cf-fan__l2">
        {order.pageLabel ?? <span className="cf-warn-text">страница не определена</span>}
        {order.volume ? `, ${order.volume}` : ""}
      </span>
    </span>
  );
}

/** Why it burns or what it waits for, one line: Hub's reason (`customOrderUrgencyOf`). */
export function reasonOf(order: FactsOrder): string | null {
  return order.reason;
}

export function OrderRow({ order, onOpen, agenda = false }: { order: CustomBoardOrder; onOpen: (code: string) => void; agenda?: boolean }) {
  const due = dueWords(order);
  const reason = reasonOf(order);
  return (
    <li className="cf-item">
      <button type="button" className={cx("cf-row", agenda && "cf-row--agenda")} onClick={() => onOpen(order.code)} aria-label={`${order.code}, ${fanName(order)}`}>
        {!agenda && (
          <span className={cx("cf-due", `cf-due--${due.tone}`)}>
            <b>{due.big}</b>
            <small>{due.small}</small>
          </span>
        )}
        <span className="cf-main">
          <FanCircle order={order} />
          <FanCell order={order} />
        </span>
        {reason !== null && <span className="cf-reason">{reason}</span>}
        <span className="cf-chain-cell"><FactChain order={order} /></span>
        <span className="cf-move-cell"><MoveLine order={order} /></span>
        <span className="cf-price"><OrderPrice order={order} /></span>
      </button>
    </li>
  );
}
