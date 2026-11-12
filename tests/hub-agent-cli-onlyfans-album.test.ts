import { createHash } from "node:crypto";
import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import { runHubCli } from "../packages/hub-agent-cli/src/main.ts";
import type { HubFileUpload, HubLocalFiles } from "../packages/hub-agent-cli/src/upload.ts";

/**
 * An OnlyFans vault album from the agent's CLI (8-docs 2026-11-12-of-vault-album,
 * PR 6): nothing goes to Hub before the person's «да» to a named price, a higher
 * price stops the run before the first byte, a file over the link limit is
 * neither uploaded nor drafted, and no album is made beside a look-alike title
 * unless the person named the album or said it is new. Hub is a stub here.
 */

const jpeg = (text: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`a photo, ${text}`)]);
const mp4 = (text: string, size = 0) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from(`a video, ${text}`), Buffer.alloc(size)]);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function folder(entries: Record<string, Buffer>, hashedNames: string[]): HubLocalFiles {
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
      hashedNames.push(basename(path));
      const bytes = bytesOf(path)!.subarray(0, byteSize);
      onBytes(bytes.length);
      return sha256(bytes);
    },
  };
}

type QuoteBody = { title: string; albumRef?: string; files: Array<{ sha256: string; byteSize: number; name: string }> };

interface QuoteSetup {
  credits: number;
  linkMaxBytes: number;
  album?: { kind: "new" | "found" | "similar"; albumRef: string | null; mediaCount: number | null; similar: Array<{ albumRef: string; title: string; mediaCount: number | null }> };
  /** walkRequested of each call in turn; the last one repeats. */
  walks?: boolean[];
  onPage?: string[];
  expectedOrder?: number[] | null;
}

function stubHub(entries: Record<string, Buffer>, setup: QuoteSetup) {
  const sent: string[] = [];
  const hashedNames: string[] = [];
  const quotes: QuoteBody[] = [];
  const drafts: Array<{ media: Array<{ fileId: number; name: string }>; vaultAlbumRef?: string }> = [];
  const held = new Map<string, number>();
  let nextId = 11;
  const client = {
    agentPublicationTargets: async () => ({ pageLabel: "lora-of", platform: "onlyfans", walls: [], tiers: [] }),
    agentVaultAlbumQuote: async ({ body }: { body: QuoteBody }) => {
      quotes.push(body);
      const walks = setup.walks ?? [false];
      const named = body.albumRef ?? null;
      const album = named !== null
        ? { kind: "found" as const, albumRef: named, mediaCount: 4, similar: [] }
        : setup.album ?? { kind: "new" as const, albumRef: null, mediaCount: null, similar: [] };
      return {
        platform: "onlyfans",
        album: { ...album, knownAt: "2026-11-12T10:00:00.000Z", walkRequested: walks[Math.min(quotes.length - 1, walks.length - 1)]! },
        files: body.files.map((file, position) => ({
          position, name: file.name, byteSize: file.byteSize,
          credits: file.byteSize > setup.linkMaxBytes ? 0 : 10,
          onPage: setup.onPage?.includes(file.name) ?? false,
          tooBig: file.byteSize > setup.linkMaxBytes,
        })),
        expectedOrder: setup.expectedOrder ?? null,
        credits: setup.credits,
        usd: Math.round(setup.credits * 1.49) / 1000,
        account: { dailyCredits: 5000, spentToday: 700, left: 4300, balance: 12_000, centsPer1000: 149 },
        linkMaxBytes: setup.linkMaxBytes,
        sending: { on: true, why: null },
      };
    },
    agentPublicationFileLookup: async ({ body }: { body: { files: Array<{ sha256: string; byteSize: number }> } }) => ({
      files: body.files.map((asked) => ({ ...asked, file: null })),
    }),
    agentPublicationCreate: async ({ body }: { body: { text: string; publishAt: string; media: Array<{ fileId: number; name: string }>; vaultAlbumRef?: string } }) => {
      drafts.push(body);
      return {
        id: 91, version: 1, status: "draft", statusReason: null, pageLabel: "lora-of", kind: "vault_album", text: body.text,
        publishAt: body.publishAt, vaultAlbumRef: body.vaultAlbumRef ?? null, blocked: false, findings: [],
      };
    },
  };
  const upload: HubFileUpload = async ({ item }) => {
    sent.push(item.name);
    const key = sha256(entries[item.name]!);
    const id = held.get(key) ?? nextId++;
    held.set(key, id);
    return {
      created: true,
      file: {
        id, modelId: 1, modelSlug: "lora", sha256: key, byteSize: item.byteSize, mimeType: item.mimeType,
        originalName: item.name, createdByUserId: 1, createdAt: "", storedAt: "", stored: true, bytesDeletedAt: null,
        retainUntil: null, uses: [],
      },
    };
  };
  return { client, upload, sent, hashedNames, quotes, drafts };
}

