import { describe, expect, it } from "vitest";

import { formatRequestValidationMessage } from "../apps/runtime/src/api/error-boundary.ts";

describe("request validation error boundary", () => {
  it("removes request values and caps the structured Zod summary", () => {
    const requestSecret = "request-payload-fragment-that-must-not-escape";
    const message = formatRequestValidationMessage({
      validationContext: "body",
      validation: Array.from({ length: 30 }, (_, index) => ({
        keyword: "custom",
        instancePath: `/field${index}`,
        message: `Invalid value ${requestSecret} ${"detail".repeat(10)}`,
      })),
    }, [{ nested: { value: requestSecret } }]);

    expect(message.length).toBeLessThanOrEqual(512);
    expect(message.endsWith("...")).toBe(true);
    expect(message).not.toContain(requestSecret);
    expect(message).toContain("[REQUEST_VALUE]");
  });

  it("does not echo unrecognized caller-owned keys", () => {
    const message = formatRequestValidationMessage({
      validationContext: "body",
      validation: [{
        keyword: "unrecognized_keys",
        instancePath: "/caller-secret-field-name",
        message: "Unrecognized key: \"caller-secret-field-name\"",
      }],
    }, []);

    expect(message).toBe("body Unrecognized field");
  });
});
