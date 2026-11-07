import { CircleCheck } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { Button, EmptyState, ErrorState, Notice, Section, Skeleton, Table, type Column } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { kernel } from "@/shared/hub";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePages } from "@/shared/usePages";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { CustomsFolds, CustomsSection } from "./Customs";
import { DisputeDrawer, DisputesSection, SettledDisputes } from "./Disputes";
import { HeldSection, ResolveSendModal, ResolvedJournal } from "./HeldSends";
import { useDecisions, useFanNames, type Dispute, type FanRefOnPage, type HeldSend } from "./data";
import "./decisions.css";

/**
 * Решения (spec §4.6): what waits for the owner's decision — sale disputes,
 * customs paid and not delivered, held sends. Each section is there only while
 * it has rows; nothing at all is «Всё решено». A section whose read failed says
 * so in its place: no answer is not a zero. What is open (a dispute's panel, a
 * send's resolve) is in the address: `?sale=`, `?send=`.
 */
export function DecisionsScreen() {
  const { isOwner, role } = useMe();
  const { page, setPage } = usePageFilter();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const pages = usePages();
  const decisions = useDecisions({ owner: isOwner, page });
  const { view } = decisions;
  // A login to its id, for the customs' «who wrote it» (the owner's people list; a team lead reads plain names).
  const users = useQuery({ queryKey: ["decisions", "users"], queryFn: () => kernel.adminListUsers(), enabled: isOwner, staleTime: 5 * 60_000 });

  const platformOf = (label: string) => pages.data?.find((one) => one.label === label)?.platform;
  const userIdOf = (username: string) => users.data?.find((user) => user.username === username && !user.deletedAt)?.id ?? null;

  const fans: FanRefOnPage[] = [
    ...(view.disputes ? [...view.disputes.open, ...view.disputes.settled].flatMap((one) => (one.fanRef === null ? [] : [{ pageLabel: one.pageLabel, fanRef: one.fanRef }])) : []),
    ...(view.customs ? [...view.customs.paid, ...view.customs.ordered] : []),
    ...(view.held ? view.held.items : []),
  ];
  const fanOf = useFanNames(fans);

  const open = (key: "sale" | "send", value: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete(key);
    else next.set(key, value);
    return next;
  });
  const saleRef = search.get("sale");
  const attemptId = search.get("send");
  // What is open stays open while Hub answers: a refused write re-reads the lists, and the row may leave them —
  // the panel and the window keep the record they were opened with, so their words about the refusal stay readable.
  const lastDispute = useRef<Dispute | null>(null);
  const lastSend = useRef<HeldSend | null>(null);
  const foundDispute = saleRef && view.disputes ? [...view.disputes.open, ...view.disputes.settled].find((one) => one.saleRef === saleRef) : undefined;
  const foundSend = attemptId && view.held ? view.held.items.find((one) => one.attemptId === attemptId) : undefined;
  if (foundDispute) lastDispute.current = foundDispute;
  if (foundSend) lastSend.current = foundSend;
  const openDispute = foundDispute ?? (saleRef && lastDispute.current?.saleRef === saleRef ? lastDispute.current : undefined);
  const openSend = foundSend ?? (attemptId && lastSend.current?.attemptId === attemptId ? lastSend.current : undefined);

  const counts = {
    disputes: view.disputes?.open.length ?? 0,
    customs: view.customs?.paid.length ?? 0,
    held: view.held?.total ?? 0,
  };
  const failed = {
    disputes: isOwner && decisions.disputes.isError && !view.disputes,
    customs: decisions.customs.isError && !view.customs,
    held: decisions.held.isError && !view.held,
  };
  const anyFailed = failed.disputes || failed.customs || failed.held;
  const waiting = counts.disputes + counts.customs + counts.held;
  const elsewhere = (view.disputes?.elsewhere ?? 0) + (view.customs?.elsewhere ?? 0) + (view.held?.elsewhere ?? 0);

  // The header's line is the screen's contents: each part jumps to its section (Р2, Р5).
  const parts = [
    counts.disputes > 0 && { id: "disputes", text: `${counts.disputes} ${ruPlural(counts.disputes, "спор", "спора", "споров")}` },
    counts.customs > 0 && { id: "customs", text: `${counts.customs} ${ruPlural(counts.customs, "кастом оплачен и не отдан", "кастома оплачены и не отданы", "кастомов оплачены и не отданы")}` },
    counts.held > 0 && { id: "held", text: `${counts.held} ${ruPlural(counts.held, "зависшая отправка", "зависшие отправки", "зависших отправок")}` },
  ].filter((part) => part !== false);
  const unanswered = [failed.disputes && "споры", failed.customs && "кастомы", failed.held && "отправки"].filter(Boolean);

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
      title="Решения"
      pageFilter
      meta={decisions.loading ? <Skeleton width={260} /> : (
        <>
          {waiting > 0 && (
            <>
              Ждут вашего решения:{" "}
              {parts.map((part, index) => (
                <Fragment key={part.id}>
                  {index > 0 && " · "}
                  <a
                    href={`#${part.id}`}
                    className="decisions-jump"
                    onClick={(event) => {
                      event.preventDefault();
                      jump(part.id);
                    }}
                  >
                    {part.text}
                  </a>
                </Fragment>
              ))}
            </>
          )}
          {unanswered.length > 0 && <>{waiting > 0 ? " · " : ""}не пришли: {unanswered.join(", ")}</>}
        </>
      )}
      updatedAt={decisions.updatedAt}
      onRefresh={decisions.refetch}
      refreshing={decisions.fetching}
    />
  );

  if (role === "chatter") return null;

  return (
    <>
      {header}
      <div className="wb-content">
        {page !== null && elsewhere > 0 && (
          <Notice action={<Button size="sm" onClick={() => setPage(null)}>Показать все страницы</Button>}>
            Показана только {page}. На других страницах ещё {elsewhere} {ruPlural(elsewhere, "решение", "решения", "решений")}.
          </Notice>
        )}

        {decisions.loading ? (
          <Section title={<Skeleton width={220} height={24} />}>
            <Table label="Решения загружаются" columns={SKELETON_COLUMNS} rows={[]} rowKey={() => ""} loading skeletonRows={3} skeletonLines={2} />
          </Section>
        ) : (
          <>
            {failed.disputes && (
              <Section title="Споры по продажам">
                <ErrorState className="decisions-error" compact onRetry={() => void decisions.disputes.refetch()} retrying={decisions.disputes.isFetching} />
              </Section>
            )}
            {view.disputes && view.disputes.open.length > 0 && (
              <DisputesSection open={view.disputes.open} settled={view.disputes.settled} fanOf={fanOf} onOpen={(ref) => open("sale", ref)} selected={openDispute?.saleRef ?? null} />
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
                  ? "Споров по продажам, оплаченных и не отданных кастомов и зависших отправок нет."
                  : `На ${page} споров, оплаченных и не отданных кастомов и зависших отправок нет.`}
              </EmptyState>
            )}

            <div className="decisions-history">
              {view.disputes && view.disputes.open.length === 0 && view.disputes.settled.length > 0 && (
                <SettledDisputes settled={view.disputes.settled} fanOf={fanOf} onOpen={(ref) => open("sale", ref)} selected={openDispute?.saleRef ?? null} />
              )}
              {view.customs && view.customs.paid.length === 0 && (
                <CustomsFolds {...view.customs} platformOf={platformOf} fanOf={fanOf} userIdOf={userIdOf} />
              )}
              <ResolvedJournal page={page} platformOf={platformOf} fanOf={fanOf} />
            </div>
          </>
        )}
      </div>

      {openDispute && (
        <DisputeDrawer
          key={openDispute.saleRef}
          dispute={openDispute}
          fan={openDispute.fanRef === null ? undefined : fanOf({ pageLabel: openDispute.pageLabel, fanRef: openDispute.fanRef })}
          onClose={() => open("sale", null)}
        />
      )}
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

/** The skeleton of a queue: the shape of its rows before the first answer. */
const SKELETON_COLUMNS: Column<never>[] = [
  { key: "when", header: "Когда", width: 170, cell: () => null },
  { key: "sum", header: "Сумма", numeric: true, width: 120, cell: () => null },
  { key: "fan", header: "Фан", width: 260, cell: () => null },
  { key: "what", header: "Что", cell: () => null },
  { key: "go", header: "", width: 44, cell: () => null },
];
