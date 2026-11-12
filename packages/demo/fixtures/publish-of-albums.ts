/**
 * OnlyFans vault albums (8-docs 2026-11-12-of-vault-album) in every outcome on
 * mia-of: a draft with its price, one going up now, one out whole, one out in
 * part, one not confirmed, one refused and one not sent — each with its run
 * (`albumRun`) as Hub's card reads it. Prices are the executor's: 3 credits a
 * started MB, 1 for a file Hub uploaded before, 0 for one too big, 15 for the
 * album's own requests.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { iso } from "../core.ts";
import { HOUR_MS, demoDigits, demoSha } from "./publish-of-common.ts";

type Publication = KernelOperationResponse<"adminPublicationList">["publications"][number];
type Detail = KernelOperationResponse<"adminPublicationGet">;
type Event = Detail["events"][number];
type AlbumRun = NonNullable<Publication["albumRun"]>;
type FileState = AlbumRun["fileList"][number]["state"];

interface Built {
  publication: Publication;
  events: Event[];
  revision: Detail["revision"];
}

const OWNER_ID = 1;
const CONTENT_AGENT_KEY_ID = 9;
const MB = 1_000_000;
const OVERHEAD = 15;
/** The link's limit (onlyfansVaultLinkMaxMb, 1000 decimal MB by default): a larger file is added by hand. */
const LINK_MAX = 1_000 * MB;

function credits(bytes: number, state: FileState): number {
  if (state === "too_big") return 0;
  if (state === "reused" || state === "in_album") return 1;
  return Math.max(1, Math.ceil((bytes * 3) / MB));
}

/** `count` files named `stem_NN.jpg`, every fifth a short video; `big` adds one long video at the end. */
function folder(stem: string, count: number, seed: number): Array<{ name: string; bytes: number }> {
  return Array.from({ length: count }, (_, index) => {
    const video = index % 5 === 4;
    const size = video ? 22 * MB + ((seed * 7 + index * 13) % 60) * MB : 2 * MB + ((seed * 5 + index * 11) % 9) * 380_000;
    return { name: `${stem}_${String(index + 1).padStart(2, "0")}.${video ? "mov" : "jpg"}`, bytes: size };
  });
}

const ACCOUNT: AlbumRun["account"] = { dailyCredits: 15_000, spentToday: 2_710, left: 9_820, balance: 68_400, centsPer1000: 149 };

interface Spec {
  id: number;
  title: string;
  /** Hours from now of its publish time (an album goes once its time came). */
  at: number;
  status: Publication["status"];
  reason: string | null;
  files: Array<{ name: string; bytes: number; state: FileState }>;
  step: AlbumRun["step"];
  spent: number;
  stopReason?: string | null;
  /** Spent today of the albums' account was already this when it started (a running album's price is kept). */
  author?: "agent" | "human";
}

