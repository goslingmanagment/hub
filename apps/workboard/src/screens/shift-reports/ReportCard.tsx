import { useLocation } from "react-router";
import { LinkButton, Money, PageLabel, Tooltip } from "@agency_hub_core/ui";
import { shiftPauseText } from "@agency_hub_core/ui/shiftLive";
import { shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { qualityOfChatterNumbers } from "@/shared/metrics";
import { shiftPath, type BackTarget } from "@/shared/links";
import { ShiftCardFrame } from "../my-shifts/ShiftCard.js";
import { numbersFor } from "../shifts/data.js";
import type { NumbersAnswer } from "./data.js";
import { feedStepOf, type Report } from "./model.js";

/**
 * One report of «Смены → Отчёты»: the card of «Мои» (ShiftCardFrame) with the person on it. The money is Hub's for
 * this reader: the report's total — counted «по отчёту», handed in and not counted yet «сдано» — with each page's sum
 * when there are several; before a hand-in one's own draft «предварительно» (as «Мои»), anyone else's shift its sales
 * «по правилу», in the quieter ink. What it is made of and
 * the line in time are the report's own lines once handed in, the rule's before. The comment for the next shift as
 * text. Someone else's report has no button (the card opens the shift's page); one's own has the step «Мои» shows.
 */

/** The card's money and, for a report of several pages, each page's sum. */
function ReportMoney({ report }: { report: Report }) {
  const handed = report.report;
  if (handed !== null) {
    const word = handed.source === "version" ? "по отчёту" : "сдано";
    const sum = (
      <span className="mys-card__sum">
        <Money mills={handed.totalMills} strong={handed.source === "version"} />
        <span className="mys-card__sum-word">{word}{handed.cut ? ", ваши страницы" : ""}</span>
      </span>
    );
    return (
      <div className="mys-card__money">
        {handed.cut
          ? <Tooltip content="В отчёте есть страницы, которых вы не ведёте: здесь только ваши." align="end">{sum}</Tooltip>
          : handed.source === "candidate"
            ? <Tooltip content="Отчёт сдан, но ещё не учтён: его проверяют или ждут «Подтверждаю»." align="end">{sum}</Tooltip>
            : sum}
        {handed.pages.length > 1 && (
          <ul className="rep-card__pages" aria-label="По страницам">
            {handed.pages.map((page) => (
              <li key={page.pageLabel}>
                <PageLabel label={page.pageLabel} />
                <Money mills={page.amountMills} muted={page.amountMills === 0} />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  // One's own shift not handed in: its draft, as «Мои» shows it.
  if (report.draftTotalMills !== null) {
    return (
      <div className="mys-card__money">
        <Tooltip content="Черновик отчёта: сумма по правилу и вашим отметкам. Станет итоговой, когда вы сдадите смену." align="end">
          <span className="mys-card__sum"><Money mills={report.draftTotalMills} /><span className="mys-card__sum-word mys-card__sum-word--pre">предварительно</span></span>
        </Tooltip>
      </div>
    );
  }
  if (report.rule === null) return <div className="mys-card__money" />;
  return (
    <div className="mys-card__money">
      <Tooltip content="Продажи смены по правилу «чья продажа», как их видит Hub: это не отчёт. Сумма отчёта может быть другой: в нём делят продажи с коллегами и добавляют то, чего нет в Hub." align="end">
        <span className="mys-card__sum mys-card__sum--rule"><Money mills={report.rule.mills} /><span className="mys-card__sum-word">по правилу</span></span>
      </Tooltip>
    </div>
  );
}

/** The comment for the next shift: what the next shift reads, as written. */
function NextComment({ comments }: { comments: Report["comments"] }) {
  return (
    <div className="rep-card__comment">
      <span className="rep-card__comment-head">Следующей смене</span>
      {comments.map((one) => (
        <p key={`${one.modelName}:${one.comment}`} className="rep-card__comment-text">
          {one.modelName !== "" && <b>{one.modelName}: </b>}
          {one.comment}
        </p>
      ))}
    </div>
  );
}

export function ReportCard({ report, numbers, maxSaleMills, back }: {
  report: Report;
  numbers: NumbersAnswer | undefined;
  maxSaleMills: number;
  back: { back: BackTarget };
}) {
  const location = useLocation();
  const step = feedStepOf(report);
  const when = shiftWhen({ startedAt: report.startedAt, endedAt: report.endedAt, ongoing: report.ongoing, workedMinutes: report.workedMinutes });
  const parts = report.report?.parts ?? report.rule;
  const found = numbersFor(report, numbers);
  const board = `/report/${report.shiftId}`;
  return (
    <ShiftCardFrame
      cardKey={String(report.shiftId)}
      page={shiftPath(report.userId, report.startedAt, location.search)}
      back={back}
      person={report.personName}
      when={when}
      ongoing={report.ongoing}
      pause={shiftPauseText(report)}
      workedMinutes={report.workedMinutes}
      pages={report.pages}
      money={<ReportMoney report={report} />}
      track={{ startedAt: report.startedAt, endedAt: report.endedAt, ongoing: report.ongoing, pauses: report.pauses, sales: parts?.sales ?? [] }}
      kinds={parts === null ? null : { parts, basis: report.report !== null ? "report" : "rule" }}
      numbers={found === undefined ? undefined : { numbers: found.numbers, quality: qualityOfChatterNumbers(found.numbers), ongoing: found.ongoing }}
      maxSaleMills={maxSaleMills}
      note={report.comments.length > 0 ? <NextComment comments={report.comments} /> : undefined}
      step={step}
      facts={step.facts}
      actions={report.own
        ? <LinkButton to={board} state={back} variant={step.action !== null ? "primary" : "ghost"} size="md">{step.action ?? "Открыть отчёт"}</LinkButton>
        : null}
    />
  );
}
