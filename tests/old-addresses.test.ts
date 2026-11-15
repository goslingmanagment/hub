import { describe, expect, it } from "vitest";

import { teamPeopleInHub, teamToWorkboard } from "../apps/dashboard/src/lib/workboard.ts";
import { signinNamesOf, workboardOnConsoleRedirect } from "../apps/runtime/src/services/signin-handoff.ts";
import { OLD_ADDRESSES, WORKBOARD_OLD_PATHS, registryTabLanding, workboardOldAddress } from "../packages/ui/src/old-addresses.ts";
import { matchScreen } from "../packages/ui/src/screens.ts";
import { hubEntryHref, workboardEntryHref } from "../packages/ui/src/sites.ts";

// Old addresses lead to new ones (products plan §2.3, §7.3): every row of the one table, walked through the layers
// that answer it in production — Hub's server, the console's router, the hand-off, Workboard's router — the way a
// browser follows them (it keeps the `#…` across a server's redirect).

const NAMES = signinNamesOf({ isProduction: true } as Parameters<typeof signinNamesOf>[0]);
const HUB = NAMES.console;
const TEAM = NAMES.team;
const BASE = "/workboard";

/** The hand-off's address (`/api/v1/auth/sso?to=…&next=…`) on `origin`: where it leads, signed in. */
function handOff(origin: string, href: string): URL {
  const hop = new URL(href, origin);
  expect(hop.pathname, href).toBe("/api/v1/auth/sso");
  return new URL(hop.searchParams.get("next")!);
}

