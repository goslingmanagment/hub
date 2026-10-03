import { describe, expect, it } from "vitest";

import type { DmParityArchiveState, DmParityFullRow, DmParityHotState, DmParityRefState } from "@agency_hub_core/db";

import {
  compareFullRow,
  compareMessageWindows,
  differingFields,
  extraThreads,
  oneSidedIds,
  ParityLedger,
  parityVerdict,
  PARITY_PERSISTENCE_MS,
  presenceFinding,
  toSecond,
  type ParityMessage,
  type ParityPlace,
} from "../apps/runtime/src/sync/parity/classify.ts";

// Step 4, S4-06 (owner decision №11): the pure classifier of the DM reader
// parity — every class from one window comparison, the presence table, the
// --full row judgement, the persistence rule and the verdict.

const CHAT = "800000000000000001";
const OTHER_CHAT = "800000000000000002";

function state(ref: string, hot: DmParityHotState, archive: DmParityArchiveState, chats: {
  hot?: string; archive?: string;
} = {}): DmParityRefState {
  return {
    ref,
    hot,
    archive,
    hotConversationRef: hot === "other_conversation" ? chats.hot ?? OTHER_CHAT : null,
    archiveConversationRef: archive === "other_conversation" ? chats.archive ?? OTHER_CHAT : null,
  };
}

function message(id: string, input: {
  provenance?: "rest" | "live" | null; deleted?: boolean; text?: string; tip?: number; at?: string;
} = {}): ParityMessage {
  return {
    id,
    provenance: input.provenance === undefined ? "rest" : input.provenance,
    deleted: input.deleted ?? false,
    fields: { senderRole: "fan", text: input.text ?? `text ${id}`, createdAt: input.at ?? "2026-10-03T10:00:00Z", tipCents: input.tip ?? 0 },
  };
}

describe("presenceFinding: what one store holding a message live means", () => {
  it.each([
    ["live", "live", null],
    ["live", "absent", ["missing_in_archive", "row"]],
    ["live", "not_stored", ["missing_in_archive", "row"]],
    ["live", "deleted", ["extra_in_archive", "deletion"]],
    ["deleted", "live", ["missing_in_archive", "deletion"]],
    ["absent", "live", ["extra_in_archive", "row"]],
    ["deleted", "absent", ["missing_in_archive", "row"]],
    ["deleted", "not_stored", ["missing_in_archive", "row"]],
    ["absent", "deleted", ["extra_in_archive", "deletion"]],
    ["deleted", "deleted", null],
    ["absent", "absent", null],
  ] as Array<[DmParityHotState, DmParityArchiveState, [string, string] | null]>)("hot %s, archive %s", (hot, archive, expected) => {
    const finding = presenceFinding(state("1", hot, archive), CHAT);
    expect(finding === null ? null : [finding.class, finding.aspect]).toEqual(expected);
  });

  it("a message filed under another chat by one store is a conversation mismatch", () => {
    expect(presenceFinding(state("1", "live", "other_conversation"), CHAT)).toEqual({
      class: "field_mismatch", messageId: "1", aspect: "conversation", hot: CHAT, archive: OTHER_CHAT,
    });
    expect(presenceFinding(state("1", "other_conversation", "absent"), CHAT)).toEqual({
      class: "field_mismatch", messageId: "1", aspect: "conversation", hot: OTHER_CHAT, archive: null,
    });
    // Both stores agree it is another chat's message: nothing to report here.
    expect(presenceFinding(state("1", "other_conversation", "other_conversation"), CHAT)).toBeNull();
  });
});

