import { createHash } from "node:crypto";
import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import { KernelApiError } from "@kernel/sdk";

import { runHubCli } from "../packages/hub-agent-cli/src/main.ts";
import {
  formatHubBytes,
  HUB_UPLOAD_NETWORK_WAIT_MS,
  uploadHubFiles,
  type HubFileUpload,
  type HubLocalFiles,
  type HubUploadItem,
} from "../packages/hub-agent-cli/src/upload.ts";

/**
 * A pack from a content manager's computer (audit 2026-11-04): a break —
 * a lost network, a closed window — must not cost the whole pack again. The
 * files' bytes are compared with what Hub holds before anything goes up, the
 * folder's twins are found the same way, and a lost network is waited for in
 * minutes. Hub here is a stub with memory, so a second run sees the first.
 */

const jpeg = (text: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`a photo, ${text}`)]);
const mp4 = (text: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from(`a video, ${text}`)]);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const networkError = () => new KernelApiError("Network error calling POST /upload: read ECONNRESET", "network", null, "network_error", null);
const answerError = (status: number) => new KernelApiError(`refused with ${status}`, status >= 500 ? "server" : "http", status, "x", null);

function folder(entries: Record<string, Buffer>): HubLocalFiles {
  const bytesOf = (path: string) => entries[basename(path)];
  return {
    stat: async (path) => {
      if (path === "/pack") return { kind: "folder", size: 0 };
      const bytes = bytesOf(path);
      return bytes === undefined ? null : { kind: "file", size: bytes.length };
    },
    head: async (path, count) => bytesOf(path)!.subarray(0, count),
    list: async () => Object.keys(entries),
    sha256: async (path, byteSize, onBytes) => {
      const bytes = bytesOf(path)!.subarray(0, byteSize);
      onBytes(bytes.length);
      return sha256(bytes);
    },
  };
}

/** Hub as the CLI sees it: files kept by their bytes, the lookup, the targets and the draft. */
function stubHub(entries: Record<string, Buffer>) {
  const held = new Map<string, { id: number; name: string; byteSize: number }>();
  let nextId = 11;
  const sent: string[] = [];
  const lookups: Array<{ files: number; keep: boolean }> = [];
  const drafts: Array<{ media: Array<{ fileId: number; name: string }> }> = [];
  const hub = {
    held,
    sent,
    lookups,
    drafts,
    /** An upload's failure, by file name; null: it lands. */
    failing: (_name: string): Error | null => null,
    lookupFails: false,
    createFails: null as Error | null,
  };
  const client = {
    agentPublicationTargets: async () => ({ pageLabel: "ari-1", platform: "fansly", walls: [], tiers: [] }),
    agentPublicationFileLookup: async ({ body }: { body: { files: Array<{ sha256: string; byteSize: number }>; keep: boolean } }) => {
      lookups.push({ files: body.files.length, keep: body.keep });
      if (hub.lookupFails) throw answerError(404);
      return {
        files: body.files.map((asked) => {
          const file = held.get(asked.sha256);
          return {
            ...asked,
            file: file === undefined || file.byteSize !== asked.byteSize ? null : {
              id: file.id, sha256: asked.sha256, byteSize: file.byteSize, mimeType: "image/jpeg", originalName: file.name,
            },
          };
        }),
      };
    },
    agentPublicationCreate: async ({ body }: { body: { text: string; publishAt: string; media: Array<{ fileId: number; name: string }> } }) => {
      if (hub.createFails !== null) throw hub.createFails;
      drafts.push(body);
      return {
        id: 77, version: 1, status: "draft", statusReason: null, pageLabel: "ari-1", kind: "vault_album", text: body.text,
        publishAt: body.publishAt, vaultAlbumRef: null, blocked: false, findings: [],
      };
    },
  };
  const upload: HubFileUpload = async ({ item }) => {
    sent.push(item.name);
    const failure = hub.failing(item.name);
    if (failure !== null) throw failure;
    const bytes = entries[item.name]!;
    const key = sha256(bytes);
    const before = held.get(key);
    const file = before ?? { id: nextId++, name: item.name, byteSize: bytes.length };
    held.set(key, file);
    return {
      created: before === undefined,
      file: {
        id: file.id, modelId: 1, modelSlug: "ari", sha256: key, byteSize: file.byteSize, mimeType: "image/jpeg",
        originalName: file.name, createdByUserId: 1, createdAt: "", storedAt: "", stored: true, bytesDeletedAt: null,
        retainUntil: null, uses: [],
      },
    };
  };
  return { hub, client, upload };
}

