import { useEffect, useRef, useState } from "react";
import type { ShiftReportClaim } from "@agency_hub_core/contracts";
import { Button, Fan, Money, TextInput, toast } from "@agency_hub_core/ui";
import { formatDateTime, formatDay, formatMills } from "@agency_hub_core/ui/format";
import { clockOf } from "@agency_hub_core/ui/shiftReports";
import { ChainMoney } from "@/shared/saleChain";
import { useClaimAnswer } from "./data";

/**
 * Заявки on the shift screen (ecosystem package G): a claim of another person on
 * a sale of yours stands under that line with the two answers, «Согласен» and
 * «Не согласен» (a line of why); your own claim says where it is — waiting for
 * the colleague, agreed, with the owner, decided. A claim of a sale that is not
 * a line here stands above the report. The words say what each answer does,
 * so nobody needs a manual: agreeing gives the sale away (or halves it),
 * disagreeing hands it to the owner.
 */

const KIND_WORDS: Readonly<Record<string, string>> = {
  message_purchase: "PPV",
  post_purchase: "пост",
  tip: "чаевые",
  stream_tip: "чаевые",
  subscription: "подписка",
};

function quoted(note: string | null): string {
  return note === null || note.trim() === "" ? "" : `«${note.trim()}»`;
}

/** The owner's decision in the reader's words (the names stand alone: no case endings to guess). */
function decisionWords(claim: ShiftReportClaim, own: boolean): string {
  const theirs = claim.direction === "incoming" ? "second" : "first";
  switch (claim.decision?.outcome) {
    case "first":
    case "second": {
      if (!own) return `Владелец решил: целиком ${(claim.decision.outcome === "first" ? claim.claimant?.name : claim.side?.name) ?? ""}`.trim();
      return claim.decision.outcome === theirs ? "Владелец решил: продажа ваша" : "Владелец решил: продажа не ваша";
    }
    case "half": return "Владелец решил: пополам";
    case "nobody": return "Владелец решил: никому";
    default: return "Владелец решил";
  }
}

/** Where a claim stands, one line: from the reader's side on their own report, in the third person on another's. */
export function claimState(claim: ShiftReportClaim, own = true): { tone: "wait" | "done" | "owner"; words: string } {
  const side = claim.side?.name ?? "Коллега";
  const why = claim.answerNote ? `, ${quoted(claim.answerNote)}` : "";
  if (claim.state === "decided") return { tone: "done", words: `${decisionWords(claim, own)}${claim.decision?.note ? ` (${quoted(claim.decision.note)})` : ""}` };
  if (claim.direction === "incoming" && own) {
    if (claim.state === "agreed") return { tone: "done", words: claim.statement === "share" ? "Вы ответили «Согласен»: пополам" : "Вы ответили «Согласен»: у вас эта продажа не считается" };
    if (claim.state === "owner" && claim.answer === "disagree") return { tone: "owner", words: `Вы ответили «Не согласен»${why}. Решит владелец` };
    if (claim.state === "owner") return { tone: "owner", words: "Вы не ответили за сутки: решит владелец. Ответить можно и сейчас" };
    return { tone: "wait", words: "" };
  }
  if (claim.state === "agreed") return { tone: "done", words: `${side}: «Согласен». ${claim.statement === "share" ? "Делите пополам" : "Продажа ваша"}` };
  if (claim.state === "owner") {
    switch (claim.escalatedWhy) {
      case "disagree": return { tone: "owner", words: `${side}: «Не согласен»${why}. Решит владелец` };
      case "silence": return { tone: "owner", words: `${side}: нет ответа за сутки. Решит владелец` };
      case "double": return { tone: "owner", words: `${side}: та же продажа в отчёте. Решит владелец` };
      default: return { tone: "owner", words: claim.side === null ? "Спросить некого: решит владелец" : `${side}: сдаёт смену не в системе. Решит владелец` };
    }
  }
  return { tone: "wait", words: `${side}: ответа пока нет${claim.answerBy ? `, ждём до ${formatDateTime(claim.answerBy)}` : ""}` };
}

/** «Согласен» / «Не согласен» with a line of why: the answer of the other side. */
function Answer({ claim, shiftId }: { claim: ShiftReportClaim; shiftId: number }) {
  const answer = useClaimAnswer(shiftId);
  const [disagreeing, setDisagreeing] = useState(false);
  const [why, setWhy] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (disagreeing) input.current?.focus();
  }, [disagreeing]);
  const send = (value: "agree" | "disagree") => answer.mutate({ claimId: claim.id, answer: value, note: value === "disagree" ? why.trim() : null }, {
    onSuccess: () => toast.success(value === "agree" ? "Ответ записан: вы согласны" : "Ответ записан: решит владелец"),
  });
  if (disagreeing) {
    return (
      <span className="shf-claim__answer">
        <TextInput
          ref={input}
          value={why}
          maxLength={300}
          placeholder="Почему не согласны? Одной строкой"
          aria-label="Почему не согласны"
          onChange={(event) => setWhy(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && why.trim() !== "") send("disagree");
            if (event.key === "Escape") setDisagreeing(false);
          }}
        />
        <Button size="sm" variant="primary" disabled={why.trim() === ""} loading={answer.isPending} onClick={() => send("disagree")}>Отправить</Button>
        <Button size="sm" variant="ghost" onClick={() => setDisagreeing(false)}>Отмена</Button>
      </span>
    );
  }
  return (
    <span className="shf-claim__answer">
      <Button size="sm" variant="primary" loading={answer.isPending && answer.variables?.answer === "agree"} onClick={() => send("agree")}>Согласен</Button>
      <Button size="sm" variant="secondary" onClick={() => setDisagreeing(true)}>Не согласен</Button>
    </span>
  );
}

