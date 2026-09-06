import { createHash, randomUUID } from "node:crypto";
import { checkOfapiCurrentBinding, markOfapiBindingUnavailable, insertObservation, recordOfapiCredentialPreflight, type Database } from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { notifyOfapiAuthIncident } from "./notification-incidents.ts";
import { OfapiApiError, ofapiAccountNotFound } from "./ofapi.ts";

import { asRecord } from "./ofapi-payloads.ts";

export const OFAPI_ADMIN_ACCOUNTS_REDACTION_RULE = "ofapi_admin_accounts_v2";
// Exactly the keys toAccountRecords (ofapi.ts:456-500) reads, with the scalar type each may carry.
// Everything else — onlyfans_email, _meta, the session material inside onlyfans_user_data — never
// reaches the journal. Objects/arrays under an allowed key are dropped too: the allowlist is on VALUES.
const ROSTER_STRING_KEYS = new Set([
  "id", "onlyfans_username", "onlyfansUsername", "username", "display_name", "displayName", "name",
  "authentication_progress", "avatar", "avatar_url", "avatarUrl", "created_at", "updated_at",
]);
// Identity ids are kept AS RECEIVED (number or string): an unsafe integer or a non-numeric string must
// still read as identityStatus="conflict" after projection, never be normalized into a valid-looking id.
const ROSTER_ID_KEYS = new Set(["onlyfans_id", "onlyfans_user_id", "onlyfansUserId"]);
const ROSTER_BOOLEAN_KEYS = new Set(["is_authenticated"]);
const ROSTER_USER_DATA_KEYS = new Set(["onlyfans_user_data", "onlyfansUserData"]);
const MACHINE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function isIdScalar(value: unknown): value is string | number { return typeof value === "number" || typeof value === "string"; }

/** Preserve invalid numeric identity through JSON serialization, including Infinity. */
function projectId(value: string | number): string | number {
  return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
}

function describeBodyShape(parsed: unknown, body: string): "json_object" | "json_array" | "text" | "empty" {
  if (body.length === 0) return "empty";
  if (Array.isArray(parsed)) return "json_array";
  return asRecord(parsed) ? "json_object" : "text";
}

export function projectOfapiAccountsRoster(input: { status: number; body: string }): { body: string; redaction: Record<string, unknown> } {
  const base = {
    rule: OFAPI_ADMIN_ACCOUNTS_REDACTION_RULE,
    originalBytes: Buffer.byteLength(input.body, "utf8"),
    originalSha256: createHash("sha256").update(input.body).digest("hex"),
  };
  let parsed: unknown = null;
  let isJson = false;
  try { parsed = JSON.parse(input.body); isJson = true; } catch { /* non-JSON */ }
  if (input.status !== 200) {
    // A refused roster read is an audit fact about ACCESS, not about accounts: keep the status, the shape
    // and a bounded machine code; never the bytes (an edge/HTML or error body is not proven secret-free).
    const record = asRecord(parsed);
    const error = asRecord(record?.error);
    const codeCandidate = error?.code ?? record?.code ?? record?.error;
    const errorCode = typeof codeCandidate === "string" && MACHINE_CODE.test(codeCandidate) ? codeCandidate : null;
    return { body: "", redaction: { ...base, withheld: "non_200_status", bodyShape: describeBodyShape(parsed, input.body), errorCode } };
  }
  if (!isJson) return { body: "", redaction: { ...base, withheld: "non_json_body" } };
  const wrapper = asRecord(parsed);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(wrapper?.data) ? wrapper!.data as unknown[] : null;
  if (!list) return { body: "", redaction: { ...base, withheld: "unrecognized_roster_shape" } };
  let dropped = 0;
  const projected = list.map(item => {
    const record = asRecord(item);
    if (!record) { dropped += 1; return null; }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (ROSTER_STRING_KEYS.has(key) && typeof value === "string") out[key] = value;
      else if (ROSTER_ID_KEYS.has(key) && isIdScalar(value)) out[key] = projectId(value);
      else if (ROSTER_BOOLEAN_KEYS.has(key) && typeof value === "boolean") out[key] = value;
      else if (ROSTER_USER_DATA_KEYS.has(key)) {
        // Only the creator id survives from the nested object; the object itself (ip, csrf, wsAuthToken,
        // wsUrl, …) never does.
        // Identity semantics of toAccountRecords (ofapi.ts:470) must survive the projection: it picks the
        // snake object BEFORE the camel object, so a present-but-useless nested object stays as `{}` —
        // dropping it would let the parser fall through to the other alias and turn missing/conflict into
        // a valid id (reproduced by the revision audit).
        const nested = asRecord(value);
        if (nested) out[key] = isIdScalar(nested.id) ? { id: projectId(nested.id) } : {};
        dropped += nested ? Math.max(0, Object.keys(nested).length - (isIdScalar(nested.id) ? 1 : 0)) : 1;
      } else dropped += 1;
    }
    return out;
  });
  const wrapped = Array.isArray(parsed) ? projected : { data: projected }; // _meta deliberately absent
  return { body: JSON.stringify(wrapped), redaction: { ...base, droppedKeys: dropped } };
}

/** Shared by boot and registration; excludes session material from roster evidence. */
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
      const marked = await markOfapiBindingUnavailable(db, accountId, generation);
      if (marked) await notifyOfapiAuthIncident({ db, config, logger }, {
        platformAccountId: marked.page.id, pageLabel: marked.page.label, platform: "onlyfans",
        authStatus: "account_not_found", occurredAt: marked.markedAt,
      });
    },
    credentialPolicy: { expectedTeamSlug: config.ofapiExpectedTeamSlug ?? null },
    onPreflight: (value: Parameters<typeof recordOfapiCredentialPreflight>[1]) => recordOfapiCredentialPreflight(db, value),
    onAdminResponse: async (value: { operation: string; status: number; body: string }) => {
      // Control-plane roster evidence excludes session material before journaling (decision #253).
      const stored = value.operation === "ofapi_admin_accounts"
        ? projectOfapiAccountsRoster(value)
        : { body: value.body, redaction: null };
      await insertObservation(db, {
        source: "operator", producer: "ofapi:admin", platform: "onlyfans", kind: value.operation,
        payload: { status: value.status, body: stored.body, bodyEncoding: "utf8",
          ...(stored.redaction ? { redaction: stored.redaction } : {}),
        },
        payloadHash: createHash("sha256").update(stored.body).digest(), idempotencyKey: randomUUID(),
      });
    },
  };
}
