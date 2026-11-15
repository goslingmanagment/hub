import { describe, expect, it } from "vitest";

import {
  HSTS_HEADER, boardFrameDevOrigins, boardFrameHeaders, isBoardFramePath, pageHeaders,
} from "../apps/runtime/src/api/page-headers.ts";

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

  // The «Отчёт» board in the extension's frame (package R): the one path the two sites may frame.
  it("lets only the extension's two sites frame the board's frame path, with no x-frame-options", () => {
    for (const production of [true, false]) {
      const frame = boardFrameHeaders(production);
      expect(frame["content-security-policy"]).toBe("frame-ancestors https://fansly.com https://chat.onlymonster.ai");
      expect(frame).not.toHaveProperty("x-frame-options");
    }
    expect(isBoardFramePath("/workboard/frame/report")).toBe(true);
    expect(isBoardFramePath("/workboard/frame/report?shift=12")).toBe(true);
    // Exactly the board's frame: another frame path is not lifted until it is listed by name.
    expect(isBoardFramePath("/workboard/frame/other")).toBe(false);
    expect(isBoardFramePath("/workboard/frame/report/x")).toBe(false);
    expect(isBoardFramePath("/workboard/report/12")).toBe(false);
    expect(isBoardFramePath("/workboard/frameworks")).toBe(false);
    expect(isBoardFramePath("/api/v1/workboard/frame/report")).toBe(false);
  });

  it("adds the local stand's origins outside production only", () => {
    const origins = boardFrameDevOrigins("http://127.0.0.1:5390, http://localhost:8080 javascript:alert(1)");
    expect(boardFrameHeaders(false, origins)["content-security-policy"]).toBe(
      "frame-ancestors https://fansly.com https://chat.onlymonster.ai http://127.0.0.1:5390 http://localhost:8080",
    );
    expect(boardFrameHeaders(true, origins)["content-security-policy"]).toBe("frame-ancestors https://fansly.com https://chat.onlymonster.ai");
  });
});
