import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isMatterInfoKind, waitingProductOf, type Matter } from "@agency_hub_core/contracts";
import { toast } from "@agency_hub_core/ui";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { kernel } from "@/shared/hub";
import { consoleHref } from "@/shared/links";
import { mattersListQuery } from "@/shared/myMatters";
import { waitedFor, waitingSince } from "@agency_hub_core/ui/waiting/kinds";

/**
 * The first lines of what waits for the person themself (their own matters, and a lead's of the teams they lead), on
 * «Сегодня» (products package W): the longest waiting first, a colleague's question on their sale before all; the whole
 * list is «Ждут вас». Nothing waits: one quiet line. Hub never serves a chatter another person's matter or one with money.
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
export function ClaimAnswer({ claimId }: { claimId: number }) {
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

/** How many lines «Сегодня» shows; the rest are in «Ждут вас». */
const SHOWN = 3;

/** `workboardOnly`: the owner's, whose Workboard list is Workboard's cut (the rest waits in Hub's «Ждут вас»). */
export function MyMatters({ title = "Ждут вас", workboardOnly = false }: { title?: string; workboardOnly?: boolean }) {
  const list = useQuery({ ...mattersListQuery, refetchInterval: MINUTE });
  const matters = (list.data?.matters ?? [])
    .filter((matter) => matter.mine && !isMatterInfoKind(matter.kind) && (!workboardOnly || waitingProductOf(matter.kind) === "workboard"))
    .map((matter) => ({ matter, since: waitingSince(matter) }))
    // A claim to answer comes first: it has a day before it goes to the owner. Then the longest waiting.
    .sort((left, right) => Number(right.matter.kind === CLAIM_KIND) - Number(left.matter.kind === CLAIM_KIND)
      || left.since.localeCompare(right.since) || left.matter.id - right.matter.id);
  const now = list.data ? Date.parse(list.data.serverNow) : Date.now();
  const shown = matters.slice(0, SHOWN);
  return (
    <section className="wt-strip" aria-labelledby="wt-mine">
      <h2 className="wt-strip__title" id="wt-mine">
        {title}
        {matters.length > 0 && <Link className="wt-link wt-strip__all" to="/waiting">{matters.length > SHOWN ? `все ${matters.length}` : "открыть"}</Link>}
      </h2>
      {list.isLoading ? <p className="ui-muted wt-strip__none">Смотрим…</p>
        : list.isError && !list.data ? <p className="ui-muted wt-strip__none">Не удалось узнать, что ждёт. Спросим снова через минуту.</p>
          : matters.length === 0 ? <p className="ui-muted wt-strip__none">Сейчас ничего не ждёт.</p>
            : <ul className="wt-sheet wt-lines">{shown.map(({ matter }) => <Row key={matter.id} matter={matter} now={now} />)}</ul>}
    </section>
  );
}