describe("compareMessageWindows: one reader, both stores, one snapshot", () => {
  it("identical windows agree", () => {
    const window = [message("3"), message("2"), message("1")];
    expect(compareMessageWindows(window, window.map((row) => ({ ...row })), new Map(), CHAT)).toEqual({
      findings: [], shifted: 0,
    });
  });

  it("classifies every difference: field, REST copy, deletion, presence, shift and ties", () => {
    const hot = [
      message("9", { provenance: "rest" }), // the archive shows the socket copy: no REST copy there yet
      message("8", { provenance: "live" }), // the archive holds a REST copy the hot table lacks
      message("7", { text: "hello" }), // a field differs
      message("6", { deleted: true }), // the hot table deleted it, the archive did not
      message("5"), // only the hot window: the archive lacks it
      message("4"), // only the hot window: the archive holds it (pushed out)
      message("2"), // tie: order differs
      message("1"),
    ];
    const archive = [
      message("10"), // only the archive window: an archive-only row
      message("9", { provenance: "live" }),
      message("8", { provenance: "rest" }),
      message("7", { text: "hello!" }),
      message("6"),
      message("1"),
      message("2"),
    ];
    expect(oneSidedIds(hot, archive)).toEqual(["5", "4", "10"]);
    const states = new Map([
      ["5", state("5", "live", "absent")],
      ["4", state("4", "live", "live")],
      ["10", state("10", "absent", "live")],
    ]);
    const { findings, shifted } = compareMessageWindows(hot, archive, states, CHAT);
    expect(shifted).toBe(1);
    expect(findings.map((finding) => [finding.class, finding.messageId, finding.aspect])).toEqual([
      ["missing_in_archive", "9", "rest_copy"],
      ["extra_in_archive", "8", "rest_copy"],
      ["field_mismatch", "7", "text"],
      ["missing_in_archive", "6", "deletion"],
      ["missing_in_archive", "5", "row"],
      ["extra_in_archive", "10", "row"],
      ["tie_order", "2", "order"],
      ["tie_order", "1", "order"],
    ]);
    expect(findings.find((finding) => finding.messageId === "7")).toMatchObject({ hot: "hello", archive: "hello!" });
  });

  it("refuses a one-sided message whose store state was not read", () => {
    expect(() => compareMessageWindows([message("1")], [], new Map(), CHAT)).toThrow(/No store state for message 1/);
  });

  it("differingFields lists thread values that differ, nulls equal to missing keys", () => {
    expect(differingFields({ count: 3, oldest: "1", gone: null }, { count: 4, oldest: "1" })).toEqual([
      { field: "count", hot: 3, archive: 4 },
    ]);
  });

  it("toSecond serves the instant to the second", () => {
    expect(toSecond(new Date("2026-10-03T10:00:00.999Z"))).toBe("2026-10-03T10:00:00Z");
    expect(toSecond(null)).toBeNull();
  });
});

describe("compareFullRow: one hot row against its archive row", () => {
  const base: DmParityFullRow = {
    hotId: 1,
    pageId: 4,
    threadId: 10,
    conversationRef: CHAT,
    ref: "900",
    hot: {
      deleted: false,
      senderRole: "fan",
      senderId: "700",
      createdAt: new Date("2026-10-03T10:00:00.400Z"),
      content: "  hi <br> there ",
      tipCents: 499,
      opened: false,
    },
    archive: {
      conversationRef: CHAT,
      deleted: false,
      stored: true,
      senderRole: "fan",
      senderId: "700",
      occurredAt: new Date("2026-10-03T10:00:00.400Z"),
      textPlain: "hi\nthere",
      tipMills: "4990",
      isOpened: null,
    },
  };

  it("agrees on the served values (text normalized, tip mills→cents)", () => {
    expect(compareFullRow(base)).toEqual([]);
  });

  it("finds a missing archive row, a deletion only one side has, and another chat", () => {
    expect(compareFullRow({ ...base, archive: null })).toEqual([
      { class: "missing_in_archive", messageId: "900", aspect: "row", hot: "live", archive: "absent" },
    ]);
    expect(compareFullRow({ ...base, hot: { ...base.hot, deleted: true } })[0]).toMatchObject({
      class: "missing_in_archive", aspect: "deletion",
    });
    expect(compareFullRow({ ...base, archive: { ...base.archive!, deleted: true } })[0]).toMatchObject({
      class: "extra_in_archive", aspect: "deletion",
    });
    expect(compareFullRow({ ...base, archive: { ...base.archive!, conversationRef: OTHER_CHAT } })).toEqual([
      { class: "field_mismatch", messageId: "900", aspect: "conversation", hot: CHAT, archive: OTHER_CHAT },
    ]);
  });

  it("finds the fields the readers would serve differently", () => {
    const findings = compareFullRow({
      ...base,
      hot: { ...base.hot, opened: true },
      archive: { ...base.archive!, senderRole: "model", tipMills: "5000", occurredAt: new Date("2026-10-03T10:00:01Z") },
    });
    expect(findings.map((finding) => [finding.aspect, finding.hot, finding.archive])).toEqual([
      ["senderRole", "fan", "model"],
      ["createdAt", "2026-10-03T10:00:00Z", "2026-10-03T10:00:01Z"],
      ["tipCents", 499, 500],
      ["isOpened", true, false],
    ]);
  });
});

