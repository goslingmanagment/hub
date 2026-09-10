import { describe, expect, it } from "vitest";
import { diagnoseFrame, diagnoseReceivedRecord, MAX_FRAME_BYTES } from "../scripts/fansly-ws/diagnostic.ts";
import {
  privateMessageEvent, received, serviceFrame, syntheticMessage, syntheticSecret, wrapped,
} from "./helpers/fansly-ws-fixtures.ts";

const key = Buffer.alloc(32, 7);
const report = (frame: string) => diagnoseFrame(frame, key);

describe("offline Fansly received-frame diagnostics", () => {
  it("excludes double-JSON outbound auth before inspecting its body", () => {
    const auth = { ...received(wrapped(1, { token: syntheticSecret })), direction: "sent" };
    expect(diagnoseReceivedRecord(auth, key)).toEqual({ excluded: "not_received" });
    const ambiguous = { ...auth, direction: "outbound" };
    expect(diagnoseReceivedRecord(ambiguous, key)).toEqual({ excluded: "not_received" });
  });

  it.each([
    "wss://other.example/", "wss://chatws.fansly.com/", "wss://wsv3.fansly.com/?v=3&token=secret",
    "wss://secret@wsv3.fansly.com/?v=3", "wss://wsv3.fansly.com/?v=3#secret",
  ])("excludes unrelated or secret-bearing endpoint %s", (url) => {
    expect(diagnoseReceivedRecord({ ...received("{}"), url }, key))
      .toEqual({ excluded: "unapproved_endpoint" });
  });

  it("distinguishes session frame, pong and WS 401 without claiming binding or changing REST", () => {
    expect(report(wrapped(1, { session: { id: syntheticSecret } })).nodes[0]?.kind)
      .toBe("session_verified_frame");
    expect(report(wrapped(2, {})).nodes[0]?.kind).toBe("pong");
    expect(report(wrapped(0, { code: 401, message: syntheticSecret })).nodes[0])
      .toEqual({ path: [], kind: "error", transportType: 0, errorCode: 401 });
    expect(report(wrapped(1, syntheticSecret)).nodes[0]?.reason).toBe("invalid_payload");
  });

  it("keeps each mixed/nested batch child visible, including unknown and invalid children", () => {
    const frame = JSON.stringify({ t: 10001, d: [
      serviceFrame(privateMessageEvent()),
      wrapped(10001, [wrapped(777, { token: syntheticSecret }), "bad-json"]),
      { serviceId: 5, event: JSON.stringify({ type: 99 }) },
    ] });
    const result = report(frame);
    expect(result.nodes.map((node) => [node.path, node.kind, node.reason])).toEqual([
      [[], "batch", undefined], [[0], "service", undefined], [[1], "batch", undefined],
      [[1, 0], "unknown", "unknown_transport"], [[1, 1], "unknown", "invalid_wrapper"],
      [[2], "candidate_inner_service", undefined],
    ]);
    expect(result.truncated).toBe(false);
  });

  it("exports only known field names and keyed business references", () => {
    const input = { ...received(serviceFrame(privateMessageEvent())), headers: { cookie: syntheticSecret } };
    const result = diagnoseReceivedRecord(input, key);
    const text = JSON.stringify(result);
    for (const secret of [syntheticMessage, syntheticSecret, "987654321098765432", input.url]) {
      expect(text).not.toContain(secret);
    }
    const event = report(input.frame).nodes[0]?.event;
    expect(event?.fields).toEqual(["type", "message"]);
    expect(event?.unknownFieldCount).toBe(2);
    const first = event?.references[0]?.pseudonym;
    const ack = report(serviceFrame({ type: 2, messageAckEvent: { messageId: "987654321098765432" } }));
    expect(ack.nodes[0]?.event?.references[0]?.pseudonym).toBe(first);
    const otherKey = diagnoseFrame(input.frame, Buffer.alloc(32, 8));
    expect(otherKey.nodes[0]?.event?.references[0]?.pseudonym).not.toBe(first);
  });

  it("does not leak auth even if a caller incorrectly labels it received", () => {
    const result = diagnoseReceivedRecord(received(wrapped(1, { token: syntheticSecret })), key);
    expect(JSON.stringify(result)).not.toContain(syntheticSecret);
    expect(JSON.stringify(result)).not.toContain('"token"');
  });

  it.each(["not-json", "null", "[]", '{"t":"secret","d":"secret"}'])(
    "reports invalid wrappers without echoing input: %s", (frame) => {
      const node = report(frame).nodes[0];
      expect(node?.reason).toBe("invalid_wrapper");
      expect(JSON.stringify(node)).not.toContain("secret");
    });

  it.each([
    wrapped(10001, {}), wrapped(10000, { serviceId: 5, event: "bad-json" }),
    wrapped(10000, { serviceId: "secret", event: { type: 1 } }),
    wrapped(10000, { serviceId: 5, event: { type: 1.5 } }), wrapped(0, { code: "401" }),
  ])("marks malformed payload as unresolved", (frame) => {
    expect(report(frame).nodes[0]?.reason).toBe("invalid_payload");
  });

  it("keeps unknown service/event numbers without claiming supported business scope", () => {
    const node = report(serviceFrame({ type: 999, privateText: syntheticMessage }, 999)).nodes[0];
    expect(node?.serviceId).toBe(999);
    expect(node?.eventType).toBe(999);
    expect(node?.event?.unknownFieldCount).toBe(1);
    expect(JSON.stringify(node)).not.toContain(syntheticMessage);
  });

  it("bounds size, nesting and node count with explicit incomplete results", () => {
    expect(report("x".repeat(MAX_FRAME_BYTES + 1)).rejected).toBe("frame_too_large");
    let frame = wrapped(2, {});
    for (let i = 0; i < 10; i++) frame = JSON.stringify({ t: 10001, d: [frame] });
    expect(report(frame).truncated).toBe(true);
    const many = JSON.stringify({ t: 10001, d: Array.from({ length: 300 }, () => wrapped(2, {})) });
    expect(report(many).nodes).toHaveLength(256);
    expect(report(many).truncated).toBe(true);
  });

  it.each(["2026-02-30T18:00:00.000Z", "secret", "2026-09-10T18:00:00Z"])(
    "rejects invalid or ambiguous timestamps", (receivedAt) => {
      expect(diagnoseReceivedRecord({ ...received("{}"), receivedAt }, key))
        .toEqual({ excluded: "invalid_record" });
    });

  it("requires a full random-key-sized pseudonymization key", () => {
    expect(() => diagnoseFrame("{}", Buffer.alloc(0))).toThrow("diagnostic_key_length");
  });
});
