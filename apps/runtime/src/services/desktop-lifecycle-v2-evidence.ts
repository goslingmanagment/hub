import type { Pool, PoolClient } from "pg";

const SHA_1_RE = /^[0-9a-f]{40}$/;
const SHA_256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const DESKTOP_LIFECYCLE_V2_EVIDENCE = {
  schemaVersion: 1,
  capability: "desktop-lifecycle-v2",
  extension: {
    repo: "goslingmanagment/chatgoose",
    version: "1.9.7",
    source: {
      commitSha: "77e6086f8aac4279a138ebddd7affbac50687e05",
      treeSha: "43ff07811d5a449ee884b72e0664d0c0c67d07a5",
      requiredBlobs: [
        { path: ".github/workflows/ci.yml", sha: "67675907c46cd2522a368cc3e88343fdc7958c3f" },
        { path: "src/background/persona-catalog.ts", sha: "cad45ad627d5236189814691b7e2624ef2dc9f95" },
        { path: "src/shared/persona-preservation.ts", sha: "ad39ad6dcb98d762b9b6cf26f6fb20588a421e84" },
        { path: "tests/persona-catalog.test.ts", sha: "6b782ec4cacce3105f13240d7277638f694f1879" },
        { path: "tests/options-persona-recovery.test.ts", sha: "0da1979b49c4b6b8dc0ee33620a0daf87dbb944c" },
        { path: "tests/storage-migration.test.ts", sha: "e1ec8ca22b2aef5dcfcd552fb7094e0bd8eed0be" },
      ],
    },
    tag: {
      name: "v1.9.7",
      objectSha: "3018ff1188ca61f552bed6dfb16313bedf5ff578",
      message: "ChatGoose 1.9.7 — signed and served from https://ext.gosling-agency.ru (xpi sha256:60f7377685888f3bf978fb86f9366ac0641d05aaeb8d1a4bc1ffcbfed39dd2ae); deployed from 77e6086f8aac4279a138ebddd7affbac50687e05\n",
    },
    ci: {
      runId: 29363059680,
      workflowId: 287263157,
      attempt: 1,
      headBranch: "main",
      event: "push",
      requiredJobs: [
        { name: "check", requiredSuccessfulSteps: ["Check"] },
      ],
    },
    feed: {
      url: "https://ext.gosling-agency.ru/updates.json",
      artifactUrl: "https://ext.gosling-agency.ru/chatgoose-1.9.7.xpi",
      latestArtifactUrl: "https://ext.gosling-agency.ru/chatgoose-latest.xpi",
      sha256: "60f7377685888f3bf978fb86f9366ac0641d05aaeb8d1a4bc1ffcbfed39dd2ae",
    },
  },
  desktop: {
    repo: "goslingmanagment/chatgoose_desktop_2",
    version: "0.1.42",
    source: {
      commitSha: "46b9b61cbf0fed4a9f4405b8f1241b3cb1c02806",
      treeSha: "73b6e95a986338aef50b29b3783294b3699ac078",
      requiredBlobs: [
        { path: ".github/workflows/ci.yml", sha: "8a58ed3191786d27d5f0dfb3ea0eedf89c19b121" },
        { path: ".github/workflows/windows-build.yml", sha: "39152d4e093b1c35247e222d65119bb9900247e7" },
        { path: "apps/desktop/src/main/personas/catalog.ts", sha: "3b906d165dc2d93bb3060255707ef28901b83e96" },
        { path: "apps/desktop/tests/hub/handlers.test.ts", sha: "0c54c165db9408893312af2271efde840381c5a8" },
        { path: "apps/desktop/tests/hub/persona-catalog.test.ts", sha: "e4406df5ceee1a2f5020644ebd0581272d5900cd" },
      ],
    },
    ci: {
      runId: 29365744729,
      workflowId: 308306907,
      attempt: 1,
      headBranch: "main",
      event: "push",
      requiredJobs: [
        { name: "pnpm check", requiredSuccessfulSteps: ["Check (typecheck + lint + test + build)"] },
        { name: "pnpm check (Windows)", requiredSuccessfulSteps: ["Check (typecheck + lint + test + build)"] },
      ],
    },
    candidate: {
      runId: 29377654159,
      workflowId: 295090824,
      attempt: 1,
      headBranch: "main",
      event: "workflow_dispatch",
      requiredJobs: [
        {
          name: "build",
          requiredSuccessfulSteps: [
            "Check (typecheck + lint + test + build)",
            "Build Windows installer",
            "Verify Authenticode when signing is configured or required",
            "Smoke-launch the packaged app",
            "Run actions/upload-artifact@v4",
          ],
          requiredSkippedSteps: [
            "Upload to the update feed",
            "Remove update-feed deploy key",
            "Assert served feed version == package.json == tag",
          ],
        },
      ],
      artifact: {
        id: 8328555662,
        name: "chatgoose-windows-installer",
        digest: "sha256:9f8de41f260ad885ab650204865225fa48671a89df53a9530352b37421109215",
        expiresAt: "2026-07-18T00:02:45.000Z",
        files: [
          {
            path: "ChatGoose-Setup-0.1.42.exe",
            size: 101728446,
            sha256: "cbd1c60bd2dcbe9a88fc9099a36aeb2a63d1057013006f05644ede3aff10eba9",
          },
          {
            path: "ChatGoose-Setup-0.1.42.exe.blockmap",
            size: 106629,
            sha256: "b412c98c747b94800e9a768c9ae260683edbb91e93f1a12386905868e9cfcbae",
          },
          {
            path: "latest.yml",
            size: 350,
            sha256: "0e9b2e121fb74be1d8e64d120dba89ebc599a4f59ea1e46d675e09047840cd2d",
          },
        ],
      },
    },
  },
  preservationReceipts: {
    extension: {
      verifiedAt: "2026-07-14T20:38:01.000Z",
      clientVersion: "1.9.7",
      migration: { fromSchemaVersion: 13, toSchemaVersion: 14 },
      immutableSnapshotPresent: true,
      personaCount: 1,
      personaCharacters: 6871,
      mappingCount: 6,
      aliasCount: 15,
      exportSha256: "050215a9e33165339a888ceb184b0600d135aea86e7372aa8657c90f77811510",
      catalogGetsObserved: 1,
      personaWritesObserved: 0,
    },
    desktop: {
      verifiedAt: "2026-07-14T23:56:27.889Z",
      candidateVersion: "0.1.42",
      migration: { fromSchemaVersion: 16, toSchemaVersion: 19 },
      machineId: "58201c28-5c87-44da-979e-d075c1025be3",
      personaCount: 1,
      mappingCount: 2,
      exportSha256: "e83a54317b92e4bfb49f5b654af34a399b169236ae2b3c4321b165acb8789058",
      diagnosticsSha256: "2708cadfdc9c8066e66793906c42dbf13327d1088a6a049ffd7e13dcfef43367",
    },
  },
  inventorySafetyMarginSeconds: 24 * 60 * 60,
  // Filled only after this exact Desktop build enrolls its own device token
  // and the owner binds the preserved machine UUID through the admin API.
  harvestInventory: [
    {
      machineId: "58201c28-5c87-44da-979e-d075c1025be3",
      userId: 2,
      username: "Dmitriy",
      role: "chatter",
      tokenId: 6,
      keyPrefix: "agency_hub_pending_device_OMbdOG4_Df",
      label: "MPB16m4-2.local",
      createdAt: "2026-07-15T10:24:11.315Z",
    },
  ],
} as const;

