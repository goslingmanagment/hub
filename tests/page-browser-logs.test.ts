import { mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hostAndPath, Journals, type JournalTrouble } from "../apps/page-browser/src/logs/journal.ts";
import { forgetSecrets, registerSecret } from "../apps/page-browser/src/shared/secrets.ts";
import { makeLog, setLogSink, urlForLogLine } from "../apps/page-browser/src/shared/util.ts";
import { quiet, tempDir, until } from "./helpers/page-browser-fakes.ts";

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

  it("a file that cannot be written tells its trouble, drops and counts its lines, and writes the gap first once it can again", async () => {
    const logDir = dir();
    const file = join(logDir, "states-2026-10-13.jsonl");
    // The day's file is a directory: no line goes in.
    mkdirSync(file);
    const troubles: JournalTrouble[] = [];
    const journals = new Journals({ dir: logDir, now: () => Date.parse("2026-10-13T10:00:00Z"), log: quiet, retryMs: 50, onTrouble: (trouble) => troubles.push(trouble) });
    const state = (note: string) => journals.state({ from: "ready", to: "ready", stopReason: null, retryAtWall: null, halted: false, note });
    for (const note of ["one", "two", "three"]) state(note);
    await until(() => troubles.length > 0, 3000, "the trouble");
    expect(troubles[0]).toMatchObject({ kind: "states", errors: 1 });
    // Within the pause after the error the file is not tried again.
    state("four");
    expect(troubles).toHaveLength(1);
    rmdirSync(file);
    await new Promise((resolve) => setTimeout(resolve, 80));
    state("five");
    await journals.close();
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map(({ at: _at, ...line }) => line)).toEqual([{ gap: true, dropped: 4 }, expect.objectContaining({ note: "five" })]);
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

  it("never carries a session's header, a cookie or a bearer credential, registered or not (PR 9)", async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    makeLog("hub")("oops", {
      headers: { Authorization: "never-seen-before-token", cookie: "sid=1; f=2", "Set-Cookie": "a=b", "fansly-session-id": "71234", "fansly-client-id": "70001", "fansly-client-check": "abc123", accept: "application/json" },
      note: "sent with Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig and more",
      password: 'pa"ss',
    });
    const line = JSON.parse(lines[0]!) as { headers: Record<string, string>; note: string; password: string };
    expect(line.headers).toEqual({ Authorization: "[secret]", cookie: "[secret]", "Set-Cookie": "[secret]", "fansly-session-id": "[secret]", "fansly-client-id": "[secret]", "fansly-client-check": "[secret]", accept: "application/json" });
    expect(line.note).toBe("sent with Bearer [secret] and more");
    expect(line.password).toBe("[secret]");
    // The journals go through the same scrubber.
    const logDir = dir();
    const journals = new Journals({ dir: logDir, now: () => Date.parse("2026-10-13T10:00:00Z"), log: quiet });
    journals.request({ method: "GET", host: "apiv3.fansly.com", path: "/api/v1/account/me", resourceType: "XHR", admission: "hub attempt 1", decision: "failed", result: "Aborted: Bearer abcdefgh12345678 slipped in" });
    await journals.close();
    expect(readFileSync(join(logDir, "requests-2026-10-13.jsonl"), "utf8")).not.toContain("abcdefgh12345678");
  });
});
