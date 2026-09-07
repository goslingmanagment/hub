import { describe, expect, it } from "vitest";

import {
  classifyOfapiCommandFailure,
  ofapiMediaCustodyReleaseReason,
  OfapiLocalDispatchRefusal,
} from "../apps/runtime/src/services/ofapi-command-executor.ts";
import { OfapiApiError } from "../apps/runtime/src/services/ofapi.ts";

describe("one-use media custody release verdicts (review #138 fix 1)", () => {
  const terminal = (httpStatus: number | null) => ({ state: "failed_terminal" as const, errorClass: "terminal" as const, errorCode: "x", httpStatus });
  it.each([400, 401, 403, 404, 409, 422])("releases after a definite vendor %s", (status) => {
    expect(ofapiMediaCustodyReleaseReason(null, classifyOfapiCommandFailure(new OfapiApiError("rejected", status, null)))).toBe(`vendor_rejected_${status}`);
  });
  it.each([408, 429, 500, 502, 503, 200])("keeps custody after HTTP %s", (status) => {
    expect(ofapiMediaCustodyReleaseReason(null, classifyOfapiCommandFailure(new OfapiApiError("unclear", status, null)))).toBeNull();
  });
  it("keeps custody after a transport failure and after a wrapper 4xx carrying an upstream 5xx", () => {
    expect(ofapiMediaCustodyReleaseReason(null, classifyOfapiCommandFailure(new Error("timeout")))).toBeNull();
    expect(ofapiMediaCustodyReleaseReason(null, classifyOfapiCommandFailure(new OfapiApiError("wrapped", 400, null, 503)))).toBeNull();
    expect(ofapiMediaCustodyReleaseReason(null, terminal(null))).toBeNull();
  });
  it("releases after a local refusal that happened before any HTTP, except reservation refusals that rolled back", () => {
    expect(ofapiMediaCustodyReleaseReason(new OfapiLocalDispatchRefusal("credit_accounting_unavailable"), terminal(null))).toBe("local_refusal_credit_accounting_unavailable");
    expect(ofapiMediaCustodyReleaseReason(new OfapiLocalDispatchRefusal("credential_not_verified"), terminal(null))).toBe("local_refusal_credential_not_verified");
    expect(ofapiMediaCustodyReleaseReason(new OfapiLocalDispatchRefusal("media_token_already_used"), terminal(null))).toBeNull();
    expect(ofapiMediaCustodyReleaseReason(new OfapiLocalDispatchRefusal("provider_replay_unavailable"), terminal(null))).toBeNull();
  });
});
