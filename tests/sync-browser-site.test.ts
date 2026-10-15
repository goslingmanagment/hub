import { describe, expect, it } from "vitest";

import type { CancelAdmit, SiteAdmit, SiteAdmitResult, SiteDone, State, WsAdmit, WsAdmitResult, WsDone } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import type { LinkStatus, PageBrowserRpcClient } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { BrowserSiteAdmission } from "../apps/runtime/src/sync/fansly/browser-site.ts";

// The site path's adapter (Project Browser PR 14) against a stub link: the
// operator's absolute wait deadline of a request (a socket's counts from its
// CONNECT) is carried, and checked again right before the grant (Astra PR 14,
// P2).

const FP = "a".repeat(64);
const CONNECTION = "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

function stubLink() {
  let other: ((message: never) => void) | null = null;
  let linkListener: ((status: LinkStatus) => void) | null = null;
  let endListener: ((end: SiteDone | WsDone) => boolean) | null = null;
  const answers: Array<SiteAdmitResult | WsAdmitResult> = [];
  const state = { mode: "automation", sessionFingerprint: FP } as unknown as State;
  const client = {
    up: true,
    epoch: 1,
    quiesced: { type: "quiesced", previousGeneration: 0, lastSendMono: null, lastSendWall: null },
    state,
    onOtherMessage(listener: ((message: never) => void) | null) {
      other = listener;
    },
    onEnd(listener: ((end: SiteDone | WsDone) => boolean) | null) { endListener = listener; },
    onLink(listener: (status: LinkStatus) => void) {
      linkListener = listener;
      return () => undefined;
    },
    answerSiteAdmit(_epoch: number, answer: Omit<SiteAdmitResult, "type" | "ownerGeneration">) {
      answers.push({ type: "siteAdmitResult", ownerGeneration: 1, ...answer } as SiteAdmitResult);
      return true;
    },
    answerWsAdmit(_epoch: number, answer: Omit<WsAdmitResult, "type" | "ownerGeneration">) {
      answers.push({ type: "wsAdmitResult", ownerGeneration: 1, ...answer } as WsAdmitResult);
      return true;
    },
    resultAck() {
      return true;
    },
  };
  return {
    client: client as unknown as PageBrowserRpcClient, answers,
    deliver: (message: WsAdmit | SiteAdmit | CancelAdmit) => other!(message as never),
    end: (message: SiteDone | WsDone) => endListener!(message),
    reconnect: () => { linkListener!({ kind: "down", reason: "test" }); client.epoch += 1; },
  };
}

function ask(kind: "site" | "ws"): SiteAdmit | WsAdmit {
  return kind === "ws"
    ? { type: "wsAdmit", connectionId: CONNECTION, url: "wss://wsv3.fansly.com/", context: "page", sessionFingerprint: FP, requestedMono: 100_000, waitDeadlineMono: 160_000 }
    : { type: "siteAdmit", siteRequestId: CONNECTION, method: "GET", host: "api", path: "/api/v1/account/me", query: "", resourceType: "XHR", route: "account.me", operation: "read", sessionFingerprint: FP, pausedMono: 100_000, waitDeadlineMono: 160_000 };
}