async function draft(stub: ReturnType<typeof stubHub>, entries: Record<string, Buffer>, extra: string[]) {
  let clock = Date.parse("2026-11-12T12:00:00Z");
  const sleeps: number[] = [];
  const result = await runHubCli({
    argv: ["vault-album-draft", "--page-label", "lora-of", "--title", "Pack", "/pack", ...extra],
    env: { HUB_AGENT_KEY: "t" },
    readFile: () => null,
    fileMode: () => null,
    createHubClient: () => stub.client as never,
    files: folder(entries, stub.hashedNames),
    upload: stub.upload,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    progress: () => {},
  });
  return { result, sleeps, data: result.document.data as Record<string, unknown> };
}

const pack = () => ({ "IMG_1.jpg": jpeg("one"), "IMG_2.mp4": mp4("two", 400), "IMG_3.jpg": jpeg("three") });

describe("vault-album-draft on an OnlyFans page", () => {
  it("answers the dry run with the quote's own numbers and sends nothing", async () => {
    const entries = pack();
    const stub = stubHub(entries, {
      credits: 2740, linkMaxBytes: 1000, onPage: ["IMG_3.jpg"], expectedOrder: [2, 0, 1],
      album: { kind: "found", albumRef: "777", mediaCount: 12, similar: [] },
    });
    const { result, data } = await draft(stub, entries, ["--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(stub.sent).toEqual([]);
    expect(stub.drafts).toEqual([]);
    expect(data).toMatchObject({
      dryRun: true,
      price: { credits: 2740, usd: 4.083 },
      account: { dailyCredits: 5000, spentToday: 700, left: 4300, balance: 12_000, fitsToday: true },
      albumFound: { kind: "found", albumRef: "777", mediaCount: 12, walkPending: false },
      byHand: [],
      onPage: [{ position: 3, name: "IMG_3.jpg" }],
      expectedOrder: [{ place: 1, position: 3, name: "IMG_3.jpg" }, { place: 2, position: 1 }, { place: 3, position: 2 }],
      sending: { on: true, why: null },
    });
    expect(String(data.next)).toContain("--max-credits 2740");
    // Asked before the files were read (to start a walk) and with their hashes.
    expect(stub.quotes).toHaveLength(2);
    expect(stub.quotes[1]!.files.map((file) => file.sha256)).toEqual(Object.values(entries).map(sha256));
  });

  it("stops before the first byte when the price is above --max-credits, and names both numbers", async () => {
    const entries = pack();
    const stub = stubHub(entries, { credits: 3100, linkMaxBytes: 10_000 });
    const { result, data } = await draft(stub, entries, ["--max-credits", "2740"]);
    expect(result.exitCode).not.toBe(0);
    expect(stub.sent).toEqual([]);
    expect(stub.drafts).toEqual([]);
    expect(data).toMatchObject({ drafted: false, stopped: "price_over_max_credits" });
    expect(String(data.next)).toContain("3100");
    expect(String(data.next)).toContain("2740");
  });

  it("refuses a real run without --max-credits, before any quote or byte", async () => {
    const entries = pack();
    const stub = stubHub(entries, { credits: 30, linkMaxBytes: 10_000 });
    const { result } = await draft(stub, entries, []);
    expect(result.exitCode).not.toBe(0);
    expect(stub.quotes).toEqual([]);
    expect(stub.sent).toEqual([]);
  });

  it("neither reads, uploads nor drafts a file over the link limit, and lists it by hand", async () => {
    const entries = pack();
    const stub = stubHub(entries, { credits: 20, linkMaxBytes: 300 });
    const { result, data } = await draft(stub, entries, ["--max-credits", "20"]);
    expect(result.exitCode).toBe(0);
    expect(stub.hashedNames).toEqual(["IMG_1.jpg", "IMG_3.jpg"]);
    expect(stub.sent.sort()).toEqual(["IMG_1.jpg", "IMG_3.jpg"]);
    expect(stub.drafts).toHaveLength(1);
    expect(stub.drafts[0]!.media.map((media) => media.name)).toEqual(["IMG_1.jpg", "IMG_3.jpg"]);
    expect(data.byHand).toEqual([{ position: 2, name: "IMG_2.mp4", size: expect.any(String) }]);
  });

  it("stops on a similar title unless the album is named or declared new", async () => {
    const entries = pack();
    const similar = { kind: "similar" as const, albumRef: null, mediaCount: null, similar: [{ albumRef: "555", title: "pack 🤍", mediaCount: 30 }] };

    const stopped = stubHub(entries, { credits: 30, linkMaxBytes: 10_000, album: similar });
    const first = await draft(stopped, entries, ["--max-credits", "30"]);
    expect(first.result.exitCode).not.toBe(0);
    expect(first.data).toMatchObject({ stopped: "album_title_similar", albumFound: { similar: [{ albumRef: "555" }] } });
    expect(stopped.sent).toEqual([]);
    expect(stopped.drafts).toEqual([]);

    const named = stubHub(entries, { credits: 30, linkMaxBytes: 10_000, album: similar });
    const second = await draft(named, entries, ["--max-credits", "30", "--album-ref", "555"]);
    expect(second.result.exitCode).toBe(0);
    expect(named.drafts[0]!.vaultAlbumRef).toBe("555");

    const fresh = stubHub(entries, { credits: 30, linkMaxBytes: 10_000, album: similar });
    const third = await draft(fresh, entries, ["--max-credits", "30", "--new-album"]);
    expect(third.result.exitCode).toBe(0);
    expect(fresh.drafts[0]!.vaultAlbumRef).toBeUndefined();
  });

  it("waits a bounded time for the page's albums to be read, then stops a real run that still cannot know", async () => {
    const entries = pack();
    const stub = stubHub(entries, { credits: 30, linkMaxBytes: 10_000, walks: [true] });
    const { result, data, sleeps } = await draft(stub, entries, ["--max-credits", "30"]);
    expect(result.exitCode).not.toBe(0);
    expect(data).toMatchObject({ stopped: "album_list_not_read", albumFound: { walkPending: true } });
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(3 * 60_000);
    expect(stub.sent).toEqual([]);

    const walked = stubHub(entries, { credits: 30, linkMaxBytes: 10_000, walks: [true, true, false] });
    const after = await draft(walked, entries, ["--max-credits", "30"]);
    expect(after.result.exitCode).toBe(0);
    expect(walked.quotes).toHaveLength(3);
    expect(walked.drafts).toHaveLength(1);
  });
});

describe("publication-get of an OnlyFans album", () => {
  it("prints the publication with its run and a progress line", async () => {
    const albumRun = {
      step: "uploads", files: 4, done: 1, reused: 1, refused: 1, unknown: 0, notTried: 0, tooBig: 1,
      currentFile: "IMG_3.jpg", estimateCredits: 120, spentCredits: 40, stopReason: null,
      fileList: [
        { name: "IMG_1.jpg", bytes: 10, state: "uploaded", credits: 10 },
        { name: "IMG_2.jpg", bytes: 10, state: "failed", credits: 10 },
        { name: "IMG_3.jpg", bytes: 10, state: "uploading", credits: 10 },
        { name: "IMG_4.mp4", bytes: 10, state: "too_big", credits: 0 },
      ],
      account: null, linkMaxBytes: 1_000_000_000,
    };
    const result = await runHubCli({
      argv: ["publication-get", "--id", "91"],
      env: { HUB_AGENT_KEY: "t" },
      readFile: () => null,
      fileMode: () => null,
      createHubClient: () => ({ agentPublicationGet: async () => ({ id: 91, status: "submitting", albumRun }) }) as never,
    });
    expect(result.exitCode).toBe(0);
    expect(result.document.data).toMatchObject({ id: 91, albumRun: { spentCredits: 40 } });
    const note = String(result.document.note);
    expect(note).toContain("2 of 4");
    expect(note).toContain("IMG_3.jpg");
    expect(note).toContain("40 spent of 120");
    expect(note).toContain("IMG_2.jpg");
    expect(note).toContain("IMG_4.mp4");
  });
});
