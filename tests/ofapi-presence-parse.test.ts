import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseOfapiPresencePayload } from "../apps/runtime/src/services/ofapi-presence-projection.ts";

// Pure parser checks against the captured live webhook fixtures. The
// projection itself (ingest, gating, store writes) is covered against a real
// database in ofapi-presence.integration.test.ts.

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");

function loadFixtureEnvelope(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return raw;
}

describe("parseOfapiPresencePayload (live fixtures)", () => {
  it("maps users.online and users.offline payloads", () => {
    const online = loadFixtureEnvelope("users_online.json");
    const parsedOnline = parseOfapiPresencePayload(online.payload as Record<string, unknown>);
    expect(parsedOnline).toEqual({
      fanId: "1000033",
      lastSeenAt: new Date("2026-06-10T20:01:06.000000Z"),
      observedAt: new Date("2026-06-10T20:01:06.000000Z"),
    });

    const offline = loadFixtureEnvelope("users_offline.json");
    const parsedOffline = parseOfapiPresencePayload(offline.payload as Record<string, unknown>);
    // Offline carries the historical lastSeen, earlier than the status change.
    expect(parsedOffline?.lastSeenAt).toEqual(new Date("2026-06-10T20:35:03.000000Z"));
    expect(parsedOffline?.observedAt).toEqual(new Date("2026-06-10T21:10:08.000000Z"));
  });

  it("returns null without a fan id", () => {
    expect(parseOfapiPresencePayload({ observed_at: "2026-06-10T20:01:06Z" })).toBeNull();
  });
});
