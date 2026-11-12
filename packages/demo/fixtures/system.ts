import { daysAgo, hoursAgo, iso, type DemoHandlers, type DemoRequest } from "../core.ts";
import { demoConfigView } from "./system-config.ts";
import {
  demoAdminIncidents,
  demoAdminLogs,
  demoClientHealth,
  demoDbStats,
  demoQueueJobs,
  demoSyncRunDetail,
} from "./system-dev.ts";
import {
  demoBannedWords,
  demoStoredReads,
  demoWebhookCatalog,
  demoWebhookDeliveries,
  demoWebhookPolicy,
} from "./system-ofapi.ts";
import { demoPageSyncBlocks, demoSyncHistoryRequests, demoSyncOverview, demoSyncPages } from "./system-sync.ts";
import { reportHandlers } from "./system-reports.ts";
import { demoSystemState } from "./system-state.ts";
import { peopleMessagesHandlers } from "./system-people-messages.ts";

type Capability =
  | "read:messages" | "read:money" | "read:observations_envelope" | "read:datasets" | "request:hydration"
  | "write:publication_drafts" | "approve:publications" | "write:fan_queues" | "read:content" | "read:team"
  | "withdraw:publications" | "delete:posts" | "look:media" | "write:reports" | "signin:taskindex" | "signin:contentops" | "introspect:agent_keys";

/** The agents of the keys (fixtures/people.ts): whose each key is. */
const AGENTS = {
  helper: { code: "helper-bot", displayName: "Помощник в чате", state: "working" },
  contentops: { code: "contentops", displayName: "Сервер ContentOps", state: "working" },
} as const;

/**
 * The agents' read keys: the research agent, ContentOps (its own content only), the queue builder, a service's own
 * key (no agent), and two that ended before the people registry (no agent either).
 */
function agentKeys(request: DemoRequest) {
  const now = request.now;
  const key = (
    id: number,
    name: string,
    prefix: string,
    capabilities: Capability[],
    pageLabels: string[],
    createdDaysAgo: number,
    expiresInDays: number,
    lastUsedHoursAgo: number | null,
    revokedDaysAgo: number | null = null,
    agent: (typeof AGENTS)[keyof typeof AGENTS] | null = null,
    lastOperation: string | null = null,
  ) => {
    const expiresAt = daysAgo(now, -expiresInDays);
    const revokedAt = revokedDaysAgo === null ? null : iso(daysAgo(now, revokedDaysAgo));
    return {
      id,
      name,
      keyPrefix: `agency_hub_agent_${prefix}`,
      capabilities,
      pageLabels,
      expiresAt: iso(expiresAt),
      createdAt: iso(daysAgo(now, createdDaysAgo)),
      revokedAt,
      lastUsedAt: lastUsedHoursAgo === null ? null : iso(hoursAgo(now, lastUsedHoursAgo)),
      isActive: revokedAt === null && expiresAt.getTime() > now.getTime(),
      agent: agent === null ? null : { ...agent },
      lastCall: lastOperation === null || lastUsedHoursAgo === null ? null : { at: iso(hoursAgo(now, lastUsedHoursAgo)), operation: lastOperation },
    };
  };
  const all = ["mia-1", "mia-2", "mia-3", "mia-of", "mia-vip-of", "nova-1", "ivy-1", "ivy-2"];
  return [
    key(7, "Исследователь архива", "Xk4q9TzP2w", ["read:messages", "read:money", "read:datasets", "read:observations_envelope", "request:hydration", "read:team"], all, 41, 79, 0.3, null, AGENTS.helper, "agentShiftReview"),
    key(9, "ContentOps", "m3RfV8bN1c", ["read:content", "write:publication_drafts", "approve:publications", "withdraw:publications", "look:media", "signin:contentops"], ["mia-1", "mia-2", "mia-3", "nova-1"], 8, 82, 2.6, null, AGENTS.contentops, "agentDatasetQuery"),
    key(10, "Очереди фанов", "Q7pLs2dYe9", ["read:datasets", "read:money", "write:fan_queues"], ["mia-1", "mia-2", "nova-1"], 5, 85, 19, null, AGENTS.helper, "agentFanQueueCreate"),
    key(13, "TaskIndex: вход и «кто этот ключ»", "Hn2wQ5sLr8", ["signin:taskindex", "introspect:agent_keys"], ["mia-1"], 1, 89, 0.1, null, null, "agentKeyIntrospect"),
    // The agents that publish report pages (system-reports.ts): the traffic routine and the boards.
    key(11, "Трафик", "Tf3kW8mZr2", ["write:reports"], ["mia-1"], 4, 86, 2.6),
    key(12, "Доски агентства", "Bd9xQ1nVs6", ["write:reports"], ["mia-1"], 3, 87, 0.7),
    key(4, "Разбор страниц Ivy (разовый)", "aZ5h0KcW3u", ["read:messages", "read:datasets"], ["ivy-1", "ivy-2"], 62, -2, 300),
    key(3, "Старый агент отчётов", "Tr8vN6eJq1", ["read:money", "read:datasets"], ["mia-1", "nova-1"], 120, 245, 2_100, 33),
  ].sort((left, right) => Number(right.isActive) - Number(left.isActive) || right.id - left.id);
}

/** Demo answers of this area's screens (see demo/core.ts). */
export const systemHandlers: DemoHandlers = {
  // Система → Отчёты агентов, Трафик → Сводка: the pages agents publish.
  ...reportHandlers,
  // System → «Fansly» / «OnlyFans»
  syncOverview: (request) => demoSyncOverview(request),
  pageSyncBlocks: (request) => demoPageSyncBlocks(request),
  syncPages: (request) => demoSyncPages(request),
  syncHistoryRequests: (request) => demoSyncHistoryRequests(request),

  // System → «OnlyFans API»
  adminOfapiWebhookCollectionPolicy: () => demoWebhookPolicy(),
  adminOfapiWebhookEventCatalog: () => demoWebhookCatalog(),
  adminOfapiWebhookDeliveries: (request) => demoWebhookDeliveries(request),
  ofapiBannedWordsAdminGet: () => demoBannedWords(),
  ofapiReadCollectionsGet: (request) => demoStoredReads(request),

  // System → «Конфигурация», «Функции», «Ключи агентов»
  adminConfig: (request) => demoConfigView(request),
  agentKeyList: (request) => agentKeys(request),

  // System → developer screens
  adminLogs: (request) => demoAdminLogs(request),
  adminIncidents: (request) => demoAdminIncidents(request),
  adminSyncRunDetail: (request) => demoSyncRunDetail(request),
  adminQueueJobs: (request) => demoQueueJobs(request),
  adminDbStats: (request) => demoDbStats(request),
  adminClientHealth: (request) => demoClientHealth(request),

  // System → «Состояние»: the routines and copies (the `hub-demo-scenario` cookie: healthy, mac-silent).
  systemState: (request) => demoSystemState(request),
  // Система → «Сообщения людям»: the server's sender as merged (no token, every kind off) and what it held.
  ...peopleMessagesHandlers,
};
