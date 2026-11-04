import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { OfLink } from "@agency_hub_core/contracts";

import {
  agoText,
  bindingView,
  count,
  differenceView,
  fansView,
  hubMoneyView,
  linkKindLabels,
  linkStateView,
  moscowDateTime,
  toneBadge,
  vendorMoneyView,
} from "./ofLinksView.js";

// «Ссылки OnlyFans»: one row per link, a chevron opens what OnlyFans itself
// counted. A table where the screen is wide, a list of cards where it is not
// (container query on the section).

function Sub({ children }: { children: ReactNode }) {
  return <span className="fan-cell-sub block">{children}</span>;
}

function kindLine(link: OfLink): string {
  if (link.linkKind !== "trial" || link.trialDays === null) return linkKindLabels[link.linkKind];
  const days = link.trialDays;
  const mod10 = days % 10;
  const mod100 = days % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "день" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "дня" : "дней";
  return `Пробная ссылка на ${days} ${word}`;
}

function StateCell({ link }: { link: OfLink }) {
  const state = linkStateView(link);
  return <>
    <span className={toneBadge[state.tone]}>{state.label}</span>
    {state.detail && <Sub>{state.detail}</Sub>}
    {!link.inLatestRun && <Sub>нет в последнем сборе</Sub>}
  </>;
}

function HubCell({ link }: { link: OfLink }) {
  const hub = hubMoneyView(link);
  return <>
    <span className={hub.amount === null ? "text-text-muted" : undefined}>{hub.amount ?? "нет данных"}</span>
    {hub.note && <Sub>{hub.note.replace(" · ", ", ")}</Sub>}
  </>;
}

function ChannelCell({ link }: { link: OfLink }) {
  const binding = bindingView(link);
  if (binding === null) return <span className="text-text-muted">без канала</span>;
  return <>
    <span>{binding.channel}</span>
    <Sub>{binding.contractor}</Sub>
    <Sub>{binding.dates}{binding.assumed && ", начало не подтверждено"}</Sub>
  </>;
}

/** The opened row: what OnlyFans counted, its recalculation, the difference, when, the number. */
function LinkDetails({ link, now }: { link: OfLink; now: number }) {
  const vendor = vendorMoneyView(link);
  const difference = differenceView(link);
  return (
    <dl className="kv of-link-details">
      <dt>Доход по OnlyFans</dt>
      <dd>
        <span className={vendor.amount === null ? "text-text-muted" : undefined}>{vendor.amount ?? "нет данных"}</span>
        <Sub>{vendor.note}</Sub>
      </dd>
      <dt>Пересчёт</dt>
      <dd>
        {vendor.recalculation ? <>
          {vendor.recalculation.when}: {vendor.recalculation.change}
          {vendor.recalculation.account && <Sub>{vendor.recalculation.account}</Sub>}
        </> : <span className="text-text-muted">не было</span>}
      </dd>
      <dt>Разница</dt>
      <dd>
        {difference.amount ?? <span className="text-text-muted">—</span>}
        {difference.period && <Sub>{difference.period}</Sub>}
        {difference.figures && <Sub>{difference.figures}</Sub>}
        {difference.note && <Sub>{difference.note}</Sub>}
      </dd>
      <dt>Данные на</dt>
      <dd>{moscowDateTime(link.observedAt)}, {agoText(link.observedAt, now)}</dd>
      <dt>Номер ссылки</dt>
      <dd>{link.url ? <a className="link" href={link.url} target="_blank" rel="noreferrer">{link.linkRef}</a> : link.linkRef}</dd>
    </dl>
  );
}

export function OfLinksTable({ links, now }: { links: readonly OfLink[]; now: number }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const keyOf = (link: OfLink) => `${link.pageId}:${link.linkKind}:${link.linkRef}`;
  const toggle = (key: string) => setOpen((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return <div className="@container">
    <div className="table-wrap hidden @4xl:block">
      <table className="data-table fan-table" data-of-links="table">
        <thead>
          <tr>
            <th scope="col">Ссылка</th>
            <th scope="col">Статус</th>
            <th scope="col" className="num">Клики</th>
            <th scope="col" className="num">Фаны</th>
            <th scope="col" className="num">Доход по Hub</th>
            <th scope="col">Канал</th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => {
            const key = keyOf(link);
            const expanded = open.has(key);
            const fans = fansView(link);
            return <Fragment key={key}>
              <tr data-of-link={link.linkRef} className="cursor-pointer" onClick={() => toggle(key)}>
                <td>
                  <button type="button" className="of-link-toggle" aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); toggle(key); }}>
                    <ChevronRight size={16} aria-hidden="true" className={expanded ? "rotate-90" : undefined} />
                    <span>{link.name ?? `Ссылка ${link.linkRef}`}</span>
                  </button>
                  <span className="fan-cell-sub block of-link-indent">{kindLine(link)}</span>
                </td>
                <td className="status-col"><StateCell link={link} /></td>
                <td className="num">{count(link.clicks)}</td>
                <td className="num">{fans.value}<Sub>{fans.metric}</Sub></td>
                <td className="num"><HubCell link={link} /></td>
                <td><ChannelCell link={link} /></td>
              </tr>
              {expanded && (
                <tr className="of-link-open">
                  <td colSpan={6}><LinkDetails link={link} now={now} /></td>
                </tr>
              )}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
    <ul className="of-link-cards @4xl:hidden" data-of-links="list">
      {links.map((link) => {
        const fans = fansView(link);
        return <li key={keyOf(link)} data-of-link={link.linkRef}>
          <div className="of-link-card-head">
            <div className="min-w-0">
              <span className="font-medium">{link.name ?? `Ссылка ${link.linkRef}`}</span>
              <Sub>{kindLine(link)}</Sub>
            </div>
            <div className="shrink-0 text-right"><StateCell link={link} /></div>
          </div>
          <dl className="of-link-card-grid">
            <div><dt>Клики</dt><dd>{count(link.clicks)}</dd></div>
            <div><dt>Фаны</dt><dd>{fans.value}<Sub>{fans.metric}</Sub></dd></div>
            <div><dt>Доход по Hub</dt><dd><HubCell link={link} /></dd></div>
            <div><dt>Канал</dt><dd><ChannelCell link={link} /></dd></div>
          </dl>
          <details className="help">
            <summary>Подробнее</summary>
            <div className="help-body"><LinkDetails link={link} now={now} /></div>
          </details>
        </li>;
      })}
    </ul>
  </div>;
}