/** A claim under its line: someone else's with the answers, or where yours stands. */
export function ClaimOnLine({ claim, shiftId, netMills, own = true }: { claim: ShiftReportClaim; shiftId: number; netMills: number; own?: boolean }) {
  if (claim.direction === "incoming" && claim.canAnswer && claim.state === "asked") {
    const who = claim.claimant?.name ?? "Коллега";
    const share = claim.statement === "share";
    const half = Math.floor(netMills / 2);
    return (
      <div className="shf-claim shf-claim--ask" role="group" aria-label={`Заявка: ${who}`}>
        <p className="shf-claim__title">{share ? `${who} предлагает делить эту продажу пополам` : `${who} считает эту продажу своей`}</p>
        {claim.note && <p className="shf-claim__note">{quoted(claim.note)}</p>}
        <p className="shf-claim__what">
          {share
            ? <>Согласны: каждому по <Money mills={half} />. Не согласны: решит владелец.</>
            : <>Согласны: её получит {who}, у вас она не считается. Не согласны: решит владелец.</>}
          {claim.answerBy && <> Ответьте до {formatDateTime(claim.answerBy)}.</>}
        </p>
        <Answer claim={claim} shiftId={shiftId} />
      </div>
    );
  }
  const state = claimState(claim, own);
  if (claim.direction === "incoming" && claim.canAnswer) {
    return (
      <div className="shf-claim shf-claim--owner" role="group">
        <p className="shf-claim__title">{claim.claimant?.name ?? "Коллега"} {claim.statement === "share" ? "предлагает делить эту продажу пополам" : "считает эту продажу своей"}{claim.note ? `: ${quoted(claim.note)}` : ""}</p>
        <p className="shf-claim__what">{state.words}.</p>
        <Answer claim={claim} shiftId={shiftId} />
      </div>
    );
  }
  const lead = claim.direction === "incoming"
    ? `${claim.claimant?.name ?? "Коллега"} ${claim.statement === "share" ? "предлагает делить её пополам" : "считает её своей"}${claim.note ? `: ${quoted(claim.note)}` : ""}. `
    : "";
  return (
    <p className={`shf-claim-line shf-claim-line--${state.tone}`}>
      {lead}{state.words}
    </p>
  );
}

/** Claims of the reader's sales that are not lines of this report: above it, each with the sale. */
export function LooseClaims({ claims, shiftId }: { claims: readonly ShiftReportClaim[]; shiftId: number }) {
  if (claims.length === 0) return null;
  return (
    <section className="shf-card shf-claims-loose" aria-labelledby="shf-loose">
      <header className="shf-card__head">
        <h2 id="shf-loose" className="shf-card__title">Заявки на ваши продажи</h2>
        <span className="shf-card__hint">продажи из других смен</span>
      </header>
      <ul className="shf-sales">
        {claims.map((claim) => (
          <li key={claim.id} className="shf-sale" id={claim.transactionId === null ? undefined : `sale-${claim.transactionId}`}>
            <span className="shf-sale__time">{claim.sale ? <>{formatDay(claim.sale.occurredAt)}<br />{clockOf(claim.sale.occurredAt)}</> : null}</span>
            <div className="shf-sale__main">
              <p className="shf-sale__what">
                {claim.pageLabel && <span className="ui-page">{claim.pageLabel}</span>}
                {claim.sale && <Fan name={claim.sale.fan.name} username={claim.sale.fan.username} fanRef={claim.sale.fan.fanRef ?? ""} className="shf-sale__fan" />}
                {claim.sale && <span className="shf-sale__kind">{KIND_WORDS[claim.sale.kind] ?? claim.sale.kind}</span>}
              </p>
              <ClaimOnLine claim={claim} shiftId={shiftId} netMills={claim.sale?.netMills ?? 0} />
            </div>
            <span className="shf-sale__money">{claim.sale && claim.transactionId !== null && <ChainMoney saleId={claim.transactionId}><Money mills={claim.sale.netMills} muted /></ChainMoney>}</span>
            <span className="shf-sale__act" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The amount words of a claim for a toast or a title. */
export const claimMoney = (mills: number) => formatMills(mills);