describe("the ledger: persistence, rechecks and the verdict", () => {
  const t0 = new Date("2026-10-03T12:00:00Z");
  const after = (ms: number) => new Date(t0.getTime() + ms);
  const place = (reader: ParityPlace["reader"]): ParityPlace => ({
    pageId: 4, pageLabel: "lilly-1", threadId: 10, conversationRef: CHAT, reader,
  });
  const missing = { class: "missing_in_archive" as const, messageId: "5", aspect: "row", hot: "live", archive: "absent" };

  it("a missing message persists only when still seen ≥ 2 min after first", () => {
    const ledger = new ParityLedger();
    ledger.record(place("A1.messages@25"), missing, t0);
    ledger.record(place("A3.transcript"), missing, after(60_000));
    expect(ledger.openMissing()).toHaveLength(1);
    expect(ledger.dueRechecks(after(60_000))).toEqual([]);
    ledger.record(place("A1.messages@25"), missing, after(PARITY_PERSISTENCE_MS));
    const [item] = ledger.items();
    expect(item).toMatchObject({ status: "persistent", observations: 3, readers: ["A1.messages@25", "A3.transcript"] });
    expect(ledger.openMissing()).toEqual([]);
  });

  it("a recheck resolves a message the archive caught up with; seen again, it is a new episode", () => {
    const ledger = new ParityLedger();
    ledger.record(place("A4.summary"), missing, t0);
    const [due] = ledger.dueRechecks(after(PARITY_PERSISTENCE_MS));
    ledger.decide(due!, false, after(PARITY_PERSISTENCE_MS));
    expect(ledger.items()[0]).toMatchObject({ status: "resolved" });
    ledger.record(place("A4.summary"), missing, after(10 * 60_000));
    expect(ledger.items()[0]).toMatchObject({ status: "open", firstSeenAt: after(10 * 60_000).toISOString() });
  });

  it("counts classes by reader and page, lists the archive-only threads, and judges the run", () => {
    const ledger = new ParityLedger();
    for (const id of ["10", "11"]) {
      ledger.record(place("A1.messages@100"), {
        class: "extra_in_archive", messageId: id, aspect: "row", hot: "absent", archive: "live",
      }, t0);
      ledger.record(place("A4.summary"), {
        class: "extra_in_archive", messageId: id, aspect: "row", hot: "absent", archive: "live",
      }, t0);
    }
    ledger.record(place("A4.summary"), {
      class: "extra_in_archive", messageId: "12", aspect: "row", hot: "absent", archive: "live",
    }, t0);
    ledger.record(place("A1.messages@25"), { class: "tie_order", messageId: "2", aspect: "order", hot: 0, archive: 1 }, t0);
    ledger.recordShift("A1.messages@100", 2);
    ledger.recordDrift(place("A4.summary"), "lastFanMessageAt", "2026-10-03T09:00:00.000Z", "2026-10-03T08:00:00.000Z");

    const classes = ledger.classes();
    expect(classes.extra_in_archive).toMatchObject({ total: 3, byReader: { "A1.messages@100": 2, "A4.summary": 3 }, byPage: { "lilly-1": 3 } });
    expect(classes.tie_order.total).toBe(1);
    expect(classes.missing_in_archive).toMatchObject({ total: 0, persistent: 0, resolved: 0, open: 0 });
    expect(extraThreads(ledger.items())).toEqual([{
      pageLabel: "lilly-1", threadId: 10, conversationRef: CHAT, messages: 3, byReader: { "A1.messages@100": 2, "A4.summary": 3 },
    }]);
    expect(ledger.shifts()).toEqual({ "A1.messages@100": 2 });
    expect(ledger.drift()).toHaveLength(1);
    // Extra rows, ties and drift do not fail the parity.
    expect(parityVerdict({ classes, fullRequested: false, fullCompleted: false })).toEqual({ verdict: "pass", failReasons: [] });

    ledger.record(place("A2.preview@25"), { class: "field_mismatch", messageId: "7", aspect: "text", hot: "a", archive: "b" }, t0);
    ledger.record(place("A1.messages@25"), missing, t0);
    ledger.record(place("A1.messages@25"), missing, after(PARITY_PERSISTENCE_MS));
    const failed = parityVerdict({ classes: ledger.classes(), fullRequested: true, fullCompleted: false });
    expect(failed).toEqual({
      verdict: "fail",
      failReasons: ["1 persistent missing_in_archive", "1 field_mismatch", "--full did not finish"],
    });
  });
});
