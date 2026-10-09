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
  vendorMoneyView,
  type Tone,
} from "./ofLinksView.js";

// «Ссылки OnlyFans»: one row per link. A table where the screen is wide, a
// list of cards where it is not (container query on the section).

const toneClass: Record<Tone, string> = {
  ok: "bg-emerald-500/10 text-emerald-700",
  muted: "bg-hover text-text-secondary",
  warn: "bg-amber-500/10 text-amber-700",
};

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

function StateCell({ link }: { link: OfLink }) {
  const state = linkStateView(link);
  return <>
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${toneClass[state.tone]}`}>{state.label}</span>
    {state.detail && <Muted nowrap>{state.detail}</Muted>}
  </>;
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
    {vendor.recalculation && <span className="mt-0.5 block text-xs text-amber-700" data-of-link-recalculation="">
      {vendor.recalculation.when}<br /><span className="whitespace-nowrap">{vendor.recalculation.change}</span>
    </span>}
    {vendor.recalculation?.account && <span className="block text-xs text-amber-700">{vendor.recalculation.account}</span>}
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

function SnapshotCell({ link, now }: { link: OfLink; now: number }) {
  return <>
    <span className="block whitespace-nowrap tabular-nums">{moscowDateTime(link.observedAt)}</span>
    <Muted nowrap>{link.inLatestRun ? agoText(link.observedAt, now) : "нет в последнем сборе"}</Muted>
  </>;
}

const head = "px-2.5 py-2 text-xs font-medium text-text-muted";
const cell = "px-2.5 py-2.5 align-top";
const columns: Array<{ title: string; numeric?: boolean; render: (link: OfLink, now: number) => ReactNode }> = [
  { title: "Ссылка", render: (link) => <LinkCell link={link} /> },
  { title: "Статус и срок", render: (link) => <StateCell link={link} /> },
  { title: "Клики", numeric: true, render: (link) => <span className="tabular-nums">{count(link.clicks)}</span> },
  { title: "Фаны", numeric: true, render: (link) => <FansCell link={link} /> },
  { title: "OFAPI, чистыми", numeric: true, render: (link) => <VendorCell link={link} /> },
  { title: "Hub, чистыми", numeric: true, render: (link) => <HubCell link={link} /> },
  { title: "Разница", numeric: true, render: (link) => <DifferenceCell link={link} /> },
  { title: "Канал · подрядчик", render: (link) => <ChannelCell link={link} /> },
  { title: "Снимок, МСК", render: (link, now) => <SnapshotCell link={link} now={now} /> },
];

export function OfLinksTable({ links, now }: { links: readonly OfLink[]; now: number }) {
  return <div className="@container">
    <div className="hidden overflow-x-auto @4xl:block">
      <table className="w-full text-sm" data-of-links="table">
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => <th key={column.title} scope="col" className={`${head} ${column.numeric ? "text-right" : "text-left"}`}>{column.title}</th>)}
          </tr>
        </thead>
        <tbody>
          {links.map((link) => <tr key={`${link.pageId}:${link.linkKind}:${link.linkRef}`} className={`border-b border-border-light ${link.state === "active" ? "" : "text-text-secondary"}`} data-of-link={link.linkRef}>
            {columns.map((column) => <td key={column.title} className={`${cell} ${column.numeric ? "text-right" : ""}`}>{column.render(link, now)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <ul className="divide-y divide-border-light @4xl:hidden" data-of-links="list">
      {links.map((link) => <li key={`${link.pageId}:${link.linkKind}:${link.linkRef}`} className="py-3" data-of-link={link.linkRef}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 break-words"><LinkCell link={link} /></div>
          <div className="shrink-0 text-right"><StateCell link={link} /></div>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm @md:grid-cols-3 @xl:grid-cols-4">
          {columns.slice(2).map((column) => <div key={column.title} className="min-w-0 break-words">
            <dt className="text-xs text-text-muted">{column.title}</dt>
            <dd>{column.render(link, now)}</dd>
          </div>)}
        </dl>
      </li>)}
    </ul>
  </div>;
}
