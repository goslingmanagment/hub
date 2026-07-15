import { describe, expect, it } from "vitest";

import {
  DESKTOP_LIFECYCLE_V2_EVIDENCE,
  validateDesktopLifecycleV2Evidence,
} from "../apps/runtime/src/services/desktop-lifecycle-v2-evidence.ts";
import { PUBLIC_RUNTIME_CAPABILITIES } from "../apps/runtime/src/services/public-capabilities.ts";

describe("public runtime capabilities", () => {
  it("advertises lifecycle-v2 only with the compiled exact release and fleet evidence", () => {
    expect(PUBLIC_RUNTIME_CAPABILITIES).toEqual(["desktop-lifecycle-v2"]);
    expect(validateDesktopLifecycleV2Evidence()).toBe(DESKTOP_LIFECYCLE_V2_EVIDENCE);
  });
});
