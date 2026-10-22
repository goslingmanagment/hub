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
// operator would only refuse, and nothing reaches the operator. The page's
// saved settings are still compared with the hello's meanwhile: a proxy the
// owner fixed reaches the operator during the hold, not after it.

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

  /** A transport over a stub of the operator's link: what `prepare` reads
   *  of the page's settings, says again, registers or sends is counted; the
   *  database is never to be touched. */
  async function transportOver(initial: State, settings: { hello: string; saved: string }) {
    const seen = { digestReads: 0, reconnects: 0, touched: 0 };
    const touched = () => {
      seen.touched += 1;
      throw new Error("not expected here");
    };
    const client = {
      state: initial,
      status: { kind: "up" },
      up: true,
      quiesced: { type: "quiesced", previousGeneration: 0, lastSendMono: null, lastSendWall: null },
      get helloDigest() {
        return settings.hello;
      },
      settingsDigestNow: async () => {
        seen.digestReads += 1;
        return settings.saved;
      },
      reconnect: () => {
        seen.reconnects += 1;
        settings.hello = settings.saved;
      },
      start: () => undefined,
      close: async () => undefined,
      onLink: () => () => undefined,
      onUnclaimedResult: () => undefined,
      onUnclaimedOutcome: () => undefined,
      register: touched,
      send: touched,
    };
    const db = new Proxy({}, { get: () => touched }) as unknown as Database;
    const transport = await createBrowserPageTransport({ db, config: {} as AppConfig }, { pageId: 7 }, { client: client as unknown as PageBrowserRpcClient });
    return { transport, client, seen };
  }

  const plan = { spec: "polls" as const, params: {} };
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

  it("prepare refuses before the admission: nothing is registered or sent, no database is touched, and it takes requests again once the state says so", async () => {
    const { transport, client, seen } = await transportOver(state(blocked("exit_ip_unknown")), { hello: "d1", saved: "d1" });
    const refused = await refusal(transport.prepare(plan));
    expect(refused).toBeInstanceOf(PageTransportUnavailableError);
    expect(refused).toMatchObject({ code: "unavailable", reason: expect.stringContaining("exit_ip_unknown") });
    expect(seen).toMatchObject({ reconnects: 0, touched: 0 });
    // The operator confirmed the pinned IP: prepare goes past the refusal,
    // to the request itself (the snapshot's database read — the stub's end).
    client.state = state({ allowed: true, reason: null, sinceWall: null });
    const next = await refusal(transport.prepare(plan));
    expect(next).not.toBeInstanceOf(PageTransportUnavailableError);
    expect(seen.touched).toBeGreaterThan(0);
    await transport.close();
  });

  it("while held, settings the owner changed still reach the operator: a new hello, and still nothing admitted, registered or sent", async () => {
    const settings = { hello: "the broken proxy", saved: "the broken proxy" };
    const { transport, seen } = await transportOver(state(blocked("exit_ip_unknown")), settings);
    await refusal(transport.prepare(plan));
    expect(seen).toMatchObject({ digestReads: 1, reconnects: 0, touched: 0 });
    // The owner saves a working proxy.
    settings.saved = "the working proxy";
    for (let i = 0; i < 3; i += 1) expect(await refusal(transport.prepare(plan))).toMatchObject({ reason: expect.stringContaining("exit_ip_unknown") });
    // Said again once: the next looks find the hello current.
    expect(seen).toMatchObject({ digestReads: 4, reconnects: 1, touched: 0 });
    await transport.close();
  });
});
