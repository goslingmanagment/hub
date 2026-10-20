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
    "bundleSha256": "1b19619f20e8a1656a091c0be6c7e859921a0f75f97b8636648ca8d06f186019",
    "contractHash": "9137410d6c88a628b538e61b912e209b79c087144e4ac8f21edbea7c6f587493",
    "sourceCommit": "bd3eec0657bca31e418e377288214b920575211b",
    "vendorDistSha256": "8e569bdb7e12ada6b2afb58b51befeec72acb481f9f9e137d808a5a70982c05a",
    "zodVersion": "4.6.5",
    "status": "candidate",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.2.5"
        ]
      }
    ],
    "operations": [
      "authIssueDeviceTokenWithPassword",
      "authRevokeCurrentDeviceToken",
      "clientAiUsageDaily",
      "clientAudienceNew",
      "clientBootstrap",
      "clientConversationFeed",
      "clientConversationRecaps",
      "clientFanClaim",
      "clientFanClaimStatus",
      "clientFanProfileFromGeneration",
      "clientSpenderAwaitingReply",
      "clientSpenderStats",
      "pageConversationProfile",
      "pageSpenderAutoLists",
      "spenderDetail"
    ],
    "fixture": "tests/fixtures/client-sdks/1b19619f20e8"
  },
  {
    "bundleSha256": "1da6e2f4cf2260f14311cb263331cad4e2176f0af8a0675ee83135a1c653f094",
    "contractHash": "a6f77fbb2ecffe7223855ac8760bfc590bb49cdfd0fc27e760ed06bdf42497b9",
    "sourceCommit": "a3449f77746e5ea83091330a6388213bedd9ec7f",
    "vendorDistSha256": "d304cff3eb920b8d1ad5240f0afa9c2772edcccd180a5c1d6c0a5e52b5c6ef89",
    "zodVersion": "4.4.3",
    "status": "released",
    "clients": [
      {
        "name": "fansly-chat",
        "versions": [
          "2.10.1"
        ]
      }
    ],
    "operations": [
      "aiUsageBatch",
      "authIssueDeviceTokenWithPassword",
      "authRevokeCurrentDeviceToken",
      "followerOutreachAttempt",
      "pageConversationProfile",
      "pageTopSpenders",
      "upsertFanProfile",
      "voiceNoteCreate",
      "voiceNoteStatus"
    ],
    "fixture": "tests/fixtures/client-sdks/1da6e2f4cf22"
  },
  {
    "bundleSha256": "33bb942244eb5d81e751eb8c59185a3147e6c6bd80ca6df801e18ac79c17e4e5",
    "contractHash": "db838fab3e9aa6949b38653aa321f907e6fddc218c2bd2b22dcae065a8929583",
    "sourceCommit": "d7de039a522ce8764f3b48a6a84ae152764b7049",
    "vendorDistSha256": "dac4dd6215bb2d981a298008b4bf0d19f2e1ec827a1c6d484e848d08e99780e4",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.5.9"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/33bb942244eb"
  },
  {
    "bundleSha256": "64a972fd6222146851797da149e109f53a116eeabd35fb875dac3d48c3288842",
    "contractHash": "030124539ce7c649519ca0acafe8c6c131e3620025e7b858650857baa7119bbc",
    "sourceCommit": "6ee3d627e204efd791424b5ae5802b9e4a48b82c",
    "vendorDistSha256": "bd65e2476a58b208e6f4ffa4797904d0ad9f40acb1d43e993ea0e176eec7e384",
    "zodVersion": "4.4.3",
    "status": "released",
    "clients": [
      {
        "name": "fansly-chat",
        "versions": [
          "2.8.1",
          "2.9.0"
        ]
      }
    ],
    "operations": [
      "aiUsageBatch",
      "authIssueDeviceTokenWithPassword",
      "authRevokeCurrentDeviceToken",
      "followerOutreachAttempt",
      "pageConversationProfile",
      "pageTopSpenders",
      "upsertFanProfile",
      "voiceNoteCreate",
      "voiceNoteStatus"
    ],
    "fixture": "tests/fixtures/client-sdks/64a972fd6222"
  },
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
  {
    "bundleSha256": "eb9748670d9761bfc3caac97003ffbdcecb1407756f0284a06223821e8f8c161",
    "contractHash": "030124539ce7c649519ca0acafe8c6c131e3620025e7b858650857baa7119bbc",
    "sourceCommit": "6ee3d627e204efd791424b5ae5802b9e4a48b82c",
    "vendorDistSha256": "bd65e2476a58b208e6f4ffa4797904d0ad9f40acb1d43e993ea0e176eec7e384",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.2.2",
          "0.2.3",
          "0.2.4"
        ]
      }
    ],
    "operations": [
      "authIssueDeviceTokenWithPassword",
      "authRevokeCurrentDeviceToken",
      "clientAiUsageDaily",
      "clientAudienceNew",
      "clientBootstrap",
      "clientConversationFeed",
      "clientConversationRecaps",
      "clientFanClaim",
      "clientFanClaimStatus",
      "clientFanProfileFromGeneration",
      "clientSpenderAwaitingReply",
      "clientSpenderStats",
      "pageConversationProfile",
      "pageSpenderAutoLists",
      "spenderDetail"
    ],
    "fixture": "tests/fixtures/client-sdks/eb9748670d97"
  },
  {
    "bundleSha256": "ecc96bbb7c17b30fd06941e0bce701393b707762ffb24015c9627cb50d7783fd",
    "contractHash": "152b37aee3198a4527e1def4890ef091ec77e2c31c5b76a99c8fb9c2af82fbea",
    "sourceCommit": "74c0f32251b633b76e0eb06f4c0e0762ae31eae2",
    "vendorDistSha256": "f332ee31209f6cbb21e343010b94f0edd7fa765e39871f5463f865b41d924eb8",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.5.0",
          "0.5.1",
          "0.5.2",
          "0.5.3",
          "0.5.4",
          "0.5.5",
          "0.5.6",
          "0.5.7",
          "0.5.8"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/ecc96bbb7c17"
  },
  // client-sdk-registry:end
];