/** One address, followed to where it rests; the steps it took. `owner`: who opens it (a person's access is Hub's for the owner). */
function follow(start: string, owner = true): { at: string; steps: string[] } {
  let url = new URL(start);
  const steps: string[] = [];
  for (let step = 0; step < 8; step += 1) {
    const path = `${url.pathname}${url.search}`;
    if (url.origin === HUB) {
      // Hub's server: a Workboard address leaves for the team's name.
      const server = workboardOnConsoleRedirect({ here: HUB, method: "GET", url: path }, NAMES);
      if (server !== null && !server.startsWith("/api/v1/auth/sso")) {
        // An address that stays on the console's name (the old «Решения»: Hub's «Ждут вас»).
        const next = new URL(server, HUB);
        next.hash = url.hash;
        url = next;
        steps.push("server");
        continue;
      }
      if (server !== null) {
        const next = handOff(HUB, server);
        next.hash = url.hash;
        url = next;
        steps.push("server");
        continue;
      }
      // The console's old «Команда → Люди»: the registry, Hub «Люди» (App.tsx `TeamPeopleToHub`).
      const people = teamPeopleInHub(path);
      if (people !== null) {
        url = new URL(people, HUB);
        steps.push("console");
        continue;
      }
      // The console's old «Команда»: its Workboard screen, on the team's name.
      const team = teamToWorkboard(`${path}${url.hash}`, "2026-11-10");
      if (team !== null) {
        const parsed = new URL(team, HUB);
        url = new URL(handOff(HUB, workboardEntryHref(HUB, `${parsed.pathname}${parsed.search}`)));
        url.hash = parsed.hash;
        steps.push("console");
        continue;
      }
      return { at: url.href, steps };
    }
    if (url.origin === TEAM && (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) {
      const at = { pathname: url.pathname.slice(BASE.length) || "/", search: url.search, hash: url.hash };
      const moved = workboardOldAddress(at);
      if (moved !== null) {
        url = new URL(`${BASE}${moved.pathname}${moved.search}${moved.hash}`, TEAM);
        steps.push("workboard");
        continue;
      }
      // A registry tab of a person's card (screens/team/PersonRoute.tsx): Hub «Люди» for the owner, signed in on the
      // way; the person's «Команда» card for anyone else.
      const registry = registryTabLanding(at, owner);
      if (registry !== null && "hub" in registry) {
        url = new URL(handOff(TEAM, hubEntryHref(TEAM, registry.hub)));
        steps.push("workboard→hub");
        continue;
      }
      if (registry !== null) {
        url = new URL(`${BASE}${registry.workboard.pathname}${registry.workboard.search}${registry.workboard.hash}`, TEAM);
        steps.push("workboard");
        continue;
      }
    }
    return { at: url.href, steps };
  }
  throw new Error(`${start} does not come to rest`);
}

/** Whether a router path matches a route pattern (`:name` one segment, `:name?` an optional last one). */
function matchesRoute(pattern: string, path: string): boolean {
  const source = pattern.split("/").map((part) => (part.endsWith("?") ? "(?:/[^/]+)?" : part.startsWith(":") ? "/[^/]+" : part ? `/${part}` : "")).join("");
  return new RegExp(`^${source || "/"}$`).test(path === "/" ? "/" : path.replace(/\/+$/, ""));
}

/** Workboard's routes a resting address may open (apps/workboard/src/app/routes.tsx). */
const WORKBOARD_ROUTES = ["/", "/today", "/start", "/shifts", "/shifts/mine", "/shifts/team", "/team", "/team/:ref/:tab?", "/customs", "/customs/:code", "/sales/:tab", "/waiting", "/money", "/money/debts", "/money/reports", "/money/mine", "/report/:shiftId", "/account", "/fans", "/fans/subscribers", "/fans/followers", "/fans/gone", "/fans/by-spend", "/fans/by-spend/:bucketKey", "/fans/:pageLabel/:platform/:platformUserId", "/fans/:platform/:platformUserId"];

describe("old addresses", () => {
  it.each(OLD_ADDRESSES.map((row) => [row.from, row.to, row.who]))("%s lands on %s (%s)", (from, to) => {
    const { at } = follow(from);
    expect(at).toBe(to);
    const url = new URL(at);
    if (url.origin === TEAM) {
      const route = url.pathname.slice(BASE.length) || "/";
      expect(WORKBOARD_ROUTES.some((pattern) => matchesRoute(pattern, route)), at).toBe(true);
    } else {
      expect(matchScreen(url.pathname)?.screen.product, at).toBe("hub");
    }
  });

  it("lands a team lead on the person's «Команда» card from an old address of the person's access", () => {
    expect(follow(`${TEAM}/workboard/people/7/access?days=7`, false).at).toBe(`${TEAM}/workboard/team/7?days=7`);
    expect(follow(`${TEAM}/workboard/access?person=7`, false).at).toBe(`${TEAM}/workboard/team/7`);
    expect(follow(`${TEAM}/workboard/people/7/access`, true).at).toBe(`${HUB}/people/7/logins`);
  });

  it("keeps the released extension's «Мои смены» on the team's name, without a sign-in hop: «Смены → Мои»", () => {
    expect(follow(`${TEAM}/workboard/my/shifts`)).toEqual({ at: `${TEAM}/workboard/shifts/mine`, steps: ["workboard"] });
  });

  it("has a router path for every old path of Workboard, and every one of them leads somewhere new", () => {
    for (const path of WORKBOARD_OLD_PATHS) {
      const sample = `/${path.replace(/:[a-zA-Z]+/g, "7")}`;
      expect(workboardOldAddress({ pathname: sample, search: "", hash: "" }), path).not.toBeNull();
    }
    for (const route of WORKBOARD_ROUTES) {
      const sample = route.replace(/:[a-zA-Z]+\??/g, "7");
      expect(workboardOldAddress({ pathname: sample, search: "", hash: "" }), route).toBeNull();
    }
  });

  it("sends a Workboard address on the console's name on with nothing lost, and leaves everything else alone", () => {
    const to = workboardOnConsoleRedirect({ here: HUB, method: "GET", url: "/workboard/shifts/4/2026-11-06T09:16?chat=fansly%3A77" }, NAMES)!;
    expect(new URL(to, HUB).searchParams.get("next")).toBe(`${TEAM}/workboard/shifts/4/2026-11-06T09:16?chat=fansly%3A77`);
    expect(new URL(to, HUB).searchParams.get("silent")).toBe("1");
    for (const [here, method, url] of [
      [TEAM, "GET", "/workboard/shifts"],
      [HUB, "POST", "/workboard/shifts"],
      [HUB, "GET", "/workboards"],
      [HUB, "GET", "/workboard/assets/index-1.js"],
      [HUB, "GET", "/workboard/frame/report?shift=4"],
      [HUB, "GET", "/api/v1/auth/me"],
      [HUB, "GET", "/workboard//evil.example/x"],
    ] as const) {
      expect(workboardOnConsoleRedirect({ here, method, url }, NAMES), `${here} ${method} ${url}`).toBeNull();
    }
  });
});
