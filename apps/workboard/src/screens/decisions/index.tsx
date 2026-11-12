import { CircleCheck } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { EmptyState, ErrorState, Section, Skeleton, Table, type Column } from "@agency_hub_core/ui";
import { decisionParts, decisionsElsewhereText, decisionsFailedText, type DecisionQueue } from "@/shared/decisions";
import { useMattersActive } from "@/shared/matters";
import { usersQuery } from "@/shared/reads";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePages } from "@/shared/usePages";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { CustomsFolds, CustomsSection } from "./Customs";
import { HeldSection, ResolveSendModal, ResolvedJournal } from "./HeldSends";
import { ChattersQuestions, QuestionsSection, QuestionsUnavailable } from "./Questions";
import { ReportsSection } from "./Reports";
import { useDecisions, useFanNames, type FanRefOnPage, type HeldSend } from "./data";
import { WaitingScreen } from "../waiting/index";
import "./decisions.css";

/**
 * The address `/decisions`, «Ждут вас» (it was Решения): while the owner's
 * switch `mattersReadEnabled` is off, its four queues exactly as before; on,
 * the list read from matters (screens/waiting). Until the switch is known, the
 * same skeleton the queues show while they load. One name either way.
 */
export function DecisionsScreen() {
  const { role } = useMe();
  const { active } = useMattersActive();
  if (role === "chatter") return null;
  if (active === null) {
    return (
      <>
        <ScreenHeader title="Ждут вас" pageFilter meta={<Skeleton width={260} />} />
        <div className="wb-content">
          <Section title={<Skeleton width={220} height={24} />}>
            <Table label="Ждут вас: загружается" columns={SKELETON_COLUMNS} rows={[]} rowKey={() => ""} loading skeletonRows={3} skeletonLines={2} className="decisions-skeleton" />
          </Section>
        </div>
      </>
    );
  }
  return active ? <WaitingScreen /> : <DecisionsByQueue />;
}

/**
 * The four queues (it was Решения, spec §4.6): what waits for the owner's decision — the questions «whose
 * is this sale» the chat agent asked him, the shift reports' questions (posts
 * the ledger could not parse, paid days whose report changed),
 * customs paid and not delivered, held sends. Each section is there only while
 * it has rows; nothing at all is «Всё решено». A section whose read failed says
 * so in its place: no answer is not a zero. A send's resolve, when open, is in
 * the address: `?send=`.
 */
