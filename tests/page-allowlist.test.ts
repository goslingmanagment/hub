import { describe, expect, it } from "vitest";

import { isPageAllowlisted } from "../packages/shared/src/page-allowlist.ts";

describe("isPageAllowlisted", () => {
  it.each([undefined, "", "  ", " , ,"])("fails closed on an empty CSV %j", (csv) => {
    expect(isPageAllowlisted(csv, "lilly-1")).toBe(false);
  });

  it("matches labels exactly after trimming CSV whitespace", () => {
    expect(isPageAllowlisted("lilly-1", "lilly-1")).toBe(true);
    expect(isPageAllowlisted(" lilly-1 , ari-2", "ari-2")).toBe(true);
    expect(isPageAllowlisted("lilly-1,ari-2", "lora-3")).toBe(false);
    expect(isPageAllowlisted("lilly", "lilly-1")).toBe(false);
    expect(isPageAllowlisted("Lilly-1", "lilly-1")).toBe(false);
  });
});
