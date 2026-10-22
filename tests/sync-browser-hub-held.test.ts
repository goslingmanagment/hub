import { describe, expect, it } from "vitest";

import type { AppConfig } from "@agency_hub_core/shared";
import type { Database } from "@agency_hub_core/db";

import type { PageBrowserRpcClient } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import type { HubSendBlock, State } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import { PageTransportUnavailableError } from "../apps/runtime/src/sync/engine/ports.ts";
import { browserNotTaking, createBrowserPageTransport } from "../apps/runtime/src/sync/fansly/browser-transport.ts";

// While the page's operator holds Hub's requests for a reason of its own
// (`state.hubSend`: its exit IP unknown, a client header the site computes
// otherwise, …) — which can last hours — the engine admits nothing: `prepare`
// refuses before the admission, so no attempt row is written for a send the
// operator would only refuse, and nothing reaches the operator.

function state(hubSend: State["hubSend"]): State {
  return {
    type: "state",
    step: "ready",
    stopReason: null,
    retryAtWall: null,
    exitOpen: true,
    mode: "automation",
    sessionFingerprint: "a".repeat(64),
    accountId: "123",
    exitIp: "203.0.113.7",
    chromeVersion: "155.0",
    operatorVersion: "1",
    buffer: { bytes: 0, oldestAgeMs: 0 },
    selfTest: null,
    ...(hubSend === undefined ? {} : { hubSend }),
  };
}

const blocked = (reason: HubSendBlock): State["hubSend"] => ({ allowed: false, reason, sinceWall: Date.now() - 60_000 });

describe("a page's browser that holds Hub's requests", () => {
  it("takes none while the operator holds them for its own reason; the start's own steps and an older operator are judged as before", () => {
    for (const reason of ["exit_ip_unknown", "client_check", "header_parity", "manual_login", "buffer"] as const) {
      expect(browserNotTaking(state(blocked(reason)))).not.toBeNull();
    }
    // The start's steps the engine's own requests (the identity read) and the
    // site's make pass.
    for (const reason of ["no_template", "site_not_loaded"] as const) expect(browserNotTaking(state(blocked(reason)))).toBeNull();
    expect(browserNotTaking(state({ allowed: true, reason: null, sinceWall: null }))).toBeNull();
    // An operator before minor 5 says nothing of it.
    expect(browserNotTaking(state(undefined))).toBeNull();
  });

  it("prepare refuses before the admission: nothing is registered or sent, no database is read, and it takes requests again once the state says so", async () => {
    let calls = 0;
    const touched = () => {
      calls += 1;
      throw new Error("not expected here");
    };
    const client = {
      state: state(blocked("exit_ip_unknown")),
      status: { kind: "up" },
      up: true,
      quiesced: { type: "quiesced", previousGeneration: 0, lastSendMono: null, lastSendWall: null },
      helloDigest: "d",
      start: () => undefined,
      close: async () => undefined,
      onLink: () => () => undefined,
      onUnclaimedResult: () => undefined,
      onUnclaimedOutcome: () => undefined,
      register: touched,
      send: touched,
      // Past the refusal the first thing prepare does is read the settings
      // the hello carried: a refusal of its own here shows it got that far.
      settingsDigestNow: async () => {
        throw new Error("the settings are not read in this test");
      },
    };
    const db = new Proxy({}, { get: () => touched }) as unknown as Database;
    const transport = await createBrowserPageTransport({ db, config: {} as AppConfig }, { pageId: 7 }, { client: client as unknown as PageBrowserRpcClient });
    const plan = { spec: "polls" as const, params: {} };

    const refused = await transport.prepare(plan).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(PageTransportUnavailableError);
    expect(refused).toMatchObject({ code: "unavailable", reason: expect.stringContaining("exit_ip_unknown") });
    expect(calls).toBe(0);

    // The operator confirmed the pinned IP: prepare goes on to the hello's
    // settings (and no further here).
    client.state = state({ allowed: true, reason: null, sinceWall: null });
    const next = await transport.prepare(plan).then(() => null, (error: unknown) => error);
    expect(next).toBeInstanceOf(PageTransportUnavailableError);
    expect((next as PageTransportUnavailableError).reason).not.toContain("exit_ip_unknown");
    expect(calls).toBe(0);
    await transport.close();
  });
});
