// Frozen client SDKs: the vendored @kernel/sdk builds of released (and
// candidate) clients that every hub candidate must keep serving.
//
// Each row is one build, frozen as an esbuild bundle (zod inside) under
// tests/fixtures/client-sdks/<bundle12>/ and run against a live hub by
// tests/client-sdk-compat.integration.test.ts. The row key is the BUNDLE
// digest, not the contract hash: the contract hash is sha256 of the OpenAPI
// document, so SDK code can change under one hash, and two such builds must
// never overwrite each other's fixture. Several rows may therefore share a
// contractHash; whoever lists the hashes dedupes them.
//
// The registry lives hub-side only and is never vendored into a client.
// Rows are written by `node scripts/register-client-sdk.mjs` between the
// markers below, sorted by bundleSha256 — never edit them by hand.

export const CLIENT_SDK_NAMES = ["onlyfans-chat", "fansly-chat", "chat-extension"] as const;
export type ClientSdkName = (typeof CLIENT_SDK_NAMES)[number];

export const CLIENT_SDK_FIXTURE_ROOT = "tests/fixtures/client-sdks";

export interface ClientSdkRegistryRow {
  /** sha256 of `<fixture>/sdk.mjs`: the row key. */
  bundleSha256: string;
  /** KERNEL_CONTRACT_HASH baked into the bundle (sha256 of the OpenAPI document). */
  contractHash: string;
  /** Hub commit the client vendored from: 40 hex, never "-dirty". */
  sourceCommit: string;
  /** sha256 over the client's vendored dist/ (sorted `path\0sha256(file)\n`
   *  lines): lets a client's release gate find its exact row. */
  vendorDistSha256: string;
  /** zod bundled into sdk.mjs: read from the build metafile and checked
   *  against the client's lockfile, since vendorDistSha256 covers dist/ only. */
  zodVersion: string;
  status: "released" | "candidate";
  clients: ReadonlyArray<{ name: ClientSdkName; versions: readonly string[] }>;
  /** Operation keys the compat suite exercises beyond its shared core. */
  operations: readonly string[];
  /** Repo-relative fixture directory: `${CLIENT_SDK_FIXTURE_ROOT}/<bundleSha256 first 12>`. */
  fixture: string;
}

export const CLIENT_SDK_REGISTRY: readonly ClientSdkRegistryRow[] = [
  // client-sdk-registry:begin
  {
    "bundleSha256": "6d2ce2a90751df7280891ceb6dcc6c8fe9f99a89ef99fbb040d4734e778d5e5e",
    "contractHash": "b95b765c12f50905cb8f98c2d9644cf5adc4234299cd6516f0cd649b39235aab",
    "sourceCommit": "e033e3ec097f913a32433febcf60c6f3615ba071",
    "vendorDistSha256": "15a0f5f4a2f466abc7ed0fe247ae3f708ee572937f87cf8f2f72e0110e83e1f6",
    "zodVersion": "4.4.3",
    "status": "released",
    "clients": [
      {
        "name": "fansly-chat",
        "versions": [
          "2.6.0",
          "2.7.0",
          "2.7.1"
        ]
      },
      {
        "name": "onlyfans-chat",
        "versions": [
          "0.1.64"
        ]
      }
    ],
    "operations": [
      "aiUsageBatch",
      "authActivateDeviceToken",
      "authIssueDeviceTokenWithPassword",
      "authRevokeCurrentDeviceToken",
      "cancelOfapiCommand",
      "createOfapiCommand",
      "eventsV2Facts",
      "followerOutreachAttempt",
      "getOfapiCommand",
      "ofapiCreditsChatterSummary",
      "pageConversationProfile",
      "pageFanProfile",
      "pageTopSpenders",
      "upsertFanProfile",
      "voiceNoteCreate",
      "voiceNoteStatus"
    ],
    "fixture": "tests/fixtures/client-sdks/6d2ce2a90751"
  },
  // client-sdk-registry:end
];
