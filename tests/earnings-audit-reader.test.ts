import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EarningsAuditReader } from "../scripts/fansly-events/earnings-audit-reader.ts";

let directory: string;
let reader: EarningsAuditReader | null = null;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hub-audit-reader-"));
  await symlink(process.execPath, join(directory, "node"));
  vi.stubEnv("PATH", directory);
});
afterEach(async () => {
  await reader?.close(); reader = null;
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function fakeSsh(source: string) {
  await writeFile(join(directory, "ssh"), "#!/usr/bin/env node\n" + source, { flag: "wx", mode: 0o700 });
  reader = new EarningsAuditReader("fixture");
  return reader;
}

describe("earnings audit subprocess ownership", () => {
  it("completes cleanup after spawn ENOENT instead of waiting for a nonexistent exit", async () => {
    reader = new EarningsAuditReader("fixture");
    await expect(reader.read("select 1;")).rejects.toThrow(/Could not start/);
    expect((await reader.close()).error).toMatch(/Could not start/);
  });

  it("ends a healthy session through EOF and preserves its response", async () => {
    const child = await fakeSsh(`process.stdin.on('data', () => process.stdout.write('{"ok":true}\\n'));`);
    expect(await child.read("select 1;")).toEqual({ ok: true });
    expect(await child.close()).toEqual({ stderr: "", error: null });
  });

  it("escalates cleanup when its child ignores SIGTERM", async () => {
    const child = await fakeSsh(`
      process.on('SIGTERM', () => {});
      process.stdin.on('data', () => process.stdout.write('{"ready":true}\\n'));
      setInterval(() => {}, 1000);
    `);
    expect(await child.read("ready")).toEqual({ ready: true });
    const cleanup = await child.close();
    expect(cleanup.error).toMatch(/ended unexpectedly/);
  }, 10_000);

  it("rejects unsolicited extra responses", async () => {
    const child = await fakeSsh(`process.stdin.on('data', () => process.stdout.write('{}\\n{}\\n'));`);
    await expect(child.read("one")).rejects.toThrow(/Unexpected/);
  });

  it("accepts coalesced and split JSON lines in a bounded response batch", async () => {
    const child = await fakeSsh(`process.stdin.on('data', () => {
      process.stdout.write('1\\n2\\n{');
      setTimeout(() => process.stdout.write('"three":3}\\n'), 10);
    });`);
    expect(await child.readMany("three", 3)).toEqual([1, 2, { three: 3 }]);
    expect((await child.close()).error).toBeNull();
  });

  it("rejects an interrupted batch instead of returning its successful prefix", async () => {
    const child = await fakeSsh(`process.stdin.on('data', () => {
      process.stdout.write('{}\\n{}\\n'); process.exit(1);
    });`);
    await expect(child.readMany("three", 3)).rejects.toThrow(/ended unexpectedly/);
  });

  it("counts newline bytes and bounds each line even inside a larger batch", async () => {
    const child = await fakeSsh(`let calls = 0; process.stdin.on('data', () => {
      const size = 8 * 1024 * 1024 - 3 + calls++;
      process.stdout.write('"' + 'x'.repeat(size) + '"\\n');
    });`);
    expect(await child.read("exact")).toHaveLength(8 * 1024 * 1024 - 3);
    await expect(child.readMany("oversized", 2)).rejects.toThrow(/byte limit/);
  });

  it("rejects malformed JSON and invalid response counts", async () => {
    const child = await fakeSsh(`process.stdin.on('data', () => process.stdout.write('{bad}\\n'));`);
    await expect(child.readMany("zero", 0)).rejects.toThrow(/response count/);
    await expect(child.readMany("nine", 9)).rejects.toThrow(/response count/);
    await expect(child.readMany("bad", 1)).rejects.toThrow(/Invalid earnings audit database response/);
  });

});
