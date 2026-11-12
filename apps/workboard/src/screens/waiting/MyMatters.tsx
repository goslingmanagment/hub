import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { isMatterInfoKind, type Matter } from "@agency_hub_core/contracts";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { consoleHref } from "@/shared/links";
import { mattersListQuery } from "@/shared/matters";
import { waitedFor, waitingSince } from "./kinds";
import "./waiting.css";

/**
 * «Ждут вас» of a chatter: a strip above «Мои смены», not a menu item (ecosystem
 * plan §6, package K). Their own open matters only — Hub never serves a
 * chatter another person's matter or one with money. Nothing waits: no strip
 * at all. It is the person's own list, so it does not wait for the owner's
 * switch: what reaches it is what each check opens for them.
 */

const MINUTE = 60_000;

function Go({ link }: { link: string }) {
  if (link.startsWith("/workboard/") || link === "/workboard") return <Link to={link.slice("/workboard".length) || "/"} className="wt-go">Открыть</Link>;
  return <a href={consoleHref(link)} className="wt-go">Открыть</a>;
}

function Row({ matter, now }: { matter: Matter; now: number }) {
  const since = waitingSince(matter);
  return (
    <li className="wt-line">
      <div className="wt-line__main">
        <span className="wt-line__title">{matter.title}</span>
        {matter.pageLabels.length > 0 && <span className="wt-line__about">{matter.pageLabels.join(", ")}</span>}
      </div>
      <span className="wt-line__age" title={`С ${formatDateTime(since, { yearUnlessCurrent: true })}`}>{waitedFor(since, now)}</span>
      <span className="wt-line__go">{matter.link ? <Go link={matter.link} /> : null}</span>
    </li>
  );
}

export function MyMatters() {
  const list = useQuery({ ...mattersListQuery, refetchInterval: MINUTE });
  const matters = (list.data?.matters ?? []).filter((matter) => !isMatterInfoKind(matter.kind));
  if (matters.length === 0) return null;
  const now = list.data ? Date.parse(list.data.serverNow) : Date.now();
  return (
    <section className="wt-strip" aria-labelledby="wt-mine">
      <h2 className="wt-strip__title" id="wt-mine">Ждут вас</h2>
      <ul className="wt-sheet wt-lines">
        {matters.map((matter) => <Row key={matter.id} matter={matter} now={now} />)}
      </ul>
    </section>
  );
}
