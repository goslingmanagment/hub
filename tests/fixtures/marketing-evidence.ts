/** Synthetic UI evidence only. No network, credentials, provider writes or live data. */
import { ofapiMarketingActionSchema, ofapiMarketingIntentSchema, type OfapiMarketingResource } from "../../packages/contracts/src/ofapi-smart-links.ts";

export const marketingEvidenceFixtureNames = [
  "ofapiMarketingGet", "ofapiMarketingPrepare", "ofapiReadCollectionsGet", "ofapiContentEventsGet", "ofapiBannedWordsAdminGet",
  "adminOfapiWebhookCollectionPolicy", "adminOfapiWebhookEventCatalog", "adminOfapiWebhookDeliveries", "adminOfapiWebhookRedeliver",
  "ofapiKeyScopeGet", "ofapiVendorUsageRefresh",
] as const;
export const marketingReadOnlyPreviewOperations = new Set<string>(["ofapiMarketingPrepare", "ofapiVendorUsageRefresh"]);
// The middleware must additionally require body.dryRun === true for this set.
export const marketingSyntheticDryRunOperations = new Set<string>(["adminOfapiWebhookRedeliver"]);
const nowDefault = "2026-09-11T10:00:00.000Z";
const defaultPages = [{ id: 2, label: "demo-onlyfans", platform: "onlyfans" }, { id: 3, label: "demo-onlyfans-vip", platform: "onlyfans" }];
const uuid = (id: number) => `40000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const linkId = (id: number) => `01ARZ3NDEKTSV4RRFFQ69G5F${id.toString().padStart(2, "0")}`;

function resource(pageId: number, patch: Partial<OfapiMarketingResource>, now: string): OfapiMarketingResource {
  return { pageId, nativeAccountRef: `acct_synthetic_${pageId}`, kind: "smart_link", id: linkId(pageId), shared: false, parentId: null, name: `SYNTHETIC кампания ${pageId}`,
    observedAt: now, linkType: "tracking_link", platform: null, platformPixelId: null, publicUrl: `https://example.test/synthetic-${pageId}`, httpMethod: null, status: null, destination: null,
    clicks: 0, conversions: null, subscribers: 0, spenders: null, revenueMills: "0", revenueBasis: "net", cost: null, tags: ["SYNTHETIC", "осень"], eventNames: {}, conversionTypes: [], scope: null,
    linkIds: [], templateVariables: [], headerNames: [], hasBodyTemplate: false, ...patch };
}

