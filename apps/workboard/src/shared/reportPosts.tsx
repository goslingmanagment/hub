import { ExternalLink } from "lucide-react";
import type { TeamLedgerReportPost } from "@agency_hub_core/contracts";
import { formatDateTime, formatDay, formatMills } from "@agency_hub_core/ui/format";
import { moscowDayOf } from "@agency_hub_core/ui/moscow";
import { POST_FLAG_HINTS, postFlagWord } from "@agency_hub_core/ui/shiftReports";
import "./report.css";

/**
 * A post in «Отчётность» the ledger could not use in full, in words — the same on «Выплаты → Отчёты» and in
 * Решения: what is wrong, the numbers that disagree, and the way to the post in Telegram.
 */

const BLOCKING = new Set(["unknown_author", "no_date", "sum_mismatch", "date_mismatch"]);

/** The post's flags, the blocking ones first: «Страницы не сходятся с итогом». */
export function postProblemWords(post: Pick<TeamLedgerReportPost, "flags" | "blocking">): string {
  const flags = [...post.flags].sort((left, right) => Number(BLOCKING.has(right)) - Number(BLOCKING.has(left)));
  const words = flags.map(postFlagWord);
  const text = words.join(", ");
  return text === "" ? "" : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** What each flag rests on, in numbers or names: «по страницам $124.20, в итоге поста $134.20». */
export function postEvidence(post: TeamLedgerReportPost): string[] {
  const out: string[] = [];
  for (const flag of post.flags) {
    switch (flag) {
      case "sum_mismatch":
        out.push(`по страницам ${formatMills(post.pagesMills)}, в итоге поста ${formatMills(post.totalMills)}`);
        break;
      case "date_mismatch":
        out.push(`дата в посте ${post.reportDate === null ? "не прочитана" : formatDay(post.reportDate)}, отправлен ${formatDay(moscowDayOf(post.postedAt))}`);
        break;
      case "no_date":
        out.push(`отправлен ${formatDateTime(post.postedAt)}`);
        break;
      case "unknown_author":
        out.push(`отправил ${post.sender.trim() || "без имени"}${post.tag ? `, ${post.tag}` : ", без #тега"}`);
        break;
      case "unknown_page": {
        const unknown = post.pages.filter((line) => line.pageLabel === null);
        if (unknown.length > 0) out.push(`не узнаны: ${unknown.map((line) => `«${line.name}» ${formatMills(line.amountMills)}`).join(", ")}`);
        break;
      }
      case "tag_mismatch":
        out.push(`тег ${post.tag || "—"}, отправил ${post.sender.trim() || "без имени"}`);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Every flag's full meaning, for a hint. */
export function postHint(post: Pick<TeamLedgerReportPost, "flags">): string {
  return post.flags.map((flag) => POST_FLAG_HINTS[flag] ?? postFlagWord(flag)).join(" ");
}

/** «Открыть пост ↗»: the message in Telegram, a new tab. Nothing when the chat makes no link. */
export function PostLink({ post }: { post: Pick<TeamLedgerReportPost, "link"> }) {
  if (post.link === null) return null;
  return (
    <a href={post.link} target="_blank" rel="noreferrer" className="wb-post-link">
      Открыть пост
      <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
    </a>
  );
}
