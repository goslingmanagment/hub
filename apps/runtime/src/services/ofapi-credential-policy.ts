import { createHash, randomUUID } from "node:crypto";
import { checkOfapiCurrentBinding, markOfapiBindingUnavailable, insertObservation, recordOfapiCredentialPreflight, type Database } from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { notifyOfapiAuthIncident } from "./notification-incidents.ts";
import { OfapiApiError, ofapiAccountNotFound } from "./ofapi.ts";

/** Both boot and the registration fallback use this policy. No key material is
 * put in observations, diagnostics or the preflight result. */
export function ofapiCredentialPolicy(db: Database, config: AppContext["config"], logger: AppContext["logger"]) {
  return {
    beforeAccountRequest: async (pageId: number | null | undefined, accountId: string, generation?: number) => {
      try { return await checkOfapiCurrentBinding(db, pageId, accountId, generation); }
      catch { throw new OfapiApiError("OFAPI current account binding unavailable", 409, null); }
    },
    onAccountResponse: async (accountId: string, generation: number, status: number, body: string) => {
      if (status !== 404) return;
      await insertObservation(db, {
        source: "pull", producer: "ofapi:account-error", platform: "onlyfans", nativeAccountRef: accountId,
        kind: "ofapi.account.response", payload: { status, body, bodyEncoding: "utf8", generation },
        payloadHash: createHash("sha256").update(body).digest(), idempotencyKey: randomUUID(),
      });
      if (!ofapiAccountNotFound(status, body)) return;
      const page = await markOfapiBindingUnavailable(db, accountId, generation);
      if (page) await notifyOfapiAuthIncident({ db, config, logger }, {
        platformAccountId: page.id, pageLabel: page.label, platform: "onlyfans", authStatus: "account_not_found",
      });
    },
    credentialPolicy: { expectedTeamSlug: config.ofapiExpectedTeamSlug ?? null },
    onPreflight: (value: Parameters<typeof recordOfapiCredentialPreflight>[1]) => recordOfapiCredentialPreflight(db, value),
    onAdminResponse: async (value: { operation: string; status: number; body: string }) => {
      // Response bytes only, never Authorization or the webhook signing request.
      await insertObservation(db, {
        source: "operator", producer: "ofapi:admin", platform: "onlyfans", kind: value.operation,
        payload: { status: value.status, body: value.body, bodyEncoding: "utf8" },
        payloadHash: createHash("sha256").update(value.body).digest(), idempotencyKey: randomUUID(),
      });
    },
  };
}