function DecisionsByQueue() {
  const { isOwner, role } = useMe();
  const { page, setPage } = usePageFilter();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const pages = usePages();
  // The old address of the customs (`/decisions#customs`, «Ждут вас» links it) leads to the board «Кастомы».
  useEffect(() => {
    if (location.hash === "#customs") navigate({ pathname: "/customs", search: location.search }, { replace: true });
  }, [location.hash, location.search, navigate]);
  const decisions = useDecisions({ owner: isOwner, page });
  const { view } = decisions;
  // A login to its id, for the customs' «who wrote it» (the owner's people list; a team lead reads plain names).
  const users = useQuery({ ...usersQuery, enabled: isOwner, staleTime: 5 * 60_000 });

  const platformOf = (label: string) => pages.data?.find((one) => one.label === label)?.platform;
  const userIdOf = (username: string) => users.data?.find((user) => user.username === username && !user.deletedAt)?.id ?? null;

  const fans: FanRefOnPage[] = [
    ...(view.questions ? [...view.questions.owner, ...view.questions.chatters].flatMap((question) => (question.fanRef === null || question.pageLabel === "" ? [] : [{ pageLabel: question.pageLabel, fanRef: question.fanRef }])) : []),
    ...(view.customs ? [...view.customs.paid, ...view.customs.ordered, ...view.customs.other] : []),
    ...(view.held ? view.held.items : []),
  ];
  const fanOf = useFanNames(fans);

  const open = (key: "send", value: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete(key);
    else next.set(key, value);
    return next;
  });
  const attemptId = search.get("send");
  // What is open stays open while Hub answers: a refused write re-reads the lists, and the row may leave them —
  // the window keeps the record it was opened with, so its words about the refusal stay readable.
  const lastSend = useRef<HeldSend | null>(null);
  const foundSend = attemptId && view.held ? view.held.items.find((one) => one.attemptId === attemptId) : undefined;
  if (foundSend) lastSend.current = foundSend;
  const openSend = foundSend ?? (attemptId && lastSend.current?.attemptId === attemptId ? lastSend.current : undefined);

  const failed = {
    questions: isOwner && decisions.questions.isError && !view.questions,
    reports: isOwner && (decisions.posts.isError || decisions.changes.isError) && !view.reports,
    customs: decisions.customs.isError && !view.customs,
    held: decisions.held.isError && !view.held,
  };
  const anyFailed = failed.questions || failed.reports || failed.customs || failed.held;
  // The counts of this page (or of all), in the words the menu and Смены use (D17): a queue that did not answer is
  // null, never a zero. A team lead has no questions or reports to read: theirs is a zero, not a failure.
  const reportParts = !isOwner ? { posts: 0, changes: 0 } : view.reports ? { posts: view.reports.posts.length, changes: view.reports.changes.length } : null;
  const counts = {
    questions: !isOwner ? 0 : view.questions ? view.questions.owner.length : null,
    reports: reportParts === null ? null : reportParts.posts + reportParts.changes,
    reportParts,
    customs: view.customs ? view.customs.paid.length : null,
    held: view.held ? view.held.total : null,
    failed: (["questions", "reports", "customs", "held"] as const).filter((queue) => failed[queue]) as DecisionQueue[],
  };
  const waiting = (counts.questions ?? 0) + (counts.reports ?? 0) + (counts.customs ?? 0) + (counts.held ?? 0);
  const elsewhere = (view.questions?.elsewhere ?? 0) + (view.reports?.elsewhere ?? 0) + (view.customs?.elsewhere ?? 0) + (view.held?.elsewhere ?? 0);
  // The header's line is the screen's contents: each part jumps to its section (Р2, Р5).
  const parts = decisionParts(counts, location.search);
  // The questions' failure is said once, in their own section's line (the ledger's word, not Hub's): not here as well.
  const failedText = decisionsFailedText({ ...counts, failed: counts.failed.filter((queue) => queue !== "questions") });
  const elsewhereText = page !== null ? decisionsElsewhereText(elsewhere) : null;

  // A link with an anchor (`/decisions#held`, the «Ждут решения» line of Смены) lands on its section once the
  // queues have answered: before that the section is not there yet. The sticky header is minded by scroll-margin.
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    const id = location.hash.slice(1);
    if (decisions.loading || id === "" || jumped.current === location.key) return;
    const target = document.getElementById(id);
    if (!target) return;
    const arriving = jumped.current === null;
    jumped.current = location.key;
    target.scrollIntoView({ block: "start", behavior: arriving ? "auto" : "smooth" });
  }, [decisions.loading, location.hash, location.key]);
  const jump = (id: string) => navigate({ search: location.search, hash: id }, { replace: true });

  const header = (
    <ScreenHeader
      title="Ждут вас"
      pageFilter
      meta={decisions.loading ? <Skeleton width={260} /> : (
        <>
          {parts.length > 0 ? "Ждут вашего решения: " : page !== null && !anyFailed ? `На ${page} решений нет` : ""}
          {parts.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 && " · "}
              <a
                href={`#${part.queue}`}
                className="decisions-jump"
                onClick={(event) => {
                  event.preventDefault();
                  jump(part.queue);
                }}
              >
                {part.text}
              </a>
            </Fragment>
          ))}
          {failedText !== null && <>{parts.length > 0 || page !== null ? " · " : ""}{failedText}</>}
          {/* The rest of the team's decisions, when a page is picked: a quiet tail that shows them all (D17). */}
          {elsewhereText !== null && (
            <>
              {" · "}
              <button type="button" className="decisions-jump decisions-elsewhere" onClick={() => setPage(null)}>{elsewhereText}</button>
            </>
          )}
        </>
      )}
      updatedAt={decisions.updatedAt}
      stale={decisions.stale}
      onRefresh={decisions.refetch}
      refreshing={decisions.fetching}
    />
  );

  if (role === "chatter") return null;

  return (
    <>
      {header}
      <div className="wb-content">
        {decisions.loading ? (
          <Section title={<Skeleton width={220} height={24} />}>
            <Table label="Ждут вас: загружается" columns={SKELETON_COLUMNS} rows={[]} rowKey={() => ""} loading skeletonRows={3} skeletonLines={2} className="decisions-skeleton" />
          </Section>
        ) : (
          <>
            {failed.questions && <QuestionsUnavailable onRetry={() => void decisions.questions.refetch()} retrying={decisions.questions.isFetching} />}
            {view.questions && view.questions.owner.length > 0 && (
              <QuestionsSection owner={view.questions.owner} chatters={view.questions.chatters} serverNow={view.questions.serverNow} platformOf={platformOf} fanOf={fanOf} />
            )}

            {failed.reports && (
              <Section title="Отчёты">
                <ErrorState
                  className="decisions-error"
                  compact
                  onRetry={() => {
                    if (decisions.posts.isError) void decisions.posts.refetch();
                    if (decisions.changes.isError) void decisions.changes.refetch();
                  }}
                  retrying={decisions.posts.isFetching || decisions.changes.isFetching}
                />
              </Section>
            )}
            {view.reports && view.reports.posts.length + view.reports.changes.length > 0 && (
              <ReportsSection posts={view.reports.posts} changes={view.reports.changes} />
            )}

            {failed.customs && (
              <Section title="Кастомы">
                <ErrorState className="decisions-error" compact onRetry={() => void decisions.customs.refetch()} retrying={decisions.customs.isFetching} />
              </Section>
            )}
            {view.customs && view.customs.paid.length > 0 && (
              <CustomsSection {...view.customs} platformOf={platformOf} fanOf={fanOf} userIdOf={userIdOf} />
            )}

            {failed.held && (
              <Section title="Зависшие отправки">
                <ErrorState className="decisions-error" compact onRetry={() => void decisions.held.refetch()} retrying={decisions.held.isFetching} />
              </Section>
            )}
            {view.held && view.held.items.length > 0 && (
              <HeldSection
                items={view.held.items}
                total={view.held.total}
                serverNow={view.held.serverNow}
                platformOf={platformOf}
                fanOf={fanOf}
                onOpen={(id) => open("send", id)}
                selected={openSend?.attemptId ?? null}
              />
            )}

            {waiting === 0 && !anyFailed && (
              <EmptyState icon={CircleCheck} title="Всё решено" className="decisions-empty">
                {page === null
                  ? `${isOwner ? "Вопросов «чья продажа», н" : "Н"}еразобранных постов и изменённых выплаченных дней, оплаченных и не отданных кастомов и зависших отправок нет.`
                  : `На ${page} ${isOwner ? "вопросов «чья продажа», " : ""}неразобранных постов, оплаченных и не отданных кастомов и зависших отправок нет.`}
              </EmptyState>
            )}

            <div className="decisions-history">
              {view.questions && view.questions.owner.length === 0 && view.questions.chatters.length > 0 && (
                <ChattersQuestions alone chatters={view.questions.chatters} serverNow={view.questions.serverNow} platformOf={platformOf} fanOf={fanOf} />
              )}
              {view.customs && view.customs.paid.length === 0 && (
                <CustomsFolds {...view.customs} platformOf={platformOf} fanOf={fanOf} userIdOf={userIdOf} />
              )}
              <ResolvedJournal page={page} platformOf={platformOf} />
            </div>
          </>
        )}
      </div>

      {openSend && view.held && (
        <ResolveSendModal
          key={openSend.attemptId}
          item={openSend}
          serverNow={view.held.serverNow}
          platform={platformOf(openSend.pageLabel)}
          fan={fanOf(openSend)}
          onClose={() => open("send", null)}
        />
      )}
    </>
  );
}

/** The skeleton of a queue: the shape of its rows before the first answer — a fan and its page, what, who, when, the arrow. */
const SKELETON_COLUMNS: Column<never>[] = [
  { key: "fan", header: "Фан", width: 220, cell: () => null },
  { key: "what", header: "Что", cell: () => null },
  { key: "who", header: "Кто", width: 180, cell: () => null },
  { key: "when", header: "Когда", width: 200, cell: () => null },
  { key: "go", header: "", width: 44, cell: () => null },
];
