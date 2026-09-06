import { sql } from "drizzle-orm";
import { getOfapiWebhookConfig, insertAuditEvent } from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { OFAPI_WEBHOOK_CANONICALIZED_KINDS } from "./canonicalize/ofapi-webhook.ts";
import { OFAPI_OPTIONAL_WEBHOOK_GROUPS } from "./ofapi-lifecycle-contract.ts";
import { resolveOfapiClient } from "./ofapi-webhooks.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { asRecord } from "./ofapi-payloads.ts";
export function parseOfapiWebhookEventCatalog(body: unknown) {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data) || data.length > 1000)
    throw new Error("OFAPI event catalog omitted bounded data array");
  const seen = new Set<string>();
  return data.map((value) => {
    const row = asRecord(value);
    if (
      typeof row?.value !== "string" ||
      !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(row.value) ||
      row.value.length > 100 ||
      typeof row.description !== "string" ||
      row.description.length > 2000 ||
      seen.has(row.value)
    )
      throw new Error("OFAPI event catalog has invalid or duplicate identity");
    seen.add(row.value);
    return { value: row.value, description: row.description };
  });
}
/** Control-plane catalog is projected from the latest retained response on read. */
export async function readOfapiWebhookEventCatalog(
  app: Pick<AppContext, "db">,
) {
  const result = await app.db.execute<{
    id: string;
    received_at: Date;
    payload: unknown;
  }>(
    sql`select id,received_at,payload from observations where source='operator' and kind='ofapi_webhook_event_catalog' order by received_at desc,id desc limit 1`,
  );
  const row = result.rows[0];
  if (!row)
    return {
      source: "onlyfansapi" as const,
      state: "never" as const,
      observedAt: null,
      observationId: null,
      events: [],
    };
  const base = {
    source: "onlyfansapi" as const,
    observedAt: new Date(row.received_at).toISOString(),
    observationId: String(row.id),
  };
  let data;
  try {
    const payload = asRecord(row.payload);
    if (payload?.status !== 200 || typeof payload.body !== "string")
      throw new Error("invalid response");
    data = parseOfapiWebhookEventCatalog(JSON.parse(payload.body));
  } catch {
    return { ...base, state: "invalid" as const, events: [] };
  }
  const config = await getOfapiWebhookConfig(app.db),
    requested = new Set(config?.events ?? []);
  return {
    ...base,
    state: "captured" as const,
    events: data.map((event) => ({
      ...event,
      requested: requested.has(event.value),
      supported:
        OFAPI_WEBHOOK_CANONICALIZED_KINDS.has(event.value) ||
        event.value === "users.typing",
      optionalGroup:
        Object.entries(OFAPI_OPTIONAL_WEBHOOK_GROUPS).find(([, events]) =>
          (events as readonly string[]).includes(event.value),
        )?.[0] ?? null,
    })),
  };
}
export async function refreshOfapiWebhookEventCatalog(
  app: AppContext,
  actorUserId: number,
) {
  const client = resolveOfapiClient(app);
  if (!client.listWebhookEvents)
    throw new ServiceUnavailableError(
      "OFAPI event catalog access is unavailable",
    );
  const result = await client.listWebhookEvents();
  if (!result.capture)
    throw new ServiceUnavailableError(
      "Event catalog response was not captured",
    );
  await insertAuditEvent(app.db, {
    actorUserId,
    source: "api",
    eventType: "admin.ofapi_webhook_event_catalog_refreshed",
    metadata: {
      observationId: result.capture.observationId,
      estimatedCredits: 0,
    },
  });
  return readOfapiWebhookEventCatalog(app);
}
