import type { ReactNode } from "react";
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

// «Ссылки»: one row per link. A table where the screen is wide, a list of
// cards where it is not (container query on the section). The phone rule of
// ui.css (no wrapping in a data table) does not reach the table: below 56rem
// the list is shown instead.

function Muted({ children, nowrap = false }: { children: ReactNode; nowrap?: boolean }) {
  return <span className={`block text-xs text-text-muted ${nowrap ? "whitespace-nowrap" : ""}`}>{children}</span>;
}

function LinkCell({ link }: { link: OfLink }) {
  return <>
    <span className="block font-medium text-text-primary">{link.name ?? `Ссылка ${link.linkRef}`}</span>
    <Muted>
      {linkKindLabels[link.linkKind]}
      {link.trialDays !== null && ` · ${link.trialDays} дн.`}
      {" · "}
      {link.url ? <a className="underline decoration-dotted hover:text-accent" href={link.url} target="_blank" rel="noreferrer">{link.linkRef}</a> : link.linkRef}
    </Muted>
  </>;
}

/** The state, its term, and — when the link fell out of the last collection —
 *  that fact; when its figures were read is in the cell's tooltip. */
function StateCell({ link, now }: { link: OfLink; now: number }) {
  const state = linkStateView(link);
  return <span className="block" title={`Данные на ${moscowDateTime(link.observedAt)} МСК · ${agoText(link.observedAt, now)}`}>
    <span className={toneBadge[state.tone]}>{state.label}</span>
    {state.detail && <Muted nowrap>{state.detail}</Muted>}
    {!link.inLatestRun && <span className="block whitespace-nowrap text-xs text-warning-dark">нет в последнем сборе</span>}
  </span>;
}

function FansCell({ link }: { link: OfLink }) {
  const fans = fansView(link);
  return <>
    <span className="block font-medium tabular-nums">{fans.value}</span>
    <Muted nowrap>{fans.metric}</Muted>
  </>;
}

function VendorCell({ link }: { link: OfLink }) {
  const vendor = vendorMoneyView(link);
  return <>
    <span className={`block whitespace-nowrap tabular-nums ${vendor.amount === null ? "text-text-muted" : "font-medium"}`}>{vendor.amount ?? "нет данных"}</span>
    <Muted>{vendor.note}</Muted>
    {vendor.recalculation && <span className="mt-0.5 block text-xs text-warning-dark" data-of-link-recalculation="">
      {vendor.recalculation.when}<br /><span className="whitespace-nowrap">{vendor.recalculation.change}</span>
    </span>}
    {vendor.recalculation?.account && <span className="block text-xs text-warning-dark">{vendor.recalculation.account}</span>}
  </>;
}

function HubCell({ link }: { link: OfLink }) {
  const hub = hubMoneyView(link);
  return <>
    <span className={`block whitespace-nowrap tabular-nums ${hub.amount === null ? "text-text-muted" : "font-medium"}`}>{hub.amount ?? "нет данных"}</span>
    {hub.note && <Muted>{hub.note}</Muted>}
  </>;
}

function DifferenceCell({ link }: { link: OfLink }) {
  const difference = differenceView(link);
  return <>
    <span className="block whitespace-nowrap tabular-nums">{difference.amount ?? "—"}</span>
    {difference.period && <Muted>{difference.period}</Muted>}
    {difference.figures && <Muted>{difference.figures}</Muted>}
    {difference.note && <Muted>{difference.note}</Muted>}
  </>;
}

function ChannelCell({ link }: { link: OfLink }) {
  const binding = bindingView(link);
  if (binding === null) return <span className="text-text-muted">без канала</span>;
  return <span className="block [overflow-wrap:anywhere]">
    <span className="block text-text-primary">{binding.channel}</span>
    <Muted>{binding.contractor}</Muted>
    <Muted>{binding.dates}{binding.assumed && " · начало не подтверждено"}</Muted>
  </span>;
}

const columns: Array<{ title: string; numeric?: boolean; render: (link: OfLink, now: number) => ReactNode }> = [
  { title: "Ссылка", render: (link) => <LinkCell link={link} /> },
  { title: "Статус", render: (link, now) => <StateCell link={link} now={now} /> },
  { title: "Клики", numeric: true, render: (link) => <span className="tabular-nums">{count(link.clicks)}</span> },
  { title: "Фаны", numeric: true, render: (link) => <FansCell link={link} /> },
  { title: "Доход по OnlyFans", numeric: true, render: (link) => <VendorCell link={link} /> },
  { title: "Доход по Hub", numeric: true, render: (link) => <HubCell link={link} /> },
  { title: "Разница", numeric: true, render: (link) => <DifferenceCell link={link} /> },
  { title: "Канал", render: (link) => <ChannelCell link={link} /> },
];

export function OfLinksTable({ links, now }: { links: readonly OfLink[]; now: number }) {
  return <div className="@container">
    <div className="hidden overflow-x-auto @4xl:block">
      <table className="data-table" data-of-links="table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column.title} scope="col" className={column.numeric ? "num" : undefined}>{column.title}</th>)}
          </tr>
        </thead>
        <tbody>
          {links.map((link) => <tr key={`${link.pageId}:${link.linkKind}:${link.linkRef}`} data-of-link={link.linkRef}>
            {/* Not `num`: a money cell carries notes that must wrap. */}
            {columns.map((column) => <td key={column.title} className={`align-top ${column.numeric ? "text-right tabular-nums" : ""} ${link.state === "active" ? "" : "muted"}`}>{column.render(link, now)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <ul className="divide-y divide-border-light @4xl:hidden" data-of-links="list">
      {links.map((link) => <li key={`${link.pageId}:${link.linkKind}:${link.linkRef}`} className="px-5 py-4" data-of-link={link.linkRef}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 break-words"><LinkCell link={link} /></div>
          <div className="shrink-0 text-right"><StateCell link={link} now={now} /></div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm @md:grid-cols-3 @xl:grid-cols-4">
          {columns.slice(2).map((column) => <div key={column.title} className="min-w-0 break-words">
            <dt className="text-xs text-text-muted">{column.title}</dt>
            <dd>{column.render(link, now)}</dd>
          </div>)}
        </dl>
      </li>)}
    </ul>
  </div>;
}
