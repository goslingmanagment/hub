import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@agency_hub_core/db";

import {
  classifyOfapiCommandFailure,
  localDispatchRefusalFrom,
  OfapiLocalDispatchRefusal,
} from "../apps/runtime/src/services/ofapi-command-executor.ts";
import {
  createOfapiClient,
  OfapiApiError,
  OfapiCreditAccountingUnavailableError,
} from "../apps/runtime/src/services/ofapi.ts";
import { assertOfapiConfiguredAccess, OfapiKeyScopeUnavailableError } from "../apps/runtime/src/services/ofapi-vendor-usage.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";
const CONVERSATION = "123456789";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("key-scope lookup failure before dispatch (review #138 fix 3)", () => {
  it("types a throwing declaration lookup as a pre-dispatch refusal, not a raw error", async () => {
    const cause = new Error("connection terminated unexpectedly");
    const db = { execute: vi.fn().mockRejectedValue(cause) } as unknown as Database;
    const error = await assertOfapiConfiguredAccess(db, "fp", { operation: "ofapi_command_send_text", method: "POST", accountId: ACCOUNT }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OfapiKeyScopeUnavailableError);
    expect((error as OfapiKeyScopeUnavailableError).cause).toBe(cause);
    expect((error as OfapiKeyScopeUnavailableError).statusCode).toBe(503);
  });

  it("classifies the typed refusal as local and retryable with zero fetch calls, never indeterminate", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const db = { execute: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as Database;
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api", apiKey: "test-key", restDelayMs: 0,
      beforeOperationRequest: (request) => assertOfapiConfiguredAccess(db, "fp", request),
    });
    const error = await client.sendTextMessage!({ pageId: 42 }, ACCOUNT, CONVERSATION, { text: "secret command text" }).catch((caught: unknown) => caught);
    expect(fetchMock).not.toHaveBeenCalled();
    const refusal = localDispatchRefusalFrom(error);
    expect(refusal).toBeInstanceOf(OfapiLocalDispatchRefusal);
    expect(refusal).toMatchObject({ reason: "key_scope_unavailable", detail: "key_declaration_lookup_failed" });
    expect(classifyOfapiCommandFailure(refusal)).toEqual({
      state: "failed_retryable", errorCode: "ofapi_key_scope_unavailable", errorClass: "retryable", httpStatus: null,
    });
    // The raw error would have been parked as an unknown vendor outcome — the exact bug.
    expect(classifyOfapiCommandFailure(error)).toMatchObject({ state: "indeterminate", errorCode: "ofapi_transport_unknown" });
  });

  it("keeps every other local refusal terminal and a policy denial distinct from a lookup failure", () => {
    expect(classifyOfapiCommandFailure(new OfapiLocalDispatchRefusal("key_scope_denied"))).toEqual({
      state: "failed_terminal", errorCode: "ofapi_key_scope_denied", errorClass: "terminal", httpStatus: null,
    });
    expect(localDispatchRefusalFrom(new OfapiCreditAccountingUnavailableError())).toMatchObject({ reason: "credit_accounting_unavailable" });
    expect(localDispatchRefusalFrom(new OfapiApiError("rejected", 422, null))).toBeNull();
    expect(localDispatchRefusalFrom(new Error("socket closed"))).toBeNull();
  });
});
