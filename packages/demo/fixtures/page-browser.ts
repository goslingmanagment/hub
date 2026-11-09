/**
 * The pages' server browsers: every Fansly page already runs in its own
 * browser (its login is closed: the browser works by itself), two new
 * browsers are being onboarded, two drafts wait for the server.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { daysAgo, demoError, hoursAgo, iso, type DemoHandlers, type DemoReply } from "../core.ts";
import { resolvePage } from "./page-world.ts";

function isReply(value: unknown): value is DemoReply {
  return typeof value === "object" && value !== null && (value as { demoReply?: unknown }).demoReply === true;
}

type Profile = KernelOperationResponse<"pageBrowserProfileGet">;
type Summary = Profile["profile"];

const ENV_CHICAGO = { timeZone: "America/Chicago", languages: ["en-US", "en"], geolocation: { latitude: 41.8781, longitude: -87.6298, accuracyM: 3000 } };
const ENV_MIAMI = { timeZone: "America/New_York", languages: ["en-US", "en"], geolocation: { latitude: 25.7617, longitude: -80.1918, accuracyM: 2500 } };

interface DemoProfile {
  profileId: string;
  name: string;
  proxy: { scheme: "socks5"; host: string; port: number; username: string } | null;
  pinnedExitIp: string | null;
  env: typeof ENV_CHICAGO | null;
  createdDaysAgo: number;
  started: boolean;
  /** Logged in, the login still open: the account's step is next. */
  loggedIn?: boolean;
}

const PROFILES: readonly DemoProfile[] = [
  {
    profileId: "5b7e2c1a-93d4-4f6e-8a21-3c9d0e4f7b12",
    name: "nova-2",
    proxy: { scheme: "socks5", host: "us-chi.residential.demo.invalid", port: 9050, username: "agency-nova2" },
    pinnedExitIp: "73.22.181.46",
    env: ENV_CHICAGO,
    createdDaysAgo: 1,
    started: true,
  },
  {
    profileId: "c0a4f8e2-61b7-4d3a-b9f5-7e2d14a6c830",
    name: "mia-4",
    proxy: { scheme: "socks5", host: "us-mia.residential.demo.invalid", port: 9050, username: "agency-mia4" },
    pinnedExitIp: null,
    env: ENV_MIAMI,
    createdDaysAgo: 0,
    started: false,
  },
  {
    profileId: "e7d1b3a9-4c25-4f80-9a6e-1b2c3d4e5f60",
    name: "ivy-3",
    proxy: { scheme: "socks5", host: "us-pdx.residential.demo.invalid", port: 9050, username: "agency-ivy4" },
    pinnedExitIp: "71.59.204.18",
    env: ENV_CHICAGO,
    createdDaysAgo: 0,
    started: true,
    loggedIn: true,
  },
];

function summaryOf(profile: DemoProfile, now: Date): Summary {
  return {
    profileId: profile.profileId,
    name: profile.name,
    container: `pb-${profile.name}`,
    onboarding: profile.loggedIn ? "open" : "off",
    createdAt: iso(hoursAgo(now, profile.createdDaysAgo * 24 + 3)),
    proxySet: profile.proxy !== null,
    pinnedExitIp: profile.pinnedExitIp,
    envSet: profile.env !== null,
    operator: profile.started
      ? {
        step: "idle",
        stopReason: null,
        mode: "automation",
        exitOpen: true,
        exitIp: profile.pinnedExitIp,
        accountId: null,
        sessionKnown: false,
        selfTest: { ok: true, at: iso(hoursAgo(now, 0.4)), failed: null },
        lastStateAt: iso(hoursAgo(now, 0.05)),
        linkError: null,
      }
      : {
        step: null,
        stopReason: null,
        mode: "automation",
        exitOpen: false,
        exitIp: null,
        accountId: null,
        sessionKnown: false,
        selfTest: null,
        lastStateAt: null,
        linkError: null,
      },
  };
}

