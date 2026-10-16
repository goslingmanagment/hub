import { describe, expect, it } from "vitest";

import type { OperatorToEngine, SiteAdmitResult, SiteDone, State, WsDone, WsAdmitResult } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
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
  let end: ((message: SiteDone | WsDone) => boolean) | null = null;
  let onLink: ((status: LinkStatus) => void) | null = null;
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
    onEnd(listener: typeof end) { end = listener; },
    onSiteObserved() {},
    onLink(listener: (status: LinkStatus) => void) {
      onLink = listener;
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
    deliver: (message: OperatorToEngine) => other!(message as never),
    deliverEnd: (message: SiteDone | WsDone) => end!(message),
    reconnect: () => { onLink!({ kind: "down", reason: "test" }); client.epoch += 1; },
  };
}

describe("the site path's wait deadline", () => {
  it("keeps credentials distinct from held for both HTTP and socket refusals", () => {
    const link = stubLink();
    const site = new BrowserSiteAdmission({ client: link.client, bridge: { toKernel: (n) => n, fromKernel: (n) => n }, monoNow: () => 100 });
    link.deliver({ type: "siteAdmit", siteRequestId: "http-credentials", method: "GET", host: "apiv3.fansly.com", path: "/api/v1/account/me", query: "", resourceType: "XHR", route: "account.me", operation: "read", sessionFingerprint: FP, pausedMono: 100, waitDeadlineMono: 10_000 });
    link.deliver({ type: "wsAdmit", connectionId: CONNECTION, url: "wss://wsv3.fansly.com/", context: "page", sessionFingerprint: FP, requestedMono: 100, waitDeadlineMono: 10_000 });
    site.refuse("http-credentials", "credentials"); site.refuse(CONNECTION, "credentials");
    expect(link.answers.map((a) => [a.type, a.admit, a.admit ? null : a.reason])).toEqual([
      ["siteAdmitResult", false, "credentials"], ["wsAdmitResult", false, "credentials"],
    ]);
  });

  it("withdraws a pending admission by kind/id/epoch, and fences a choice from before cancellation or reconnection", () => {
    const link = stubLink();
    const site = new BrowserSiteAdmission({ client: link.client, bridge: { toKernel: (n) => n, fromKernel: (n) => n }, monoNow: () => 100 });
    const ask = { type: "wsAdmit" as const, connectionId: CONNECTION, url: "wss://wsv3.fansly.com/", context: "page" as const, sessionFingerprint: FP, requestedMono: 100, waitDeadlineMono: 10_000 };
    link.deliver(ask);
    const oldChoice = site.pending()[0]!;
    link.deliver({ type: "admissionCancel", kind: "site", id: CONNECTION, reason: "request_ended" });
    expect(site.pending()).toHaveLength(1);
    link.reconnect();
    link.deliver(ask);
    expect(site.grant(CONNECTION, { attemptId: 7, sendWithinMs: 100 }, oldChoice)).toBe(false);
    expect(site.pending()).toHaveLength(1);
    link.deliver({ type: "admissionCancel", kind: "ws", id: CONNECTION, reason: "document_replaced" });
    expect(site.pending()).toEqual([]);
    expect(site.grant(CONNECTION, { attemptId: 8, sendWithinMs: 100 })).toBe(false);
    link.deliver(ask);
    expect(site.pending()).toEqual([]);
    expect(link.answers).toEqual([]);
  });

  it("a withdrawal crossing a grant never invents an unsent result: the buffered end still decides", async () => {
    const link = stubLink();
    const site = new BrowserSiteAdmission({ client: link.client, bridge: { toKernel: (n) => n, fromKernel: (n) => n }, monoNow: () => 100 });
    link.deliver({ type: "wsAdmit", connectionId: CONNECTION, url: "wss://wsv3.fansly.com/", context: "page", sessionFingerprint: FP, requestedMono: 100, waitDeadlineMono: 10_000 });
    site.grant(CONNECTION, { attemptId: 7, sendWithinMs: 100 });
    link.deliver({ type: "admissionCancel", kind: "ws", id: CONNECTION, reason: "request_ended" });
    const ended = site.end(CONNECTION, new AbortController().signal);
    link.deliverEnd({ type: "wsDone", connectionId: CONNECTION, attemptId: 7, sent: true, sentMono: 110, status: 101, error: null });
    expect(await ended).toMatchObject({ kind: "response", status: 101 });
  });

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
