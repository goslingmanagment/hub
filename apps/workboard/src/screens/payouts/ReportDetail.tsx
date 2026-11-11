import { Badge, Money, PageLabel, Tooltip, cx } from "@agency_hub_core/ui";
import type { TeamLedgerReportPage, TeamLedgerReportPost } from "@agency_hub_core/contracts";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { savedLine } from "@agency_hub_core/ui/shiftReports";
import { ReportLines, ReportPages } from "@/shared/ReportBody";
import { PostLink, postEvidence, postHint, postProblemWords } from "@/shared/reportPosts";
import type { ReportRow } from "./reportRows";

/**
 * One person's report day, opened (the owner's): the pages as posted and as the agent drafted them — the difference
 * marked where the chatter changed it — when it was composed and posted, what is wrong with a post the ledger could
 * not use (the numbers that disagree, the way to the post), then the sales exactly as the chatter sees them in
 * «Мои смены». `panel`: inside a side panel, its own width; else under a journal row, to the money column's edge.
 */
export function ReportDetail({ row, panel = false }: { row: ReportRow; panel?: boolean }) {
  // Under a journal row the row's state already says what is wrong with its post: here only the numbers and the post.
  const said = !panel;
  const postedAt = latest(row.pages);
  const when = [row.draft ? savedLine(row.draft) : null, postedAt ? `отправлен ${formatDateTime(postedAt)}` : null]
    .filter((part): part is string => part !== null).join(" · ");

  // The box takes the cell's width and gives the table none of its own (report.css): an opened report never widens the sheet.
  return (
    <div className="wb-report-box">
      <div className={cx("wb-report", panel && "wb-report--panel")}>
        {row.pages.length > 0 && (
          <div className="wb-report__posted">
            <ReportPages pages={row.pages} changes />
            {when !== "" && <p className="wb-report__saved">{when}</p>}
          </div>
        )}
        {row.posts.map((post) => <PostProblem key={post.id} post={post} lines={row.pages.length === 0} said={said} />)}
        {row.draft !== null
          ? <ReportLines report={row.draft} />
          : row.posts.length === 0 && <p className="wb-report__none">Черновика нет: отчёт написан без агента, продаж по нему у ledger нет.</p>}
      </div>
    </div>
  );
}

function latest(pages: readonly TeamLedgerReportPage[]): string | null {
  return pages.map((page) => page.postedAt).filter((at): at is string => at !== null).sort().at(-1) ?? null;
}

/**
 * What is wrong with a post, the numbers that disagree and the way to it; `lines` — the post's own lines too, when
 * the day has no pages to show (a post of nobody's day); `said` — the row above already names the problem, so only
 * its numbers stand here.
 */
function PostProblem({ post, lines, said }: { post: TeamLedgerReportPost; lines: boolean; said: boolean }) {
  const evidence = postEvidence(post);
  const facts = evidence.join(" · ");
  return (
    <section className="payouts-post" aria-label="Пост в Отчётности">
      <div className="payouts-post__head">
        {said ? (
          <Tooltip content={postHint(post)} align="start">
            <span className="payouts-post__what">{facts !== "" ? `Пост: ${facts}` : postProblemWords(post)}</span>
          </Tooltip>
        ) : (
          <>
            <Tooltip content={postHint(post)} align="start">
              <span>
                <Badge tone={post.blocking ? "warning" : "neutral"}>{post.blocking ? "Пост не разобран" : "В посте"}</Badge>
              </span>
            </Tooltip>
            <span className="payouts-post__what">{postProblemWords(post)}</span>
          </>
        )}
        <PostLink post={post} />
      </div>
      {!said && facts !== "" && <p className="payouts-post__facts">{facts}</p>}
      {lines && post.pages.length > 0 && (
        <ul className="payouts-post__lines" aria-label="Строки поста">
          {post.pages.map((line, index) => (
            <li key={`${line.name}-${index}`}>
              <span>{line.pageLabel === null ? <span className="payouts-drift">«{line.name}»</span> : <PageLabel label={line.pageLabel} />}</span>
              <Money mills={line.amountMills} />
            </li>
          ))}
          {/* A sum that does not add up is said above in both numbers: not a third time here. */}
          {!post.flags.includes("sum_mismatch") && (
            <li className="payouts-post__total">
              <span>«Общий доход» в посте</span>
              <Money mills={post.totalMills} strong />
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
