import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isMatterInfoKind, type Matter } from "@agency_hub_core/contracts";
import { toast } from "@agency_hub_core/ui";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { kernel } from "@/shared/hub";
import { consoleHref } from "@/shared/links";
import { mattersListQuery } from "@/shared/myMatters";
import { waitedFor, waitingSince } from "@agency_hub_core/ui/waiting/kinds";

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

/** A colleague's question on your sale waits a day for your answer; after a day of silence the sale stays with the one who asked (`silenceSettles`). */
const CLAIM_KIND = "sale.claim";

/**
 * The answer to a colleague's question, in the line itself: the sale may be on none of the person's boards (it waits
 * for their next shift), and one press is all an answer is. «Не согласен» sends the question to whoever decides.
 */
function ClaimAnswer({ claimId }: { claimId: number }) {
  const client = useQueryClient();
  const answer = useMutation({
    mutationFn: (word: "agree" | "disagree") => kernel.saleClaimAnswer({ params: { claimId }, body: { answer: word, note: null } }),
    onSuccess: (_saved, word) => {
      toast.success(word === "agree" ? "Продажа отдана" : "Записано: вы не согласны");
      void client.invalidateQueries({ queryKey: ["matters"] });
      void client.invalidateQueries({ queryKey: ["report"] });
    },
    onError: () => toast.error("Не получилось. Попробуйте ещё раз"),
  });
  return (
    <span className="wt-answer">
      <button type="button" className="wt-go wt-answer__one" disabled={answer.isPending} onClick={() => answer.mutate("agree")}>Согласен</button>
      <button type="button" className="wt-go wt-answer__one" disabled={answer.isPending} onClick={() => answer.mutate("disagree")}>Не согласен</button>
    </span>
  );
}

function Row({ matter, now }: { matter: Matter; now: number }) {
  const since = waitingSince(matter);
  const claim = matter.kind === CLAIM_KIND;
  const answerBy = claim && typeof matter.evidence.answerBy === "string" ? matter.evidence.answerBy : null;
  const claimId = claim && typeof matter.evidence.claimId === "number" ? matter.evidence.claimId : null;
  const why = claim && typeof matter.evidence.note === "string" && matter.evidence.note.trim() !== "" ? matter.evidence.note.trim() : null;
  const about = [matter.pageLabels.join(", "), answerBy === null ? "" : `ответьте до ${formatDateTime(answerBy)}, иначе продажа останется за тем, кто забрал`].filter((part) => part !== "");
  return (
    <li className="wt-line">
      <div className="wt-line__main">
        <span className="wt-line__title">{matter.title}</span>
        {why !== null && <span className="wt-line__about">«{why}»</span>}
        {about.length > 0 && <span className="wt-line__about">{about.join(" · ")}</span>}
      </div>
      <span className="wt-line__age" title={`С ${formatDateTime(since, { yearUnlessCurrent: true })}`}>{waitedFor(since, now)}</span>
      <span className="wt-line__go">{claimId !== null ? <ClaimAnswer claimId={claimId} /> : matter.link ? <Go link={matter.link} /> : null}</span>
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
