import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareContinuityObservation } from "../scripts/fansly-ws/compare-continuity.ts";
import { correlationKeyFingerprint } from "../scripts/fansly-ws/correlation-key.ts";
import { diagnoseFrame } from "../scripts/fansly-ws/diagnostic.ts";
import { readPrivateLines } from "../scripts/fansly-ws/private-lines.ts";
import { privateMessageEvent, serviceFrame, syntheticSecret, wrapped } from "./helpers/fansly-ws-fixtures.ts";

const execute = promisify(execFile);
const key = Buffer.alloc(32, 7);
const from = "2026-09-16T00:00:00.000Z";
const to = "2026-09-16T06:00:00.000Z";
const connectionId = "12345678-1234-4123-8123-123456789abc";
const window = { from, to: "2026-09-16T00:01:00.000Z" };
const windows = { left: window, right: window };
const diagnostic = diagnoseFrame(serviceFrame(privateMessageEvent()), key);
const browser = { schemaVersion: 1, evidenceKind: "offline_diagnostic",
  correlationKeyFingerprint: correlationKeyFingerprint(key), records: [{ receivedAt: from, diagnostic }] };
type InputRecord = Record<string, unknown>;
let directory: string;
let path: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "continuity-compare-")); path = join(directory, "receipts.jsonl"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function records(): InputRecord[] {
  return [
    { kind: "started", schemaVersion: 1, evidenceKind: "w0_continuity_observation", pageLabel: "lilly-1",
      phase: "continuous", connectionId, credentialRouteGeneration: "a".repeat(64),
      correlationKeyFingerprint: correlationKeyFingerprint(key), elapsedMs: 0 },
    { kind: "frame", connectionId, receivedAt: from, diagnostic, elapsedMs: 1 },
    { kind: "generation_check", state: "unchanged", startedAt: from, finishedAt: from, elapsedMs: 2 },
    { kind: "finished", collectionCompleted: true, elapsedMs: 21_600_001,
      observation: { startedAt: from, finishedAt: to, stopReason: "deadline", sessionFrameSeen: true,
        sessionObservedMs: 21_600_000, framesReceived: 1, framesRetained: 1 },
      finalGeneration: { state: "unchanged", startedAt: to, finishedAt: to } },
  ];
}

async function save(input = records()) {
  const text = input.map((row, index) => JSON.stringify({ recordedAt: from, ordinal: index + 1, ...row }) + "\n").join("");
  await writeFile(path, text, { mode: 0o600 });
  return text;
}

describe("continuity phase comparison", () => {
  it("compares native long metadata and retains exact-byte provenance without accepting live gates", async () => {
    const text = await save();
    const result = await compareContinuityObservation(browser, path, windows);
    expect(result).toMatchObject({ matchingReferences: 1, fanOut: "unverified",
      captureCompleteness: "unverified", readerLatencyMeasured: false,
      rightEvidence: { evidenceKind: "w0_continuity_observation", phase: "continuous", frames: 1,
        records: 4, selectedFrames: 1, collectionReceiptValidated: true,
        sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text),
        hostOutputSync: "unverified", cleanup: "unverified", plannedGaps: "unverified" } });
  });

  it("validates more than 10,000 whole-phase frames while retaining only the declared half-open window", async () => {
    const rows = records();
    const tail = rows.pop()!;
    const pong = diagnoseFrame(wrapped(2, {}), key);
    for (let index = 0; index < 10_010; index++) rows.push({ kind: "frame", connectionId,
      receivedAt: window.to, diagnostic: pong, elapsedMs: index + 3 });
    (tail.observation as InputRecord).framesReceived = 10_011;
    (tail.observation as InputRecord).framesRetained = 10_011;
    rows.push(tail);
    await save(rows);
    expect(await compareContinuityObservation(browser, path, { left: window, right: { from, to } })).toMatchObject({ matchingReferences: 1,
      right: { records: 1, inWindow: 1 }, rightEvidence: { frames: 10_011, selectedFrames: 1,
        framesOutsideComparisonWindow: 10_010 } });
  });

  it.each([
    ["missing terminal", (r: InputRecord[]) => { r.pop(); }],
    ["duplicate terminal", (r: InputRecord[]) => { r.push(r.at(-1)!); }],
    ["ordinal gap", (r: InputRecord[]) => { r[1]!.ordinal = 3; }],
    ["backwards monotonic time", (r: InputRecord[]) => { r[2]!.elapsedMs = 0; }],
    ["mixed connection", (r: InputRecord[]) => { r[1]!.connectionId = "23456789-1234-4123-8123-123456789abc"; }],
    ["generation failure", (r: InputRecord[]) => { r[2]!.state = "changed"; }],
    ["unknown record", (r: InputRecord[]) => { r[2]!.kind = "secret"; }],
    ["invalid phase", (r: InputRecord[]) => { r[0]!.phase = "prototype"; }],
    ["wrong page", (r: InputRecord[]) => { r[0]!.pageLabel = "ari-1"; }],
    ["false completion", (r: InputRecord[]) => { r[3]!.collectionCompleted = false; }],
    ["missing frame", (r: InputRecord[]) => { (r[3]!.observation as InputRecord).framesReceived = 2; }],
    ["short duration", (r: InputRecord[]) => { (r[3]!.observation as InputRecord).sessionObservedMs = 120_000; }],
    ["impossible duration", (r: InputRecord[]) => { r[3]!.elapsedMs = 3; }],
    ["final generation failure", (r: InputRecord[]) => { (r[3]!.finalGeneration as InputRecord).state = "unavailable"; }],
  ])("rejects %s even outside the selected window", async (_name, mutate) => {
    const rows = records(); mutate(rows); await save(rows);
    await expect(compareContinuityObservation(browser, path, windows)).rejects.toThrow();
  });

  it("requires a whole complete phase and matching keys even for an empty comparison window", async () => {
    await save();
    const empty = { from: "2026-09-16T00:02:00.000Z", to: "2026-09-16T00:03:00.000Z" };
    expect(await compareContinuityObservation(browser, path, { left: empty, right: empty }))
      .toMatchObject({ matchingReferences: 0, comparisonState: "inconclusive" });
    await expect(compareContinuityObservation({ ...browser, correlationKeyFingerprint: "b".repeat(64) }, path, windows))
      .rejects.toThrow("different_correlation_keys");
    await expect(compareContinuityObservation(browser, path, { left: window, right: { from, to: "2026-09-17T00:00:00.000Z" } }))
      .rejects.toThrow("window_outside_continuity_observation");
  });

  it("does not export arbitrary long-stream fields or diagnostic payload text", async () => {
    const rows = records(); rows[0]![syntheticSecret] = syntheticSecret;
    rows[1]!.diagnostic = { ...diagnostic, token: syntheticSecret };
    rows[3]!.token = syntheticSecret; await save(rows);
    const result = JSON.stringify(await compareContinuityObservation(browser, path, windows));
    expect(result).not.toContain(syntheticSecret);
    expect(result).not.toContain("SYNTHETIC_PRIVATE_CORRESPONDENCE");
    expect(result).not.toContain("987654321098765432");
  });

  it("retains unknown and partial in-window diagnostic debt", async () => {
    const rows = records(); rows[1]!.diagnostic = { ...diagnostic, truncated: true }; await save(rows);
    expect(await compareContinuityObservation(browser, path, windows)).toMatchObject({ incompleteInput: true,
      right: { partial: 1 }, fanOut: "unverified" });
  });

  it("rejects nonprivate, symlinked, oversized-line and unterminated files", async () => {
    await save(); await chmod(path, 0o644);
    await expect(compareContinuityObservation(browser, path, windows)).rejects.toThrow();
    await chmod(path, 0o600); const link = join(directory, "link"); await symlink(path, link);
    await expect(compareContinuityObservation(browser, link, windows)).rejects.toThrow();
    await writeFile(path, "x".repeat(1024 * 1024) + "\n");
    await expect(compareContinuityObservation(browser, path, windows)).rejects.toThrow("observation_line_limit");
    await writeFile(path, "{}");
    await expect(compareContinuityObservation(browser, path, windows)).rejects.toThrow("incomplete_observation_line");
  });

  it("enforces both total-file and line bounds across read chunks", async () => {
    await writeFile(path, "x".repeat(70_000) + "\n", { mode: 0o600 });
    const read = async (bytes: number, line: number) => {
      let count = 0; for await (const _row of readPrivateLines(path, bytes, line)) count++; return count;
    };
    await expect(read(80_000, 70_001)).resolves.toBe(1);
    await expect(read(70_000, 80_000)).rejects.toThrow();
    await expect(read(80_000, 70_000)).rejects.toThrow();
  });

  it("writes a private CLI artifact, preserves existing output and redacts failures", async () => {
    await save();
    const left = join(directory, "browser.json"), bounds = join(directory, "windows.json"), output = join(directory, "comparison.json");
    await writeFile(left, JSON.stringify(browser), { mode: 0o600 });
    await writeFile(bounds, JSON.stringify(windows), { mode: 0o600 });
    const run = () => execute(process.execPath, ["--import", "tsx/esm", "scripts/fansly-ws/compare-continuity-cli.ts",
      left, path, bounds, output], { timeout: 5000 });
    await run(); const original = await readFile(output, "utf8");
    expect(JSON.parse(original).matchingReferences).toBe(1);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(run()).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await readFile(output, "utf8")).toBe(original);
    await writeFile(path, syntheticSecret + "\n");
    const failure = await run().catch((error: unknown) => error) as { stderr: string; stdout: string };
    expect(failure.stderr).not.toContain(syntheticSecret); expect(failure.stdout).toBe("");
  });
});
