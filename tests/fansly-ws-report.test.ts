import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDiagnosticReport } from "../scripts/fansly-ws/report.ts";
import { privateMessageEvent, received, serviceFrame, syntheticSecret, wrapped } from "./helpers/fansly-ws-fixtures.ts";

const execFileAsync = promisify(execFile);

describe("private offline Fansly report files", () => {
  let directory: string;
  let input: string;
  let key: string;
  let output: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fansly-ws-report-"));
    input = join(directory, "received.jsonl");
    key = join(directory, "key");
    output = join(directory, "report.json");
    await writeFile(key, Buffer.alloc(32, 7), { mode: 0o600 });
    await writeFile(input, [
      JSON.stringify(received(serviceFrame(privateMessageEvent()))),
      JSON.stringify({ ...received(wrapped(1, { token: syntheticSecret })), direction: "sent" }),
      "invalid-json",
    ].join("\n"), { mode: 0o600 });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("writes a private metadata-only report with exclusions and unverified binding", async () => {
    expect(await writeDiagnosticReport(input, key, output)).toEqual({ records: 3 });
    const text = await readFile(output, "utf8");
    expect(text).not.toContain(syntheticSecret);
    const report = JSON.parse(text);
    expect(report.accountBinding).toBe("unverified");
    expect(report.records[1]).toEqual({ excluded: "not_received" });
    expect(report.records[2]).toEqual({ excluded: "invalid_record" });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("never replaces an existing evidence file", async () => {
    await writeFile(output, "retain me");
    await expect(writeDiagnosticReport(input, key, output)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("retain me");
  });

  it.each(["input", "key"])("refuses a non-private %s", async (target) => {
    await chmod(target === "key" ? key : input, 0o644);
    await expect(writeDiagnosticReport(input, key, output)).rejects.toThrow("invalid_private_input");
    await expect(stat(output)).rejects.toThrow();
  });

  it("refuses a malformed key and excessive record count", async () => {
    await writeFile(key, Buffer.alloc(31));
    await expect(writeDiagnosticReport(input, key, output)).rejects.toThrow("invalid_key");
    await writeFile(key, Buffer.alloc(32));
    await writeFile(input, "{}\n".repeat(10001));
    await expect(writeDiagnosticReport(input, key, output)).rejects.toThrow("too_many_lines");
    await expect(stat(output)).rejects.toThrow();
  });

  it("rejects a FIFO without waiting for a writer or leaking paths", async () => {
    const fifo = join(directory, "SECRET_PATH_FIFO");
    await execFileAsync("mkfifo", ["-m", "600", fifo]);
    const failure = await execFileAsync(process.execPath, [
      "--import", "tsx/esm", "scripts/fansly-ws/report.ts", fifo, key, output,
    ], { timeout: 3000 }).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1, killed: false, stdout: "" });
    expect(String((failure as { stderr: string }).stderr)).not.toContain("SECRET_PATH_FIFO");
    await expect(stat(output)).rejects.toThrow();
  });

  it("rejects batch expansion under a bounded child-process heap", async () => {
    const frame = JSON.stringify({ t: 10001, d: Array.from({ length: 256 }, () => ({})) });
    await writeFile(input, `${JSON.stringify(received(frame))}\n`.repeat(10000));
    await expect(writeDiagnosticReport(input, key, output)).rejects.toThrow("report_too_large");
    const failure = await execFileAsync(process.execPath, [
      "--max-old-space-size=192", "--import", "tsx/esm", "scripts/fansly-ws/report.ts", input, key, output,
    ], { timeout: 10000 }).then(() => null, (error: unknown) => error);
    // A normal bounded rejection, not a timeout or V8 out-of-memory abort.
    expect(failure).toMatchObject({ code: 1, killed: false, signal: null, stdout: "" });
    expect((failure as { stderr: string }).stderr).toContain("Diagnostic export failed");
    await expect(stat(output)).rejects.toThrow();
  }, 15000);

  it("bounds newline-heavy input before allocating a line array", async () => {
    await writeFile(input, "\n".repeat(32 * 1024 * 1024));
    await expect(writeDiagnosticReport(input, key, output)).rejects.toThrow("too_many_lines");
    const failure = await execFileAsync(process.execPath, [
      "--max-old-space-size=192", "--import", "tsx/esm", "scripts/fansly-ws/report.ts", input, key, output,
    ], { timeout: 5000 }).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1, killed: false, signal: null, stdout: "" });
    expect((failure as { stderr: string }).stderr).toContain("Diagnostic export failed");
    await expect(stat(output)).rejects.toThrow();
  });
});
