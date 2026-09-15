import { describe, expect, it } from "vitest";
import { extractFanslyWsHints, type FanslyWsHintType } from "../packages/shared/src/fansly-ws-hints.ts";
import { serviceFrame, syntheticSecret, wrapped } from "./helpers/fansly-ws-fixtures.ts";

const enabled = new Set<FanslyWsHintType>(["message_created", "group_created"]);
const message = (groupId = "12", id = "34") => serviceFrame({
  type: 1, message: { groupId, id, content: syntheticSecret },
});

describe("B1 addresses from durable WS envelopes", () => {
  it("requires explicit type enablement and never exports message bodies", () => {
    expect(extractFanslyWsHints(message(), new Set())).toEqual([{ path: [], outcome: "not_enabled" }]);
    const result = extractFanslyWsHints(message(), enabled);
    expect(result).toEqual([{ path: [], outcome: "hint",
      hint: { type: "message_created", groupRef: "12", messageRef: "34" } }]);
    expect(JSON.stringify(result)).not.toContain(syntheticSecret);
  });

  it("treats a new-group ID as an address requiring REST, not a group snapshot", () => {
    expect(extractFanslyWsHints(serviceFrame({ type: 8, id: "56" }, 4), enabled))
      .toEqual([{ path: [], outcome: "hint",
        hint: { type: "group_created", groupRef: "56", messageRef: null } }]);
  });

  it("keeps old-ID and correlation-wide deletion separate from head reads", () => {
    expect(extractFanslyWsHints(serviceFrame({ type: 10,
      message: { id: "34", type: 3, correlationId: "78" } }), enabled))
      .toEqual([{ path: [], outcome: "mutation_debt", mutation: {
        messageRef: "34", groupRef: null, correlationRef: "78", bulk: true,
      } }]);
  });

  it("does not route local, alternate-shape, typing, money or session material", () => {
    for (const frame of [
      serviceFrame({ type: 22, message: { id: "34", groupId: "12" } }),
      serviceFrame({ type: 1, message: { id: "34", groupId: "12" } }, 6),
      JSON.stringify({ serviceId: 5, event: { type: 1, message: { id: "34", groupId: "12" } } }),
      wrapped(1, { token: syntheticSecret }), wrapped(2, {}),
    ]) {
      const result = extractFanslyWsHints(frame, enabled);
      expect(result.every((node) => node.outcome === "unrouted")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(syntheticSecret);
    }
  });

  it.each(["", "12/../34", "https://example.test", "x".repeat(33)])(
    "retains invalid target %s as debt without inventing an address", (value) => {
      expect(extractFanslyWsHints(message(value), enabled)).toEqual([{ path: [], outcome: "invalid" }]);
    },
  );

  it("preserves independent children when a mixed batch contains malformed material", () => {
    const result = extractFanslyWsHints(wrapped(10001, [message(), "not-json", wrapped(10001, [message("56")])]), enabled);
    expect(result.filter((node) => node.outcome === "hint").map((node) => node.hint?.groupRef)).toEqual(["12", "56"]);
    expect(result).toContainEqual({ path: [1], outcome: "invalid" });
  });

  it("bounds container traversal and keeps omitted children explicit", () => {
    let deep: unknown = JSON.parse(message());
    for (let i = 0; i < 12; i++) deep = { t: 10001, d: [deep] };
    expect(extractFanslyWsHints(JSON.stringify(deep), enabled).at(-1)?.outcome).toBe("limit");
    const many = extractFanslyWsHints(wrapped(10001, Array.from({ length: 1000 }, () => message())), enabled);
    expect(many).toHaveLength(256);
    expect(many.at(-1)?.outcome).toBe("limit");
    const nested = extractFanslyWsHints(wrapped(10001, Array.from({ length: 300 },
      () => wrapped(10001, [message(), message()]))), enabled);
    expect(nested).toHaveLength(256);
    expect(nested.at(-1)?.outcome).toBe("limit");
  });
});
