import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { sendFanslyWireRequest } from "@agency_hub_core/fansly";
import { egressScopeKey } from "@agency_hub_core/platform-core";

import {
  FANSLY_PUBLIC_API_HOST,
  FanslyPublicHostRefusedError,
  fanslyPublicEgressKey,
  isFanslyPublicOrigin,
  restrictToFanslyPublicHost,
} from "../apps/runtime/src/services/egress/fansly-public.ts";

// Arena "vanished chat" R5 (plan §7): the public reader's egress lets Fansly's
// API host through and nothing else, refusing in the dispatch itself — before
// a connection or a proxy tunnel exists. Everything here runs against undici's
// MockAgent with net connect disabled: no request leaves the process.

// undici is not a root dependency; resolve the runtime's copy (the pattern of
// tests/helpers/no-outbound.ts).
const requireFromRuntime = createRequire(new URL("../apps/runtime/package.json", import.meta.url));
interface MockInterceptor { reply(status: number, body: string): unknown }
interface MockPool { intercept(options: { path: string | ((path: string) => boolean); method: string }): MockInterceptor }
interface UndiciMockAgent {
  disableNetConnect(): void;
  get(origin: string): MockPool;
  dispatch(options: { origin?: unknown; path?: unknown }, handler: unknown): boolean;
  close(): Promise<void>;
}
const undici = requireFromRuntime("undici") as { MockAgent: new () => UndiciMockAgent };

type Dispatcher = Parameters<typeof restrictToFanslyPublicHost>[0];

let agent: UndiciMockAgent | null = null;
const dispatched: string[] = [];

afterEach(async () => {
  await agent?.close();
  agent = null;
  dispatched.length = 0;
});

function mockFansly(): Dispatcher {
  agent = new undici.MockAgent();
  agent.disableNetConnect();
  const inner = agent.dispatch.bind(agent);
  agent.dispatch = (options, handler) => {
    dispatched.push(`${String(options.origin)}${String(options.path)}`);
    return inner(options, handler);
  };
  agent.get(`https://${FANSLY_PUBLIC_API_HOST}`)
    .intercept({ path: (path) => path.startsWith("/api/v1/account?"), method: "GET" })
    .reply(200, JSON.stringify({ success: true, response: [] }));
  return agent as unknown as Dispatcher;
}

describe("the public egress's host restriction", () => {
  it("knows Fansly's API over HTTPS on its default port and nothing else", () => {
    expect(isFanslyPublicOrigin(`https://${FANSLY_PUBLIC_API_HOST}`)).toBe(true);
    expect(isFanslyPublicOrigin(`https://${FANSLY_PUBLIC_API_HOST}:443`)).toBe(true);
    for (const origin of [
      `http://${FANSLY_PUBLIC_API_HOST}`,
      `https://${FANSLY_PUBLIC_API_HOST}:8443`,
      "https://wsv3.fansly.com",
      "https://cdn3.fansly.com",
      "https://fansly.com",
      `https://${FANSLY_PUBLIC_API_HOST}.example.com`,
      `https://user:secret@${FANSLY_PUBLIC_API_HOST}`,
      "https://api.ipify.org",
      "not a url",
    ]) {
      expect(isFanslyPublicOrigin(origin), origin).toBe(false);
    }
  });

  it("refuses another origin in the dispatch itself — nothing reaches the transport — and lets Fansly's API through", async () => {
    const restricted = restrictToFanslyPublicHost(mockFansly());
    for (const origin of ["https://api.ipify.org", "https://wsv3.fansly.com", `http://${FANSLY_PUBLIC_API_HOST}`]) {
      await expect(restricted.request({ origin, path: "/", method: "GET" })).rejects.toBeInstanceOf(FanslyPublicHostRefusedError);
    }
    expect(dispatched).toEqual([]);

    const served = await restricted.request({
      origin: `https://${FANSLY_PUBLIC_API_HOST}`,
      path: "/api/v1/account?ngsw-bypass=true&ids=1",
      method: "GET",
    });
    expect(served.statusCode).toBe(200);
    expect(await served.body.text()).toBe(JSON.stringify({ success: true, response: [] }));
    expect(dispatched).toEqual([`https://${FANSLY_PUBLIC_API_HOST}/api/v1/account?ngsw-bypass=true&ids=1`]);
  });

  it("makes a wire send to another host an unsent transport error, its send check never asked", async () => {
    const restricted = restrictToFanslyPublicHost(mockFansly());
    let asked = 0;
    const outcome = await sendFanslyWireRequest(restricted, {
      url: "https://api.ipify.org/?format=json",
      headers: {},
      timeoutMs: 2_000,
    }, { check: () => { asked += 1; return null; } }, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: "transport_error", sent: false });
    expect(asked).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("has its own scope and egress key, never a page's", () => {
    expect(egressScopeKey({ kind: "fansly_public" })).toBe("fansly-public");
    expect(fanslyPublicEgressKey({ url: "socks5://proxy.example.internal:1080" }))
      .toBe("fansly-public:socks5://proxy.example.internal:1080");
  });
});
