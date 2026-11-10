import { Link, useParams } from "react-router";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { useModelApplication } from "@/api/modelApplications";
import { KernelApiError } from "@/api/sdk";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateTime, formatMomentAgo } from "@/lib/format";
import { applicationStatusWord } from "./ModelApplicationsPage.js";

/**
 * Команда → Анкеты → one questionnaire: its answers by section, refreshed every
 * 5 s while open. A sent one shows what was sent; one in progress the latest
 * answers its page saved.
 */

type Answer = KernelOperationResponse<"adminModelApplication">["answers"][number];

const GOOGLE_WORD: Readonly<Record<"recorded" | "failed" | "skipped", string>> = {
  recorded: "записана",
  failed: "не записана",
  skipped: "не отправлялась",
};

/** Non-empty answers grouped by section, in the questionnaire's order. */
export function answersBySection(answers: readonly Answer[]): { section: string; answers: Answer[] }[] {
  const groups = new Map<string, Answer[]>();
  for (const answer of answers) {
    if (answer.value.trim() === "") continue;
    const list = groups.get(answer.section) ?? [];
    list.push(answer);
    groups.set(answer.section, list);
  }
  return [...groups].map(([section, list]) => ({ section, answers: list }));
}

export function ModelApplicationPage() {
  const { ref } = useParams<{ ref: string }>();
  const { data, error, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useModelApplication(ref);

  if (!data) {
    if (error instanceof KernelApiError && (error.status === 404 || error.status === 400)) {
      return (
        <div className="team-screen">
          <PageHeader title="Анкета не найдена" />
          <StatusPanel
            title="Анкета не найдена"
            description="Возможно, ссылка устарела или в ней опечатка."
            action={<Link to="/team/applications" className="btn btn-sm">К анкетам</Link>}
          />
        </div>
      );
    }
    return (
      <div className="team-screen">
        {isLoading ? <TableSkeleton rows={8} columns={2} /> : <NoAnswerPanel retry={refetch} />}
      </div>
    );
  }

  const now = Date.parse(data.serverNow);
  const groups = answersBySection(data.answers);
  const line = [
    `${data.filled} из ${data.total}`,
    ...(data.section === null ? [] : [`раздел «${data.section}»`]),
    `начала ${formatDateTime(data.startedAt, { yearUnlessCurrent: true })}`,
    `обновлено ${formatMomentAgo(data.updatedAt, now)}`,
    ...(data.googleStatus === null
      ? []
      : [`Google-форма: ${GOOGLE_WORD[data.googleStatus]}${data.googleStatus === "failed" && data.googleError ? ` (${data.googleError})` : ""}`]),
  ].join(" · ");

  return (
    <div className="team-screen">
      <PageHeader
        title={data.name ?? "Анкета без имени"}
        description={<><StatusBadge status={applicationStatusWord(data)} /> {line}</>}
        fresh={{ at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching }}
      />
      <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />
      {data.answersFrom === "snapshot" && (
        <Notice>Ещё не отправлена: ответы на момент последнего сохранения страницы, обновляются сами.</Notice>
      )}
      {groups.length === 0 ? (
        <StatusPanel
          title={data.answersFrom === "none" ? "Ответов пока нет" : "Все ответы пустые"}
          description={data.answersFrom === "none" ? "Страница анкеты ещё не прислала ни одного ответа." : undefined}
        />
      ) : (
        groups.map((group, index) => (
          <section key={group.section} className="card" aria-labelledby={`application-section-${index}`}>
            <header className="card-header">
              <h2 id={`application-section-${index}`} className="card-title">{group.section}</h2>
            </header>
            <dl className="card-body application-answers">
              {group.answers.map((answer) => (
                <div key={answer.key} className="application-answer">
                  <dt className="muted">{answer.label}</dt>
                  <dd className="whitespace-pre-wrap">{answer.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))
      )}
    </div>
  );
}