export const pageBrowserHandlers: DemoHandlers = {
  pageBrowserLoginGet: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const bound = page.platform === "fansly";
    return {
      page: { label: page.label, pageId: page.id },
      transport: "browser" as const,
      login: { state: "off" as const, changedAt: bound ? iso(daysAgo(request.now, 9, 14)) : null },
      browser: bound
        ? { ready: true, problem: null, reachable: true }
        : { ready: false, problem: "no browser profile is bound to the page", reachable: null },
      screen: null,
      refused: null,
      screenUrl: `/api/v1/page-browser/pages/${encodeURIComponent(page.label)}/screen/`,
    };
  },

  pageBrowserProfiles: (request) => ({ profiles: PROFILES.map((profile) => summaryOf(profile, request.now)) }),

  pageBrowserProfileGet: (request) => {
    const profile = PROFILES.find((item) => item.profileId === request.params.profileId);
    if (!profile) return demoError(404, "not_found", "Такого браузера нет");
    const masked = profile.proxy ? { ...profile.proxy, passwordSet: true } : null;
    return {
      profile: summaryOf(profile, request.now),
      socksEndpoint: profile.proxy ? `${profile.proxy.host}:${profile.proxy.port}` : null,
      proxy: profile.proxy && masked
        ? { url: `socks5://${profile.proxy.host}:${profile.proxy.port}`, username: profile.proxy.username, masked }
        : null,
      env: profile.env,
      login: profile.loggedIn ? { state: "open" as const, changedAt: iso(hoursAgo(request.now, 0.2)) } : { state: "off" as const, changedAt: null },
      browser: profile.pinnedExitIp === null
        ? { ready: false, problem: "its exit IP is not pinned", reachable: null }
        : { ready: true, problem: null, reachable: true },
      screen: null,
      refused: null,
      screenUrl: `/api/v1/page-browser/profiles/${profile.profileId}/screen/`,
      identity: profile.loggedIn
        ? { requestedAt: iso(hoursAgo(request.now, 0.1)), pending: false, ok: true, accountId: "804119203377000194", username: "ivyrose.three", displayName: "Ivy Rose", checkedAt: iso(hoursAgo(request.now, 0.1)), error: null }
        : { requestedAt: null, pending: false, ok: null, accountId: null, username: null, displayName: null, checkedAt: null, error: null },
    };
  },

  pageBrowserDrafts: (request) => ({
    drafts: [
      {
        name: "ivy-4",
        page: null,
        proxy: { scheme: "socks5" as const, host: "us-pdx.residential.demo.invalid", port: 9050, username: "agency-ivy4", passwordSet: true },
        env: { timeZone: "America/Los_Angeles", languages: ["en-US", "en"], geolocation: { latitude: 45.5152, longitude: -122.6784, accuracyM: 3000 } },
        revision: 2,
        createdAt: iso(hoursAgo(request.now, 30)),
        updatedAt: iso(hoursAgo(request.now, 5)),
        command: "scripts/deploy-page-browser.sh add-profile <host> --page ivy-4 --image <образ>",
      },
      {
        name: "mia-5",
        page: null,
        proxy: { scheme: "socks5" as const, host: "us-dal.residential.demo.invalid", port: 9050, username: "agency-mia5", passwordSet: true },
        env: null,
        revision: 1,
        createdAt: iso(hoursAgo(request.now, 2)),
        updatedAt: iso(hoursAgo(request.now, 2)),
        command: "scripts/deploy-page-browser.sh add-profile <host> --page mia-5 --image <образ>",
      },
    ],
    // Every Fansly page already has its browser: none waits to move.
    pages: [],
  }),

  // A check reads nothing of the platform: the demo answers that the proxy works.
  pageBrowserProxyCheck: (request) => ({
    ok: true,
    problem: null,
    spoken: "socks5" as const,
    proxy: { scheme: "socks5" as const, host: "us-pdx.residential.demo.invalid", port: 9050, username: "agency-new", passwordSet: true },
    socksEndpoint: "203.0.113.24:9050",
    latencyMs: 182,
    exit: { ip: "71.59.204.18", country: "United States", countryCode: "US", region: "Oregon", city: "Portland", isp: "Demo Residential", asn: "AS64500", timeZone: "America/Los_Angeles", latitude: 45.5152, longitude: -122.6784 },
    ipInfoService: "ipinfo",
    env: { timeZone: "America/Los_Angeles", languages: ["en-US", "en"], geolocation: { latitude: 45.5152, longitude: -122.6784, accuracyM: 3000 } },
    checkId: "4f1c2b8e-9a3d-4e6f-8b1a-2c3d4e5f6a7b",
    checkedAt: iso(request.now),
  }),
};
