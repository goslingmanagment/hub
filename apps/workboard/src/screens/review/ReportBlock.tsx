import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { OwnShiftRow, ShiftReportResponse } from "@agency_hub_core/contracts";
import { Badge, Button, LinkButton, Money, PageLabel, Skeleton, Tooltip } from "@agency_hub_core/ui";
import { formatCount, formatMills, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { addDays, moscowDayOf } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { kindWord } from "@agency_hub_core/ui/shiftReports";
import { kernel } from "@/shared/hub";
import { useBackState } from "@/shared/links";
import { ReportBody } from "@/shared/ReportBody";
import { checkWords } from "@/shared/reportChecks";
import { useMe } from "@/shared/useMe";
import { reportStepOf } from "@/screens/my-shifts/model";
import { reportKey } from "@/screens/report/data";

/**
 * The shift's report on its page (`/shifts/:userId/:shiftStart`), above the numbers and the pulse: a chatter who opens
 * a shift from «Мои смены» reads here what the board holds, without the board. Its state (handed in when, the version,
 * Hub's check, Gengar), the total and each page's sum, what it is made of, its sales (folded), the comment for the next
 * shift, and the way to the board — «Сдать смену» or «Подтвердить» for one's own shift that waits, else «Открыть
 * отчёт». A shift reported the old way (a post in «Отчётность», no report in Hub) shows, for one's own shift, what «Мои
 * смены» opens in place (shared/ReportBody.tsx).
 *
 * Everything is what Hub's reads return to this reader (`shiftReport`: the board, or the report's body; a colleague or a
 * lead sees what Hub cuts for them): nothing is hidden by role here, nothing is summed here.
 */

/**
 * The shift's report in Hub (ecosystem package F): its row of the person's list (`shiftReportsList`), when the person
 * hands shifts in in Hub (their switch is on) and this shift began after it — the row that ran with it the longest.
 * `row` null — the old way (or not known yet). (It was the header's button «Отчёт: сдан / не сдан» before the block
 * below said all of it, with the same way to the board.)
 */
function useShiftReportRow(userId: number, start: number, end: number) {
  const day = moscowDayOf(start);
  const read = useQuery({
    queryKey: ["review", "report", userId, day],
    queryFn: () => kernel.shiftReportsList({ query: { userId, from: addDays(day, -1), to: day } }),
    staleTime: 60_000,
  });
  const list = read.data;
  if (!list?.enabled || list.enabledSince === null) return { read, row: null };
  const since = Date.parse(list.enabledSince);
  const row = list.shifts
    .filter((one) => Date.parse(one.startedAt) >= since)
    .map((one) => ({ one, overlap: Math.min(end, Math.max(Date.parse(one.endedAt), Date.parse(one.startedAt) + 1)) - Math.max(start, Date.parse(one.startedAt)) }))
    .filter((pair) => pair.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)[0]?.one ?? null;
  return { read, row };
}

type Report = ShiftReportResponse;
type Board = NonNullable<Report["board"]>;

/** A sale of the report as the block lists it. */
interface Line {
  key: string;
  at: string;
  pageLabel: string;
  kind: string;
  fan: string | null;
  amountMills: number;
  note: string | null;
}

/** What the report holds, as this reader sees it: the board's rows in its phase, else the report's body. */
interface Holding {
  totalMills: number;
  pages: Array<{ pageLabel: string; platform: string | null; amountMills: number }>;
  lines: Line[];
  /** Not handed in yet: a draft's total. */
  preliminary: boolean;
}

function holdingOf(report: Report): Holding | null {
  const board = report.board;
  if (board && !board.preview) {
    const rows = board.columns.flatMap((column) => column.rows).filter((row) => row.ticked && row.amountMills > 0);
    return {
      totalMills: board.totals.nowMills,
      pages: board.columns.map((column) => ({ pageLabel: column.pageLabel, platform: column.platform, amountMills: column.sumMills })),
      lines: rows.map((row) => ({ key: row.key, at: row.occurredAt, pageLabel: row.pageLabel, kind: row.kind, fan: row.fan.name ?? row.fan.username, amountMills: row.amountMills, note: row.note?.text ?? null })),
      preliminary: board.phase === "draft" || board.phase === "fixing",
    };
  }
  const view = report.view;
  if (view === null) return null;
  // One's own handed-in report without a board shows the draft: its pages only while they are the version's.
  const latest = report.latest;
  if (report.access === "own" && latest !== null && view.totalMills !== latest.totalMills) {
    return { totalMills: latest.totalMills, pages: [], lines: [], preliminary: false };
  }
  return {
    totalMills: view.totalMills,
    pages: view.pages.map((page) => ({ pageLabel: page.pageLabel, platform: page.platform, amountMills: page.amountMills })),
    lines: view.lines.filter((line) => line.amountMills > 0).map((line) => ({
      key: String(line.transactionId), at: line.occurredAt, pageLabel: line.pageLabel, kind: line.kind, fan: line.fan.name ?? line.fan.username, amountMills: line.amountMills, note: line.note,
    })),
    preliminary: report.state !== "submitted",
  };
}

/** The kinds of the report's sales, counted: «PPV 5, чаевые 1» (the words of «Мои смены»' cards). */
const KIND_GROUP: Readonly<Record<string, string>> = { message_purchase: "PPV", tip: "чаевые", stream_tip: "чаевые", subscription: "подписки", post_purchase: "посты" };
/** One sale's kind in the same words. */
const KIND_ONE: Readonly<Record<string, string>> = { message_purchase: "PPV", tip: "чаевые", stream_tip: "чаевые на стриме", subscription: "подписка", post_purchase: "пост" };

function madeOf(lines: readonly Line[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const group = KIND_GROUP[line.kind] ?? kindWord(line.kind);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([group, count]) => `${group} ${count}`).join(", ");
}

/** Hub's check and Gengar's, in words (the board's, shared/reportChecks.ts); none — nothing to say. */
function checksOf(board: Board | null): string[] {
  const candidate = board?.candidate ?? null;
  if (!board || board.preview || candidate === null) return [];
  return checkWords({
    hub: candidate.hub.state, foundCount: candidate.hub.foundCount, foundMills: candidate.hub.foundMills,
    gengar: candidate.gengar.state, proposals: candidate.gengar.proposals,
  });
}

/** The state's words, its tone and the one way to the board. */
function stepOf(report: Report): { words: string; tone: "warning" | "success" | "info" | "off"; when: string | null; action: string | null } {
  const board = report.board && !report.board.preview ? report.board : null;
  const own = report.access === "own" && report.canEdit;
  const latest = report.latest;
  const handed = latest === null ? null : `сдан ${formatWeekdayDay(latest.submittedAt)} в ${formatTimeOfDay(latest.submittedAt)}, версия ${latest.version}${latest.door === "telegram" ? ", через Генгара" : ""}`;
  if (board) {
    switch (board.phase) {
      case "draft":
        return report.shift.ongoing
          ? { words: "Смена идёт", tone: "info", when: null, action: null }
          : { words: "Не сдан", tone: "warning", when: null, action: own ? "Сдать смену" : null };
      case "checking":
        return { words: "Проверка", tone: "info", when: board.handedInAt ? `сдан в ${formatTimeOfDay(board.handedInAt)}` : null, action: null };
      case "confirm":
        return { words: "Подтвердите", tone: "warning", when: board.handedInAt ? `сдан в ${formatTimeOfDay(board.handedInAt)}` : null, action: own ? "Подтвердить" : null };
      case "fixing":
        return { words: "Правка", tone: "warning", when: handed, action: own ? "Сдать заново" : null };
      case "counted": {
        const uncopied = own && report.posts.length > 0 && (board.post?.copiedAt ?? null) === null;
        return { words: "Учтён", tone: "success", when: handed, action: uncopied ? "Скопировать пост" : null };
      }
    }
  }
  if (report.state === "submitted") return { words: "Сдан", tone: "success", when: handed, action: null };
  return report.shift.ongoing
    ? { words: "Смена идёт", tone: "info", when: null, action: null }
    : { words: "Не сдан", tone: "warning", when: null, action: own ? "Сдать смену" : null };
}

function HubReport({ report, label }: { report: Report; label: string }) {
  const [open, setOpen] = useState(false);
  const back = useBackState(label);
  const holding = holdingOf(report);
  const step = stepOf(report);
  const checks = checksOf(report.board);
  const comments = (report.view?.comments ?? []).filter((one) => one.comment.trim() !== "");
  const comment = comments.length === 0 && report.view?.comment.trim() ? [{ modelSlug: "", modelName: "", comment: report.view.comment }] : comments;
  const after = report.afterSubmission;
  return (
    <section className="review-report" aria-label="Отчёт смены">
      <div className="review-report__head">
        <h2 className="review-report__title">Отчёт смены</h2>
        <span className="review-report__state">
          <Badge tone={step.tone} bare={step.tone !== "warning"}>{step.words}</Badge>
          {[step.when, ...checks].filter(Boolean).map((words) => <span key={words} className="review-report__fact">{words}</span>)}
        </span>
        <span className="review-report__go">
          <LinkButton to={`/report/${report.shift.id}`} state={back} variant={step.action ? "primary" : "secondary"} size="md">{step.action ?? "Открыть отчёт"}</LinkButton>
        </span>
      </div>
      {holding !== null && (
        <div className="review-report__body">
          <div className="review-report__total">
            <span className="review-report__sum"><Money mills={holding.totalMills} strong /></span>
            <span className={holding.preliminary ? "review-report__word review-report__word--pre" : "review-report__word"}>{holding.preliminary ? "предварительно" : "по отчёту"}</span>
          </div>
          <div className="review-report__parts">
            {holding.pages.length > 0 && (
              <ul className="review-report__pages" aria-label="По страницам">
                {holding.pages.map((page) => (
                  <li key={page.pageLabel}>
                    <PageLabel label={page.pageLabel} platform={page.platform} />
                    <Money mills={page.amountMills} muted={page.amountMills === 0} />
                  </li>
                ))}
              </ul>
            )}
            {holding.lines.length > 0 && (
              <span className="review-report__made">
                {formatCount(holding.lines.length)} {ruPlural(holding.lines.length, "продажа", "продажи", "продаж")}: {madeOf(holding.lines)}
              </span>
            )}
          </div>
        </div>
      )}
      {after !== null && (
        <p className="review-report__after">После сдачи пришло ещё {formatCount(after.count)} {ruPlural(after.count, "продажа", "продажи", "продаж")} на {formatMills(after.mills)}: их можно досдать на доске.</p>
      )}
      {comment.length > 0 && (
        <div className="review-report__comment">
          <span className="review-report__comment-head">Комментарий следующей смене</span>
          {comment.map((one) => (
            <p key={one.modelSlug} className="review-report__comment-text">{comment.length > 1 ? <b>{one.modelName}: </b> : null}{one.comment}</p>
          ))}
        </div>
      )}
      {holding !== null && holding.lines.length > 0 && (
        <div className="review-report__sales">
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Свернуть продажи" : `Продажи отчёта · ${formatCount(holding.lines.length)}`}
          </Button>
          {open && (
            <ol className="review-report__lines">
              {[...holding.lines].sort((a, b) => a.at.localeCompare(b.at)).map((line) => (
                <li key={line.key} className="review-report__line">
                  <span className="review-report__line-time">{formatTimeOfDay(line.at)}</span>
                  <span className="review-report__line-what">
                    <span className="review-report__line-fan">{line.fan ?? "фан без имени"}</span>
                    <span className="review-report__line-meta">{KIND_ONE[line.kind] ?? kindWord(line.kind)} · {line.pageLabel}</span>
                    {line.note && <span className="review-report__line-note">{line.note}</span>}
                  </span>
                  <Money mills={line.amountMills} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

/** One's own shift reported the old way: its row of «Мои смены» (`accountShifts`, paired by Hub), opened. */
function OldWayReport({ start, end, startedAt }: { start: number; end: number; startedAt: string }) {
  const until = moscowDayOf(end);
  const read = useQuery({
    queryKey: ["review", "own-report", until],
    queryFn: () => kernel.accountShifts({ query: { days: 3, until } }),
    staleTime: 60_000,
  });
  if (read.isPending) return <section className="review-report"><Skeleton width="40%" /></section>;
  const rows: OwnShiftRow[] = read.data?.rows ?? [];
  const row = rows.find((one) => one.shift?.startedAt === startedAt)
    ?? rows.find((one) => one.shift !== null && Date.parse(one.shift.startedAt) < end && Date.parse(one.shift.endedAt) > start)
    ?? null;
  if (row === null || row.hub !== null) return null;
  const step = reportStepOf(row);
  if (step.words === "") return null;
  return (
    <section className="review-report" aria-label="Отчёт смены">
      <div className="review-report__head">
        <h2 className="review-report__title">Отчёт смены</h2>
        <span className="review-report__state">
          <Badge tone={step.tone === "warn" ? "warning" : step.tone === "good" ? "success" : step.tone === "live" ? "info" : "off"} bare={step.tone !== "warn"}>{step.words}</Badge>
          {step.note !== null && <span className="review-report__fact">{step.note}</span>}
        </span>
        {row.totalMills !== null && (
          <span className="review-report__go">
            <Tooltip content="Отчёт в «Отчётности»: как его отправили." align="end">
              <span className="review-report__total review-report__total--inline">
                <span className="review-report__sum"><Money mills={row.totalMills} strong /></span>
                <span className="review-report__word">по отчёту</span>
              </span>
            </Tooltip>
          </span>
        )}
      </div>
      {row.report !== null && <ReportBody report={row.report} />}
    </section>
  );
}

export function ReportBlock({ userId, start, end, startedAt, label }: { userId: number; start: number; end: number; startedAt: string; label: string }) {
  const me = useMe();
  const { read: list, row } = useShiftReportRow(userId, start, end);
  const report = useQuery({
    // The board's own key (screens/report/data.ts): the board opens from here at once, and its writes show here.
    queryKey: reportKey(row?.shiftId ?? 0),
    queryFn: () => kernel.shiftReport({ params: { shiftId: row!.shiftId } }),
    enabled: row !== null,
    staleTime: 10_000,
  });
  if (list.isPending || (row !== null && report.isPending)) {
    return <section className="review-report" aria-busy><Skeleton width="30%" height={20} /><Skeleton width="60%" height={28} /></section>;
  }
  if (row !== null && report.data) return <HubReport report={report.data} label={label} />;
  // No report in Hub: one's own shift shows its old way; someone else's has nothing Hub gives this reader here.
  if (row === null && me.user?.id === userId) return <OldWayReport start={start} end={end} startedAt={startedAt} />;
  return null;
}
