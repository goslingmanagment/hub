import { describe, expect, it } from "vitest";
import { compareDiagnosticReports } from "../scripts/fansly-ws/compare.ts";
import { correlationKeyFingerprint } from "../scripts/fansly-ws/correlation-key.ts";
import { diagnoseFrame } from "../scripts/fansly-ws/diagnostic.ts";
import { privateMessageEvent, serviceFrame, syntheticSecret, wrapped } from "./helpers/fansly-ws-fixtures.ts";

const key = Buffer.alloc(32, 7);
const start = "2026-09-10T18:00:00.000Z";
const end = "2026-09-10T18:02:00.000Z";
const windows = { left: { from: start, to: end }, right: { from: start, to: end } };
const receipt = (frame: string, receivedAt = start) => ({ receivedAt, diagnostic: diagnoseFrame(frame, key) });
const report = (records: unknown[], fingerprint = correlationKeyFingerprint(key)) => ({
  schemaVersion: 1, evidenceKind: "offline_diagnostic", correlationKeyFingerprint: fingerprint, records,
});
const message = () => receipt(serviceFrame(privateMessageEvent()));

describe("Fansly received-reference comparison", () => {
  it("finds candidate entities without asserting event identity, independent receivers or fan-out", () => {
    const captured = report([message()]);
    const result = compareDiagnosticReports(captured, captured, windows);
    expect(result).toMatchObject({
      comparisonState: "candidate_entity_correspondence", matchingReferences: 1,
      leftOnlyReferences: 0, rightOnlyReferences: 0, receiverIndependence: "unverified",
      fanOut: "unverified", accountBinding: "unverified", readerLatencyMeasured: false,
    });
    expect(result.matches[0]).toMatchObject({ field: "message.id", leftOccurrences: 1, rightOccurrences: 1 });
  });

  it("requires equal actual key fingerprints, including for empty reports", () => {
    expect(() => compareDiagnosticReports(report([]), report([], correlationKeyFingerprint(Buffer.alloc(32, 8))), windows))
      .toThrow("different_correlation_keys");
    expect(() => compareDiagnosticReports(report([]), { ...report([]), correlationKeyFingerprint: undefined }, windows))
      .toThrow("incompatible_diagnostic_report");
  });

  it.each([
    { name: "empty", records: [] },
    { name: "control only", records: [receipt(wrapped(1, {})), receipt(wrapped(2, {}))] },
    { name: "unknown", records: [receipt(wrapped(123, {}))] },
    { name: "reference-free service", records: [receipt(serviceFrame({ type: 2 }, 4))] },
  ])("keeps $name input inconclusive", ({ records }) => {
    expect(compareDiagnosticReports(report(records), report(records), windows)).toMatchObject({
      comparisonState: "inconclusive", matchingReferences: 0, fanOut: "unverified",
    });
  });

  it("does not match different messages sharing a group, or group-only services", () => {
    const other = privateMessageEvent();
    other.message.id = "987654321098765433";
    const result = compareDiagnosticReports(report([message()]), report([receipt(serviceFrame(other))]), windows);
    expect(result).toMatchObject({ matchingReferences: 0, leftOnlyReferences: 1, rightOnlyReferences: 1 });
    const group = report([receipt(serviceFrame({ type: 1, group: { id: "123" } }))]);
    expect(compareDiagnosticReports(group, group, windows)).toMatchObject({
      matchingReferences: 0, left: { unmatchableServices: 1 },
    });
  });

  it.each([{ name: "event type", type: 2, service: 5 }, { name: "service", type: 1, service: 6 }])(
    "keeps $name in the correspondence key", ({ type, service }) => {
      const other = receipt(serviceFrame({ ...privateMessageEvent(), type }, service));
      expect(compareDiagnosticReports(report([message()]), report([other]), windows).matchingReferences).toBe(0);
    },
  );

  it("retains repeated references as ambiguous instead of greedily pairing occurrences", () => {
    const changed = privateMessageEvent();
    changed.message.content = "a later version of the same entity";
    const result = compareDiagnosticReports(
      report([message(), receipt(serviceFrame(changed))]), report([message()]), windows,
    );
    expect(result).toMatchObject({ matchingReferences: 1, ambiguousReferences: 1, fanOut: "unverified" });
    expect(result.matches[0]).toMatchObject({ leftOccurrences: 2, rightOccurrences: 1, ambiguousOccurrences: true });
  });

  it("uses only the half-open overlap; outside records are not reported as missing", () => {
    const from = "2026-09-10T18:00:30.000Z";
    const to = "2026-09-10T18:01:00.000Z";
    const interval = { left: { from: start, to }, right: { from, to: end } };
    const left = report([message(), receipt(serviceFrame(privateMessageEvent()), from), receipt(serviceFrame(privateMessageEvent()), to)]);
    const right = report([receipt(serviceFrame(privateMessageEvent()), from)]);
    expect(compareDiagnosticReports(left, right, interval)).toMatchObject({
      comparisonWindow: { from, to }, matchingReferences: 1, leftOnlyReferences: 0,
      left: { inWindow: 1, outsideWindow: 2 },
    });
  });

  it.each([
    { name: "disjoint", input: { left: { from: start, to: end }, right: { from: end, to: "2026-09-10T18:03:00.000Z" } } },
    { name: "missing", input: {} },
    { name: "invalid", input: { left: { from: syntheticSecret, to: end }, right: windows.right } },
  ])("rejects $name observation windows without exporting input", ({ input }) => {
    expect(() => compareDiagnosticReports(report([]), report([]), input)).toThrow();
    try { compareDiagnosticReports(report([]), report([]), input); }
    catch (error) { expect(String(error)).not.toContain(syntheticSecret); }
  });

  it("rejects a declared window extending beyond the actual probe", () => {
    const live = { ...report([]), evidenceKind: "live_socket_probe", observation: {
      startedAt: "2026-09-10T18:00:30.000Z", finishedAt: end, records: [message()],
    } };
    expect(() => compareDiagnosticReports(report([message()]), live, windows))
      .toThrow("window_outside_probe_observation");
  });

  it("keeps a probe's dropped frame visible beside its retained matching reference", () => {
    const live = { ...report([]), evidenceKind: "live_socket_probe", observation: {
      startedAt: start, finishedAt: end, records: [message()], framesReceived: 2,
      framesRetained: 1, stopReason: "frame_limit",
    } };
    expect(compareDiagnosticReports(report([message()]), live, windows)).toMatchObject({
      matchingReferences: 1, incompleteInput: true,
      right: { missingReceipts: 1, interrupted: true }, fanOut: "unverified",
    });
    live.observation.framesRetained = 2;
    expect(() => compareDiagnosticReports(report([message()]), live, windows))
      .toThrow("inconsistent_probe_receipts");
  });

  it("keeps exclusions, corruption and truncated frames explicit alongside valid candidates", () => {
    const partial = message();
    partial.diagnostic.truncated = true;
    const left = report([message(), partial, { excluded: syntheticSecret }, { receivedAt: syntheticSecret }]);
    expect(compareDiagnosticReports(left, report([message()]), windows)).toMatchObject({
      matchingReferences: 1, incompleteInput: true, fanOut: "unverified",
      left: { partial: 1, excluded: 1, invalid: 1 },
    });
  });

  it("never copies arbitrary report, node, header or correspondence fields", () => {
    const input = report([message()]);
    const contaminated = { ...input, [syntheticSecret]: syntheticSecret, url: syntheticSecret, token: syntheticSecret };
    const output = JSON.stringify(compareDiagnosticReports(contaminated, contaminated, windows));
    expect(output).not.toContain(syntheticSecret);
    expect(output).not.toContain("SYNTHETIC_PRIVATE_CORRESPONDENCE");
    expect(output).not.toContain("987654321098765432");
    expect(output).not.toContain(key.toString("hex"));
  });
});
