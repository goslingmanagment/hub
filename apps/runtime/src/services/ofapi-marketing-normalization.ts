import { ofapiMarketingResourceSchema, ofapiMarketingMetricSchema, type OfapiMarketingMetric, type OfapiMarketingResource } from "@agency_hub_core/contracts";
import { ofapiDollarValueToMillsString } from "./ofapi-message-material.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";

const text = (v: unknown) => typeof v === "string" ? v : null;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export function marketingDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.origin : null; }
  catch { return null; }
}
export function marketingTemplateVariables(...values: unknown[]): string[] {
  return [...new Set(values.flatMap(value => typeof value === "string" ? [...value.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map(m => m[1]!) : []))].sort();
}
export function normalizeOfapiMarketingResource(input: {
  kind: OfapiMarketingResource["kind"]; pageId: number | null; parentId?: string | null;
  row: Record<string, unknown>; observedAt: Date;
}): OfapiMarketingResource {
  const { row, kind } = input;
  const id = idToString(row.id); if (!id) throw new Error("Marketing resource identity unavailable");
  const headers = Array.isArray(row.headers) ? row.headers.map(asRecord).filter(Boolean) : [];
  const eventNames = Object.fromEntries(Object.entries(row).filter(([key, value]) => /^event_(click|new_subscriber|first_transaction|new_transaction|message_received_from_fan|fan_sent_[13]_messages?)$/.test(key) && (typeof value === "string" || value === null)));
  const cost = asRecord(row.cost);
  const revenue = asRecord(row.revenue);
  return ofapiMarketingResourceSchema.parse({
    pageId: input.pageId, nativeAccountRef: text(asRecord(row.account)?.id), kind, id, shared: asRecord(row.owner) !== null, parentId: input.parentId ?? null,
    name: text(row.name) ?? text(row.label) ?? text(row.campaignName) ?? text(row.trialLinkName),
    observedAt: input.observedAt.toISOString(), linkType: text(row.link_type), platform: text(row.platform),
    publicUrl: ["smart_link", "tracking", "trial"].includes(kind) && marketingDestination(row.traffic_redirect_url ?? row.campaignUrl ?? row.url) ? text(row.traffic_redirect_url ?? row.campaignUrl ?? row.url) : null,
    platformPixelId: text(row.pixel_id), httpMethod: row.http_method === "GET" || row.http_method === "POST" ? row.http_method : null, status: text(row.status),
    destination: marketingDestination(row.url ?? row.event_source_url ?? row.traffic_redirect_url ?? row.campaignUrl),
    clicks: count(row.clicks_count ?? row.clicksCount ?? row.clicksCounts),
    conversions: count(row.conversions_count), subscribers: count(row.subscribers_count ?? row.subscribersCount ?? row.subscribeCounts),
    spenders: count(row.spenders_count ?? revenue?.spendersCount),
    revenueMills: ofapiDollarValueToMillsString(revenue ? revenue.isLoading === true ? null : revenue.total : row.revenue),
    revenueBasis: "unspecified",
    cost: cost ? { inputMode: text(cost.inputMode), inputValue: typeof cost.inputValue === "number" || typeof cost.inputValue === "string" ? String(cost.inputValue) : null,
      currency: text(cost.currency), unit: "provider_input", source: "provider_campaign_configuration" } : null,
    tags: strings(row.tags), eventNames, conversionTypes: strings(row.conversion_types), scope: text(row.smart_link_scope),
    linkIds: strings(row.smart_link_ids), templateVariables: marketingTemplateVariables(row.url, row.body, ...headers.map(h => h?.value)),
    headerNames: headers.flatMap(h => typeof h?.name === "string" ? [h.name] : []), hasBodyTemplate: typeof row.body === "string" && row.body.length > 0,
  });
}

/** Attribution facts remain separate from Hub's financial ledger. These DTOs
 * omit IPs, user agents, query strings, postback bodies and ad access tokens. */
export function normalizeOfapiMarketingAnalytics(operation: string, body: unknown): OfapiMarketingMetric[] {
  const root = asRecord(body), data = root?.data, row = asRecord(data);
  if (operation.endsWith("_stats")) {
    if (!row || !asRecord(row.summary)) throw new Error("Marketing stats contract rejected");
    const normalize = (item: unknown, period: "summary" | "daily" | "monthly") => {
      const r = asRecord(item); if (!r) throw new Error("Marketing metric contract rejected");
      return ofapiMarketingMetricSchema.parse({ period, timestamp: text(r.timestamp), clicks: count(r.clicks ?? r.clicks_total), subscribers: count(r.subs ?? r.subs_total),
        spenders: count(r.spenders ?? r.spenders_total), revenueMills: ofapiDollarValueToMillsString(r.revenue ?? r.revenue_total), revenueBasis: "unspecified", attributionOnly: true });
    };
    return [normalize(row.summary, "summary"), ...(Array.isArray(row.daily_metrics) ? row.daily_metrics.map(v => normalize(v, "daily")) : []), ...(Array.isArray(row.monthly_metrics) ? row.monthly_metrics.map(v => normalize(v, "monthly")) : [])];
  }
  // The public cohort documentation supplies no success schema. Preserve bounded
  // numeric paths without inventing windows, units, identities or money basis.
  if (operation.endsWith("_cohort_arps")) {
    if (!row) throw new Error("Cohort metric contract rejected");
    const walk = (value: unknown, path: string, depth: number): OfapiMarketingMetric[] => {
      if (depth > 8) return [];
      if ((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)))
        return [{ period: "cohort", metricPath: path, providerValue: String(value), revenueBasis: "unspecified", attributionOnly: true }];
      if (Array.isArray(value)) return value.slice(0,1000).flatMap((v,i) => walk(v, `${path}[${i}]`, depth+1));
      const r = asRecord(value); return r ? Object.entries(r).filter(([k]) => /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(k) && !/token|secret|headers|password/i.test(k)).flatMap(([k,v]) => walk(v, path ? `${path}.${k}` : k, depth+1)).slice(0,10000) : [];
    };
    return walk(row, "", 0);
  }
  const items = Array.isArray(data) ? data : Array.isArray(row?.rows) ? row.rows : Array.isArray(row?.list) ? row.list : null;
  if (!items) throw new Error("Marketing analytics contract rejected");
  return items.map(item => {
    const r = asRecord(item); if (!r) throw new Error("Marketing analytics row rejected");
    const user = asRecord(r.fan) ?? asRecord(r.user), click = asRecord(r.click) ?? r, insights = asRecord(r.subscription_insights), revenue = asRecord(r.revenue);
    const fanId = idToString(r.onlyfans_id ?? r.fan_onlyfans_id ?? user?.onlyfans_id ?? user?.id ?? (operation.endsWith("_subscribers") ? r.id : null));
    return ofapiMarketingMetricSchema.parse({ nativeId: idToString(r.id ?? r.conversion_id ?? r.click_id ?? fanId), period: "row",
      occurredAt: text(r.conversion_at ?? r.converted_at ?? r.created_at ?? r.timestamp ?? r.date), fanId,
      username: text(r.username ?? user?.username), conversionType: text(r.conversion_type), country: text(click.country_code),
      isBot: typeof click.is_bot === "boolean" ? click.is_bot : null, isDuplicate: typeof click.is_duplicate === "boolean" ? click.is_duplicate : null,
      organic: typeof click.is_organic === "boolean" ? click.is_organic : null,
      previouslySubscribed: typeof insights?.previously_subscribed === "boolean" ? insights.previously_subscribed : null,
      subscribedUsingPromo: typeof insights?.subscribed_using_promo === "boolean" ? insights.subscribed_using_promo : null,
      currentSubscriptionFromSmartLink: typeof insights?.current_subscription_from_smart_link === "boolean" ? insights.current_subscription_from_smart_link : null,
      amountGrossMills: ofapiDollarValueToMillsString(r.amount_gross), amountNetMills: ofapiDollarValueToMillsString(r.amount_net),
      revenueMills: ofapiDollarValueToMillsString(r.revenue_net ?? revenue?.total), revenueBasis: r.revenue_net !== undefined ? "net" : "unspecified",
      tipsNetMills: ofapiDollarValueToMillsString(r.tips_net), messagesSentByFan: count(r.messages_sent_by_fan), attributionOnly: true,
    });
  });
}