function build(now: Date, spec: Spec): Built {
  const nowMs = now.getTime();
  const publishAt = nowMs + spec.at * HOUR_MS;
  const createdAt = Math.min(publishAt, nowMs) - 5 * HOUR_MS;
  const approvedAt = createdAt + 2 * HOUR_MS;
  const fileList = spec.files.map((file) => ({ name: file.name, bytes: file.bytes, state: file.state, credits: credits(file.bytes, file.state) }));
  const estimate = fileList.reduce((sum, file) => sum + file.credits, OVERHEAD);
  const count = (...states: FileState[]) => spec.files.filter((file) => states.includes(file.state)).length;
  const beforeOut = spec.status === "draft" || spec.status === "approved";
  const run: AlbumRun = {
    step: spec.step,
    files: spec.files.length,
    done: count("uploaded"),
    reused: count("reused", "in_album"),
    refused: count("failed"),
    unknown: count("unknown"),
    notTried: count("not_tried") + (spec.step === "done" ? count("pending") : 0),
    tooBig: count("too_big"),
    currentFile: spec.files.find((file) => file.state === "uploading")?.name ?? null,
    estimateCredits: estimate,
    spentCredits: spec.spent,
    stopReason: spec.stopReason ?? null,
    fileList,
    account: beforeOut ? ACCOUNT : null,
    linkMaxBytes: LINK_MAX,
  };
  const approved = spec.status !== "draft";
  const revisionId = approved ? spec.id * 3 + 1 : null;
  const agent = (spec.author ?? "agent") === "agent";
  const hub = { actorKind: "hub" as const, actorUserId: null, actorAgentKeyId: null };
  const events: Event[] = [{
    fromStatus: null, toStatus: "draft", actorKind: agent ? "agent" : "human", actorUserId: agent ? null : OWNER_ID,
    actorAgentKeyId: agent ? CONTENT_AGENT_KEY_ID : null, reason: null, at: iso(new Date(createdAt)),
  }];
  if (approved) {
    events.push({ fromStatus: "draft", toStatus: "approved", actorKind: "agent", actorUserId: null, actorAgentKeyId: CONTENT_AGENT_KEY_ID, reason: null, at: iso(new Date(approvedAt)) });
  }
  const startedAt = Math.max(publishAt, approvedAt) + 60_000;
  if (spec.status === "missed") {
    events.push({ fromStatus: "approved", toStatus: "missed", ...hub, reason: spec.reason, at: iso(new Date(publishAt + 12 * HOUR_MS)) });
  } else if (approved && spec.status !== "approved") {
    events.push({ fromStatus: "approved", toStatus: "submitting", ...hub, reason: null, at: iso(new Date(startedAt)) });
    if (spec.status !== "submitting") {
      events.push({ fromStatus: "submitting", toStatus: spec.status, ...hub, reason: spec.reason, at: iso(new Date(startedAt + spec.files.length * 70_000)) });
    }
  }
  const last = events.at(-1)!.at;
  const sent = !["draft", "approved", "missed"].includes(spec.status);
  const findings = spec.status === "draft"
    ? spec.files.flatMap((file, index) => file.state === "too_big"
      ? [{ code: "onlyfans_file_too_large" as const, severity: "warning" as const, mediaKey: `file:${7000 + spec.id * 10 + index}`, at: null, postRef: null, publicationId: null, detail: { byteSize: file.bytes, maxBytes: LINK_MAX, byHand: 1 } }]
      : [])
    : [];
  const publication: Publication = {
    id: spec.id,
    pageLabel: "mia-of",
    platform: "onlyfans",
    kind: "vault_album",
    status: spec.status,
    version: approved ? 2 : 1,
    text: spec.title,
    publishAt: iso(new Date(publishAt)),
    expiresAt: null,
    wallRefs: [],
    tierRefs: [],
    priceMills: null,
    repost: false,
    pinWallRefs: [],
    replyLock: [],
    subscribersOnly: false,
    extraAttachments: [],
    media: spec.files.map((file, position) => ({
      role: "media" as const, position, source: "file" as const, mediaRef: null, fileId: 7000 + spec.id * 10 + position, attachment: 0, name: file.name,
    })),
    findings,
    blocked: false,
    author: agent ? { kind: "agent", userId: null, agentKeyId: CONTENT_AGENT_KEY_ID } : { kind: "human", userId: OWNER_ID, agentKeyId: null },
    approvedRevisionId: revisionId,
    platformPostRef: null,
    vaultAlbumRef: sent && spec.step !== "album" ? demoDigits(`ofalbum:${spec.id}`, 9) : null,
    statusReason: spec.reason,
    previousPublicationId: null,
    withdrawal: null,
    deletion: null,
    albumRun: run,
    createdAt: iso(new Date(createdAt)),
    updatedAt: last,
    statusChangedAt: last,
  };
  const revision: Detail["revision"] = revisionId === null ? null : {
    id: revisionId, fingerprint: demoSha(`ofalbum-rev:${spec.id}`).slice(0, 40), approvedByUserId: OWNER_ID, approvedAt: iso(new Date(approvedAt)),
  };
  return { publication, events, revision };
}

const with_ = (files: Array<{ name: string; bytes: number }>, state: (index: number) => FileState) =>
  files.map((file, index) => ({ ...file, state: state(index) }));

