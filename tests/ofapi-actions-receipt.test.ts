import { describe, expect, it } from "vitest";
import { ofapiActionSchema, type OfapiAction } from "../packages/contracts/src/ofapi-actions.ts";
import { negativeReceipt } from "../apps/runtime/src/services/ofapi-payloads.ts";
import { ofapiAccountResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-account.ts";
import { ofapiCollectionResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-collections.ts";
import { ofapiPublishingResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-publishing.ts";
import { ofapiActionRequest, ofapiActionResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-registry.ts";
import { classifyOfapiActionResult } from "../apps/runtime/src/services/ofapi-actions.ts";

// One acknowledgement-shaped action per module: each confirms on `data.success === true`,
// so any disagreement between them is the receipt rule, not the operation.
const parse = (value: Record<string, unknown>): OfapiAction => ofapiActionSchema.parse({ pageId: 7, ...value });
const publishing = parse({ action: "post_delete", postId: "7" });
const account = parse({ action: "account_drm_update", enabled: false });
const collection = parse({ action: "user_list_delete", listId: "555" });
const acks = { publishing, account, collection };
const classify = (command: OfapiAction, status: number, body: unknown) => classifyOfapiActionResult(command, ofapiActionRequest(command, "acct_bound"), status, body);

describe("the one negative-receipt rule", () => {
  it("reads every documented vendor 'no' shape", () => {
    // 422 validation envelope: `errors` is a Laravel-style object keyed by field, not an array.
    expect(negativeReceipt({ error: "VALIDATION_ERROR", message: "The text field is required.", errors: { text: ["The text field is required."] }, _meta: {} })).toBe(true);
    expect(negativeReceipt({ errors: { name: ["Name already in use"] } })).toBe(true);
    expect(negativeReceipt({ errors: ["denied"] })).toBe(true);
    // ONLYFANS_COM_ERROR envelope and the nested OnlyFans body object.
    expect(negativeReceipt({ error: "ONLYFANS_COM_ERROR", message: "Bad Request", onlyfans_response: { status: 400 } })).toBe(true);
    expect(negativeReceipt({ error: { code: 0, message: "Not enough funds to request a payout" } })).toBe(true);
    // Upload status row and the vendor's boolean on media / mass-messaging items.
    expect(negativeReceipt({ status: "failed", prefixed_id: "ofapi_media_01JR1234", error: "Failed to download file from the provided URL." })).toBe(true);
    expect(negativeReceipt({ hasError: true })).toBe(true);
    expect(negativeReceipt({ success: true, hasError: true })).toBe(true);
    expect(negativeReceipt({ success: false })).toBe(true);
  });

  it("treats the vendor's 'no error' spellings as absent and ignores nested records", () => {
    for (const empty of [undefined, null, false, "", 0, []]) {
      expect(negativeReceipt({ error: empty, errors: empty, hasError: false, success: true })).toBe(false);
    }
    // The banking read carries `DAC7: { error: null }` — nested records are the caller's business.
    expect(negativeReceipt({ DAC7: { required: true, state: "success", error: null } })).toBe(false);
    expect(negativeReceipt({ data: { error: "nested" } })).toBe(false);
    for (const shape of [null, undefined, "", "error", 0, [], [{ error: "x" }]]) expect(negativeReceipt(shape)).toBe(false);
  });

  it("lets only an explicit caller read a false success as a domain answer, never over a provider error", () => {
    expect(negativeReceipt({ success: false }, { allowFalseSuccess: true })).toBe(false);
    expect(negativeReceipt({ success: false, error: "denied" }, { allowFalseSuccess: true })).toBe(true);
    expect(negativeReceipt({ success: false, hasError: true }, { allowFalseSuccess: true })).toBe(true);
    expect(negativeReceipt({ success: false, errors: { username: ["taken"] } }, { allowFalseSuccess: true })).toBe(true);
  });
});

describe("the three action modules and the core classifier agree on receipts", () => {
  const verdicts: [unknown, boolean][] = [
    [{ data: { success: true } }, true],
    [{ data: { success: true, error: null, errors: [], hasError: false } }, true],
    // The shape that split the modules: publishing/account rejected it, collections confirmed a deletion.
    [{ data: { success: true, hasError: true } }, false],
    [{ data: { success: true, errors: { name: ["Name already in use"] } } }, false],
    [{ data: { success: true, error: { code: 0, message: "Rejected" } } }, false],
    [{ data: { success: true, error: "Rejected" } }, false],
    [{ data: { success: false } }, false],
    // Envelope-level markers next to a clean data record.
    [{ data: { success: true }, error: "VALIDATION_ERROR", errors: { text: ["The text field is required."] } }, false],
    [{ data: { success: true }, hasError: true }, false],
    [{ data: { success: true }, success: false }, false],
    [{ data: { success: true }, errors: ["denied"] }, false],
  ];

  it.each(verdicts)("%j → confirmed=%s for every module through the registry", (body, expected) => {
    for (const [name, command] of Object.entries(acks)) {
      expect(ofapiActionResultConfirmed(command, 200, body), name).toBe(expected);
    }
  });

  it("applies the same data-level rule inside each module directly", () => {
    const data = { success: true, hasError: true };
    expect(ofapiPublishingResultConfirmed(publishing as Parameters<typeof ofapiPublishingResultConfirmed>[0], 200, { data })).toBe(false);
    expect(ofapiAccountResultConfirmed(account as Parameters<typeof ofapiAccountResultConfirmed>[0], 200, { data })).toBe(false);
    expect(ofapiCollectionResultConfirmed(collection as Parameters<typeof ofapiCollectionResultConfirmed>[0], data)).toBe(false);
    const clean = { success: true, error: "", errors: null };
    expect(ofapiPublishingResultConfirmed(publishing as Parameters<typeof ofapiPublishingResultConfirmed>[0], 200, { data: clean })).toBe(true);
    expect(ofapiAccountResultConfirmed(account as Parameters<typeof ofapiAccountResultConfirmed>[0], 200, { data: clean })).toBe(true);
    expect(ofapiCollectionResultConfirmed(collection as Parameters<typeof ofapiCollectionResultConfirmed>[0], clean)).toBe(true);
  });

  it("classifies a vendor 'no' as rejected and a silent unconfirmed body as indeterminate, for every module", () => {
    for (const [name, command] of Object.entries(acks)) {
      expect(classify(command, 200, { data: { success: true } }), name).toMatchObject({ state: "confirmed", errorCode: null });
      expect(classify(command, 200, { data: { success: true, hasError: true } }), name).toMatchObject({ state: "rejected", errorCode: "vendor_action_rejected" });
      expect(classify(command, 200, { data: { success: true }, errors: { text: ["The text field is required."] } }), name).toMatchObject({ state: "rejected", errorCode: "vendor_action_rejected" });
      expect(classify(command, 200, { data: { success: true }, success: false }), name).toMatchObject({ state: "rejected", errorCode: "vendor_action_rejected" });
      expect(classify(command, 200, { data: {} }), name).toMatchObject({ state: "indeterminate", errorCode: "vendor_result_unconfirmed" });
      expect(classify(command, 200, { data: { success: true, error: null, errors: [] } }), name).toMatchObject({ state: "confirmed" });
    }
  });

  it("keeps the username read's false success a confirmed answer unless a provider error accompanies it", () => {
    const username = parse({ action: "username_availability_read", username: "already_used" });
    expect(classify(username, 200, { data: { success: false } })).toMatchObject({ state: "confirmed" });
    expect(classify(username, 200, { data: { success: false, error: "denied" } })).toMatchObject({ state: "rejected", errorCode: "vendor_action_rejected" });
    expect(classify(username, 200, { success: false, data: { success: false } })).toMatchObject({ state: "rejected", errorCode: "vendor_action_rejected" });
  });
});
