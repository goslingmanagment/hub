import { describe, expect, it } from "vitest";

import type { SiteAdmitResult, State, WsAdmit, WsAdmitResult } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
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
    onEnd() {},
    onLink(_listener: (status: LinkStatus) => void) {
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
  return { client: client as unknown as PageBrowserRpcClient, answers, deliver: (message: WsAdmit) => other!(message as never) };
}

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
