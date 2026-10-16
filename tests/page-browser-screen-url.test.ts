import { describe, expect, it } from "vitest";
import { pageBrowserScreenUrl } from "../apps/runtime/src/services/egress/page-browser-login.ts";
import { parseXGeometry } from "../apps/page-browser/src/env/display.ts";

describe("the fixed X desktop", () => {
  it.each(["/api/v1/page-browser/pages/lilly-1/screen", "/api/v1/page-browser/profiles/00000000-0000-0000-0000-000000000001/screen"])("scales the viewer for %s and keeps its authenticated socket path", (base) => {
    const url = new URL(pageBrowserScreenUrl(base), "https://hub.example");
    expect(url.searchParams.get("resize")).toBe("scale");
    expect(url.searchParams.get("autoconnect")).toBe("1");
    expect(url.searchParams.get("path")).toBe(`${base.slice(1)}/websockify`);
  });
  it("reads the actual root geometry and refuses incomplete or invalid X output", () => {
    expect(parseXGeometry("screen #0:\n  dimensions:    1728x936 pixels (457x247 millimeters)\n  depth of root window:    24 planes\n")).toEqual({ width: 1728, height: 936, depth: 24 });
    expect(() => parseXGeometry("dimensions: 1920x1080 pixels")).toThrow();
    expect(() => parseXGeometry("dimensions: 0x1080 pixels\ndepth of root window: 24 planes")).toThrow();
  });
});
