// One Fansly account lookup, journaled — the probe both DM lanes use to ask
// "does this partner id still resolve?" before they act on an exclusion.
//
// Extracted from executor-handlers.ts unchanged so the dm_conversations sweep
// (fansly-dm-conversations.ts) and the dm_messages chunk (executor-handlers.ts)
// keep sharing one implementation rather than one of them re-deriving it.
//
// Owner decision 2026-09-30: the same partner is asked about at most once a
// day per page (FANSLY_ACCOUNT_LOOKUP_REUSE_MS); within the day the last
// answer stands, so the sweep stopped re-probing an unresolvable partner on
// every pass (~96 lookups a day in prod). The answer lives on the partner's
// page link; a partner not linked to the page is asked every time, as before.
// The probe stores no profile, so fan hydration keeps its own stamp.

import { readFanslyAccountProbe, recordFanslyAccountProbe } from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";

import type { AppContext } from "../../bootstrap.ts";
import { FANSLY_ACCOUNT_LOOKUP_REUSE_MS } from "./fan-hydration.ts";
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
  const partner = { platformAccountId: capture.platformAccountId, platformUserId: partnerPlatformUserId };
  const previous = await readFanslyAccountProbe(app.db, partner);
  if (previous && Date.now() - previous.probedAt.getTime() < FANSLY_ACCOUNT_LOOKUP_REUSE_MS) {
    return previous.resolved ? "resolved" : "unresolved";
  }

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
  const resolution: FanslyAccountResolution = response.parsed.length === 0
    ? "unresolved"
    : response.parsed.some((account) => account.id === partnerPlatformUserId)
    ? "resolved"
    : "unknown";
  // Only a definite answer holds for the day; "unknown" asks again next time.
  if (resolution !== "unknown") {
    await recordFanslyAccountProbe(app.db, {
      ...partner,
      probedAt: new Date(),
      resolved: resolution === "resolved",
    });
  }
  return resolution;
}
