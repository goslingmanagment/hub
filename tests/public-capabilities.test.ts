import { describe, expect, it } from "vitest";

import { PUBLIC_RUNTIME_CAPABILITIES } from "../apps/runtime/src/services/public-capabilities.ts";

describe("public runtime capabilities", () => {
  it("keeps lifecycle-v2 disabled until the deploy evidence verifier exists", () => {
    expect(PUBLIC_RUNTIME_CAPABILITIES).not.toContain("desktop-lifecycle-v2");
  });
});