export type DesktopLifecycleV2InventoryItem = {
  readonly machineId: string;
  readonly userId: number;
  readonly username: string;
  readonly role: "chatter";
  readonly tokenId: number;
  readonly keyPrefix: string;
  readonly label: string;
  readonly createdAt: string;
};
type DesktopLifecycleV2EvidenceLiteral = typeof DESKTOP_LIFECYCLE_V2_EVIDENCE;
export type DesktopLifecycleV2Evidence = Omit<
  DesktopLifecycleV2EvidenceLiteral,
  "harvestInventory"
> & {
  readonly harvestInventory: readonly DesktopLifecycleV2InventoryItem[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Desktop lifecycle v2 evidence invalid: ${message}`);
  }
}

function assertIsoTimestamp(value: string, label: string) {
  assert(!Number.isNaN(Date.parse(value)), `${label} must be an ISO timestamp`);
  assert(new Date(value).toISOString() === value, `${label} must be canonical UTC ISO`);
}

export function validateDesktopLifecycleV2Evidence(
  evidence: DesktopLifecycleV2Evidence = DESKTOP_LIFECYCLE_V2_EVIDENCE,
) {
  assert(evidence.schemaVersion === 1, "unsupported schemaVersion");
  assert(evidence.capability === "desktop-lifecycle-v2", "wrong capability");

  for (const [clientName, client] of [
    ["extension", evidence.extension],
    ["desktop", evidence.desktop],
  ] as const) {
    assert(SHA_1_RE.test(client.source.commitSha), `${clientName} commit SHA`);
    assert(SHA_1_RE.test(client.source.treeSha), `${clientName} tree SHA`);
    assert(client.source.requiredBlobs.length > 0, `${clientName} proof blobs missing`);
    for (const blob of client.source.requiredBlobs) {
      assert(blob.path.length > 0 && SHA_1_RE.test(blob.sha), `${clientName} invalid proof blob`);
    }
  }

  assert(SHA_1_RE.test(evidence.extension.tag.objectSha), "extension tag object SHA");
  assert(SHA_256_RE.test(evidence.extension.feed.sha256), "extension XPI SHA-256");
  assert(evidence.extension.ci.runId > 0, "extension CI run missing");
  assert(evidence.desktop.ci.runId > 0, "desktop CI run missing");
  assert(evidence.desktop.candidate.runId > 0, "desktop candidate run missing");
  assert(/^sha256:[0-9a-f]{64}$/.test(evidence.desktop.candidate.artifact.digest), "desktop artifact digest");
  assertIsoTimestamp(evidence.desktop.candidate.artifact.expiresAt, "desktop artifact expiresAt");
  assert(evidence.desktop.candidate.artifact.files.length > 0, "desktop artifact files missing");
  for (const file of evidence.desktop.candidate.artifact.files) {
    assert(file.path.length > 0 && file.size > 0 && SHA_256_RE.test(file.sha256), "invalid desktop artifact file");
  }

  assert(evidence.preservationReceipts.extension.personaWritesObserved === 0, "extension persona writes observed");
  assert(evidence.preservationReceipts.extension.immutableSnapshotPresent, "extension immutable snapshot missing");
  assert(evidence.preservationReceipts.desktop.machineId === "58201c28-5c87-44da-979e-d075c1025be3", "desktop receipt machine mismatch");
  assertIsoTimestamp(evidence.preservationReceipts.extension.verifiedAt, "extension receipt verifiedAt");
  assertIsoTimestamp(evidence.preservationReceipts.desktop.verifiedAt, "desktop receipt verifiedAt");

  const machineIds = new Set<string>();
  const tokenIds = new Set<number>();
  assert(evidence.harvestInventory.length > 0, "harvest inventory is empty");
  for (const rawItem of evidence.harvestInventory) {
    const item = rawItem as DesktopLifecycleV2InventoryItem;
    assert(UUID_RE.test(item.machineId), "invalid inventory machine UUID");
    assert(item.machineId === evidence.preservationReceipts.desktop.machineId, "inventory machine lacks preservation receipt");
    assert(Number.isSafeInteger(item.userId) && item.userId > 0, "invalid inventory userId");
    assert(item.username.length > 0, "invalid inventory username");
    assert(item.role === "chatter", "inventory token must belong to a chatter");
    assert(Number.isSafeInteger(item.tokenId) && item.tokenId > 0, "invalid inventory tokenId");
    assert(item.keyPrefix.length >= 8, "invalid inventory keyPrefix");
    assert(item.label.length > 0, "invalid inventory label");
    assertIsoTimestamp(item.createdAt, "inventory createdAt");
    assert(!machineIds.has(item.machineId), "duplicate inventory machine UUID");
    assert(!tokenIds.has(item.tokenId), "duplicate inventory tokenId");
    machineIds.add(item.machineId);
    tokenIds.add(item.tokenId);
  }

  return evidence;
}

function canonicalTimestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

export async function verifyDesktopLifecycleV2Inventory(
  pool: Pick<Pool, "connect">,
  evidence: DesktopLifecycleV2Evidence = DESKTOP_LIFECYCLE_V2_EVIDENCE,
  now = new Date(),
) {
  validateDesktopLifecycleV2Evidence(evidence);
  const client = await pool.connect();
  try {
    await client.query("begin transaction read only");
    await client.query("set local statement_timeout = '5s'");
    await client.query("set local lock_timeout = '5s'");
    const verified = await verifyInventoryRows(client, evidence, now);
    await client.query("commit");
    return verified;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function verifyInventoryRows(
  client: Pick<PoolClient, "query">,
  evidence: DesktopLifecycleV2Evidence,
  now: Date,
) {
  const minimumExpiry = new Date(now.getTime() + evidence.inventorySafetyMarginSeconds * 1000);
  const verified: Array<{ machineId: string; tokenId: number; username: string }> = [];

  for (const rawItem of evidence.harvestInventory) {
    const item = rawItem as DesktopLifecycleV2InventoryItem;
    const result = await client.query<{
      token_id: string | number;
      user_id: string | number;
      username: string;
      role: string;
      disabled_at: Date | string | null;
      label: string;
      key_prefix: string;
      harvest_machine_id: string | null;
      created_at: Date | string;
      expires_at: Date | string;
      last_used_at: Date | string | null;
      revoked_at: Date | string | null;
    }>(`
      select
        dt.id as token_id,
        u.id as user_id,
        u.username,
        u.role,
        u.disabled_at,
        dt.label,
        dt.key_prefix,
        dt.harvest_machine_id,
        dt.created_at,
        dt.expires_at,
        dt.last_used_at,
        dt.revoked_at
      from device_tokens dt
      join users u on u.id = dt.user_id
      where dt.id = $1
    `, [item.tokenId]);

    assert(result.rowCount === 1 && result.rows.length === 1, `token ${item.tokenId} not found exactly once`);
    const row = result.rows[0]!;
    assert(Number(row.token_id) === item.tokenId, `token ${item.tokenId} identity mismatch`);
    assert(Number(row.user_id) === item.userId, `token ${item.tokenId} userId mismatch`);
    assert(row.username === item.username, `token ${item.tokenId} username mismatch`);
    assert(row.role === item.role, `token ${item.tokenId} role mismatch`);
    assert(row.disabled_at === null, `token ${item.tokenId} user is disabled`);
    assert(row.label === item.label, `token ${item.tokenId} label mismatch`);
    assert(row.key_prefix === item.keyPrefix, `token ${item.tokenId} keyPrefix mismatch`);
    assert(row.harvest_machine_id === item.machineId, `token ${item.tokenId} machine binding mismatch`);
    assert(canonicalTimestamp(row.created_at) === item.createdAt, `token ${item.tokenId} createdAt mismatch`);
    assert(row.revoked_at === null, `token ${item.tokenId} is revoked`);
    assert(row.last_used_at !== null, `token ${item.tokenId} has never authenticated`);
    assert(new Date(row.expires_at).getTime() > minimumExpiry.getTime(), `token ${item.tokenId} expires inside safety margin`);
    verified.push({ machineId: item.machineId, tokenId: item.tokenId, username: item.username });
  }

  return verified;
}
