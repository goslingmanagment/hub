import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildFanslyRequestHeaders,
  resolveFanslyClientCheck,
} from "@agency_hub_core/fansly";

import { loadSessionBundleFromFile } from "../apps/runtime/src/services/page-context.ts";

async function withSessionFile(
  body: Record<string, unknown>,
  run: (filePath: string) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "fansly-session-"));
  const filePath = path.join(dir, "session.json");

  try {
    await writeFile(filePath, JSON.stringify(body), "utf8");
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Fansly session files", () => {
  it("accepts authorization-only bundles", async () => {
    await withSessionFile({ authorization: "token" }, async (filePath) => {
      await expect(loadSessionBundleFromFile(filePath)).resolves.toEqual({
        authorization: "token",
        fanslyClientId: undefined,
        fanslyClientCheck: undefined,
        fanslySessionId: undefined,
        routeChecks: undefined,
      });
    });
  });

  it("treats null optional headers as missing", async () => {
    await withSessionFile(
      {
        authorization: "token",
        "fansly-client-id": null,
        fanslyClientCheck: "client-check",
      },
      async (filePath) => {
        await expect(loadSessionBundleFromFile(filePath)).resolves.toEqual({
          authorization: "token",
          fanslyClientId: undefined,
          fanslyClientCheck: "client-check",
          fanslySessionId: undefined,
          routeChecks: undefined,
        });
      },
    );
  });

  it("rejects non-string optional headers", async () => {
    await withSessionFile(
      {
        authorization: "token",
        "fansly-session-id": 123,
      },
      async (filePath) => {
        await expect(loadSessionBundleFromFile(filePath)).rejects.toThrow(
          'Session file field "fansly-session-id" must be a string when provided',
        );
      },
    );
  });

  it("accepts only named per-route client checks", async () => {
    await withSessionFile(
      {
        authorization: "token",
        routeChecks: { earnings: "earnings-check", message: "message-check" },
      },
      async (filePath) => {
        await expect(loadSessionBundleFromFile(filePath)).resolves.toMatchObject({
          routeChecks: { earnings: "earnings-check", message: "message-check" },
        });
      },
    );

    await withSessionFile(
      { authorization: "token", routeChecks: { madeUpRoute: "check" } },
      async (filePath) => {
        await expect(loadSessionBundleFromFile(filePath)).rejects.toThrow("routeChecks");
      },
    );
  });
});

describe("Fansly adapter headers", () => {
  it("reproduces the captured Firefox header order and exact safe values", () => {
    const headers = buildFanslyRequestHeaders({
      authorization: "token",
      fanslyClientId: "client-id",
      fanslySessionId: "session-id",
      fanslyClientCheck: "legacy-check-must-not-leak",
      routeChecks: { earnings: "earnings-check" },
    }, "/account/wallets/earnings/stats", 1_777_000_000_000);

    expect(Object.keys(headers)).toEqual([
      "user-agent",
      "accept",
      "accept-language",
      "accept-encoding",
      "referer",
      "fansly-client-id",
      "fansly-client-ts",
      "fansly-session-id",
      "fansly-client-check",
      "origin",
      "dnt",
      "sec-gpc",
      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "authorization",
    ]);
    expect(headers).toMatchObject({
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0",
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "gzip, deflate, br, zstd",
      referer: "https://fansly.com/",
      "fansly-client-check": "earnings-check",
      origin: "https://fansly.com",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      authorization: "token",
    });
    expect(headers).not.toHaveProperty("referrer");
  });

  it("never falls back to a stale global check for an unclassified route", () => {
    const session = {
      authorization: "token",
      fanslyClientCheck: "legacy-check-must-not-leak",
      routeChecks: { earnings: "earnings-check" },
    };
    expect(resolveFanslyClientCheck(session, "/notifications")).toEqual({
      route: null,
      check: null,
      state: "route_unclassified",
    });
    expect(buildFanslyRequestHeaders(session, "/notifications"))
      .not.toHaveProperty("fansly-client-check");
  });
});
