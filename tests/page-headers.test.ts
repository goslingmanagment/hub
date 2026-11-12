import { describe, expect, it } from "vitest";

import { HSTS_HEADER, pageHeaders } from "../apps/runtime/src/api/page-headers.ts";

// Hub's pages are never framed by another site, and production asks for HTTPS only (ecosystem R9).
describe("the headers of every answer", () => {
  it("lets only Hub's own pages frame Hub, everywhere", () => {
    for (const production of [true, false]) {
      expect(pageHeaders(production)).toMatchObject({ "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'" });
    }
  });

  it("asks for HTTPS for a year in production, never for the other names under the domain", () => {
    expect(pageHeaders(true)["strict-transport-security"]).toBe(HSTS_HEADER);
    expect(HSTS_HEADER).toBe("max-age=31536000");
    expect(HSTS_HEADER).not.toMatch(/includeSubDomains/i);
    expect(pageHeaders(false)).not.toHaveProperty("strict-transport-security");
  });
});
