import { Fragment } from "react";
import { Link, useLocation } from "react-router";
import { formatCount } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { useDecisionCounts } from "@/shared/decisions";
import { carryParams } from "@/shared/links";

/**
 * «Ждут решения» (spec §4.1.1): one quiet line, only when something waits for
 * the owner's decision; each part leads to its section of Решения, with this
 * period and page. Hidden at zero and while a queue is still being read (the
 * counts are the sidebar's, src/shared/decisions.ts: never a partial sum).
 */
export function WaitingLine() {
  const counts = useDecisionCounts();
  const location = useLocation();
  const search = carryParams(location.search).toString();
  const parts: { key: string; text: string; to: string }[] = [];
  if (!counts.settled) return null;
  if (counts.disputes) {
    parts.push({ key: "disputes", to: `/decisions${search ? `?${search}` : ""}#disputes`, text: `${formatCount(counts.disputes)} ${ruPlural(counts.disputes, "спор", "спора", "споров")} по продажам` });
  }
  if (counts.customs) {
    parts.push({
      key: "customs",
      to: `/decisions${search ? `?${search}` : ""}#customs`,
      text: `${formatCount(counts.customs)} ${ruPlural(counts.customs, "кастом оплачен и не отдан", "кастома оплачены и не отданы", "кастомов оплачены и не отданы")}`,
    });
  }
  if (counts.held) {
    parts.push({ key: "held", to: `/decisions${search ? `?${search}` : ""}#held`, text: `${formatCount(counts.held)} ${ruPlural(counts.held, "отправка зависла", "отправки зависли", "отправок зависли")}` });
  }
  if (parts.length === 0) return null;

  return (
    <nav className="shifts-waiting" aria-label="Ждут решения">
      <span className="shifts-waiting__label">
        <span aria-hidden className="shifts-waiting__dot" />
        Ждут решения
      </span>
      <span className="shifts-waiting__parts">
        {parts.map((part, index) => (
          <Fragment key={part.key}>
            {index > 0 && <span aria-hidden className="shifts-waiting__sep">·</span>}
            <Link to={part.to} className="shifts-waiting__link">{part.text}</Link>
          </Fragment>
        ))}
      </span>
    </nav>
  );
}
