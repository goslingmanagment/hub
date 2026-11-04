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

type Capability =
  | "read:messages" | "read:money" | "read:observations_envelope" | "read:datasets" | "request:hydration"
  | "write:publication_drafts" | "approve:publications" | "write:fan_queues" | "read:content";

/** The agents' read keys: the research agent, ContentOps (its own content only), the queue builder, and two that ended. */
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
    };
  };
  const all = ["mia-1", "mia-2", "mia-3", "mia-of", "mia-vip-of", "nova-1", "ivy-1", "ivy-2"];
  return [
    key(7, "Исследователь архива", "Xk4q9TzP2w", ["read:messages", "read:money", "read:datasets", "read:observations_envelope", "request:hydration"], all, 41, 79, 0.3),
    key(9, "ContentOps", "m3RfV8bN1c", ["read:content", "write:publication_drafts", "approve:publications"], ["mia-1", "mia-2", "mia-3", "nova-1", "ivy-1", "ivy-2"], 8, 82, 2.6),
    key(10, "Очереди фанов", "Q7pLs2dYe9", ["read:datasets", "read:money", "write:fan_queues"], ["mia-1", "mia-2", "nova-1"], 5, 85, 19),
    key(4, "Разбор страниц Ivy (разовый)", "aZ5h0KcW3u", ["read:messages", "read:datasets"], ["ivy-1", "ivy-2"], 62, -2, 300),
    key(3, "Старый агент отчётов", "Tr8vN6eJq1", ["read:money", "read:datasets"], ["mia-1", "nova-1"], 120, 245, 2_100, 33),
  ].sort((left, right) => Number(right.isActive) - Number(left.isActive) || right.id - left.id);
}

/** Demo answers of this area's screens (see demo/core.ts). */
export const systemHandlers: DemoHandlers = {
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
};
