import { useQueries, useQuery } from "@tanstack/react-query";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import type { NotificationsIncidentItem, SyncBlocksPage } from "@agency_hub_core/contracts";

import { buildPageSectionRoute } from "@/lib/navigation";
import { enginePageStatus } from "@/pages/settings/engine/enginePageSummary";
import { engineStatusState } from "@/pages/settings/engine/engineDisplay";
import { clientHealthRange } from "@/pages/dev/clientHealthView";
import { hydrationRequestTakesApproval } from "./agentHydration.js";
import { clientHeldSendsQueryOptions } from "./clientHeldSends.js";
import { publicationsQueryOptions } from "./publications.js";
import { kernel } from "./sdk.js";
import { teamCustomsQueryOptions, teamShiftDisputesQueryOptions } from "./team.js";

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
 */
export interface WaitingRow {
  id: "drafts" | "unknown" | "disputes" | "customs" | "held" | "login" | "failures" | "extension" | "history";
  label: string;
  /** null: the read failed. */
  count: number | null;
  /** The read's limit was hit: there are at least this many. */
  capped?: boolean;
  to: string;
}

const MINUTE = 60_000;
const LIST_LIMIT = 1000;

/** A counter of a read's rows, or null while it has no answer. */
function failedOr<T>(query: { data: T | undefined; isError: boolean }, count: (data: T) => number): number | null {
  if (query.data !== undefined) return count(query.data);
  return query.isError ? null : 0;
}

/** The owner has the hub's key state in the config; a team lead cannot read it. */
export function useOfapiStatus(role: string): "on" | "off" | "unknown" {
  const config = useQuery({
    queryKey: ["admin", "config"],
    queryFn: () => kernel.adminConfig(),
    enabled: role === "owner",
    refetchInterval: 5 * MINUTE,
    meta: { suppressGlobalError: true },
  });
  const running = config.data?.subsystems.flatMap((subsystem) => subsystem.items).find((item) => item.key === "ofapiApiKey")?.running ?? [];
  if (running.length === 0) return "unknown";
  return running.some((instance) => instance.state === "set") ? "on" : "off";
}

/** The kinds of the vendor's own troubles: while it is off they wait for nobody. */
function counted(incident: NotificationsIncidentItem, loginPages: ReadonlySet<string>, ofapiOff: boolean): boolean {
  if (incident.kind === "auth_blocked" && incident.pageLabel !== null && loginPages.has(incident.pageLabel)) return false;
  if (!ofapiOff) return true;
  // A late answer to OnlyFans' letter can freeze the page's money: it always counts.
  if (incident.kind === "ofapi_platform_notice") return true;
  if (incident.kind.startsWith("ofapi_")) return false;
  if (incident.platform === "onlyfans" && incident.kind !== "chatspace_tab") return false;
  return true;
}

export function useWaitingCounts(role: string): { rows: WaitingRow[]; total: number } {
  const owner = role === "owner";
  const ofapi = useOfapiStatus(role);
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const week = clientHealthRange("7d", today);

  const [drafts, unknown, disputes, customs, held, overview, enginePages, incidents, extension, history] = useQueries({
    queries: [
      { ...publicationsQueryOptions({ status: "draft", limit: LIST_LIMIT }), enabled: owner, refetchInterval: MINUTE },
      { ...publicationsQueryOptions({ status: "unknown", limit: LIST_LIMIT }), enabled: owner, refetchInterval: MINUTE },
      { ...teamShiftDisputesQueryOptions, enabled: owner, refetchInterval: MINUTE },
      { ...teamCustomsQueryOptions, refetchInterval: MINUTE },
      { ...clientHeldSendsQueryOptions({ state: "held", limit: 1, offset: 0 }), refetchInterval: MINUTE },
      {
        queryKey: ["syncBlocks", "overview"],
        queryFn: () => kernel.syncOverview(),
        enabled: owner,
        refetchInterval: MINUTE,
        meta: { suppressGlobalError: true },
      },
      {
        queryKey: ["syncEngine", "pages"],
        queryFn: () => kernel.syncPages(),
        enabled: owner,
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
  const ofapiOff = ofapi !== "on";

  const rows: WaitingRow[] = [];
  const push = (row: WaitingRow) => {
    if (row.count !== 0) rows.push(row);
  };

  if (owner) {
    const draftCount = failedOr(drafts, (data) => data.publications.length);
    push({ id: "drafts", label: "Посты на утверждение", count: draftCount, capped: draftCount === LIST_LIMIT, to: "/publications?status=draft&window=all" });
    push({ id: "unknown", label: "Публикации с исходом «Неизвестно»", count: failedOr(unknown, (data) => data.publications.length), to: "/publications?status=unknown&window=all" });
    push({ id: "disputes", label: "Споры по продажам", count: failedOr(disputes, (data) => data.disputes.filter((dispute) => dispute.resolution === null).length), to: "/team/payouts#disputes" });
  }
  push({ id: "customs", label: "Кастомы оплачены, не отданы", count: failedOr(customs, (data) => data.customs.filter((custom) => custom.state === "paid").length), to: "/team/customs" });
  push({ id: "held", label: "Проверить отправки", count: failedOr(held, (data) => data.total), to: "/team/held-sends" });
  if (owner) {
    const loginFailed = overview.isError || enginePages.isError;
    push({
      id: "login",
      label: "Нужен вход в Fansly",
      count: loginFailed && overview.data === undefined ? null : loginPages.length,
      to: loginPages.length === 1 ? buildPageSectionRoute(loginPages[0]!, "browser-login") : "/system/collection",
    });
    push({ id: "failures", label: "Сбои", count: failedOr(incidents, (data) => data.items.filter((item) => counted(item, loginLabels, ofapiOff)).length), to: "/system/failures" });
    push({
      id: "extension",
      label: "Критичные сбои расширения",
      count: failedOr(extension, (data) => data.counters.filter((counter) => counter.code.startsWith("p1.")).reduce((sum, counter) => sum + counter.total, 0)),
      to: "/system/dev/extension",
    });
    if (ofapi === "on") {
      push({ id: "history", label: "Заявки на историю", count: failedOr(history, (data) => data.items.filter(hydrationRequestTakesApproval).length), to: "/system/history-requests?state=requested" });
    }
  }

  return { rows, total: rows.reduce((sum, row) => sum + (row.count ?? 0), 0) };
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
