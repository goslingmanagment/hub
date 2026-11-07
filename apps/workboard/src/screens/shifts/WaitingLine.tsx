import { Fragment } from "react";
import { Link } from "react-router";
import { formatCount } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { useDecisionCounts } from "@/shared/decisions";

/**
 * «Ждут решения» (spec §4.1.1): one quiet line, only when something waits for
 * the owner's decision; each part leads to Решения. Hidden at zero. The counts
 * are the sidebar's (src/shared/decisions.ts), so the two never disagree.
 */
export function WaitingLine() {
  const counts = useDecisionCounts();
  const parts: { key: string; text: string; to: string }[] = [];
  if (counts.disputes) {
    parts.push({ key: "disputes", to: "/decisions#disputes", text: `${formatCount(counts.disputes)} ${ruPlural(counts.disputes, "спор", "спора", "споров")} по продажам` });
  }
  if (counts.customs) {
    parts.push({
      key: "customs",
      to: "/decisions#customs",
      text: `${formatCount(counts.customs)} ${ruPlural(counts.customs, "кастом оплачен и не отдан", "кастома оплачены и не отданы", "кастомов оплачены и не отданы")}`,
    });
  }
  if (counts.held) {
    parts.push({ key: "held", to: "/decisions#held", text: `${formatCount(counts.held)} ${ruPlural(counts.held, "отправка зависла", "отправки зависли", "отправок зависли")}` });
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