async function draft(stub: ReturnType<typeof stubHub>, entries: Record<string, Buffer>, extra: string[] = []) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  let clock = Date.parse("2026-11-04T20:00:00Z");
  const result = await runHubCli({
    argv: ["vault-album-draft", "--page-label", "ari-1", "--title", "Pack", "/pack", ...extra],
    env: { HUB_AGENT_KEY: "t" },
    readFile: () => null,
    fileMode: () => null,
    createHubClient: () => stub.client as never,
    files: folder(entries),
    upload: stub.upload,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    progress: (line) => lines.push(line),
  });
  return { result, lines, sleeps, data: result.document.data as Record<string, unknown> };
}

describe("vault-album-draft after a break", () => {
  it("sends again only the files Hub lacks, says how many are there, and drafts all of them in the folder's order", async () => {
    const entries = { "IMG_1.jpg": jpeg("one"), "IMG_2.mp4": mp4("two"), "IMG_10.jpg": jpeg("ten") };
    const stub = stubHub(entries);
    // The network goes for good while IMG_2 is sent: the others land, IMG_2 waits its 15 minutes and fails.
    stub.hub.failing = (name) => (name === "IMG_2.mp4" ? networkError() : null);
    const first = await draft(stub, entries);
    expect(first.result.exitCode).toBe(4);
    expect(first.data).toMatchObject({ drafted: false, uploads: { files: 3, uploaded: 2, failed: 1, notSent: 0 } });
    expect(String(first.data.next)).toContain("the 2 in Hub do not go up again");
    expect(first.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(HUB_UPLOAD_NETWORK_WAIT_MS);
    expect(first.lines.some((line) => line.includes("waiting for the network"))).toBe(true);

    // The same command again, the network back: only IMG_2 goes up.
    stub.hub.failing = () => null;
    stub.hub.sent.length = 0;
    const again = await draft(stub, entries);
    expect(again.result.exitCode).toBe(0);
    expect(stub.hub.sent).toEqual(["IMG_2.mp4"]);
    expect(stub.hub.lookups.at(-1)).toEqual({ files: 3, keep: true });
    expect(again.lines).toContain(`hub: 2 of 3 files are in Hub already (${formatHubBytes(entries["IMG_1.jpg"].length + entries["IMG_10.jpg"].length)})`
      + ` and are not sent again; sending the other 1 (${formatHubBytes(entries["IMG_2.mp4"].length)})`);
    expect(again.data).toMatchObject({ uploads: { files: 3, uploaded: 1, alreadyThere: 2, notSent: 2, failed: 0 } });
    expect((again.data.album as Array<Record<string, unknown>>).map((entry) => [entry.name, entry.notSent ?? false]))
      .toEqual([["IMG_1.jpg", true], ["IMG_2.mp4", false], ["IMG_10.jpg", true]]);
    const ids = (name: string) => stub.hub.held.get(sha256(entries[name as keyof typeof entries]))!.id;
    expect(stub.hub.drafts[0]!.media).toEqual(["IMG_1.jpg", "IMG_2.mp4", "IMG_10.jpg"].map((name) => ({ source: "file", fileId: ids(name), name })));
  });

  it("finds the folder's twins by their bytes before anything goes up, in a dry run too", async () => {
    const entries = { "a.jpg": jpeg("same"), "b.jpg": jpeg("other"), "c.jpg": jpeg("same") };
    for (const extra of [[], ["--dry-run"]]) {
      const stub = stubHub(entries);
      const run = await draft(stub, entries, extra);
      expect(run.result.exitCode, extra.join(" ")).toBe(4);
      expect(run.data.duplicates).toEqual([{ name: "c.jpg", sameAs: "a.jpg" }]);
      expect(stub.hub.sent).toEqual([]);
      expect(stub.hub.lookups).toEqual([]);
    }
  });

  it("a dry run says which files Hub holds, keeping nothing", async () => {
    const entries = { "a.jpg": jpeg("a"), "b.jpg": jpeg("b") };
    const stub = stubHub(entries);
    stub.hub.held.set(sha256(entries["a.jpg"]), { id: 5, name: "a.jpg", byteSize: entries["a.jpg"].length });
    const run = await draft(stub, entries, ["--dry-run"]);
    expect(run.result.exitCode).toBe(0);
    expect(stub.hub.lookups).toEqual([{ files: 2, keep: false }]);
    expect(stub.hub.sent).toEqual([]);
    expect(run.data).toMatchObject({ dryRun: true, inHub: { files: 1 } });
    expect((run.data.album as Array<Record<string, unknown>>).map((entry) => entry.inHub ?? false)).toEqual([true, false]);
  });

  it("sends every file when Hub cannot be asked, and says so", async () => {
    const entries = { "a.jpg": jpeg("a"), "b.jpg": jpeg("b") };
    const stub = stubHub(entries);
    stub.hub.held.set(sha256(entries["a.jpg"]), { id: 5, name: "a.jpg", byteSize: entries["a.jpg"].length });
    stub.hub.lookupFails = true;
    const run = await draft(stub, entries);
    expect(run.result.exitCode).toBe(0);
    expect(stub.hub.sent).toEqual(["a.jpg", "b.jpg"]);
    expect(run.lines.some((line) => line.startsWith("hub: could not ask Hub which files it holds"))).toBe(true);
  });

  it("never says «nothing drafted» when Hub answered the draft but this copy of the CLI could not read it", async () => {
    const entries = { "a.jpg": jpeg("a") };
    const stub = stubHub(entries);
    stub.hub.createFails = new KernelApiError("response failed contract validation", "contract", 200, "response_validation_failed", null);
    const run = await draft(stub, entries);
    expect(run.result.exitCode).toBe(4);
    expect(run.data.drafted).toBe("unknown");
    expect(String(run.data.next)).toContain("most likely drafted");
    expect(String(run.data.next)).not.toContain("Nothing drafted");

    stub.hub.createFails = answerError(400);
    const refused = await draft(stub, entries);
    expect(refused.data.drafted).toBe(false);
    expect(String(refused.data.next)).toContain("Nothing drafted: Hub refused it");
  });
});

describe("uploads wait for the network, and only for it", () => {
  const item: HubUploadItem = { path: "/pack/a.jpg", name: "a.jpg", byteSize: 10, mimeType: "image/jpeg" };

  async function send(failures: Error[]) {
    const sleeps: number[] = [];
    const lines: string[] = [];
    let tries = 0;
    const { outcomes } = await uploadHubFiles({
      pageLabel: "ari-1",
      items: [item],
      parallel: 1,
      upload: async () => {
        const failure = failures[tries];
        tries += 1;
        if (failure !== undefined) throw failure;
        return { created: true, file: { id: 1, sha256: "x", originalName: "a.jpg", byteSize: 10, mimeType: "image/jpeg" } } as never;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
      progress: (line) => lines.push(line),
    });
    return { outcome: outcomes[0]!, sleeps, tries, lines };
  }

  it("rides out minutes without a network, or a restarting Hub, instead of failing after 42 s", async () => {
    const run = await send([networkError(), networkError(), answerError(502), answerError(503), answerError(504), networkError(), networkError()]);
    expect(run.outcome.ok).toBe(true);
    expect(run.tries).toBe(8);
    expect(run.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(60_000 * 3);
    expect(run.lines.filter((line) => line.includes("waiting for the network"))).toHaveLength(7);
  });

  it("gives a file up after about 15 minutes of waiting", async () => {
    const run = await send(Array.from({ length: 100 }, networkError));
    expect(run.outcome.ok).toBe(false);
    expect(run.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(HUB_UPLOAD_NETWORK_WAIT_MS);
    expect(run.tries).toBeLessThan(25);
  });

  it("does not send again what Hub refused for good, and tries a broken Hub a few times only", async () => {
    for (const status of [400, 401, 403, 404, 413, 415, 507]) {
      const run = await send([answerError(status)]);
      expect([status, run.outcome.ok, run.tries, run.sleeps]).toEqual([status, false, 1, []]);
    }
    const broken = await send([answerError(500), answerError(500), answerError(500), answerError(500)]);
    expect([broken.outcome.ok, broken.tries, broken.sleeps]).toEqual([false, 4, [2_000, 10_000, 30_000]]);
  });
});