describe.each(["site", "ws"] as const)("pending %s withdrawal", (kind) => {
  function setup() {
    const link = stubLink();
    const site = new BrowserSiteAdmission({ client: link.client, bridge: { toKernel: (mono) => mono, fromKernel: (mono) => mono }, monoNow: () => 100_000 });
    link.deliver(ask(kind));
    return { link, site };
  }

  it("removes pending work; a duplicate ask or a late grant cannot resurrect it", async () => {
    const { link, site } = setup();
    const picked = site.pending()[0]!;
    link.deliver({ type: "cancelAdmit", kind, requestId: CONNECTION, reason: "ended" });
    link.deliver(ask(kind));
    expect(site.pending()).toEqual([]);
    expect(site.isPending(picked)).toBe(false);
    expect(site.grant(CONNECTION, { attemptId: 7, sendWithinMs: 10_000 }, picked)).toBe(false);
    expect(link.answers).toEqual([]);
    expect(await site.end(CONNECTION, new AbortController().signal)).toMatchObject({ kind: "aborted_before_send" });
  });

  it("a grant crossing the cancellation ends not sent", async () => {
    const { link, site } = setup();
    site.grant(CONNECTION, { attemptId: 7, sendWithinMs: 10_000 }, site.pending()[0]);
    const end = site.end(CONNECTION, new AbortController().signal);
    link.deliver({ type: "cancelAdmit", kind, requestId: CONNECTION, reason: "document_replaced" });
    expect(await end).toEqual({ kind: "aborted_before_send", reason: "document_replaced" });
    site.settled(CONNECTION, 7);
    link.deliver(ask(kind));
    expect(site.pending()).toEqual([]);
  });

  it("a selection before reconnect cannot grant or refuse the re-asked request", () => {
    const { link, site } = setup();
    const stale = site.pending()[0]!;
    link.reconnect();
    link.deliver(ask(kind));
    const fresh = site.pending()[0]!;
    expect(fresh).not.toBe(stale);
    expect(site.grant(CONNECTION, { attemptId: 7, sendWithinMs: 10_000 }, stale)).toBe(false);
    site.refuse(CONNECTION, "lease", stale);
    site.settled(CONNECTION, 7);
    expect(site.pending()).toEqual([fresh]);
    expect(link.answers).toEqual([]);
    expect(site.grant(CONNECTION, { attemptId: 8, sendWithinMs: 10_000 }, fresh)).toBe(true);
    expect(link.answers).toHaveLength(1);
  });

  it("settling a stale selection before the new ask arrives does not tombstone that live request", () => {
    const { link, site } = setup();
    const stale = site.pending()[0]!;
    link.reconnect();
    expect(site.grant(CONNECTION, { attemptId: 7, sendWithinMs: 10_000 }, stale)).toBe(false);
    site.settled(CONNECTION, 7, stale);
    link.deliver(ask(kind));
    expect(site.pending()).toHaveLength(1);
    expect(site.grant(CONNECTION, { attemptId: 8, sendWithinMs: 10_000 }, site.pending()[0])).toBe(true);
  });

  it("ignores a cancellation of the other kind or from a later RPC connection", () => {
    const { link, site } = setup();
    link.deliver({ type: "cancelAdmit", kind: kind === "site" ? "ws" : "site", requestId: CONNECTION, reason: "ended" });
    expect(site.pending()).toHaveLength(1);
    site.grant(CONNECTION, { attemptId: 7, sendWithinMs: 10_000 });
    link.reconnect();
    link.deliver({ type: "cancelAdmit", kind, requestId: CONNECTION, reason: "ended" });
    // A late outcome is still the granted request's; the unrelated cancel
    // must not have converted this possible send into a not-sent outcome.
    expect(link.end(kind === "ws"
      ? { type: "wsDone", connectionId: CONNECTION, attemptId: 7, sent: true, sentMono: 100_001, status: 101, error: null }
      : { type: "siteDone", siteRequestId: CONNECTION, attemptId: 7, sent: true, sentMono: 100_001, sentWall: 1, connectionReused: null, status: 200, retryAfter: null, error: null, body: "buffered" })).toBe(true);
    return expect(site.end(CONNECTION, new AbortController().signal)).resolves.toMatchObject({ kind: "response" });
  });
});

describe("the site path's wait deadline", () => {
  it("is the operator's absolute one, carried into the request", () => {
    const link = stubLink();
    const now = 100_000;
    const site = new BrowserSiteAdmission({ client: link.client, bridge: { toKernel: (mono) => mono, fromKernel: (mono) => mono }, monoNow: () => now });
    // Astra's case: the CONNECT's wait ended (99 999) before the operator asked (100 000).
    link.deliver({ type: "wsAdmit", connectionId: CONNECTION, url: "wss://wsv3.fansly.com/?v=3", context: "page", sessionFingerprint: FP, requestedMono: 100_000, waitDeadlineMono: 99_999 });
    expect(site.pending()).toEqual([expect.objectContaining({ id: CONNECTION, askedMono: 100_000, waitDeadlineMono: 99_999 })]);
  });

  it("is checked again right before the grant: a request whose wait ended meanwhile is refused and ends not sent", async () => {
    const link = stubLink();
    let now = 100_000;
    const site = new BrowserSiteAdmission({ client: link.client, bridge: { toKernel: (mono) => mono, fromKernel: (mono) => mono }, monoNow: () => now });
    link.deliver({ type: "wsAdmit", connectionId: CONNECTION, url: "wss://wsv3.fansly.com/?v=3", context: "page", sessionFingerprint: FP, requestedMono: 100_000, waitDeadlineMono: 100_050 });
    expect(site.pending().map((request) => request.id)).toEqual([CONNECTION]);
    // Chosen at 100 000; the slot's admission took 60 ms.
    now = 100_060;
    site.grant(CONNECTION, { attemptId: 7, sendWithinMs: 15_000 });
    expect(link.answers).toEqual([{ type: "wsAdmitResult", ownerGeneration: 1, connectionId: CONNECTION, admit: false, reason: "wait_expired", retryNotBeforeWall: null }]);
    expect(await site.end(CONNECTION, new AbortController().signal)).toEqual({ kind: "aborted_before_send", reason: "wait_expired" });

    // Before its deadline: granted with the send window.
    const second = "1f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    link.deliver({ type: "wsAdmit", connectionId: second, url: "wss://wsv3.fansly.com/?v=3", context: "page", sessionFingerprint: FP, requestedMono: 100_060, waitDeadlineMono: 160_000 });
    site.grant(second, { attemptId: 8, sendWithinMs: 15_000 });
    expect(link.answers.at(-1)).toEqual({ type: "wsAdmitResult", ownerGeneration: 1, connectionId: second, admit: true, deadlineMono: 115_060, attemptId: 8 });
  });
});
