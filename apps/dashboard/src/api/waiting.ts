import { useCallback } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import type { NotificationsIncidentItem, SyncBlocksPage } from "@agency_hub_core/contracts";

import { isOfapiOffFailure } from "@/lib/failures";
import { buildPageSectionRoute } from "@/lib/navigation";
import { workboardHref } from "@/lib/workboard";
import type { OfapiStatus } from "@/lib/statusWords";
import { enginePageStatus } from "@/pages/settings/engine/enginePageSummary";
import { engineStatusState } from "@/pages/settings/engine/engineDisplay";
import { clientHealthRange } from "@/pages/dev/clientHealthView";
import { hydrationRequestTakesApproval } from "./agentHydration.js";
import { clientHeldSendsQueryOptions } from "./clientHeldSends.js";
import { publicationsQueryOptions } from "./publications.js";
import { kernel } from "./sdk.js";
import { reportQuestionsQueryOptions, saleQuestionsQueryOptions, teamCustomsQueryOptions } from "./team.js";

/**
 * «Ждут вас»: everything that waits for the owner, as counts by kind, each with
 * the one place where it is done (design/ia.md §5). The menu's number is the sum
 * of these rows and the home block shows them: one hook, so they cannot differ.
 * Neither the period nor the page filter touches it.
 *
 * No answer is not a zero: a read that failed gives its row `count: null` and
 * «не удалось проверить», and the menu's number sums what did answer. The query
 * keys are the ones the target screens use, so a write there moves the count at
 * once. Read every minute, only while the tab is visible.
 *
 * A row's link carries `?page=all`: it counts over every page, so it opens every
 * page, whatever filter is remembered (lib/pageParam.ts). Workboard's rows need
 * none: without `?page=` it shows every page.
 */
export interface WaitingRow {
  /** The chip's own words (a group of the list): shown instead of the row's short label. */
  title?: string;
  /** The old rows; while the owner's switch reads matters, also «Люди и доступ», «Проверки ledger», «Другие дела» (package K). */
  id: "drafts" | "unknown" | "questions" | "reports" | "customs" | "held" | "login" | "failures" | "extension" | "history" | "content" | "people" | "ledger" | "other" | "publications" | "system";
  label: string;
  /** null: the read failed, or the state it depends on could not be checked. */
  count: number | null;
  /** The read's limit was hit: there are at least this many. */
  capped?: boolean;
  /** The one page this row is about, when it is about one. */
  page?: string | undefined;
  to: string;
}

const MINUTE = 60_000;
const LIST_LIMIT = 1000;
/** `teamCustoms` answers at most this many rows. */
const CUSTOMS_LIMIT = 200;

/** A counter of a read's rows, or null while it has no answer. */
function failedOr<T>(query: { data: T | undefined; isError: boolean }, count: (data: T) => number): number | null {
  if (query.data !== undefined) return count(query.data);
  return query.isError ? null : 0;
}

/**
 * Whether the OnlyFans API is on, with the read behind it (design/screens/system.md
 * §0.2). `off` is said only when every process reported the key unset; a process
 * that does not know makes the answer `unknown`, and so does no answer. A team lead
 * cannot read the config: always `unknown`, without a request.
 */
export function useOfapiStatusQuery(role: string): { status: OfapiStatus; isLoading: boolean; refetch: () => void } {
  const config = useQuery({
    queryKey: ["admin", "config"],
    queryFn: () => kernel.adminConfig(),
    enabled: role === "owner",
    refetchInterval: 5 * MINUTE,
    meta: { suppressGlobalError: true },
  });
  const { refetch } = config;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  // The secret's own state, not `runningState`: that is always `unknown` for a secret.
  const states = config.data?.subsystems.flatMap((subsystem) => subsystem.items).find((item) => item.key === "ofapiApiKey")?.running.map((entry) => entry.state) ?? [];
  const status: OfapiStatus = states.length === 0 || states.some((state) => state !== "set" && state !== "unset")
    ? "unknown"
    : states.every((state) => state === "unset") ? "off" : "on";
  return { status, isLoading: config.isLoading, refetch: retry };
}

/** The one answer every screen asks: `on`, `off`, or `unknown` when it cannot be said. */
export function useOfapiStatus(role: string): OfapiStatus {
  return useOfapiStatusQuery(role).status;
}

/** What waits for a person among the open failures (design/ia.md §5.2). */
function countsAsFailure(incident: NotificationsIncidentItem, loginPages: ReadonlySet<string>, ofapiOff: boolean): boolean {
  if (ofapiOff && isOfapiOffFailure(incident)) return false;
  // Already counted by the login row.
  return !(incident.kind === "auth_blocked" && incident.pageLabel !== null && loginPages.has(incident.pageLabel));
}

