import { describe, expect, it } from "vitest";
import { isFanslyGroupDetailIdentity } from "@agency_hub_core/fansly";

describe("Fansly group-detail identity contract", () => {
  it.each([
    null, {}, [], { id: "group" }, { id: "group", users: null },
    { id: "other", users: [] }, { id: "", users: [] },
    { id: "group", users: [null] }, { id: "group", users: [{}] },
    { id: "group", users: [{ userId: "" }] }, { id: "group", users: [{ userId: 12 }] },
  ])("refuses malformed or mismatched identities: %j", value => {
    expect(isFanslyGroupDetailIdentity(value, "group")).toBe(false);
  });

  it("accepts explicit empty membership and leaves additive fields untouched", () => {
    expect(isFanslyGroupDetailIdentity({ id: "group", users: [] }, "group")).toBe(true);
    const value = { id: "group", users: [{ userId: "fan", extra: "kept" }], lastMessage: null };
    expect(isFanslyGroupDetailIdentity(value, "group")).toBe(true);
    expect(value).toEqual({ id: "group", users: [{ userId: "fan", extra: "kept" }], lastMessage: null });
  });
});