/** The seven albums, one per outcome. */
export function demoOnlyfansAlbums(now: Date): Built[] {
  // One take by a link (over 100 MB, under the link's limit), one too big for it: added by hand.
  const robe = [...folder("robe", 22, 1), { name: "robe_long_take.mov", bytes: 420 * MB }, { name: "robe_full_take.mov", bytes: 1_840 * MB }];
  const pool = folder("pool", 36, 2);
  const beach = folder("beach", 12, 3);
  const mirror = [...folder("mirror", 18, 4), { name: "mirror_bts.mov", bytes: 310 * MB }, { name: "mirror_long.mov", bytes: 2_300 * MB }];
  const cozy = folder("cozy", 10, 5);
  const lace = folder("lace", 8, 6);
  const cabin = folder("cabin", 18, 7);
  const spentOf = (files: Array<{ bytes: number; state: FileState }>) => files.reduce((sum, file) => sum + (["uploaded", "failed", "unknown"].includes(file.state) ? credits(file.bytes, file.state) : 0), 0);

  const poolFiles = with_(pool, (index) => (index >= 22 ? "uploaded" : index === 21 ? "uploading" : "pending"));
  const mirrorFiles = with_(mirror, (index) => (index === 19 ? "too_big" : index === 6 || index === 11 ? "failed" : index === 14 ? "unknown" : "uploaded"));
  const laceFiles = with_(lace, (index) => (index >= 5 ? "failed" : "not_tried"));
  const beachFiles = with_(beach, (index) => (index < 2 ? "reused" : "uploaded"));
  const cozyFiles = with_(cozy, () => "uploaded");

  return [
    build(now, {
      id: 4901, title: "SEXTING white robe", at: 20, status: "draft", reason: null, step: null, spent: 0,
      files: with_(robe, (index) => (index === 23 ? "too_big" : index < 3 ? "reused" : "pending")),
    }),
    build(now, {
      id: 4902, title: "Pool day set", at: -0.4, status: "submitting", reason: null, step: "uploads", spent: spentOf(poolFiles) + 4, files: poolFiles,
    }),
    build(now, {
      id: 4903, title: "October beach set", at: -30, status: "published", reason: null, step: "done", spent: spentOf(beachFiles) + 2 + 6, files: beachFiles,
    }),
    build(now, {
      id: 4904, title: "Hotel mirror series", at: -8, status: "published", step: "done", spent: spentOf(mirrorFiles) + 7, files: mirrorFiles,
      reason: "files_failed:2/20:mirror_07.jpg=upload_http_400,mirror_12.jpg=upload_http_400;files_unknown:1/20:mirror_15.mov=indeterminate;files_too_big:1:mirror_long.mov",
    }),
    build(now, {
      id: 4905, title: "Cozy weekend", at: -5, status: "unknown", step: "done", spent: spentOf(cozyFiles) + 8, files: cozyFiles,
      reason: "files_missing:1:cozy_09.jpg",
    }),
    build(now, {
      id: 4906, title: "Red lingerie set", at: -52, status: "rejected", step: "done", spent: spentOf(laceFiles) + 3, files: laceFiles, stopReason: "three_failures",
      reason: "files_failed:3/8:lace_06.jpg=upload_http_400,lace_07.jpg=upload_http_400,lace_08.jpg=upload_http_400;files_not_tried:5:three_failures:lace_01.jpg,lace_02.jpg,lace_03.jpg,lace_04.jpg,lace_05.mov",
    }),
    missed(build(now, {
      id: 4907, title: "Mountain cabin", at: -40, status: "missed", step: null, spent: 0, files: with_(cabin, () => "pending"), reason: null,
    })),
  ];
}

/** Not sent in its 12 hours: the day's ceiling had less left than its price. */
function missed(built: Built): Built {
  const reason = `not_sent:vault_credits_day_left:400<${built.publication.albumRun?.estimateCredits ?? 0}`;
  built.publication.statusReason = reason;
  for (const event of built.events) if (event.toStatus === "missed") event.reason = reason;
  return built;
}
