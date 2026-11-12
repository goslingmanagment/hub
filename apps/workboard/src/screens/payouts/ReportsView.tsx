import { useMemo, useRef, useState } from "react";
import { Badge, Chip, EmptyState, Facts, Mark, Money, PageLabels, Person, Table, Tooltip, type Column, type FactItem } from "@agency_hub_core/ui";
import type { TeamLedgerReportsResponse } from "@agency_hub_core/contracts";
import { formatDayRange, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { postFlagWord } from "@agency_hub_core/ui/shiftReports";
import { shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { PersonLink } from "@/shared/links";
import { useReportEdge } from "@/shared/ReportBody";
import { postProblemWords } from "@/shared/reportPosts";
import { ReportDetail } from "./ReportDetail";
import { hasQuestion, reportFacts, reportRows, type ReportRow } from "./reportRows";
import { usePeopleIndex } from "@/shared/people";

/**
 * «Выплаты → Отчёты»: every chatter's report of the period, the newest day first, one row per person and day — when,
 * who, which pages, what was posted, and the state in words. A sum the chatter changed after the draft is marked
 * (what the owner looks for); a post the ledger could not use says why. A row opens in place to the report.
 */

/** The day of a row on top, the clock under it (D12): the shift's window when there is a draft, else the post's time. */
function WhenCell({ row }: { row: ReportRow }) {
  const when = row.window === null ? null : shiftWhen({ startedAt: row.window.from, endedAt: row.window.to });
  const postedAt = row.posts[0]?.postedAt ?? row.pages.find((page) => page.postedAt !== null)?.postedAt ?? null;
  return (
    <span className="payouts-when">
      <span className="payouts-when__day">{when?.days ?? formatWeekdayDay(row.reportDate)}</span>
      <span className="payouts-when__time">{when?.time ?? (postedAt === null ? "время не известно" : `пост в ${formatTimeOfDay(postedAt)}`)}</span>
    </span>
  );
}

function WhoCell({ row }: { row: ReportRow }) {
  const { person } = row;
  const people = usePeopleIndex();
  if (person.hubUser) return <PersonLink userId={person.hubUser.userId} name={people.nameOf(person.hubUser.userId, person.hubUser.username)} backLabel="Выплаты" />;
  return <Person name={person.name} hint={person.slug === null ? "ledger не знает, чей пост" : "не связан с Hub"} />;
}

function PagesCell({ row }: { row: ReportRow }) {
  const labels = row.pages.length > 0 ? row.pages.map((page) => page.pageLabel) : (row.posts[0]?.pages ?? []).map((line) => line.pageLabel ?? line.name);
  return labels.length === 0 ? <span className="ui-muted">—</span> : <PageLabels labels={labels} />;
}

function PostedCell({ row }: { row: ReportRow }) {
  if (row.postedMills === null) {
    const hint = row.state === "draft" ? "Чаттер ещё не отправил отчёт в «Отчётность»." : "Пост не вошёл в оплату: ledger его не разобрал.";
    return <Tooltip content={hint} align="end"><span className="ui-muted">—</span></Tooltip>;
  }
  return <Money mills={row.postedMills} strong />;
}

/**
 * A day handed in in Hub (package G): «Сдан в системе» with its sum, and how the post compares — equal, apart (the
 * owner's to look at), or no post at all. The post's own state follows when it needs the owner.
 */
function HubState({ row }: { row: ReportRow }) {
  const compare = row.postedMills === null
    ? <span className="payouts-sub">поста нет</span>
    : row.hub === "differs"
      ? <span className="payouts-sub payouts-drift">в посте <Money mills={row.postedMills} />: пост и отчёт в системе расходятся</span>
      : <span className="payouts-sub">пост совпадает</span>;
  return (
    <span className="payouts-state">
      <span className="payouts-state__line">
        <Badge tone="success" bare className="payouts-state__badge">Сдан в системе</Badge>
        {row.hubMills !== null && <Money mills={row.hubMills} />}
      </span>
      {compare}
      {row.blocking && <span className="payouts-sub payouts-drift">пост не разобран: {postProblemWords(row.blocking)}</span>}
    </span>
  );
}

/** The state in words; colour only where the owner has something to look at or do. */
function StateCell({ row }: { row: ReportRow }) {
  if (row.hub !== null) return <HubState row={row} />;
  const notes = row.posts.filter((post) => !post.blocking).flatMap((post) => post.flags.map(postFlagWord));
  const note = notes.length > 0 ? `в посте: ${notes.join(", ")}` : row.missing.length > 0 ? `нет в посте: ${row.missing.join(", ")}` : null;
  const word = (() => {
    switch (row.state) {
      case "unparsed":
        return (
          <>
            <Badge tone="warning" className="payouts-state__badge">Пост не разобран</Badge>
            {row.blocking && <span className="payouts-state__why">{postProblemWords(row.blocking)}</span>}
          </>
        );
      case "changed":
        return (
          <>
            <Badge tone="info" bare className="payouts-state__badge">Сумма изменена</Badge>
            {row.diffMills !== null && (
              <Mark hint="Чаттер поменял сумму в посте после черновика агента: в оплату идёт сумма поста.">
                <Money mills={row.diffMills} signed />
              </Mark>
            )}
          </>
        );
      case "draft":
        return <Badge tone="off" bare className="payouts-state__badge">Собран, не отправлен</Badge>;
      case "post_only":
        return <Badge tone="info" bare className="payouts-state__badge">Без черновика</Badge>;
      case "posted":
        return <Badge tone="success" bare className="payouts-state__badge payouts-state__badge--quiet">Отправлен</Badge>;
    }
  })();
  return (
    <span className="payouts-state">
      <span className="payouts-state__line">{word}</span>
      {note !== null && <span className="payouts-sub payouts-drift">{note}</span>}
    </span>
  );
}

const COLUMNS: Column<ReportRow>[] = [
  { key: "when", header: "День", nowrap: true, cell: (row) => <WhenCell row={row} />, sortValue: (row) => row.reportDate },
  { key: "who", header: "Кто", nowrap: true, cell: (row) => <WhoCell row={row} />, sortValue: (row) => row.person.name },
  { key: "pages", header: "Страницы", muted: true, cell: (row) => <PagesCell row={row} /> },
  { key: "posted", header: "В посте", numeric: true, nowrap: true, cell: (row) => <PostedCell row={row} />, sortValue: (row) => row.postedMills },
  { key: "state", header: "Отчёт", grow: true, cell: (row) => <StateCell row={row} /> },
];

/** «12 отчётов · в постах $1,240.50 · сумма изменена: 2 · пост не разобран: 1», and the filter to the questions. */
function FactsLine({ all, postsRead, questionsOnly, onQuestionsOnly }: {
  all: readonly ReportRow[];
  postsRead: boolean;
  questionsOnly: boolean;
  onQuestionsOnly: (on: boolean) => void;
}) {
  const facts = reportFacts(all);
  const questions = all.filter(hasQuestion).length;
  const items: FactItem[] = [
    { label: "Отчётов", value: String(facts.reports) },
    { label: "В постах", value: <Money mills={facts.postedMills} />, strong: true, hint: "Отправленные суммы отчётов периода — то, по чему ledger начисляет. Посты, которые он не разобрал, сюда не входят." },
    { label: "Сумма изменена", value: facts.changed === 0 ? "нет" : String(facts.changed), hint: "Чаттер поменял сумму в посте после черновика агента." },
    ...(postsRead ? [{ label: "Пост не разобран", value: facts.unparsed === 0 ? "нет" : String(facts.unparsed) }] : []),
    ...(facts.hub > 0 ? [{
      label: "Сдано в системе",
      value: facts.hubDiffers === 0 ? String(facts.hub) : `${facts.hub}, с постом расходятся ${facts.hubDiffers}`,
      hint: "Отчёты, сданные в Hub. Пока ledger начисляет по постам, это сверка: расхождение значит, что пост и отчёт в системе дают разные суммы.",
    }] : []),
  ];
  return (
    <div className="payouts-facts">
      <Facts items={items} label="Отчёты периода" />
      {(questions > 0 || questionsOnly) && (
        <Chip size="md" selected={questionsOnly} onClick={() => onQuestionsOnly(!questionsOnly)} className="payouts-facts__filter">
          Только с вопросами · {questions}
        </Chip>
      )}
    </div>
  );
}

export function ReportsView({ data, from, to, page, sheetsPay, questionsOnly, onQuestionsOnly }: {
  data: TeamLedgerReportsResponse;
  from: string;
  to: string;
  page: string | null;
  /** The ledger said it does not accrue from the posted reports yet (`reportsFrom` null): the payout sheets pay. */
  sheetsPay: boolean;
  questionsOnly: boolean;
  onQuestionsOnly: (on: boolean) => void;
}) {
  const all = useMemo(() => reportRows(data, page), [data, page]);
  const rows = useMemo(() => (questionsOnly ? all.filter(hasQuestion) : all), [all, questionsOnly]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const box = useRef<HTMLDivElement>(null);
  useReportEdge(box, COLUMNS.findIndex((column) => column.key === "posted"));
  const toggle = (row: ReportRow, next: boolean) => setOpen((current) => {
    const updated = new Set(current);
    if (next) updated.add(row.key);
    else updated.delete(row.key);
    return updated;
  });
  const range = formatDayRange(from, to);
  return (
    <div className="payouts-reports">
      <FactsLine all={all} postsRead={data.postsRead} questionsOnly={questionsOnly} onQuestionsOnly={onQuestionsOnly} />
      {/* Until the reports accrue, what this view shows is for checking, not what pays (a post not parsed is no decision). */}
      {sheetsPay && <p className="payouts-note">Начисляет пока таблица выплат: отчёты здесь для сверки.</p>}
      <div ref={box} className="payouts-journal">
        <Table
          label="Отчёты смен"
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.key}
          rowDetail={(row) => <ReportDetail row={row} />}
          openKeys={open}
          onOpenChange={toggle}
          align="first-line"
          skeletonLines={2}
          fit={false}
          empty={(
            <EmptyState title={questionsOnly ? "Вопросов нет" : `За ${range} отчётов нет`} compact>
              {questionsOnly
                ? "Все отчёты периода отправлены как собраны, посты разобраны."
                : page !== null ? `На ${page} за эти дни нет ни черновиков, ни постов.` : "Ни черновиков агента, ни постов в «Отчётности» за эти дни."}
            </EmptyState>
          )}
        />
      </div>
    </div>
  );
}

export function ReportsSkeleton() {
  return <Table label="Отчёты смен" columns={COLUMNS} rows={[]} rowKey={(row) => row.key} loading skeletonRows={6} skeletonLines={2} fit={false} />;
}
