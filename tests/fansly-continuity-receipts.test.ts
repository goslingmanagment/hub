import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createContinuityReceipts } from "../scripts/fansly-ws/continuity-receipts.ts";

describe("streamed W0 receipt bounds", () => {
  it("writes through an actual child stdout pipe, as with Docker attach", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", `
      import { createContinuityReceipts, writeContinuityLine } from "./scripts/fansly-ws/continuity-receipts.ts";
      const output = createContinuityReceipts(writeContinuityLine, { records: 10, bytes: 32768 });
      output.write({ kind: "started" });
      output.write({ kind: "finished", collectionCompleted: false }, true);
    `], { encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim().split("\n").map((line) => JSON.parse(line).kind))
      .toEqual(["started", "finished"]);
  });
  it("keeps a parseable prefix and does not count an unsuccessful write", () => {
    const retained: string[] = [];
    const write = vi.fn((line: string) => { retained.push(line); });
    const output = createContinuityReceipts(write, { records: 10, bytes: 32_768 });
    output.write({ kind: "started" });
    const before = output.counts();
    write.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => output.write({ kind: "frame" })).toThrow("disk full");
    expect(output.counts()).toEqual(before);
    expect(JSON.parse(retained[0]!)).toMatchObject({ kind: "started", ordinal: 1 });
  });

  it("reserves final output without discarding earlier metadata", () => {
    const lines: string[] = [];
    const output = createContinuityReceipts((line) => lines.push(line), { records: 3, bytes: 32_768 });
    output.write({ kind: "started" });
    output.write({ kind: "frame" });
    expect(() => output.write({ kind: "frame" })).toThrow("observation_output_limit");
    output.write({ kind: "finished", collectionCompleted: false }, true);
    expect(lines).toHaveLength(3);
    expect(output.counts().bytes).toBe(Buffer.byteLength(lines.join("")));
    expect(() => output.write({ kind: "frame" })).toThrow("observation_already_finished");
  });

  it("enforces bytes before emitting the next line", () => {
    const write = vi.fn();
    const output = createContinuityReceipts(write, { records: 100, bytes: 32_768 });
    expect(() => output.write({ kind: "frame", value: "x".repeat(32_768) })).toThrow("observation_output_limit");
    expect(write).not.toHaveBeenCalled();
    output.write({ kind: "finished", collectionCompleted: false }, true);
    expect(write).toHaveBeenCalledOnce();
  });
});
