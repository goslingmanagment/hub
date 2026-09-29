// One Fansly account lookup, journaled — the probe both DM lanes use to ask
// "does this partner id still resolve?" before they act on an exclusion.
//
// Extracted from executor-handlers.ts unchanged so the dm_conversations sweep
// (fansly-dm-conversations.ts) and the dm_messages chunk (executor-handlers.ts)
// keep sharing one implementation rather than one of them re-deriving it.

import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";

import type { AppContext } from "../../bootstrap.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

export type FanslyAccountResolution = "resolved" | "unresolved" | "unknown";

export async function probeFanslyAccountResolution(
  app: AppContext,
  requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0],
  partnerPlatformUserId: string,
  capture: { platformAccountId: number; syncRunId: number },
  options: {
    /** Fetch failures the caller must act on itself (auth, a rate limit, a
     * provider deadline): rethrown instead of an "unknown" verdict. */
    rethrow?: (error: unknown) => boolean;
  } = {},
): Promise<FanslyAccountResolution> {
  let response: Awaited<ReturnType<AppContext["adapter"]["getAccountsByIdsPage"]>>;
  try {
    response = await app.adapter.getAccountsByIdsPage(requestContext, [partnerPlatformUserId]);
  } catch (error) {
    if (options.rethrow?.(error) === true) {
      throw error;
    }
    // Only the probe fetch itself is best-effort ("unknown" verdict); the
    // journal write below stays outside this catch so a failed capture still
    // fails the chunk (Stage 7: never a silent drop).
    return "unknown";
  }

  await persistRawPayload(app.db, {
    platformAccountId: capture.platformAccountId,
    syncRunId: capture.syncRunId,
    endpoint: "account_lookup",
    requestParams: { ids: [partnerPlatformUserId], probe: true },
    responsePayload: response.raw,
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
  }, {
    action: "inserting account_lookup probe raw payload",
    platform: "fansly",
  });

  if (!Array.isArray(response?.parsed)) {
    return "unknown";
  }
  if (response.parsed.length === 0) {
    return "unresolved";
  }
  return response.parsed.some((account) => account.id === partnerPlatformUserId)
    ? "resolved"
    : "unknown";
}
