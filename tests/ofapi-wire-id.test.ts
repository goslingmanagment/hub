import { describe, expect, it } from "vitest";

import { ofapiWireId } from "../apps/runtime/src/services/ofapi-command-composer.ts";

// OnlyFans publishing and account actions send ids through ofapiWireId: a
// numeric id becomes a JSON number only while it survives the round trip;
// above 2^53 - 1 it stays the exact string.
describe("ofapiWireId", () => {
  it("sends a safe numeric id as a number", () => {
    expect(ofapiWireId("123")).toBe(123);
  });

  it("keeps the largest safe integer a number and the next one a string", () => {
    expect(ofapiWireId("9007199254740991")).toBe(9007199254740991);
    expect(ofapiWireId("9007199254740992")).toBe("9007199254740992");
  });

  it("keeps unsafe and non-numeric ids as the same strings", () => {
    expect(ofapiWireId("9007199254740993")).toBe("9007199254740993");
    expect(ofapiWireId("123456789012345678901234567890")).toBe("123456789012345678901234567890");
    expect(ofapiWireId("ofapi_media_abc")).toBe("ofapi_media_abc");
  });
});
