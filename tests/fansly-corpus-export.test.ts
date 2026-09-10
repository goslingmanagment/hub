import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fansly-corpus-"));
  temporaryDirectories.push(directory);
  const input = path.join(directory, "corpus.jsonl");
  const output = path.join(directory, "sensitivity.json");
  const lines = [1, 2].map((id) => JSON.stringify({
    id, pageLabel: "lilly-2", capturedAt: `2026-09-01T12:00:0${id}Z`, offset: 0,
    limit: 100, sortOrder: 1, payloadAvailable: true, dataValid: true, total: 1,
    retainedJsonBytes: 300, runOutcome: "succeeded", runFinishedAt: "2026-09-01T12:00:03Z",
    certifiedAt: `2026-09-01T12:00:0${id}Z`, heads: [{ groupId: "g", lastMessageId: "m",
      embeddedId: "m", embeddedMatches: 1, timestamp: 1700000000000,
      senderId: "fan", unreadCount: 0, flags: 0, lastUnreadMessageId: null, subscriptionTierId: null }],
  }) + "\n");
  const content = lines.join("");
  await writeFile(input, content);
  await writeFile(`${input}.manifest.json`, JSON.stringify({ operation: "corpus", records: 2,
    from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z", completedAt: "2026-09-03T00:00:00Z",
    sha256: createHash("sha256").update(content).digest("hex"),
  }));
  const analyze = () => exec(process.execPath, ["--import", "tsx/esm",
    path.resolve("scripts/fansly-events/analyze-corpus.ts"), input, output]);
  return { input, output, lines, analyze };
}

describe("completed historical export evidence", () => {
  it("carries the verified window and digest into all nine sensitivity results", async () => {
    const source = await fixture();
    await source.analyze();
    const result = JSON.parse(await readFile(source.output, "utf8"));
    expect(result.inputManifest.from).toBe("2026-09-01T00:00:00Z");
    expect(result.sensitivity).toHaveLength(9);
    expect(result.sensitivity[0].sweeps.map((s: { status: string }) => s.status))
      .toEqual(["priming", "complete"]);
  });

  it("rejects truncation between complete sweeps, not only an unfinished last sweep", async () => {
    const source = await fixture();
    await writeFile(source.input, source.lines[0]!);
    await expect(source.analyze()).rejects.toThrow("completed export manifest");
    await expect(readFile(source.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
