import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { correlationKeyFingerprint, readCorrelationKey } from "../scripts/fansly-ws/correlation-key.ts";
import { observeFanslyProbe } from "../scripts/fansly-ws/probe-observer.ts";
import { writeDiagnosticReport } from "../scripts/fansly-ws/report.ts";
import { privateMessageEvent, received, serviceFrame, wrapped } from "./helpers/fansly-ws-fixtures.ts";

describe("private Fansly experiment key", () => {
  let directory: string;
  let keyPath: string;
  const key = Buffer.from("0123456789abcdef0123456789abcdef");

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fansly-correlation-"));
    keyPath = join(directory, "correlation.key");
    await writeFile(keyPath, key, { mode: 0o600 });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("identifies equal key bytes across files and distinguishes another experiment", async () => {
    const copy = join(directory, "copy.key");
    await writeFile(copy, key, { mode: 0o600 });
    const fingerprint = correlationKeyFingerprint(await readCorrelationKey(keyPath));
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(correlationKeyFingerprint(await readCorrelationKey(copy))).toBe(fingerprint);
    expect(correlationKeyFingerprint(Buffer.alloc(32, 7))).not.toBe(fingerprint);
    expect(fingerprint).not.toBe(key.toString("hex"));
  });

  it.each([0, 31, 33])("refuses a key with %i bytes", async (length) => {
    await writeFile(keyPath, Buffer.alloc(length));
    await expect(readCorrelationKey(keyPath)).rejects.toThrow();
    expect(() => correlationKeyFingerprint(Buffer.alloc(length))).toThrow("invalid_key");
  });

  it("refuses public or symlinked key files", async () => {
    await chmod(keyPath, 0o644);
    await expect(readCorrelationKey(keyPath)).rejects.toThrow("invalid_private_input");
    await chmod(keyPath, 0o600);
    const link = join(directory, "link.key");
    await symlink(keyPath, link);
    await expect(readCorrelationKey(link)).rejects.toThrow();
  });

  it("produces matching offline and live reference pseudonyms without exporting the key", async () => {
    const frame = serviceFrame(privateMessageEvent());
    const input = join(directory, "received.jsonl");
    const output = join(directory, "report.json");
    await writeFile(input, JSON.stringify(received(frame)), { mode: 0o600 });
    await writeDiagnosticReport(input, keyPath, output);
    const text = await readFile(output, "utf8");
    const report = JSON.parse(text);

    const socket = Object.assign(new EventTarget(), {
      readyState: 1, send: () => {}, close: () => {},
    });
    const controller = new AbortController();
    const live = observeFanslyProbe({
      connect: () => socket, token: "synthetic-provider-token",
      key: await readCorrelationKey(keyPath), durationMs: 120_000, signal: controller.signal,
    });
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new MessageEvent("message", { data: wrapped(1, {}) }));
    socket.dispatchEvent(new MessageEvent("message", { data: frame }));
    controller.abort();
    const observation = await live;
    expect(report.correlationKeyFingerprint).toBe(correlationKeyFingerprint(key));
    expect(report.records[0].diagnostic).toEqual(observation.records[1]!.diagnostic);
    expect(text).not.toContain(key.toString());
    expect(text).not.toContain(key.toString("hex"));
    expect(JSON.stringify(observation)).not.toContain("synthetic-provider-token");
  });
});
