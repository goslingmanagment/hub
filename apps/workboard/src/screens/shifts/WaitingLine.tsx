import { Fragment, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Button } from "@agency_hub_core/ui";
import { decisionParts, decisionsElsewhereText, decisionsFailedText, useDecisionCounts } from "@/shared/decisions";
import { carryParams } from "@/shared/links";
import { usePageFilter } from "@/shared/usePageFilter";

/**
 * «Ждут решения» (spec §4.1.1, D17): one quiet line, only when something waits
 * for the owner's decision. With a page picked it counts that page — the same
 * numbers Решения shows after the click — and a quiet tail says what waits on
 * the other pages (it opens Решения of every page). Each part leads to its
 * section of Решения, with this period and page. A queue that did not answer is
 * said in words with «Повторить», never read as a zero. Hidden at zero and while
 * a queue is still being read (never a partial sum that grows a moment later).
 */
export function WaitingLine() {
  const { page } = usePageFilter();
  const counts = useDecisionCounts({ page });
  const location = useLocation();
  if (!counts.settled) return null;

  const parts = decisionParts(counts, location.search);
  const failed = decisionsFailedText(counts);
  const elsewhere = decisionsElsewhereText(counts.elsewhere);
  if (parts.length === 0 && failed === null && elsewhere === null) return null;

  // «ещё 4 на других страницах» opens Решения of every page: the period stays, the page filter goes.
  const everyPage = carryParams(location.search);
  everyPage.delete("page");
  const everyPageSearch = everyPage.toString();
  const tail: ReactNode[] = [];
  if (elsewhere) {
    tail.push(
      <Link key="elsewhere" to={{ pathname: "/decisions", search: everyPageSearch ? `?${everyPageSearch}` : "" }} className="shifts-waiting__link shifts-waiting__link--quiet">
        {elsewhere}
      </Link>,
    );
  }
  if (failed) {
    tail.push(
      <span key="failed" className="shifts-waiting__failed">
        {failed}
        <Button size="sm" variant="ghost" onClick={counts.retry}>Повторить</Button>
      </span>,
    );
  }

  // Nothing waits here (the page picked, or a queue failed and the others are empty): a quiet line, no accent.
  const quiet = parts.length === 0;
  const label = !quiet ? "Ждут решения" : page && elsewhere ? `На ${page} решений не ждёт` : null;
  const items: ReactNode[] = [
    ...parts.map((part) => <Link key={part.key} to={part.to} className="shifts-waiting__link">{part.text}</Link>),
    ...tail,
  ];
  return (
    <nav className={quiet ? "shifts-waiting shifts-waiting--quiet" : "shifts-waiting"} aria-label="Ждут решения">
      <span className="shifts-waiting__label">
        <span aria-hidden className="shifts-waiting__dot" />
        {label}
      </span>
      <span className="shifts-waiting__parts">
        {items.map((item, index) => (
          <Fragment key={index}>
            {/* A quiet label is a sentence of its own: a dot after it too. */}
            {(index > 0 || (quiet && label !== null)) && <span aria-hidden className="shifts-waiting__sep">·</span>}
            {item}
          </Fragment>
        ))}
      </span>
    </nav>
  );
}
