import { useState } from "react";
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

/** A claim of a colleague on your sale (package G) waits a day for your answer, then goes to the owner. */
const CLAIM_KIND = "sale.claim";

function Row({ matter, now }: { matter: Matter; now: number }) {
  const since = waitingSince(matter);
  const answerBy = matter.kind === CLAIM_KIND && typeof matter.evidence.answerBy === "string" ? matter.evidence.answerBy : null;
  const about = [matter.pageLabels.join(", "), answerBy === null ? "" : `ответьте до ${formatDateTime(answerBy)}, потом решит владелец`].filter((part) => part !== "");
  return (
    <li className="wt-line">
      <div className="wt-line__main">
        <span className="wt-line__title">{matter.title}</span>
        {about.length > 0 && <span className="wt-line__about">{about.join(" · ")}</span>}
      </div>
      <span className="wt-line__age" title={`С ${formatDateTime(since, { yearUnlessCurrent: true })}`}>{waitedFor(since, now)}</span>
      <span className="wt-line__go">{matter.link ? <Go link={matter.link} /> : null}</span>
    </li>
  );
}

/** The strip shows this many lines (the longest waiting), the rest unfold in place: the shifts stay on the first screen. */
const STRIP_SHOWN = 3;

export function MyMatters() {
  const list = useQuery({ ...mattersListQuery, refetchInterval: MINUTE });
  const [all, setAll] = useState(false);
  const matters = (list.data?.matters ?? [])
    .filter((matter) => matter.mine && !isMatterInfoKind(matter.kind))
    .map((matter) => ({ matter, since: waitingSince(matter) }))
    // A claim to answer comes first: it has a day before it goes to the owner. Then the longest waiting.
    .sort((left, right) => Number(right.matter.kind === CLAIM_KIND) - Number(left.matter.kind === CLAIM_KIND)
      || left.since.localeCompare(right.since) || left.matter.id - right.matter.id);
  if (matters.length === 0) return null;
  const now = list.data ? Date.parse(list.data.serverNow) : Date.now();
  const shown = all ? matters : matters.slice(0, STRIP_SHOWN);
  return (
    <section className="wt-strip" aria-labelledby="wt-mine">
      <h2 className="wt-strip__title" id="wt-mine">Ждут вас</h2>
      <ul className="wt-sheet wt-lines">
        {shown.map(({ matter }) => <Row key={matter.id} matter={matter} now={now} />)}
      </ul>
      {shown.length < matters.length && (
        <button type="button" className="wt-link wt-strip__more" onClick={() => setAll(true)}>
          ещё {matters.length - shown.length}
        </button>
      )}
    </section>
  );
}
