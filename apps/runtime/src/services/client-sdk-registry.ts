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
    "bundleSha256": "09f7e7b5c78c8f69b34eea5f380229c6c96a86b3b702091854900a21a44d7c7e",
    "contractHash": "552db4f131be9a35a7c78951c7cb0eba8fd05712dd0218e2ad24074f17780c15",
    "sourceCommit": "c7c9d95c0192e21d12fec1cd906a20fd97612918",
    "vendorDistSha256": "11bd53abe4bb0835616e47cfcaf0208fabacddeec1c4123f2ebce01abadf06a0",
    "zodVersion": "4.6.5",
    "status": "candidate",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.8.5"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/09f7e7b5c78c"
  },
  {
    "bundleSha256": "14fc5fb9f8b468d436e229b2d30fdcddd6c28d868ff71198442cd4c49e4610b1",
    "contractHash": "a122c4e09f2c62e0b739e8047ea6f7091aeaf796b3828a75a04c79f75a1231d9",
    "sourceCommit": "220304ccbf3fd33af999da6c8a7b73f9f4cde16b",
    "vendorDistSha256": "fc2bd53e209a669e8e456b42c0a88122d3b174736459e576c7e0c76238cac337",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "3.5.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/14fc5fb9f8b4"
  },
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
    "bundleSha256": "278432395e5704da77d88b7c7b36e5b866baa22170018df49993efc0f81bc60c",
    "contractHash": "0cc6c868f5c59aad6e702479b2f010d29fce123adc0569533ae803212eb3caa3",
    "sourceCommit": "3ffb461437963aea6719128fc8d7b386518cbefa",
    "vendorDistSha256": "b26e48c33d4a72d9bd6211711b23dabd9c44ddc13774ed658bd39430fae2014f",
    "zodVersion": "4.6.5",
    "status": "candidate",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.9.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/278432395e57"
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
    "bundleSha256": "4644047a0d0079ad4b1552c529d6b562f3f052ba2b9a6ed817ca5d3823383f6c",
    "contractHash": "4250d90752abaf55a6b29c50f14df5a3c998a100e11507969a7293b83cd4ef2a",
    "sourceCommit": "52ae2b3a77262ae210640159a10cab8d507573dc",
    "vendorDistSha256": "768f8cb86101c8c023ca7382264223ef27dd6f98ffe73a5684bd91c132b3dcb8",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "3.6.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/4644047a0d00"
  },
  {
    "bundleSha256": "4769654c86e67e3b21b1cd1f666fefd9d0580f6abd61e2ef67753c9944dba78f",
    "contractHash": "6e6d52916024adf5aa06984bf5350bf6f8407b885a25d82d6c41e9d65e37d56a",
    "sourceCommit": "9779bfb473dbf3f8d565b3251d1c443b24c39051",
    "vendorDistSha256": "d6b7a4475371071dcb7c8f9bf6a8db3e784fb0cfb01f46bd8cc4f175842e1d50",
    "zodVersion": "4.6.5",
    "status": "candidate",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.10.5"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/4769654c86e6"
  },
  {
    "bundleSha256": "5ab1f9d0d38cf1fbb27fbeba37bd40553d789c75066cc14cd3992fe08f1acb5f",
    "contractHash": "efa423b3ba0241dc1db43435572a8304dccd0f4bfded24a7ca14c4a59bf7bb15",
    "sourceCommit": "efb5a90312fe74c29affde4c323d13d7eaa05026",
    "vendorDistSha256": "4bd989d890ef59cacc694b83ea341e1e70003e9f66e1480f8954648a5b1eba31",
    "zodVersion": "4.6.5",
    "status": "candidate",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.9.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/5ab1f9d0d38c"
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
    "bundleSha256": "69580d077960a69378cd4bdbe3bb2dd94f2bcf823635ed73711ed22d164dbd27",
    "contractHash": "d13febdb54f73733f11262552926a9feea7546bcd7543f26577ac02c4c5536ac",
    "sourceCommit": "b5de702d8b4a7461dc87494b6780a45ef3cde374",
    "vendorDistSha256": "da8ac13b514ffc06a368f8c4b0d39f0160b4cb740f6e457f8262933eb201db64",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "3.10.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/69580d077960"
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
    "bundleSha256": "77ca842c1748452c2249b8f315f305ffbb2d192e6322ad41433b10b5b93e2894",
    "contractHash": "34c742e6792b289ea0201f87fe8c844a51bb2352abe9b00226982ba1a2b31c7b",
    "sourceCommit": "5bb222527635fa1d5465f4ea61bbad6ddcecaa4f",
    "vendorDistSha256": "344137676068865116f666ab64146ff490195767a278fdfed0e477f0d1ea7510",
    "zodVersion": "4.6.5",
    "status": "candidate",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.9.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/77ca842c1748"
  },
  {
    "bundleSha256": "7cda29bdc065d274fd0a54b57e004ed237fe33043ea27dcd50172c219e92890a",
    "contractHash": "19a146c19cee6e7049f8acdc1dc1d221ada5617d91f58bc15161f79652cd119f",
    "sourceCommit": "879c052272399db018c8528f16a1e151c8b328b9",
    "vendorDistSha256": "71433692eda98fdca6877e2ce2236fc16cb9e8fe49400d4a48be1bcc30c74fea",
    "zodVersion": "4.4.3",
    "status": "released",
    "clients": [
      {
        "name": "fansly-chat",
        "versions": [
          "2.14.0"
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
    "fixture": "tests/fixtures/client-sdks/7cda29bdc065"
  },
  {
    "bundleSha256": "83225850e498b852da38a40b2c94364543cdb4d36f2b6c12bcb11aae9d4f1b48",
    "contractHash": "baf15e7f1f1c249b9d8c5b56e05569b2d9a6f7656a977f13788e73557faf2862",
    "sourceCommit": "5877968eeb5de1e89d6dd1b4dd104fa7e030270c",
    "vendorDistSha256": "5d070fa2daa54ea379607fae451e6f0d4518739f2a9251618b4e0438aab2d13a",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "3.4.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/83225850e498"
  },
  {
    "bundleSha256": "864ac25f83aed8ba73251da71df7de095ec396344ca14c5934b255c9b0ccb707",
    "contractHash": "3dfd5a70e7e4a54370a654745195e5af95e5f25d0b5ca61e485563585cda101f",
    "sourceCommit": "7fcfa59c309bc083bc50eabe02cb5b1928fc3768",
    "vendorDistSha256": "04dd44f3c66e41a48fb09da674035df86f68c1d6df3a78fe36d5a67f11922630",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.6.4",
          "0.6.5"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/864ac25f83ae"
  },
  {
    "bundleSha256": "98c1c6e459d29670e7dd88a549cc8b6f99dad3df5e9b202faefd10a548a567b5",
    "contractHash": "7c4766c5a4f0e4ab43ec4b5fd1fb4650739e08df612f5a68c496b58c4b0aef5c",
    "sourceCommit": "0312b7fa266b3d4225dd14265b987a20d4093885",
    "vendorDistSha256": "94db5d85c7226061983da83a4df152b1c4eeb1357b012101f775a6ab03248715",
    "zodVersion": "4.6.5",
    "status": "candidate",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.7.1"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/98c1c6e459d2"
  },
  {
    "bundleSha256": "b08f1ab15b275ddcc1ce3de56f536518f1bd22959420ca455ab075e60bf12e90",
    "contractHash": "0693f8081a89500ce91f57a8bbbb2eb503534aab679d337d5e110581302cbd27",
    "sourceCommit": "c0fe27688e566fb188e1bf06f900a94311efe7d0",
    "vendorDistSha256": "2862934354234009149adab47384809b4a4328d2284e4af225211d1c61c1d987",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.5.20"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/b08f1ab15b27"
  },
  {
    "bundleSha256": "b1b2792746db7386ad5ac3542588688e4d8ba769a9cb94d66ac8d724b2f584d7",
    "contractHash": "152d417095207c653d7423f2155468cc6dbd4ba95d597a13afa8dacb4d8338cd",
    "sourceCommit": "c32fae68424d4eff48511af3baa08472c4a7ea5c",
    "vendorDistSha256": "d4e19d6f5e0b21f04069163adf95e2394372a7b0ca2894cfebead745a794f20b",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "3.1.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/b1b2792746db"
  },
  {
    "bundleSha256": "ba9b324a97a4581301cd0c193241d25c7e35c647ace24e0db4c0d26e8012ee2f",
    "contractHash": "3a64b6b39b479c75ca0ad6b263ffd20c7c6a7a5e8bee2b2a6ba3720ec39a4f4f",
    "sourceCommit": "a08a51de99959ce3485aca87aac4d567ae52f4d2",
    "vendorDistSha256": "41ff718916fceabc23d8a84aec7421435892a1a65c40d00d446479a6439171b6",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "3.12.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/ba9b324a97a4"
  },
  {
    "bundleSha256": "bb851b4322bc8d6f85e4418955c9e57709e0e00d5411f3257c0b939c1c0f3a47",
    "contractHash": "ab7f0d6c037e9067cffbc43f5e48a6769f5d01420f64a20d63a70a5a57a06c25",
    "sourceCommit": "e47dd4ccbdbae02bb83faed773b8311a9a9d7c84",
    "vendorDistSha256": "8fefab9f11d201986b3b7848f6280993ca6ae14d3dcb0eb47aceeda9c91417dd",
    "zodVersion": "4.6.5",
    "status": "candidate",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.9.0"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/bb851b4322bc"
  },
  {
    "bundleSha256": "be440b6237b7e1765d195880c917f64245bc11965166eebf2cbb64f77968400a",
    "contractHash": "24317a4aa9197be22309884b573e782700ffec6a697a97005ad3b09f02db4284",
    "sourceCommit": "9f8290082de0adaca3ea19c48c31c48322d06a3e",
    "vendorDistSha256": "6429f3bebde5eff7f15d39ab55e98f8565a3d1f8eb246ff43cf3b8ce636a73cf",
    "zodVersion": "4.4.3",
    "status": "released",
    "clients": [
      {
        "name": "fansly-chat",
        "versions": [
          "2.13.1"
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
    "fixture": "tests/fixtures/client-sdks/be440b6237b7"
  },
  {
    "bundleSha256": "c408b33dcc8aa17980b28346ce5aa702a2e8d2cfa6a58d2b9068450e0a8f8f4e",
    "contractHash": "acfa7edbf993e74580d9cbeb5cb0389b3d1d3ff09974729492b5e85d0ccff733",
    "sourceCommit": "b273fdf732c7bafa72ffb713fb5a7e1c61b1b5e4",
    "vendorDistSha256": "36fdb870bc4d1f837cbf5d6d004a1a956a49dbf692b8a8d99c3c1b6067355c4d",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "3.12.2"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/c408b33dcc8a"
  },
  {
    "bundleSha256": "ca8e271b602e12231cbd8ffb3d7e472587b114aad50ef760c0a50f800e2ff76b",
    "contractHash": "e67afc616a744f9894960e4f812359c59f991a68952040844d870312e48a0e49",
    "sourceCommit": "52e09102495da00f0200ae1c169d6de40a57d0b3",
    "vendorDistSha256": "ef4ebdb90eae76e7ab72b33d9ee9ad3da6c977984cc62c29af2a867f1898bd30",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "3.8.2"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/ca8e271b602e"
  },
  {
    "bundleSha256": "e1c79408533319e419a5ad08edb172290700ffcf7b4a5d5f797841e3c78d8e4b",
    "contractHash": "56068ced14f588bb556dd277bdb997f38419830dae0122776a99837454310e38",
    "sourceCommit": "a303e0b77340b24313728f18c0e5448ec9e3c9a5",
    "vendorDistSha256": "7b93b054a4ba27d53e8fd97cc13e8902f485b42bae9f09ebec8c37d779ed5a56",
    "zodVersion": "4.6.5",
    "status": "released",
    "clients": [
      {
        "name": "chat-extension",
        "versions": [
          "0.5.21"
        ]
      }
    ],
    "operations": [],
    "fixture": "tests/fixtures/client-sdks/e1c794085333"
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
