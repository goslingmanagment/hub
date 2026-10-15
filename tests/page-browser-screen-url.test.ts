import { describe, expect, it } from "vitest";

import { screenUrl } from "../apps/runtime/src/modules/page-browser/index.ts";

describe("the owner's screen preserves the browser's geometry (pilot F4)", () => {
  it.each([
    [{ kind: "page" as const, label: "lilly 1" }, "pages/lilly%201"],
    [{ kind: "profile" as const, profileId: "new-profile" }, "profiles/new-profile"],
  ])("scales the view for %j, keeping the same authenticated socket route", (target, route) => {
    const url = new URL(screenUrl(target), "https://hub.test");
    expect(url.pathname).toBe(`/api/v1/page-browser/${route}/screen/index.html`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ autoconnect: "1", resize: "scale", path: `api/v1/page-browser/${route}/screen/websockify` });
  });
});
