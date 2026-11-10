import { ArrowRight } from "lucide-react";
import { Link, useLocation } from "react-router";
import { Money, Person, Section, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import type { TeamLedgerReportPerson, TeamLedgerReportPost } from "@agency_hub_core/contracts";
import { formatDateTime, formatMills, formatWeekdayDay } from "@agency_hub_core/ui/format";
import type { PendingChange } from "@agency_hub_core/ui/shiftReports";
import { PersonLink, carryParams } from "@/shared/links";
import { PostLink, postEvidence, postHint, postProblemWords } from "@/shared/reportPosts";

/**
 * Решения → «Отчёты»: what of the shift reports the agency ledger will not pay without the owner — the posts in
 * «Отчётность» it could not parse (who, which day, what is wrong, the numbers that disagree, the post itself), and
 * the paid days whose report changed since (who, which day, was → now, the person in Выплаты). Read only: a post is
 * fixed in Telegram, a changed day is the ledger's to settle on the owner's word. A sum a chatter changed before the
 * payout is not a decision: it is in «Выплаты → Отчёты».
 */

function Who({ person }: { person: TeamLedgerReportPerson }) {
  if (person.hubUser) return <PersonLink userId={person.hubUser.userId} name={person.hubUser.username} backLabel="Решения" />;
  return <Person name={person.name} hint={person.slug === null ? "ledger не знает, чей пост" : "не связан с Hub"} />;
}

export function ReportsSection({ posts, changes }: { posts: readonly TeamLedgerReportPost[]; changes: readonly PendingChange[] }) {
  const location = useLocation();
  const payoutsOf = (slug: string) => {
    const params = carryParams(location.search);
    params.delete("page");
    params.set("person", slug);
    return `/payouts?${params.toString()}`;
  };
  const postColumns: Column<TeamLedgerReportPost>[] = [
    { key: "who", header: "Кто", nowrap: true, cell: (post) => <Who person={post.person} /> },
    {
      key: "day",
      header: "День",
      nowrap: true,
      cell: (post) => (
        <span>
          {post.reportDate === null ? <span className="ui-muted">дата не прочитана</span> : formatWeekdayDay(post.reportDate)}
          <span className="decisions-sub">отправлен {formatDateTime(post.postedAt)}</span>
        </span>
      ),
      sortValue: (post) => post.reportDate ?? post.postedAt,
    },
    {
      key: "what",
      header: "Что не так",
      grow: true,
      cell: (post) => {
        // The two numbers of a sum that does not add up are the evidence itself; any other post says what is at stake.
        const lines = [...postEvidence(post), ...(post.flags.includes("sum_mismatch") ? [] : [`в посте ${formatMills(post.totalMills)}`])];
        // The way to the post right after the words: the spare width of a wide screen falls after them, not before it.
        return (
          <span>
            <span className="decisions-what">
              <Tooltip content={postHint(post)} align="start"><span>{postProblemWords(post)}</span></Tooltip>
              <PostLink post={post} />
            </span>
            <span className="decisions-sub">{lines.join(" · ")}</span>
          </span>
        );
      },
    },
  ];
  const changeColumns: Column<PendingChange>[] = [
    { key: "who", header: "Кто", nowrap: true, cell: (change) => <Who person={change.person} /> },
    {
      key: "day",
      header: "День",
      nowrap: true,
      cell: (change) => <span>{formatWeekdayDay(change.day)}{change.model && <span className="decisions-sub">{change.model}</span>}</span>,
      sortValue: (change) => change.day,
    },
    { key: "was", header: "Было", numeric: true, nowrap: true, cell: (change) => <Money mills={change.postedMills} muted /> },
    { key: "now", header: "Стало", numeric: true, nowrap: true, cell: (change) => <Money mills={change.newMills} strong /> },
    {
      key: "why",
      header: "Почему",
      grow: true,
      cell: (change) => (
        <span className="decisions-what">
          {change.reason || <span className="ui-muted">ledger не сказал</span>}
          <Link to={payoutsOf(change.person.slug)} className="decisions-link">
            В выплатах
            <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
          </Link>
        </span>
      ),
    },
  ];
  return (
    <Section
      id="reports"
      className="decisions-section"
      title={<>Отчёты <span className="decisions-count">{posts.length + changes.length}</span></>}
      description="Что из отчётов смен ledger не начислит без вас."
    >
      <div className="decisions-groups">
        {posts.length > 0 && (
          <div className="decisions-group">
            <h3 className="decisions-group__title">Посты не разобраны<span className="decisions-group__hint">не входят в оплату, пока их не поправят в «Отчётности»</span></h3>
            <Table label="Посты, которые ledger не разобрал" columns={postColumns} rows={posts} rowKey={(post) => String(post.id)} align="first-line" fit={false} />
          </div>
        )}
        {changes.length > 0 && (
          <div className="decisions-group">
            <h3 className="decisions-group__title">Изменились выплаченные дни<span className="decisions-group__hint">поправка войдёт в следующую выплату после вашего «да» в ledger</span></h3>
            <Table label="Выплаченные дни, чей отчёт изменился" columns={changeColumns} rows={changes} rowKey={(change) => `${change.person.slug}-${change.id}`} align="first-line" fit={false} />
          </div>
        )}
      </div>
    </Section>
  );
}
