// Owner decision 2026-09-29, end to end through the real capture seam
// (persistRawPayload) and the real content-addressed catalog: an hourly
// re-read of an unchanged Fansly page whose body differs only in one-off
// CloudFront signing tokens must land on ONE catalog object, while a DM page
// keeps its signed URLs byte for byte because the AI media describer fetches
// them later.
//
// The URLs are SYNTHETIC; the shapes are the three forms seen on production.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, verifyCapturePayloadParity } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { fanslyAiMediaSource } from "../apps/runtime/src/services/ai-media-describe/fansly-source.ts";
import {
  publishCaptureCasDualWritePages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import { runCapturePayloadParityCheck } from "../apps/runtime/src/services/capture-payload-parity.ts";
import { dmRetentionDate, persistRawPayload, retentionDate } from "../apps/runtime/src/services/sync/shared.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  resetCaptureCasDualWriteForTests();
  await testDb?.stop();
});

beforeEach(async (context) => {
  resetCaptureCasDualWriteForTests();
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  const model = await createModel(app.db, { slug: "cdn-strip", name: "Cdn Strip" });
  const page = await createFanslyPage(app.db, { modelId: model!.id, label: "cdn-strip" });
  pageId = page!.id;
  publishCaptureCasDualWritePages(String(pageId));
});

function policyUrl(tag: string, epochSeconds: number, signature: string) {
  const policy = Buffer.from(JSON.stringify({
    Statement: [{
      Resource: "https://cdn3.fansly.com/*",
      Condition: { DateLessThan: { "AWS:EpochTime": epochSeconds } },
    }],
  })).toString("base64").replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~");
  return `https://cdn3.fansly.com/700000000000000001/${tag}.jpeg`
    + `?ngsw-bypass=true&Policy=${policy}&Key-Pair-Id=KTESTPAIR01&Signature=${signature}`;
}

function cannedUrl(tag: string, expires: number, signature: string) {
  return `https://cdn3.fansly.com/700000000000000001/${tag}.mp4`
    + `?ngsw-bypass=true&Expires=${expires}&Key-Pair-Id=KTESTPAIR01&Signature=${signature}`;
}

function accountMedia(id: string, read: { epoch: number; signature: string }) {
  return {
    id,
    accountId: "700000000000000002",
    previewId: null,
    permissions: { permissionFlags: [{ price: 0 }] },
    media: {
      id: `${id}0`,
      type: 1,
      mimetype: "image/jpeg",
      width: 1920,
      height: 1080,
      locations: [{ locationId: "1", location: policyUrl(`${id}-orig`, read.epoch, `${read.signature}o`) }],
      variants: [
        {
          id: `${id}1`,
          type: 1,
          mimetype: "image/jpeg",
          width: 1280,
          height: 720,
          locations: [{ locationId: "1", location: policyUrl(`${id}-720`, read.epoch, `${read.signature}v`) }],
        },
        {
          id: `${id}2`,
          type: 302,
          mimetype: "application/vnd.apple.mpegurl",
          locations: [
            { locationId: "1", location: cannedUrl(`${id}-clip`, read.epoch - 3600, `${read.signature}c`) },
            {
              location: `https://cdn3.fansly.com/new/700000000000000001/${id}/${id}.m3u8`,
              metadata: { Policy: `policy-${read.signature}`, Signature: `sig-${read.signature}`, "Key-Pair-Id": "KTESTPAIR01" },
              locationId: "102",
            },
          ],
        },
      ],
    },
  };
}

/** One transactions page as Fansly serves it since 2026-09-25: the rows plus
 *  `aggregationData.accountMedia`, whose signed URLs change on every read. */
function transactionsPage(read: { epoch: number; signature: string }) {
  return {
    data: [
      { id: "900000000000000001", type: 7001, amount: 5000, accountMediaId: "800000000000000001", createdAt: 1790000000 },
    ],
    aggregationData: { accountMedia: [accountMedia("800000000000000001", read)] },
  };
}

async function captureTransactions(read: { epoch: number; signature: string }) {
  return persistRawPayload(app.db, {
    platformAccountId: pageId,
    endpoint: "earnings_transactions",
    requestParams: { after: null, offset: 0, limit: 100 },
    responsePayload: transactionsPage(read),
    mapperVersion: "fansly-phase1-v5",
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
  }, { action: "inserting earnings_transactions raw payload", platform: "fansly" });
}

async function count(sql: string) {
  const { rows } = await testDb!.pool.query<{ n: string }>(sql);
  return Number(rows[0]?.n ?? "0");
}

