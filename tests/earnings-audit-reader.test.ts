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
});
