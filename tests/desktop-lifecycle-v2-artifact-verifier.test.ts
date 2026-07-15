import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The executable ESM verifier intentionally has no TypeScript declaration file.
import { parseLifecycleEvidenceManifest, sha256Hex, verifyLifecycleEvidence, verifyPreservationReceiptFiles } from "../scripts/verify-desktop-lifecycle-v2-evidence.mjs";

const EXTENSION_COMMIT = "a".repeat(40);
const EXTENSION_TREE = "b".repeat(40);
const EXTENSION_BLOB = "c".repeat(40);
const TAG_OBJECT = "1".repeat(40);
const DESKTOP_COMMIT = "d".repeat(40);
const DESKTOP_TREE = "e".repeat(40);
const DESKTOP_BLOB = "f".repeat(40);
const XPI = Buffer.from("signed-xpi-fixture");
const INSTALLER = Buffer.from("installer");

function manifestFixture() {
  return {
    schemaVersion: 1,
    capability: "desktop-lifecycle-v2",
    extension: {
      repo: "goslingmanagment/chatgoose",
      version: "1.9.7",
      source: {
        commitSha: EXTENSION_COMMIT,
        treeSha: EXTENSION_TREE,
        requiredBlobs: [{ path: "src/index.ts", sha: EXTENSION_BLOB }],
      },
      tag: {
        name: "v1.9.7",
        objectSha: TAG_OBJECT,
        message: "Pinned release message\n",
      },
      ci: {
        runId: 101,
        workflowId: 201,
        attempt: 1,
        headBranch: "main",
        event: "push",
        requiredJobs: [{ name: "check", requiredSuccessfulSteps: ["Check"] }],
      },
      feed: {
        url: "https://ext.gosling-agency.ru/updates.json",
        artifactUrl: "https://ext.gosling-agency.ru/chatgoose-1.9.7.xpi",
        latestArtifactUrl: "https://ext.gosling-agency.ru/chatgoose-latest.xpi",
        sha256: sha256Hex(XPI),
      },
    },
    desktop: {
      repo: "goslingmanagment/chatgoose_desktop_2",
      version: "0.1.42",
      source: {
        commitSha: DESKTOP_COMMIT,
        treeSha: DESKTOP_TREE,
        requiredBlobs: [{ path: "src/main.ts", sha: DESKTOP_BLOB }],
      },
      ci: {
        runId: 102,
        workflowId: 202,
        attempt: 1,
        headBranch: "main",
        event: "push",
        requiredJobs: [{ name: "check", requiredSuccessfulSteps: ["Check"] }],
      },
      candidate: {
        runId: 103,
        workflowId: 203,
        attempt: 1,
        headBranch: "main",
        event: "workflow_dispatch",
        requiredJobs: [{
          name: "build",
          requiredSuccessfulSteps: ["Build installer"],
          requiredSkippedSteps: ["Publish"],
        }],
        artifact: {
          id: 301,
          name: "desktop-installer",
          digest: `sha256:${"9".repeat(64)}`,
          expiresAt: "2030-07-18T00:02:45.000Z",
          files: [{
            path: "ChatGoose-Setup-0.1.42.exe",
            size: INSTALLER.length,
            sha256: sha256Hex(INSTALLER),
          }],
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
        personaCharacters: 100,
        mappingCount: 2,
        aliasCount: 3,
        exportSha256: "2".repeat(64),
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
        exportSha256: "3".repeat(64),
        diagnosticsSha256: "4".repeat(64),
      },
    },
    inventorySafetyMarginSeconds: 86_400,
    harvestInventory: [{
      machineId: "58201c28-5c87-44da-979e-d075c1025be3",
      userId: 3,
      username: "Dmitriy",
      role: "chatter",
      tokenId: 5,
      keyPrefix: "device_abc123",
      label: "ChatGoose Desktop",
      createdAt: "2026-07-15T00:05:00.000Z",
    }],
  };
}

function completedRun(
  id: number,
  workflowId: number,
  headSha: string,
  event: string,
) {
  return {
    id,
    workflow_id: workflowId,
    run_attempt: 1,
    head_sha: headSha,
    head_branch: "main",
    event,
    status: "completed",
    conclusion: "success",
  };
}

function jobs(name: string, successful: string[], skipped: string[] = []) {
  const steps = [
    ...successful.map((stepName) => ({
      name: stepName,
      status: "completed",
      conclusion: "success",
    })),
    ...skipped.map((stepName) => ({
      name: stepName,
      status: "completed",
      conclusion: "skipped",
    })),
  ];
  return {
    total_count: 1,
    jobs: [{ name, status: "completed", conclusion: "success", steps }],
  };
}

function fixtureDependencies(manifest = manifestFixture()) {
  const responses: Record<string, unknown> = {
    [`repos/${manifest.extension.repo}/git/commits/${EXTENSION_COMMIT}`]: {
      sha: EXTENSION_COMMIT,
      tree: { sha: EXTENSION_TREE },
    },
    [`repos/${manifest.extension.repo}/git/trees/${EXTENSION_TREE}?recursive=1`]: {
      sha: EXTENSION_TREE,
      truncated: false,
      tree: [{ path: "src/index.ts", type: "blob", sha: EXTENSION_BLOB }],
    },
    [`repos/${manifest.extension.repo}/git/ref/tags/v1.9.7`]: {
      ref: "refs/tags/v1.9.7",
      object: { type: "tag", sha: TAG_OBJECT },
    },
    [`repos/${manifest.extension.repo}/git/tags/${TAG_OBJECT}`]: {
      sha: TAG_OBJECT,
      tag: "v1.9.7",
      object: { type: "commit", sha: EXTENSION_COMMIT },
      message: manifest.extension.tag.message,
    },
    [`repos/${manifest.extension.repo}/actions/runs/101`]: completedRun(
      101,
      201,
      EXTENSION_COMMIT,
      "push",
    ),
    [`repos/${manifest.extension.repo}/actions/runs/101/jobs?per_page=100`]: jobs("check", ["Check"]),
    [`repos/${manifest.desktop.repo}/git/commits/${DESKTOP_COMMIT}`]: {
      sha: DESKTOP_COMMIT,
      tree: { sha: DESKTOP_TREE },
    },
    [`repos/${manifest.desktop.repo}/git/trees/${DESKTOP_TREE}?recursive=1`]: {
      sha: DESKTOP_TREE,
      truncated: false,
      tree: [{ path: "src/main.ts", type: "blob", sha: DESKTOP_BLOB }],
    },
    [`repos/${manifest.desktop.repo}/actions/runs/102`]: completedRun(
      102,
      202,
      DESKTOP_COMMIT,
      "push",
    ),
    [`repos/${manifest.desktop.repo}/actions/runs/102/jobs?per_page=100`]: jobs("check", ["Check"]),
    [`repos/${manifest.desktop.repo}/actions/runs/103`]: completedRun(
      103,
      203,
      DESKTOP_COMMIT,
      "workflow_dispatch",
    ),
    [`repos/${manifest.desktop.repo}/actions/runs/103/jobs?per_page=100`]: jobs(
      "build",
      ["Build installer"],
      ["Publish"],
    ),
    [`repos/${manifest.desktop.repo}/actions/runs/103/artifacts?per_page=100`]: {
      total_count: 1,
      artifacts: [{
        id: 301,
        name: "desktop-installer",
        digest: manifest.desktop.candidate.artifact.digest,
        expires_at: "2030-07-18T00:02:45Z",
        expired: false,
      }],
    },
  };

  const ghJson = vi.fn(async (endpoint: string): Promise<unknown> => {
    if (!(endpoint in responses)) throw new Error(`unexpected endpoint ${endpoint}`);
    return responses[endpoint];
  });
  const fetchBytes = vi.fn(async (url: string): Promise<Buffer> => {
    if (url === manifest.extension.feed.url) {
      return Buffer.from(JSON.stringify({
        addons: {
          "chatgoose@gosling.agency": {
            updates: [{
              version: manifest.extension.version,
              update_link: manifest.extension.feed.artifactUrl,
              update_hash: `sha256:${manifest.extension.feed.sha256}`,
            }],
          },
        },
      }));
    }
    return XPI;
  });
  const downloadAndExtractArtifact = vi.fn(async (input: { tempDir: string }) => {
    const extractDir = path.join(input.tempDir, "extracted");
    await mkdir(extractDir);
    await writeFile(path.join(extractDir, "ChatGoose-Setup-0.1.42.exe"), INSTALLER);
    return {
      extractDir,
      archiveSha256: manifest.desktop.candidate.artifact.digest.slice("sha256:".length),
    };
  });

  return {
    responses,
    dependencies: {
      ghJson,
      fetchBytes,
      downloadAndExtractArtifact,
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    },
  };
}

describe("desktop lifecycle v2 external evidence verifier", () => {
  it("accepts only a complete, internally consistent offline fixture", async () => {
    const manifest = manifestFixture();
    const { dependencies } = fixtureDependencies(manifest);

    await expect(verifyLifecycleEvidence(manifest, dependencies)).resolves.toMatchObject({
      capability: "desktop-lifecycle-v2",
    });
  });

  it("rejects malformed preservation evidence before any external lookup", () => {
    const manifest = manifestFixture();
    manifest.preservationReceipts.extension.personaWritesObserved = 1;
    expect(() => parseLifecycleEvidenceManifest(manifest)).toThrow("must be zero");

    const wrongRole = manifestFixture();
    wrongRole.harvestInventory[0]!.role = "owner";
    expect(() => parseLifecycleEvidenceManifest(wrongRole)).toThrow("expected exactly chatter");
  });

  it("rejects evidence that redirects verification to attacker-controlled trust roots", () => {
    const wrongExtensionRepo = manifestFixture();
    wrongExtensionRepo.extension.repo = "attacker/extension";
    expect(() => parseLifecycleEvidenceManifest(wrongExtensionRepo))
      .toThrow("expected trusted repository goslingmanagment/chatgoose");

    const wrongDesktopRepo = manifestFixture();
    wrongDesktopRepo.desktop.repo = "attacker/desktop";
    expect(() => parseLifecycleEvidenceManifest(wrongDesktopRepo))
      .toThrow("expected trusted repository goslingmanagment/chatgoose_desktop_2");

    const wrongFeed = manifestFixture();
    wrongFeed.extension.feed.artifactUrl = "https://attacker.example/chatgoose-1.9.7.xpi";
    expect(() => parseLifecycleEvidenceManifest(wrongFeed))
      .toThrow("expected trusted origin https://ext.gosling-agency.ru");
  });

  it("recomputes and inspects the private preservation receipt files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "desktop-lifecycle-v2-receipts-"));
    try {
      const manifest = manifestFixture();
      const personalities = [{ id: "legacy", name: "Legacy", content: "x".repeat(100) }];
      const accountMappings = { accountA: "legacy", accountB: "legacy" };
      const accountAliases = { accountA: "a", accountB: "b", accountC: "c" };
      const extensionReceipt = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        origin: { client: "chatgoose-firefox-extension", extensionVersion: "1.9.7" },
        preservedSnapshotValid: true,
        preservedSnapshot: {
          origin: { storageSchemaVersion: 13 },
          raw: { personalities, accountMappings, accountAliases },
        },
        currentLegacyData: { personalities, accountMappings, accountAliases },
      }));
      const desktopReceipt = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        hubOrigin: "https://gosling-agency.ru",
        rows: { personalities: [{ id: "legacy" }], accountMappings: [{ accountId: "a" }, { accountId: "b" }] },
      }));
      const diagnosticsReceipt = Buffer.from(JSON.stringify({
        app: { version: "0.1.42" },
        db: { schemaVersion: 19 },
        harvest: { machineId: "58201c28-5c87-44da-979e-d075c1025be3" },
        errorCounts: {},
      }));
      manifest.preservationReceipts.extension.exportSha256 = sha256Hex(extensionReceipt);
      manifest.preservationReceipts.desktop.exportSha256 = sha256Hex(desktopReceipt);
      manifest.preservationReceipts.desktop.diagnosticsSha256 = sha256Hex(diagnosticsReceipt);
      const extensionPath = path.join(directory, "extension.json");
      const desktopPath = path.join(directory, "desktop.json");
      const diagnosticsPath = path.join(directory, "diagnostics.json");
      await writeFile(extensionPath, extensionReceipt);
      await writeFile(desktopPath, desktopReceipt);
      await writeFile(diagnosticsPath, diagnosticsReceipt);

      await expect(verifyPreservationReceiptFiles(manifest, {
        extensionPersonaExport: extensionPath,
        desktopPersonaExport: desktopPath,
        desktopDiagnostics: diagnosticsPath,
      })).resolves.toEqual({
        extensionPersonas: 1,
        desktopPersonas: 1,
        machineId: "58201c28-5c87-44da-979e-d075c1025be3",
      });

      await writeFile(extensionPath, Buffer.concat([extensionReceipt, Buffer.from("\n")]));
      await expect(verifyPreservationReceiptFiles(manifest, {
        extensionPersonaExport: extensionPath,
        desktopPersonaExport: desktopPath,
        desktopDiagnostics: diagnosticsPath,
      })).rejects.toThrow("preservationReceipts.extension.file.sha256");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an exact tag-message or required CI-step mismatch", async () => {
    const manifest = manifestFixture();
    const fixture = fixtureDependencies(manifest);
    fixture.responses[`repos/${manifest.extension.repo}/git/tags/${TAG_OBJECT}`] = {
      sha: TAG_OBJECT,
      tag: "v1.9.7",
      object: { type: "commit", sha: EXTENSION_COMMIT },
      message: "similar but not exact\n",
    };
    await expect(verifyLifecycleEvidence(manifest, fixture.dependencies))
      .rejects.toThrow("extension.tag.object.message");

    const stepFixture = fixtureDependencies(manifest);
    stepFixture.responses[`repos/${manifest.extension.repo}/actions/runs/101/jobs?per_page=100`] =
      jobs("check", ["Different step"]);
    await expect(verifyLifecycleEvidence(manifest, stepFixture.dependencies))
      .rejects.toThrow("expected one step, got 0");
  });

  it("rejects a feed artifact hash mismatch", async () => {
    const manifest = manifestFixture();
    manifest.extension.feed.sha256 = "8".repeat(64);
    const { dependencies } = fixtureDependencies(manifest);
    await expect(verifyLifecycleEvidence(manifest, dependencies))
      .rejects.toThrow("extension.feed.artifact.sha256");
  });

  it("normalizes GitHub timestamps but verifies the exact downloaded file bytes", async () => {
    const manifest = manifestFixture();
    manifest.desktop.candidate.artifact.files[0]!.sha256 = "7".repeat(64);
    const { dependencies } = fixtureDependencies(manifest);
    await expect(verifyLifecycleEvidence(manifest, dependencies))
      .rejects.toThrow("ChatGoose-Setup-0.1.42.exe.sha256");
  });

  it("rejects a downloaded archive whose bytes do not match the Actions digest", async () => {
    const manifest = manifestFixture();
    const { dependencies } = fixtureDependencies(manifest);
    const originalDownload = dependencies.downloadAndExtractArtifact;
    dependencies.downloadAndExtractArtifact = vi.fn(async (input) => ({
      ...await originalDownload(input),
      archiveSha256: "0".repeat(64),
    }));
    await expect(verifyLifecycleEvidence(manifest, dependencies))
      .rejects.toThrow("desktop.candidate.artifact.downloadedDigest");
  });
});