describe("Fansly CDN tokens are stripped before the journal", () => {
  it("collapses two earnings_transactions reads that differ only in tokens onto one catalog object", async () => {
    await captureTransactions({ epoch: 1790600000, signature: "firstRead~A_1" });
    await captureTransactions({ epoch: 1790603600, signature: "secondRead~B_2" });

    expect(await count("select count(*)::text as n from capture_payload_objects")).toBe(1);
    expect(await count("select count(distinct payload_object_id)::text as n from sync_raw_payloads")).toBe(1);
    const hashes = await testDb!.pool.query<{ hash: string }>(
      "select encode(payload_hash, 'hex') as hash from observations where kind = 'earnings_transactions' order by id",
    );
    expect(hashes.rows).toHaveLength(2);
    expect(hashes.rows[0]!.hash).toBe(hashes.rows[1]!.hash);

    const raws = await testDb!.pool.query<{ mapper_version: string; body: string }>(
      "select mapper_version, response_payload::text as body from sync_raw_payloads order by id",
    );
    const [stored] = (await testDb!.pool.query<{ body: string }>(
      "select body::text as body from capture_json_hot_bodies",
    )).rows;
    for (const text of [...raws.rows.map((raw) => raw.body), stored!.body]) {
      expect(text).not.toMatch(/Policy|Signature|Key-Pair-Id|Expires/);
      expect(text).toContain("https://cdn3.fansly.com/700000000000000001/800000000000000001-orig.jpeg?ngsw-bypass=true");
      expect(text).toContain("https://cdn3.fansly.com/new/700000000000000001/800000000000000001/800000000000000001.m3u8");
      expect(text).toContain("900000000000000001");
    }
    expect(raws.rows.map((raw) => raw.mapper_version))
      .toEqual(["fansly-phase1-v5+cdn-tokens-stripped-v1", "fansly-phase1-v5+cdn-tokens-stripped-v1"]);

    // Both copies of every envelope hold the same stripped body, so the
    // hourly parity job has nothing to page about.
    const report = await verifyCapturePayloadParity(testDb!.db);
    expect(report).toMatchObject({ checked: 4, matched: 4, mismatched: 0 });
    const result = await runCapturePayloadParityCheck(app);
    expect(result.mismatched).toBe(0);
    expect(await count(
      "select count(*)::text as n from notification_incidents where kind = 'capture_payload_parity' and status = 'open'",
    )).toBe(0);
  });

  it("keeps a DM page's signed URLs byte-identical, and the describer still resolves one", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const media = accountMedia("810000000000000001", { epoch: future, signature: "dmRead~C_3" });
    const page = {
      messages: [{ id: "910000000000000001", groupId: "920000000000000001", senderId: "700000000000000002",
        content: "", createdAt: Math.floor(Date.now() / 1000) - 60,
        attachments: [{ contentType: 1, contentId: "810000000000000001" }] }],
      accountMedia: [media],
      accountMediaBundles: [],
    };
    const served = JSON.stringify(page);
    const { observationId } = await persistRawPayload(app.db, {
      platformAccountId: pageId,
      endpoint: "dm_messages",
      requestParams: { groupId: "920000000000000001", limit: 25, before: null },
      responsePayload: page,
      mapperVersion: "fansly-phase1-v5",
      payloadKind: "dm_messages",
      retainUntil: dmRetentionDate(),
    }, { action: "inserting ai media fast lane dm_messages raw payload", platform: "fansly" });

    const [raw] = (await testDb!.pool.query<{ mapper_version: string; body: unknown }>(
      "select mapper_version, response_payload as body from sync_raw_payloads",
    )).rows;
    const [observation] = (await testDb!.pool.query<{ body: unknown }>(
      "select payload as body from observations where kind = 'dm_messages'",
    )).rows;
    const [stored] = (await testDb!.pool.query<{ body: unknown }>(
      "select body from capture_json_hot_bodies",
    )).rows;
    expect(raw!.mapper_version).toBe("fansly-phase1-v5");
    // The 1280 px resize is the smallest image that covers 1024 px: the one
    // the describer picks.
    const signed = media.media.variants[0]!.locations[0]!.location;
    for (const body of [raw!.body, observation!.body, stored!.body]) {
      expect(body).toEqual(JSON.parse(served));
      expect(JSON.stringify(body)).toContain(signed);
    }

    const resolution = await fanslyAiMediaSource.resolve(app, {
      id: 0, pageId, platform: "fansly", mediaRef: "810000000000000001", variant: "full", mediaKind: "photo",
      senderRole: "fan", fanPlatformUserId: "700000000000000002", status: "pending", description: null,
      sourceObservationId: observationId, contentSha256: null, attempts: 1, firstMessageAt: new Date(),
      nextAttemptAt: new Date(), leaseToken: null,
    }, { now: new Date(), modelMedia: "teasers" });
    expect(resolution).toEqual({ kind: "url", url: signed, source: "fansly_capture" });
  });
});
