import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SaleChainLink, SaleChainResponse } from "@agency_hub_core/contracts";
import { cx } from "./cx.js";
import { Money } from "./Money.js";
import { Skeleton } from "./Skeleton.js";
import { useAnchoredPosition, useDismiss } from "./popover.js";
import { formatDateTime } from "../format.js";

/**
 * Цепочка продажи (ecosystem package T): from one sale, where its money is — «Продажа → Чья → Смена → Отчёт →
 * Начисление → Выплата», one line each with its state, its words and the screen that opens it. The ONE component of
 * every place a sale stands (the shift screen's lines, the owner's dispute, the console's «Операции» and a fan's
 * operations): the sale's amount is the affordance — pressed, the strip opens in place, under it. The answer is Hub's
 * (`saleChain`): what the reader may not see is not in it, and a link whose source did not answer says «неизвестно».
 */

const KIND_WORDS: Readonly<Record<string, string>> = {
  message_purchase: "PPV",
  post_purchase: "пост",
  tip: "чаевые",
  stream_tip: "чаевые",
  subscription: "подписка",
};

const STATE_HINT: Readonly<Record<SaleChainLink["state"], string>> = {
  done: "на месте",
  wait: "ещё не",
  open: "открыт спор",
  none: "не относится",
  unknown: "неизвестно",
};

/** How a link of the strip opens: the app's router for its own paths, an anchor for the rest. */
export type ChainLinkRenderer = (href: string, children: ReactNode) => ReactNode;

const anchor: ChainLinkRenderer = (href, children) => <a href={href} className="ui-chain__go">{children}</a>;

function Step({ name, link, render, children }: { name: string; link: SaleChainLink; render: ChainLinkRenderer; children?: ReactNode }) {
  return (
    <li className={cx("ui-chain__step", `ui-chain__step--${link.state}`)}>
      <span className="ui-chain__dot" aria-label={STATE_HINT[link.state]} title={STATE_HINT[link.state]} />
      <span className="ui-chain__name">{name}</span>
      <span className="ui-chain__words">
        {link.words}
        {children}
      </span>
      <span className="ui-chain__money">{link.amountMills !== null && <Money mills={link.amountMills} />}</span>
      <span className="ui-chain__open">{link.link !== null && render(link.link, "Открыть")}</span>
    </li>
  );
}

/** The strip itself, from Hub's answer. */
export function SaleChain({ chain, renderLink = anchor }: { chain: SaleChainResponse; renderLink?: ChainLinkRenderer }) {
  const { sale, home } = chain;
  const fan = sale.fan.name ?? (sale.fan.username ? `@${sale.fan.username}` : null);
  const saleLink: SaleChainLink = {
    state: "done",
    words: [sale.pageLabel, KIND_WORDS[sale.kind] ?? sale.kind, fan, formatDateTime(sale.occurredAt)].filter((part): part is string => part !== null).join(" · "),
    link: null,
    amountMills: sale.netMills,
  };
  return (
    <div className="ui-chain">
      <ol className="ui-chain__steps">
        <Step name="Продажа" link={saleLink} render={renderLink} />
        <Step name="Чья" link={home} render={renderLink}>
          {home.above !== null && <span className="ui-chain__more">{home.above}</span>}
          {home.dispute !== null && <span className="ui-chain__more ui-chain__more--open">{home.dispute}</span>}
        </Step>
      </ol>
      {chain.people.map((person) => (
        <section key={person.userId} className="ui-chain__person" aria-label={person.name}>
          <h3 className="ui-chain__who">
            {person.name}
            {person.shareMills !== null && chain.people.length > 1 && <Money mills={person.shareMills} muted />}
          </h3>
          <ol className="ui-chain__steps">
            <Step name="Смена" link={person.shift} render={renderLink} />
            <Step name="Отчёт" link={person.report} render={renderLink} />
            <Step name="Начисление" link={person.accrual} render={renderLink} />
            <Step name="Выплата" link={person.payout} render={renderLink} />
          </ol>
        </section>
      ))}
      {chain.note !== null && <p className="ui-chain__note">{chain.note}</p>}
    </div>
  );
}

type Read = { state: "loading" } | { state: "ok"; chain: SaleChainResponse } | { state: "error"; hidden: boolean };

/**
 * The sale's amount as a button: pressed, the chain opens under it (a floating box in place, so it works in a table,
 * a card and a window alike). `load` reads `saleChain` for this sale; it is called each time the strip opens.
 */
export function SaleChainTrigger({ load, children, renderLink, align = "end", className }: {
  load: () => Promise<SaleChainResponse>;
  /** The amount shown on the line: the affordance. */
  children: ReactNode;
  renderLink?: ChainLinkRenderer;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Read>({ state: "loading" });
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, [box, button], button);
  const style = useAnchoredPosition(button, box, open, { align });
  const fetchChain = useCallback(() => {
    setRead({ state: "loading" });
    load().then(
      (chain) => setRead({ state: "ok", chain }),
      (error: unknown) => {
        const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
        setRead({ state: "error", hidden: status === 404 || status === 403 });
      },
    );
  }, [load]);
  useEffect(() => {
    if (open) fetchChain();
  }, [open, fetchChain]);
  return (
    <span className={cx("ui-chain-trigger", className)}>
      <button
        ref={button}
        type="button"
        className="ui-chain-trigger__button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Цепочка денег: от продажи до выплаты"
        onClick={() => setOpen(!open)}
      >
        {children}
      </button>
      {open && (
        <div ref={box} role="dialog" aria-label="Цепочка денег продажи" className="ui-popover ui-chain-pop" style={style}>
          <p className="ui-chain-pop__title">Цепочка денег</p>
          {read.state === "loading" && <div className="ui-chain-pop__wait"><Skeleton width="90%" /><Skeleton width="70%" /><Skeleton width="80%" /></div>}
          {read.state === "error" && (
            <p className="ui-chain__note">
              {read.hidden ? "Эта продажа вам не видна." : "Цепочка не пришла. "}
              {!read.hidden && <button type="button" className="ui-chain__retry" onClick={fetchChain}>Ещё раз</button>}
            </p>
          )}
          {read.state === "ok" && <SaleChain chain={read.chain} {...(renderLink ? { renderLink } : {})} />}
        </div>
      )}
    </span>
  );
}
