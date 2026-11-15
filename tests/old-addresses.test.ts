import { describe, expect, it } from "vitest";

import { teamToWorkboard } from "../apps/dashboard/src/lib/workboard.ts";
import { signinNamesOf, workboardOnConsoleRedirect } from "../apps/runtime/src/services/signin-handoff.ts";
import { OLD_ADDRESSES, WORKBOARD_OLD_PATHS, workboardOldAddress } from "../packages/ui/src/old-addresses.ts";
import { matchScreen } from "../packages/ui/src/screens.ts";
import { workboardEntryHref } from "../packages/ui/src/sites.ts";

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

/** One address, followed to where it rests; the steps it took. */
function follow(start: string): { at: string; steps: string[] } {
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
      const moved = workboardOldAddress({ pathname: url.pathname.slice(BASE.length) || "/", search: url.search, hash: url.hash });
      if (moved !== null) {
        url = new URL(`${BASE}${moved.pathname}${moved.search}${moved.hash}`, TEAM);
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
const WORKBOARD_ROUTES = ["/", "/start", "/my/shifts", "/shifts", "/people", "/people/:ref/:tab?", "/customs", "/customs/:code", "/sales/:tab", "/waiting", "/payouts", "/report/:shiftId", "/account"];

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

  it("keeps the released extension's «Мои смены» where it is, forever", () => {
    expect(follow(`${TEAM}/workboard/my/shifts`).steps).toEqual([]);
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
