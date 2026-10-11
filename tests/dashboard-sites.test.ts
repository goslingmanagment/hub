import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHATTER_SITE_ORIGIN,
  CONSOLE_ORIGIN,
  LEGACY_CONSOLE_ORIGIN,
  applySiteTitle,
  chatterSiteOriginFor,
  isChatterSite,
} from "../apps/dashboard/src/lib/sites.ts";

// One app, served under two names. Which name a tab is on decides what a
// chatter is shown and handed — the sign-in's name, their home, the address in
// an invitation — so the names themselves are pinned here, letter for letter.

function openOn(origin: string) {
  vi.stubGlobal("window", { location: { origin } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the production names", () => {
  it("are the console's, its former one and the chatters' site", () => {
    expect(CONSOLE_ORIGIN).toBe("https://hub.gosling-agency.ru");
    expect(LEGACY_CONSOLE_ORIGIN).toBe("https://gosling-agency.ru");
    expect(CHATTER_SITE_ORIGIN).toBe("https://chatgoose.gosling-agency.ru");
  });
});

describe("isChatterSite", () => {
  it("is true on the chatters' site", () => {
    openOn("https://chatgoose.gosling-agency.ru");
    expect(isChatterSite()).toBe(true);
  });

  it.each([
    "https://hub.gosling-agency.ru",
    "https://gosling-agency.ru",
    "http://chatgoose.gosling-agency.ru",
    "https://chatgoose.gosling-agency.ru.example",
    "http://localhost:5173",
  ])("is false on %s", (origin) => {
    openOn(origin);
    expect(isChatterSite()).toBe(false);
  });

  it("is false where there is no window to ask", () => {
    expect(typeof window).toBe("undefined");
    expect(isChatterSite()).toBe(false);
  });
});

describe("chatterSiteOriginFor", () => {
  it.each(["https://hub.gosling-agency.ru", "https://gosling-agency.ru"])(
    "sends the people of the production console on %s to the chatters' site",
    (consoleOrigin) => {
      expect(chatterSiteOriginFor(consoleOrigin)).toBe("https://chatgoose.gosling-agency.ru");
    },
  );

  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "https://hub.gosling-agency.ru.example",
    "http://hub.gosling-agency.ru",
    "",
  ])("leaves %j serving its own pages", (origin) => {
    expect(chatterSiteOriginFor(origin)).toBe(origin);
  });
});

describe("applySiteTitle", () => {
  it("names the tab ChatGoose on the chatters' site", () => {
    openOn(CHATTER_SITE_ORIGIN);
    vi.stubGlobal("document", { title: "AgencyHub" });
    applySiteTitle();
    expect(document.title).toBe("ChatGoose");
  });

  it.each([CONSOLE_ORIGIN, LEGACY_CONSOLE_ORIGIN, "http://localhost:5173"])(
    "leaves the tab AgencyHub on %s",
    (origin) => {
      openOn(origin);
      vi.stubGlobal("document", { title: "AgencyHub" });
      applySiteTitle();
      expect(document.title).toBe("AgencyHub");
    },
  );
});
