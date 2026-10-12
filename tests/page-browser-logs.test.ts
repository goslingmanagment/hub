import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { hostAndPath, Journals } from "../apps/page-browser/src/logs/journal.ts";
import { forgetSecrets, registerSecret } from "../apps/page-browser/src/shared/secrets.ts";
import { makeLog, setLogSink, urlForLogLine } from "../apps/page-browser/src/shared/util.ts";
import { quiet, tempDir } from "./helpers/page-browser-fakes.ts";

// The operator's journals (Project Browser plan §4.11): JSON Lines on the
// buffer volume, one file per kind and day, compressed after the day, kept
// 30 days — and never a secret in them.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  forgetSecrets();
  setLogSink(null);
});

function dir() {
  const temp = tempDir();
  cleanups.push(temp.remove);
  return temp.dir;
}

describe("the journals", () => {
  it("write one file per kind and UTC day", async () => {
    const logDir = dir();
    const journals = new Journals({ dir: logDir, now: () => Date.parse("2026-10-13T10:00:00Z"), log: quiet });
    journals.request({ method: "GET", host: "apiv3.fansly.com", path: "/api/v1/account/me", resourceType: "XHR", admission: null, decision: "failed", result: "BlockedByClient: no admission" });
    journals.connection({ id: 1, host: "apiv3.fansly.com", port: 443, cls: "api", openedWall: 1, closedWall: 1, durationMs: 0, up: 0, down: 0, held: 0, refused: true, result: "refused: exit closed" });
    journals.state({ from: "exit_closed", to: "env_applied", stopReason: null, retryAtWall: null, halted: false, note: "" });
    await journals.close();
    expect(readdirSync(logDir).sort()).toEqual(["connections-2026-10-13.jsonl", "requests-2026-10-13.jsonl", "states-2026-10-13.jsonl"]);
    const request = JSON.parse(readFileSync(join(logDir, "requests-2026-10-13.jsonl"), "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({ at: "2026-10-13T10:00:00.000Z", method: "GET", path: "/api/v1/account/me", decision: "failed" });
  });

  it("keep a URL's host and path only", () => {
    expect(hostAndPath("https://cdn3.fansly.com/abc/1.jpg?Policy=xyz&Signature=sig&Key-Pair-Id=k#frag")).toEqual({ host: "cdn3.fansly.com", path: "/abc/1.jpg" });
    expect(hostAndPath("not a url")).toEqual({ host: "", path: "" });
    expect(hostAndPath("https://user:pa55@fansly.com/p#access_token=t0k")).toEqual({ host: "fansly.com", path: "/p" });
    // A data: URL is its own payload: only its scheme is kept.
    expect(hostAndPath("data:text/html,<p>secret</p>")).toEqual({ host: "", path: "data:" });
  });

  it("and so does the process log: no credentials, query, fragment or payload of a URL", () => {
    expect(urlForLogLine("https://user:pa55@fansly.com:8443/p/q?x=1#access_token=t0k")).toBe("https://fansly.com:8443/p/q");
    expect(urlForLogLine("wss://wsv3.fansly.com/?token=abc")).toBe("wss://wsv3.fansly.com/");
    expect(urlForLogLine("data:text/plain;base64,c2VjcmV0")).toBe("data:");
    expect(urlForLogLine("blob:https://fansly.com/3f1c")).toBe("blob:");
    expect(urlForLogLine("about:blank")).toBe("about:");
    expect(urlForLogLine("")).toBe("");
  });

  it("stop the page's traffic when a journal cannot be written", async () => {
    const logDir = dir();
    const troubles: string[] = [];
    // A directory where the file should be: the open fails like a full disk would.
    mkdirSync(join(logDir, "requests-2026-10-13.jsonl"));
    const journals = new Journals({ dir: logDir, now: () => Date.parse("2026-10-13T10:00:00Z"), log: quiet, onTrouble: (reason) => troubles.push(reason) });
    journals.request({ method: "GET", host: "fansly.com", path: "/", resourceType: "Document", admission: null, decision: "failed", result: "x" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(troubles).toHaveLength(1);
    expect(troubles[0]).toMatch(/^the requests journal could not be written/);
    await journals.close();
  });

  it("and when a journal falls behind the disk", async () => {
    const troubles: string[] = [];
    const journals = new Journals({ dir: dir(), log: quiet, maxPendingBytes: 1024, onTrouble: (reason) => troubles.push(reason) });
    for (let i = 0; i < 50; i++) journals.request({ method: "GET", host: "fansly.com", path: `/${"x".repeat(100)}`, resourceType: "Document", admission: null, decision: "failed", result: "x" });
    expect(troubles).toEqual([expect.stringMatching(/^the requests journal is \d+ bytes behind the disk$/)]);
    await journals.close();
  });

  it("compress a day that ended and remove what is older than the retention", async () => {
    const logDir = dir();
    writeFileSync(join(logDir, "requests-2026-10-12.jsonl"), '{"a":1}\n');
    writeFileSync(join(logDir, "requests-2026-09-01.jsonl.gz"), "old");
    writeFileSync(join(logDir, "connections-2026-09-12.jsonl"), "older than 30 days\n");
    writeFileSync(join(logDir, "unrelated.txt"), "kept");
    const journals = new Journals({ dir: logDir, now: () => Date.parse("2026-10-13T00:05:00Z"), log: quiet });
    await journals.housekeep();
    await journals.close();
    expect(readdirSync(logDir).sort()).toEqual(["requests-2026-10-12.jsonl.gz", "unrelated.txt"]);
    expect(gunzipSync(readFileSync(join(logDir, "requests-2026-10-12.jsonl.gz"))).toString()).toBe('{"a":1}\n');
  });

  it("roll to a new file at midnight and compress the old one once it is written", async () => {
    const logDir = dir();
    let now = Date.parse("2026-10-13T23:59:59Z");
    const journals = new Journals({ dir: logDir, now: () => now, log: quiet });
    journals.state({ from: "a", to: "b", stopReason: null, retryAtWall: null, halted: false, note: "before midnight" });
    now = Date.parse("2026-10-14T00:00:01Z");
    journals.state({ from: "b", to: "c", stopReason: null, retryAtWall: null, halted: false, note: "after midnight" });
    await journals.close();
    expect(readdirSync(logDir).sort()).toEqual(["states-2026-10-13.jsonl.gz", "states-2026-10-14.jsonl"]);
    expect(gunzipSync(readFileSync(join(logDir, "states-2026-10-13.jsonl.gz"))).toString()).toContain("before midnight");
  });

  it("cut a registered secret out of every line, raw or JSON-escaped", async () => {
    const logDir = dir();
    registerSecret('pa"ss\\word-123');
    registerSecret("S0cks-Pa55");
    const journals = new Journals({ dir: logDir, now: () => Date.parse("2026-10-13T10:00:00Z"), log: quiet });
    journals.connection({ id: 1, host: "fansly.com", port: 443, cls: "site", openedWall: 1, closedWall: 2, durationMs: 1, up: 0, down: 0, held: 0, refused: false, result: 'failed: S0cks-Pa55 and pa"ss\\word-123' });
    await journals.close();
    const text = readFileSync(join(logDir, "connections-2026-10-13.jsonl"), "utf8");
    expect(text).not.toContain("S0cks-Pa55");
    expect(text).not.toContain("word-123");
    expect(text).toContain("[secret]");
  });
});

describe("the process log", () => {
  it("is a JSON line per event, with registered secrets cut out", () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    registerSecret("token-abcdef");
    makeLog("operator")("hello", { note: "the token-abcdef leaked into a field" });
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ c: "operator", e: "hello", note: "the [secret] leaked into a field" });
  });
});
