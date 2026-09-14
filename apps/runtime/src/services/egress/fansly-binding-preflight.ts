import { fetch } from "undici";
import { buildFanslyRequestHeaders } from "@agency_hub_core/fansly";
import type { FanslySessionBundle } from "@agency_hub_core/shared";
import type { AppEgressContext } from "./resolver.ts";

const ENDPOINT = "https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true";
export const BINDING_BODY_LIMIT = 1024 * 1024;
const REQUEST_DEADLINE_MS = 15_000;
export type BindingReason = "matched" | "missing_expected_account" | "invalid_page_egress"
  | "http_rejected" | "invalid_response" | "account_mismatch" | "body_limit" | "request_failed";
export type BindingInspection = {
  identityMatched: boolean; observedAccountId: string | null; httpStatus: number | null;
  restRequests: 0 | 1; reason: BindingReason;
};

export function isNativeAccountId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,31}$/.test(value);
}

function accountId(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("success" in body) || body.success !== true
    || !("response" in body) || !body.response || typeof body.response !== "object"
    || !("account" in body.response) || !body.response.account || typeof body.response.account !== "object"
    || !("id" in body.response.account) || !isNativeAccountId(body.response.account.id)) return null;
  return body.response.account.id;
}

/** One physical REST attempt through the exact dispatcher from the snapshot.
 * No retry, redirect, pacing, observer, provider-body export or database writer. */
export async function inspectFanslyBinding(input: {
  session: FanslySessionBundle; expectedAccountId: string | null;
  egress: AppEgressContext; signal?: AbortSignal;
}): Promise<BindingInspection> {
  const result: BindingInspection = {
    identityMatched: false, observedAccountId: null, httpStatus: null,
    restRequests: 0, reason: "missing_expected_account",
  };
  if (!isNativeAccountId(input.expectedAccountId)) return result;
  const { dispatcher, egressKey } = input.egress;
  if (!dispatcher || !egressKey || egressKey === "direct" || /^(vendor|service|legacy-page):/.test(egressKey)) {
    return { ...result, reason: "invalid_page_egress" };
  }
  const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  try {
    const headers = buildFanslyRequestHeaders(input.session, "/account/me");
    signal.throwIfAborted();
    result.restRequests = 1;
    const response = await fetch(ENDPOINT, {
      method: "GET", dispatcher, redirect: "manual", signal,
      headers,
    });
    result.httpStatus = response.status;
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ...result, reason: "http_rejected" };
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BINDING_BODY_LIMIT)) {
      await response.body?.cancel();
      return { ...result, reason: "body_limit" };
    }
    if (!response.body) return { ...result, reason: "invalid_response" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > BINDING_BODY_LIMIT) {
          await reader.cancel();
          return { ...result, reason: "body_limit" };
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
    catch { return { ...result, reason: "invalid_response" }; }
    result.observedAccountId = accountId(parsed);
    if (result.observedAccountId === null) return { ...result, reason: "invalid_response" };
    result.identityMatched = result.observedAccountId === input.expectedAccountId;
    return { ...result, reason: result.identityMatched ? "matched" : "account_mismatch" };
  } catch {
    // A provider/proxy/parser error may contain credentials or response bytes.
    return { ...result, reason: "request_failed" };
  }
}
