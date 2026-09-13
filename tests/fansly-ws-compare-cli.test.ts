import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDiagnosticReport } from "../scripts/fansly-ws/report.ts";
import { privateMessageEvent, received, serviceFrame, syntheticSecret } from "./helpers/fansly-ws-fixtures.ts";

const execute = promisify(execFile);
let directory: string;
let reports: string[];
let windows: string;
let output: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fansly-ws-compare-"));
  const input = join(directory, "received.jsonl");
  const key = join(directory, "key");
  await writeFile(input, JSON.stringify(received(serviceFrame(privateMessageEvent()))), { mode: 0o600 });
  await writeFile(key, Buffer.alloc(32, 7), { mode: 0o600 });
  reports = [join(directory, "left.json"), join(directory, "right.json")];
  for (const report of reports) await writeDiagnosticReport(input, key, report);
  windows = join(directory, "windows.json");
  const window = { from: "2026-09-10T18:00:00.000Z", to: "2026-09-10T18:02:00.000Z" };
  await writeFile(windows, JSON.stringify({ left: window, right: window }), { mode: 0o600 });
  output = join(directory, "comparison.json");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function compare() {
  return execute(process.execPath, ["--import", "tsx/esm", "scripts/fansly-ws/compare-cli.ts", ...reports, windows, output], {
    timeout: 5000,
  });
}

describe("offline comparison command", () => {
  it("compares actual exporter output into a private report without raw content", async () => {
    const result = await compare();
    expect(result.stderr).not.toContain(syntheticSecret);
    const text = await readFile(output, "utf8");
    expect(JSON.parse(text)).toMatchObject({ matchingReferences: 1, fanOut: "unverified" });
    expect(text).not.toContain(syntheticSecret);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("preserves an existing output", async () => {
    await writeFile(output, "retain existing evidence", { mode: 0o600 });
    await expect(compare()).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await readFile(output, "utf8")).toBe("retain existing evidence");
  });

  it("rejects malformed input without copying paths or JSON into errors", async () => {
    reports[0] = join(directory, syntheticSecret);
    await writeFile(reports[0], syntheticSecret, { mode: 0o600 });
    const failure = await compare().then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1, stdout: "" });
    expect((failure as { stderr: string }).stderr).not.toContain(syntheticSecret);
    await expect(stat(output)).rejects.toThrow();
  });
});
