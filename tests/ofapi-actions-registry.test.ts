import { describe, expect, it } from "vitest";
import { ofapiAccountActionOptions, ofapiActionSchema, ofapiCollectionActionOptions, ofapiPublishingActionOptions, ofapiPublishingAdmissionIssue, type OfapiAction } from "../packages/contracts/src/index.ts";
import { assertOfapiActionModulesPartition, ofapiActionAdmissionIssue, ofapiActionModule, ofapiActionRequest, ofapiActionResultConfirmed, type OfapiActionModule } from "../apps/runtime/src/services/ofapi-actions-registry.ts";
import { ofapiAccountRequest, ofapiAccountResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-account.ts";
import { ofapiCollectionRequest, ofapiCollectionResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-collections.ts";
import { ofapiPublishingRequest, ofapiPublishingResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-publishing.ts";

const names = (options: readonly { shape: { action: { value: string } } }[]) => options.map(option => option.shape.action.value);
const modules: Record<OfapiActionModule, string[]> = {
  publishing: names(ofapiPublishingActionOptions),
  account: names(ofapiAccountActionOptions),
  collection: names(ofapiCollectionActionOptions),
};
const parse = (value: Record<string, unknown>): OfapiAction => ofapiActionSchema.parse({ pageId: 7, ...value });

describe("OFAPI action registry routes on the action discriminant", () => {
  it("routes every action name in the union to exactly one module, and that module owns the name", () => {
    const union = names(ofapiActionSchema.options);
    expect(union).toHaveLength(modules.publishing.length + modules.account.length + modules.collection.length);
    expect(new Set(union).size).toBe(union.length);
    for (const name of union) {
      const module = ofapiActionModule(name as OfapiAction["action"]);
      const owners = (Object.keys(modules) as OfapiActionModule[]).filter(candidate => modules[candidate].includes(name));
      expect(owners, name).toEqual([module]);
    }
  });

  it("refuses at load time a module map that overlaps, orphans or invents an action", () => {
    const sets = (value: Record<OfapiActionModule, string[]>): Record<OfapiActionModule, ReadonlySet<string>> => ({ publishing: new Set(value.publishing), account: new Set(value.account), collection: new Set(value.collection) });
    const union = new Set(names(ofapiActionSchema.options));
    expect(() => assertOfapiActionModulesPartition(sets(modules), union)).not.toThrow();
    expect(() => assertOfapiActionModulesPartition(sets({ ...modules, account: [...modules.account, "post_delete"] }), union)).toThrow(/shared=\[post_delete \(publishing, account\)\]/);
    expect(() => assertOfapiActionModulesPartition(sets({ ...modules, collection: modules.collection.filter(name => name !== "user_list_delete") }), union)).toThrow(/orphaned=\[user_list_delete\]/);
    expect(() => assertOfapiActionModulesPartition(sets({ ...modules, publishing: [...modules.publishing, "post_reshare"] }), union)).toThrow(/foreign=\[post_reshare\]/);
    expect(() => ofapiActionModule("post_reshare" as OfapiAction["action"])).toThrow(/Unknown OFAPI action/);
  });

  it("hands each command to its own module unchanged", () => {
    const publishing = parse({ action: "post_delete", postId: "7" });
    const account = parse({ action: "account_drm_update", enabled: false });
    const collection = parse({ action: "user_list_delete", listId: "555" });
    expect(ofapiActionRequest(publishing, "acct")).toEqual(ofapiPublishingRequest(publishing as Parameters<typeof ofapiPublishingRequest>[0], "acct"));
    expect(ofapiActionRequest(account, "acct")).toEqual(ofapiAccountRequest(account as Parameters<typeof ofapiAccountRequest>[0], "acct"));
    expect(ofapiActionRequest(collection, "acct")).toEqual(ofapiCollectionRequest(collection as Parameters<typeof ofapiCollectionRequest>[0], "acct"));
    const body = { data: { success: true } };
    expect(ofapiActionResultConfirmed(publishing, 200, body)).toBe(ofapiPublishingResultConfirmed(publishing as Parameters<typeof ofapiPublishingResultConfirmed>[0], 200, body));
    expect(ofapiActionResultConfirmed(account, 200, body)).toBe(ofapiAccountResultConfirmed(account as Parameters<typeof ofapiAccountResultConfirmed>[0], 200, body));
    expect(ofapiActionResultConfirmed(collection, 200, body)).toBe(ofapiCollectionResultConfirmed(collection as Parameters<typeof ofapiCollectionResultConfirmed>[0], body.data));
    // The collection engine owns the HTTP status: a 201 confirms nothing there.
    expect(ofapiActionResultConfirmed(collection, 201, body)).toBe(false);
  });

  it("asks only the publishing module about admission", () => {
    const now = new Date("2026-09-07T12:00:00Z");
    const scheduled = parse({ action: "post_create", text: "Later", mediaFiles: ["123"], scheduledDate: "2026-09-01T12:00:00Z" });
    expect(ofapiActionAdmissionIssue(scheduled, now)).toBe(ofapiPublishingAdmissionIssue(scheduled as Parameters<typeof ofapiPublishingAdmissionIssue>[0], now));
    expect(ofapiActionAdmissionIssue(scheduled, now)).toMatch(/future/);
    expect(ofapiActionAdmissionIssue(parse({ action: "account_drm_update", enabled: false }), now)).toBeNull();
    expect(ofapiActionAdmissionIssue(parse({ action: "user_list_delete", listId: "555" }), now)).toBeNull();
  });
});