export interface WaitingCounts {
  /** The rows to show, in the table's order: nothing with a zero. */
  rows: WaitingRow[];
  /** The sum of what did answer: the menu's number. */
  total: number;
  /** The rows that could not be checked. */
  failed: WaitingRow[];
  loading: boolean;
  /** The Fansly pages that need a login: a screen beside this count says the same. */
  loginPages: readonly string[];
  refetchAll: () => void;
}

export function useWaitingCounts(role: string): WaitingCounts {
  const team = role === "owner" || role === "team_lead";
  // The owner's switch (`mattersReadEnabled`, packages D and K): on, the rows are read from matters in one request;
  // off — or not answered — every row reads its own source exactly as before. Until it is known, no row is read.
  const fromMatters = useQuery({
    queryKey: ["matters", "waiting", ""],
    queryFn: () => kernel.mattersWaiting({ query: {} }),
    enabled: team,
    refetchInterval: MINUTE,
    meta: { suppressGlobalError: true },
  });
  const active = fromMatters.data?.active === true;
  const legacy = !team || (!active && (fromMatters.data !== undefined || fromMatters.isError));
  const owner = role === "owner" && legacy;
  const { status: ofapi, isLoading: ofapiLoading, refetch: refetchOfapi } = useOfapiStatusQuery(role);
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const week = clientHealthRange("7d", today);

  const [drafts, unknown, questions, reports, customs, held, overview, enginePages, incidents, extension, history] = useQueries({
    queries: [
      { ...publicationsQueryOptions({ status: "draft", limit: LIST_LIMIT }), enabled: owner, refetchInterval: MINUTE },
      { ...publicationsQueryOptions({ status: "unknown", limit: LIST_LIMIT }), enabled: owner, refetchInterval: MINUTE },
      // The ledger's reads are heavier and change with the posts' collection: every five minutes is enough.
      { ...saleQuestionsQueryOptions, enabled: owner, refetchInterval: 5 * MINUTE },
      { ...reportQuestionsQueryOptions(today), enabled: owner, refetchInterval: 5 * MINUTE },
      { ...teamCustomsQueryOptions, enabled: legacy, refetchInterval: MINUTE },
      { ...clientHeldSendsQueryOptions({ state: "held", limit: 1, offset: 0 }), enabled: legacy, refetchInterval: MINUTE },
      {
        queryKey: ["syncBlocks", "overview"],
        queryFn: () => kernel.syncOverview(),
        // Read for the owner whatever the switch: the pages that need a login are said beside the count elsewhere too.
        enabled: role === "owner",
        refetchInterval: MINUTE,
        meta: { suppressGlobalError: true },
      },
      {
        queryKey: ["syncEngine", "pages"],
        queryFn: () => kernel.syncPages(),
        enabled: role === "owner",
        refetchInterval: MINUTE,
        meta: { suppressGlobalError: true },
      },
      {
        queryKey: ["notifications", "incidents", { status: "open", limit: 200 }],
        queryFn: () => kernel.notificationsIncidents({ query: { status: "open", limit: 200, offset: 0 } }),
        enabled: owner,
        refetchInterval: MINUTE,
        meta: { suppressGlobalError: true },
      },
      {
        queryKey: ["admin", "client-health", { ...week, clientName: "chat-extension" }],
        queryFn: () => kernel.adminClientHealth({ query: { ...week, clientName: "chat-extension" } }),
        enabled: owner,
        refetchInterval: MINUTE,
        meta: { suppressGlobalError: true },
      },
      {
        queryKey: ["agent", "hydration", { state: "requested", limit: 200 }],
        queryFn: () => kernel.agentHydrationRequestList({ query: { state: "requested", limit: 200 } as Parameters<typeof kernel.agentHydrationRequestList>[0]["query"] }),
        // Fansly's requests go by themselves and OnlyFans' cannot be approved
        // while its API is off: the row stays away until the key returns.
        enabled: owner && ofapi === "on",
        refetchInterval: MINUTE,
        meta: { suppressGlobalError: true },
      },
    ],
  });

  const loginPages = fanslyPagesNeedingLogin(overview.data?.pages, enginePages.data?.pages);
  const loginLabels = new Set(loginPages);
  // Without the key's state OnlyFans cannot honestly be subtracted: no answer, not a zero.
  const ofapiUnanswered = ofapi === "unknown" && !ofapiLoading;

  const rows: WaitingRow[] = [];
  const push = (row: WaitingRow) => {
    if (row.count !== 0) rows.push(row);
  };

  if (owner) {
    const draftCount = failedOr(drafts, (data) => data.publications.length);
    push({ id: "drafts", label: "Посты на утверждение", count: draftCount, capped: draftCount === LIST_LIMIT, to: "/content/publications?status=draft&window=all&page=all" });
    push({ id: "unknown", label: "Публикации: исход неизвестен", count: failedOr(unknown, (data) => data.publications.length), to: "/content/publications?status=unknown&window=all&page=all" });
    push({ id: "questions", label: "Чья продажа: вопросы ждут вашего слова", count: failedOr(questions, (count) => count), to: workboardHref("decisions", "", "questions") });
    push({ id: "reports", label: "Отчёты смен ждут решения", count: failedOr(reports, (count) => count), to: workboardHref("decisions", "", "reports") });
  }
  const customsCount = failedOr(customs, (data) => data.customs.filter((custom) => custom.state === "paid").length);
  push({ id: "customs", label: "Кастомы оплачены, не отданы", count: customsCount, capped: customsCount === CUSTOMS_LIMIT, to: workboardHref("decisions", "", "customs") });
  push({ id: "held", label: "Проверить отправки", count: failedOr(held, (data) => data.total), to: workboardHref("decisions", "", "held") });
  if (owner) {
    // Either read missing leaves the login state unknown: a page that was found is
    // shown, and finding none is «could not check», never a quiet zero.
    const loginUnchecked = (overview.isError && overview.data === undefined) || (enginePages.isError && enginePages.data === undefined);
    const onlyPage = loginPages.length === 1 ? loginPages[0] : undefined;
    push({
      id: "login",
      label: onlyPage === undefined ? "Нужен вход в Fansly" : `Нужен вход в Fansly: ${onlyPage}`,
      count: loginPages.length === 0 && loginUnchecked ? null : loginPages.length,
      page: onlyPage,
      to: onlyPage === undefined ? "/system/collection?page=all" : buildPageSectionRoute(onlyPage, "browser-login"),
    });
    push({
      id: "failures",
      label: "Сбои",
      count: ofapiUnanswered ? null : failedOr(incidents, (data) => data.items.filter((item) => countsAsFailure(item, loginLabels, ofapi === "off")).length),
      to: "/system/failures?page=all",
    });
    push({
      id: "extension",
      label: "Критичные сбои расширения",
      count: failedOr(extension, (data) => data.counters.filter((counter) => counter.code.startsWith("p1.")).reduce((sum, counter) => sum + counter.total, 0)),
      to: "/system/dev#extension",
    });
    if (ofapi === "on" || ofapiUnanswered) {
      push({
        id: "history",
        label: "Заявки на историю",
        count: ofapiUnanswered ? null : failedOr(history, (data) => data.items.filter(hydrationRequestTakesApproval).length),
        to: "/system/history-requests?state=requested&page=all",
      });
    }
  }

  const queries = [drafts, unknown, questions, reports, customs, held, overview, enginePages, incidents, extension, history];
  if (active && fromMatters.data) {
    // The owner's chips are the list's groups (contracts waiting-groups.ts, counted by Hub): the list's titles and
    // numbers, summing to the menu's number. A group whose source did not answer says «не удалось проверить», or «N+»
    // when it has some. A team lead keeps the rows (services/matters.ts buildWaitingRows).
    const matterRows: WaitingRow[] = role === "owner"
      ? fromMatters.data.groups.map((group) => ({
        id: group.id as WaitingRow["id"], label: group.title, title: group.title,
        count: !group.checked && group.count === 0 ? null : group.count, capped: !group.checked, to: group.to,
      }))
      : fromMatters.data.rows.map((row) => ({
        id: row.id, label: row.label, count: row.count, capped: row.capped, page: row.pageLabel ?? undefined, to: row.to,
      }));
    return {
      rows: matterRows,
      total: fromMatters.data.total,
      failed: matterRows.filter((row) => row.count === null),
      loading: false,
      loginPages,
      refetchAll: () => void fromMatters.refetch(),
    };
  }
  const loading = (team && !legacy) || ofapiLoading || queries.some((query) => query.isLoading);
  const refetchAll = () => {
    refetchOfapi();
    for (const query of queries) void query.refetch();
  };
  return {
    rows,
    total: rows.reduce((sum, row) => sum + (row.count ?? 0), 0),
    failed: rows.filter((row) => row.count === null),
    loading,
    loginPages,
    refetchAll,
  };
}

/** The Fansly pages whose browser was signed out or whose login Fansly refuses. */
function fanslyPagesNeedingLogin(
  blocks: readonly SyncBlocksPage[] | undefined,
  engine: Parameters<typeof engineStatusState>[0][] | undefined,
): string[] {
  if (!blocks) return [];
  return blocks
    .filter((page) => page.platform === "fansly")
    .filter((page) => {
      const status = engine?.find((candidate) => candidate?.pageLabel === page.pageLabel);
      return enginePageStatus(page, engineStatusState(status)).kind === "login";
    })
    .map((page) => page.pageLabel);
}