export function marketingEvidenceFixture(operation: string, query = new URLSearchParams(), _params: Record<string, string> = {}, body: Record<string, unknown> = {}, _allPages = defaultPages, now = nowDefault, mode = "normal"): unknown {
  const pages = defaultPages;
  const pageId = Number(query.get("pageId") ?? pages[0]?.id ?? 2);
  const empty = mode === "empty";
  const at = (days: number) => new Date(Date.parse(now) + days * 86_400_000).toISOString();
  const intent = (id: string, state: string, targetPage = pages[0]) => ({ id, state, action: "smart_link_create", createdAt: at(-1), errorCode: state === "indeterminate" ? "dispatch_interrupted" : null, remoteId: state === "succeeded" ? linkId(targetPage?.id ?? 2) : null, responseObservationId: null, accountingState: "pending", projectionState: "pending", preview: { pageId: targetPage?.id ?? 2, pageLabel: targetPage?.label ?? "demo-onlyfans", accountId: `acct_synthetic_${targetPage?.id ?? 2}`, values: [{ field: "name", value: "SYNTHETIC безопасная проверка" }, { field: "link_type", value: "tracking_link" }], destination: null, templateVariables: [], headerNames: [], targetId: null, changedFields: ["name"], conversionTypes: [], scope: null, affectedLinkIds: [], affectedLinksComplete: true, effect: "SYNTHETIC: создание ссылки", externalTest: false, estimatedCredits: 1 } });
  switch (operation) {
    case "ofapiMarketingGet": return { attributionWindowHours: 6, revenueIsAdditive: false, resources: empty ? [] : [
      ...pages.flatMap(page => [resource(page.id, {}, now), resource(page.id, { kind: "tracking", id: `tracking-${page.id}`, name: `SYNTHETIC tracking ${page.id}`, clicks: null, subscribers: null, revenueMills: null }, at(-1)), resource(page.id, { kind: "pixel", id: String(page.id + 100), parentId: linkId(page.id), name: "SYNTHETIC pixel", platform: "meta", platformPixelId: "synthetic-platform-pixel", publicUrl: null }, now)]),
      resource(2, { kind: "postback", pageId: null, nativeAccountRef: null, id: "20", name: "SYNTHETIC postback", publicUrl: null, destination: "https://example.test", httpMethod: "POST", scope: "global", conversionTypes: ["event_new_subscriber"], headerNames: ["Authorization"], templateVariables: ["fan_id"], hasBodyTemplate: true }, now),
    ], analytics: empty ? [] : pages.map(page => ({ pageId: page.id, operation: "ofapi_read_smart_link_stats", linkId: linkId(page.id), observedAt: now, window: { from: at(-7), to: now }, requestedRevenueBasis: "net", coverage: { state: "partial", reason: "synthetic_bounded_window" }, rows: [{ period: "summary", clicks: 0, subscribers: null, revenueMills: "0", revenueBasis: "net", attributionOnly: true }, { period: "row", fanId: "synthetic-fan", isBot: null, isDuplicate: false, amountNetMills: "7500", attributionOnly: true }] })), intents: empty ? [] : [intent(uuid(1), "prepared"), intent(uuid(2), "indeterminate", pages[1]), intent(uuid(3), "succeeded")] };
    case "ofapiMarketingPrepare": {
      const command = ofapiMarketingActionSchema.parse(body.command);
      const targetPage = "pageId" in command ? pages.find(page => page.id === command.pageId) : undefined;
      const result = intent(String(body.id), "prepared", targetPage);
      const safeFields = new Set(["name", "link_type", "free_trial_days", "tags", "label", "platform", "pixel_id", "event_type", "http_method"]);
      return ofapiMarketingIntentSchema.parse({ ...result, action: command.action, preview: { ...result.preview, pageId: "pageId" in command ? command.pageId : null, pageLabel: targetPage?.label ?? null, accountId: targetPage ? `acct_synthetic_${targetPage.id}` : null,
        values: Object.entries(command).filter(([field]) => safeFields.has(field)).map(([field, value]) => ({ field, value })), targetId: "linkId" in command ? command.linkId : "postbackId" in command ? String(command.postbackId) : null, externalTest: command.action === "pixel_test", affectedLinksComplete: command.action !== "pixel_update", effect: "SYNTHETIC: проверка указанного действия; отправка отключена" } });
    }
    case "ofapiReadCollectionsGet": {
      const operation = query.get("operation") || "ofapi_read_user_list";
      return { pageId, catalog: [{ id: "synthetic-list", operation: "ofapi_read_user_list", path: "/user-lists/:id", category: "user_lists", detail: true, defaultCollect: false, granularity: "list", query: {} }], snapshots: empty ? [] : [{ id: `snapshot-${pageId}`, source: "onlyfansapi", operation, category: "user_lists", pathname: `/acct_synthetic_${pageId}/user-lists/synthetic`, query: { limit: "100" }, window: { from: null, to: null }, observedAt: now, ageSeconds: 60, observationId: "12001", granularity: "list", coverage: { state: "partial", reason: "continuation_unspecified", indexComplete: null, omitted: null, nextQuery: null }, items: Array.from({ length: 105 }, (_, index) => ({ nativeId: `synthetic-${pageId}-${index}`, listName: `SYNTHETIC список ${index}`, usersCount: index ? 0 : null, ...(index % 2 ? { previewUsers: [] } : {}), text: index === 104 ? "SYNTHETIC за пределами первых ста" : "SYNTHETIC сохранённые сведения" })) }] };
    }
    case "ofapiContentEventsGet": return { pageId, source: "onlyfansapi", coverage: "observed_events_only", queues: empty ? [] : [{ queueId: `queue-${pageId}`, phase: "updated", queueDate: null, state: { pending: null, total: 10, isCanceled: null, hasError: false }, observedAt: now, sourceEventId: "10", sourceObservationId: "11", timeBasis: "receipt" }], likes: empty ? [] : [{ postRef: `post-${pageId}`, fanRef: "synthetic-fan", state: "undone", sourceAt: at(-1), observedAt: now, sourceEventId: "12", sourceObservationId: "13", timeBasis: "provider" }], unattributedLikes: empty ? 0 : 2, queuesHasMore: !empty, likesHasMore: !empty };
    case "ofapiBannedWordsAdminGet": return empty ? null : { version: "synthetic-v1", observedAt: now, complete: false, pages: 1, entries: [{ word: "SYNTHETIC example", riskLevel: "review", category: "synthetic", alternatives: "SYNTHETIC alternative" }, { word: "SYNTHETIC second", riskLevel: "", category: null, alternatives: null }] };
    case "adminOfapiWebhookCollectionPolicy": return { version: mode === "changed" ? 8 : 7, desiredGroups: ["media_uploads"], appliedGroups: ["media_uploads"], historyEnabled: true, applyState: "applied", errorCode: null, appliedAt: at(-1), groups: ["subscription_expiry", "account_lifecycle", "media_uploads", "data_exports", "engagement"].map(id => ({ id, events: [`synthetic.${id}`] })) };
    case "adminOfapiWebhookEventCatalog": return { source: "onlyfansapi", state: empty ? "never" : "captured", observedAt: empty ? null : now, observationId: empty ? null : "13001", events: empty ? [] : [{ value: "synthetic.future_event", description: "SYNTHETIC новое событие без обработчика", requested: false, supported: false, optionalGroup: null }] };
    case "adminOfapiWebhookDeliveries": {
      const attempts = empty ? [] : Array.from({ length: 31 }, (_, index) => ({ attemptId: 100 + index, deliveryUuid: `synthetic-delivery-${index}`, eventType: `synthetic.event_${index}`, attemptNumber: 1, succeeded: index % 3 === 0, statusCode: index % 3 === 0 ? 200 : 500, errorType: index % 3 === 0 ? null : "server_error", redeliveredFrom: null, createdAt: at(-1), deliveryRecovered: false, localEventId: index % 2 ? null : 1000 + index, captureState: index % 2 ? null : "captured", localStatus: null, projectionStatus: index % 2 ? null : "pending", canonicalVersion: null, redeliveryState: index === 3 ? "indeterminate" : null, redeliveryUuid: null, redeliverySucceeded: null })).filter(row => query.get("failedOnly") !== "true" || !row.succeeded);
      const offset = Number(query.get("offset") ?? 0), limit = Number(query.get("limit") ?? 25);
      return { webhookId: "synthetic-webhook", latestScan: empty ? null : { id: uuid(50), webhookId: "synthetic-webhook", state: "pending", from: at(-2), to: at(-1), nextOffset: 100, capturedAttempts: 31, errorCode: "max_pages", coverageScope: "credential-visible", completedAt: null }, attempts: attempts.slice(offset, offset + limit) };
    }
    case "adminOfapiWebhookRedeliver": return { id: body.id ?? uuid(51), state: "preview", redeliveryUuid: null, errorCode: null, projected: false };
    case "ofapiKeyScopeGet": return { credentialFingerprint: "a".repeat(64), version: mode === "changed" ? 8 : 7, capabilities: null, accountIds: null, visibility: "unknown", observedTeam: "SYNTHETIC team", preflightStatus: "verified", updatedAt: now, source: "owner_declaration_not_vendor_introspection" };
    case "ofapiVendorUsageRefresh": return { snapshotId: 17, observedAt: now, credentialFingerprint: "a".repeat(64), visibility: "unknown", accountId: null, vendor: { from: body.from ?? at(-1).slice(0, 10), to: body.to ?? at(-1).slice(0, 10), groupBy: "day", includesToday: false, totals: { credits: 7, requests: 11 }, results: [{ day: body.from ?? at(-1).slice(0, 10), accountId: null, endpoint: null, creditType: "read", credits: 7, requests: 11 }] }, local: { recordedCredits: 4, estimatedCredits: 2, externalResidualCredits: 1 }, difference: 3, equivalentScope: false, explanation: "SYNTHETIC: историческая область ключа неизвестна; разница не доказывает потерю учёта." };
    default: return undefined;
  }
}
