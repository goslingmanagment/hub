#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_GITHUB_JSON_BYTES = 32 * 1024 * 1024;
const MAX_FEED_BYTES = 1024 * 1024;
const MAX_XPI_BYTES = 64 * 1024 * 1024;
const TRUSTED_EXTENSION_REPOSITORY = "goslingmanagment/chatgoose";
const TRUSTED_DESKTOP_REPOSITORY = "goslingmanagment/chatgoose_desktop_2";
const TRUSTED_EXTENSION_FEED_URL = "https://ext.gosling-agency.ru/updates.json";
const TRUSTED_EXTENSION_ARTIFACT_ORIGIN = "https://ext.gosling-agency.ru";
const TRUSTED_CORE_ORIGIN = "https://gosling-agency.ru";

export class LifecycleEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "LifecycleEvidenceError";
  }
}

function fail(location, message) {
  throw new LifecycleEvidenceError(`${location}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictRecord(value, location, keys) {
  if (!isRecord(value)) fail(location, "expected an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  const unknown = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unknown.length > 0) fail(location, `unknown keys: ${unknown.join(", ")}`);
  if (missing.length > 0) fail(location, `missing keys: ${missing.join(", ")}`);
  return value;
}

function stringValue(value, location, options = {}) {
  if (typeof value !== "string" || value.length === 0) {
    fail(location, "expected a non-empty string");
  }
  if (options.pattern && !options.pattern.test(value)) {
    fail(location, `invalid value ${JSON.stringify(value)}`);
  }
  return value;
}

function integerValue(value, location, options = {}) {
  if (!Number.isSafeInteger(value)) fail(location, "expected a safe integer");
  if (options.min !== undefined && value < options.min) {
    fail(location, `must be >= ${options.min}`);
  }
  return value;
}

function booleanValue(value, location) {
  if (typeof value !== "boolean") fail(location, "expected a boolean");
  return value;
}

function arrayValue(value, location, options = {}) {
  if (!Array.isArray(value)) fail(location, "expected an array");
  if (options.nonEmpty && value.length === 0) fail(location, "must not be empty");
  return value;
}

function isoTimestamp(value, location) {
  const timestamp = stringValue(value, location);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail(location, "expected a canonical ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function httpsUrl(value, location) {
  const raw = stringValue(value, location);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(location, "expected a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    fail(location, "expected an HTTPS URL without credentials or a fragment");
  }
  return raw;
}

function relativePath(value, location) {
  const raw = stringValue(value, location);
  if (
    raw.startsWith("/")
    || raw.includes("\\")
    || raw.includes("\0")
    || raw.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(location, "expected a normalized relative POSIX path");
  }
  return raw;
}

function uniqueBy(items, keyOf, location) {
  const seen = new Set();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) fail(location, `duplicate value ${JSON.stringify(key)}`);
    seen.add(key);
  }
}

function parseSource(value, location) {
  const source = strictRecord(value, location, ["commitSha", "treeSha", "requiredBlobs"]);
  const requiredBlobs = arrayValue(source.requiredBlobs, `${location}.requiredBlobs`, { nonEmpty: true })
    .map((blob, index) => {
      const blobLocation = `${location}.requiredBlobs[${index}]`;
      const record = strictRecord(blob, blobLocation, ["path", "sha"]);
      return {
        path: relativePath(record.path, `${blobLocation}.path`),
        sha: stringValue(record.sha, `${blobLocation}.sha`, { pattern: SHA1_RE }),
      };
    });
  uniqueBy(requiredBlobs, (blob) => blob.path, `${location}.requiredBlobs`);
  return {
    commitSha: stringValue(source.commitSha, `${location}.commitSha`, { pattern: SHA1_RE }),
    treeSha: stringValue(source.treeSha, `${location}.treeSha`, { pattern: SHA1_RE }),
    requiredBlobs,
  };
}

function parseRequiredJobs(value, location, allowSkippedSteps = false) {
  const jobs = arrayValue(value, location, { nonEmpty: true }).map((job, index) => {
    const jobLocation = `${location}[${index}]`;
    const record = strictRecord(job, jobLocation, [
      "name",
      "requiredSuccessfulSteps",
      ...(allowSkippedSteps ? ["requiredSkippedSteps"] : []),
    ]);
    const steps = arrayValue(record.requiredSuccessfulSteps, `${jobLocation}.requiredSuccessfulSteps`, {
      nonEmpty: true,
    }).map((step, stepIndex) => stringValue(
      step,
      `${jobLocation}.requiredSuccessfulSteps[${stepIndex}]`,
    ));
    uniqueBy(steps, (step) => step, `${jobLocation}.requiredSuccessfulSteps`);
    const skippedSteps = allowSkippedSteps
      ? arrayValue(record.requiredSkippedSteps, `${jobLocation}.requiredSkippedSteps`, {
        nonEmpty: true,
      }).map((step, stepIndex) => stringValue(
        step,
        `${jobLocation}.requiredSkippedSteps[${stepIndex}]`,
      ))
      : [];
    uniqueBy(skippedSteps, (step) => step, `${jobLocation}.requiredSkippedSteps`);
    return {
      name: stringValue(record.name, `${jobLocation}.name`),
      requiredSuccessfulSteps: steps,
      ...(allowSkippedSteps ? { requiredSkippedSteps: skippedSteps } : {}),
    };
  });
  uniqueBy(jobs, (job) => job.name, location);
  return jobs;
}

function parseRun(value, location, extraKeys = [], allowSkippedSteps = false) {
  const keys = [
    "runId",
    "workflowId",
    "attempt",
    "headBranch",
    "event",
    "requiredJobs",
    ...extraKeys,
  ];
  const run = strictRecord(value, location, keys);
  return {
    runId: integerValue(run.runId, `${location}.runId`, { min: 1 }),
    workflowId: integerValue(run.workflowId, `${location}.workflowId`, { min: 1 }),
    attempt: integerValue(run.attempt, `${location}.attempt`, { min: 1 }),
    headBranch: stringValue(run.headBranch, `${location}.headBranch`),
    event: stringValue(run.event, `${location}.event`),
    requiredJobs: parseRequiredJobs(
      run.requiredJobs,
      `${location}.requiredJobs`,
      allowSkippedSteps,
    ),
    ...Object.fromEntries(extraKeys.map((key) => [key, run[key]])),
  };
}

function parseTag(value, location) {
  const tag = strictRecord(value, location, ["name", "objectSha", "message"]);
  return {
    name: stringValue(tag.name, `${location}.name`, { pattern: /^v\d+\.\d+\.\d+$/ }),
    objectSha: stringValue(tag.objectSha, `${location}.objectSha`, { pattern: SHA1_RE }),
    message: stringValue(tag.message, `${location}.message`),
  };
}

function parseFeed(value, location) {
  const feed = strictRecord(value, location, [
    "url",
    "artifactUrl",
    "latestArtifactUrl",
    "sha256",
  ]);
  return {
    url: httpsUrl(feed.url, `${location}.url`),
    artifactUrl: httpsUrl(feed.artifactUrl, `${location}.artifactUrl`),
    latestArtifactUrl: httpsUrl(feed.latestArtifactUrl, `${location}.latestArtifactUrl`),
    sha256: stringValue(feed.sha256, `${location}.sha256`, { pattern: SHA256_RE }),
  };
}

function parseArtifact(value, location) {
  const artifact = strictRecord(value, location, ["id", "name", "digest", "expiresAt", "files"]);
  const files = arrayValue(artifact.files, `${location}.files`, { nonEmpty: true })
    .map((file, index) => {
      const fileLocation = `${location}.files[${index}]`;
      const record = strictRecord(file, fileLocation, ["path", "size", "sha256"]);
      return {
        path: relativePath(record.path, `${fileLocation}.path`),
        size: integerValue(record.size, `${fileLocation}.size`, { min: 0 }),
        sha256: stringValue(record.sha256, `${fileLocation}.sha256`, { pattern: SHA256_RE }),
      };
    });
  uniqueBy(files, (file) => file.path, `${location}.files`);
  const digest = stringValue(artifact.digest, `${location}.digest`, {
    pattern: /^sha256:[0-9a-f]{64}$/,
  });
  return {
    id: integerValue(artifact.id, `${location}.id`, { min: 1 }),
    name: stringValue(artifact.name, `${location}.name`),
    digest,
    expiresAt: isoTimestamp(artifact.expiresAt, `${location}.expiresAt`),
    files,
  };
}

function parseExtensionReceipt(value, location) {
  const receipt = strictRecord(value, location, [
    "verifiedAt",
    "clientVersion",
    "migration",
    "immutableSnapshotPresent",
    "personaCount",
    "personaCharacters",
    "mappingCount",
    "aliasCount",
    "exportSha256",
    "catalogGetsObserved",
    "personaWritesObserved",
  ]);
  const migration = strictRecord(receipt.migration, `${location}.migration`, [
    "fromSchemaVersion",
    "toSchemaVersion",
  ]);
  return {
    verifiedAt: isoTimestamp(receipt.verifiedAt, `${location}.verifiedAt`),
    clientVersion: stringValue(receipt.clientVersion, `${location}.clientVersion`, {
      pattern: VERSION_RE,
    }),
    migration: {
      fromSchemaVersion: integerValue(
        migration.fromSchemaVersion,
        `${location}.migration.fromSchemaVersion`,
        { min: 0 },
      ),
      toSchemaVersion: integerValue(
        migration.toSchemaVersion,
        `${location}.migration.toSchemaVersion`,
        { min: 1 },
      ),
    },
    immutableSnapshotPresent: booleanValue(
      receipt.immutableSnapshotPresent,
      `${location}.immutableSnapshotPresent`,
    ),
    personaCount: integerValue(receipt.personaCount, `${location}.personaCount`, { min: 0 }),
    personaCharacters: integerValue(
      receipt.personaCharacters,
      `${location}.personaCharacters`,
      { min: 0 },
    ),
    mappingCount: integerValue(receipt.mappingCount, `${location}.mappingCount`, { min: 0 }),
    aliasCount: integerValue(receipt.aliasCount, `${location}.aliasCount`, { min: 0 }),
    exportSha256: stringValue(receipt.exportSha256, `${location}.exportSha256`, {
      pattern: SHA256_RE,
    }),
    catalogGetsObserved: integerValue(
      receipt.catalogGetsObserved,
      `${location}.catalogGetsObserved`,
      { min: 1 },
    ),
    personaWritesObserved: integerValue(
      receipt.personaWritesObserved,
      `${location}.personaWritesObserved`,
      { min: 0 },
    ),
  };
}

function parseDesktopReceipt(value, location) {
  const receipt = strictRecord(value, location, [
    "verifiedAt",
    "candidateVersion",
    "migration",
    "machineId",
    "personaCount",
    "mappingCount",
    "exportSha256",
    "diagnosticsSha256",
  ]);
  const migration = strictRecord(receipt.migration, `${location}.migration`, [
    "fromSchemaVersion",
    "toSchemaVersion",
  ]);
  return {
    verifiedAt: isoTimestamp(receipt.verifiedAt, `${location}.verifiedAt`),
    candidateVersion: stringValue(receipt.candidateVersion, `${location}.candidateVersion`, {
      pattern: VERSION_RE,
    }),
    migration: {
      fromSchemaVersion: integerValue(
        migration.fromSchemaVersion,
        `${location}.migration.fromSchemaVersion`,
        { min: 0 },
      ),
      toSchemaVersion: integerValue(
        migration.toSchemaVersion,
        `${location}.migration.toSchemaVersion`,
        { min: 1 },
      ),
    },
    machineId: stringValue(receipt.machineId, `${location}.machineId`, { pattern: UUID_RE }),
    personaCount: integerValue(receipt.personaCount, `${location}.personaCount`, { min: 0 }),
    mappingCount: integerValue(receipt.mappingCount, `${location}.mappingCount`, { min: 0 }),
    exportSha256: stringValue(receipt.exportSha256, `${location}.exportSha256`, {
      pattern: SHA256_RE,
    }),
    diagnosticsSha256: stringValue(
      receipt.diagnosticsSha256,
      `${location}.diagnosticsSha256`,
      { pattern: SHA256_RE },
    ),
  };
}

function parseInventory(value, location) {
  const machines = arrayValue(value, location, { nonEmpty: true }).map((machine, index) => {
    const machineLocation = `${location}[${index}]`;
    const record = strictRecord(machine, machineLocation, [
      "machineId",
      "userId",
      "username",
      "role",
      "tokenId",
      "keyPrefix",
      "label",
      "createdAt",
    ]);
    const role = stringValue(record.role, `${machineLocation}.role`);
    if (role !== "chatter") fail(`${machineLocation}.role`, "expected exactly chatter");
    return {
      machineId: stringValue(record.machineId, `${machineLocation}.machineId`, { pattern: UUID_RE }),
      userId: integerValue(record.userId, `${machineLocation}.userId`, { min: 1 }),
      username: stringValue(record.username, `${machineLocation}.username`),
      role,
      tokenId: integerValue(record.tokenId, `${machineLocation}.tokenId`, { min: 1 }),
      keyPrefix: stringValue(record.keyPrefix, `${machineLocation}.keyPrefix`),
      label: stringValue(record.label, `${machineLocation}.label`),
      createdAt: isoTimestamp(record.createdAt, `${machineLocation}.createdAt`),
    };
  });
  uniqueBy(machines, (machine) => machine.machineId, location);
  uniqueBy(machines, (machine) => machine.tokenId, location);
  uniqueBy(machines, (machine) => machine.keyPrefix, location);
  return machines;
}

/** Parse and strictly validate the code-reviewed, candidate-compiled evidence manifest. */
export function parseLifecycleEvidenceManifest(value) {
  const root = strictRecord(value, "manifest", [
    "schemaVersion",
    "capability",
    "extension",
    "desktop",
    "preservationReceipts",
    "inventorySafetyMarginSeconds",
    "harvestInventory",
  ]);
  if (root.schemaVersion !== 1) fail("manifest.schemaVersion", "expected exactly 1");
  if (root.capability !== "desktop-lifecycle-v2") {
    fail("manifest.capability", "expected desktop-lifecycle-v2");
  }

  const extensionRecord = strictRecord(root.extension, "manifest.extension", [
    "repo",
    "version",
    "source",
    "tag",
    "ci",
    "feed",
  ]);
  const extension = {
    repo: stringValue(extensionRecord.repo, "manifest.extension.repo", { pattern: REPOSITORY_RE }),
    version: stringValue(extensionRecord.version, "manifest.extension.version", {
      pattern: VERSION_RE,
    }),
    source: parseSource(extensionRecord.source, "manifest.extension.source"),
    tag: parseTag(extensionRecord.tag, "manifest.extension.tag"),
    ci: parseRun(extensionRecord.ci, "manifest.extension.ci"),
    feed: parseFeed(extensionRecord.feed, "manifest.extension.feed"),
  };
  if (extension.repo !== TRUSTED_EXTENSION_REPOSITORY) {
    fail("manifest.extension.repo", `expected trusted repository ${TRUSTED_EXTENSION_REPOSITORY}`);
  }
  if (extension.feed.url !== TRUSTED_EXTENSION_FEED_URL) {
    fail("manifest.extension.feed.url", `expected trusted feed ${TRUSTED_EXTENSION_FEED_URL}`);
  }
  for (const [name, url] of [
    ["artifactUrl", extension.feed.artifactUrl],
    ["latestArtifactUrl", extension.feed.latestArtifactUrl],
  ]) {
    if (new URL(url).origin !== TRUSTED_EXTENSION_ARTIFACT_ORIGIN) {
      fail(
        `manifest.extension.feed.${name}`,
        `expected trusted origin ${TRUSTED_EXTENSION_ARTIFACT_ORIGIN}`,
      );
    }
  }

  const desktopRecord = strictRecord(root.desktop, "manifest.desktop", [
    "repo",
    "version",
    "source",
    "ci",
    "candidate",
  ]);
  const rawCandidate = parseRun(
    desktopRecord.candidate,
    "manifest.desktop.candidate",
    ["artifact"],
    true,
  );
  const desktop = {
    repo: stringValue(desktopRecord.repo, "manifest.desktop.repo", { pattern: REPOSITORY_RE }),
    version: stringValue(desktopRecord.version, "manifest.desktop.version", {
      pattern: VERSION_RE,
    }),
    source: parseSource(desktopRecord.source, "manifest.desktop.source"),
    ci: parseRun(desktopRecord.ci, "manifest.desktop.ci"),
    candidate: {
      ...rawCandidate,
      artifact: parseArtifact(rawCandidate.artifact, "manifest.desktop.candidate.artifact"),
    },
  };
  if (desktop.repo !== TRUSTED_DESKTOP_REPOSITORY) {
    fail("manifest.desktop.repo", `expected trusted repository ${TRUSTED_DESKTOP_REPOSITORY}`);
  }

  const receiptsRecord = strictRecord(root.preservationReceipts, "manifest.preservationReceipts", [
    "extension",
    "desktop",
  ]);
  const preservationReceipts = {
    extension: parseExtensionReceipt(
      receiptsRecord.extension,
      "manifest.preservationReceipts.extension",
    ),
    desktop: parseDesktopReceipt(receiptsRecord.desktop, "manifest.preservationReceipts.desktop"),
  };
  const inventorySafetyMarginSeconds = integerValue(
    root.inventorySafetyMarginSeconds,
    "manifest.inventorySafetyMarginSeconds",
    { min: 3600 },
  );
  const harvestInventory = parseInventory(root.harvestInventory, "manifest.harvestInventory");

  if (extension.tag.name !== `v${extension.version}`) {
    fail("manifest.extension.tag.name", "must match the Extension version");
  }
  if (preservationReceipts.extension.clientVersion !== extension.version) {
    fail("manifest.preservationReceipts.extension.clientVersion", "must match extension.version");
  }
  if (preservationReceipts.desktop.candidateVersion !== desktop.version) {
    fail("manifest.preservationReceipts.desktop.candidateVersion", "must match desktop.version");
  }
  if (!preservationReceipts.extension.immutableSnapshotPresent) {
    fail("manifest.preservationReceipts.extension.immutableSnapshotPresent", "must be true");
  }
  if (preservationReceipts.extension.personaWritesObserved !== 0) {
    fail("manifest.preservationReceipts.extension.personaWritesObserved", "must be zero");
  }
  if (
    preservationReceipts.extension.migration.toSchemaVersion
    <= preservationReceipts.extension.migration.fromSchemaVersion
  ) {
    fail("manifest.preservationReceipts.extension.migration", "must move forward");
  }
  if (
    preservationReceipts.desktop.migration.toSchemaVersion
    <= preservationReceipts.desktop.migration.fromSchemaVersion
  ) {
    fail("manifest.preservationReceipts.desktop.migration", "must move forward");
  }
  if (!harvestInventory.some(
    (machine) => machine.machineId === preservationReceipts.desktop.machineId,
  )) {
    fail(
      "manifest.preservationReceipts.desktop.machineId",
      "must appear in harvestInventory",
    );
  }

  return {
    schemaVersion: 1,
    capability: "desktop-lifecycle-v2",
    extension,
    desktop,
    preservationReceipts,
    inventorySafetyMarginSeconds,
    harvestInventory,
  };
}

export async function readLifecycleEvidenceManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new LifecycleEvidenceError(
      `Unable to read evidence manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseLifecycleEvidenceManifest(parsed);
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readReceipt(pathname, expectedSha256, location) {
  let bytes;
  try {
    bytes = await readFile(pathname);
  } catch (error) {
    throw new LifecycleEvidenceError(
      `${location}: unable to read ${pathname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  expectEqual(sha256Hex(bytes), expectedSha256, `${location}.sha256`);
  return parseJsonBytes(bytes, location);
}

function receiptRecord(value, location) {
  if (!isRecord(value)) fail(location, "expected an object");
  return value;
}

function collectionCount(value, location) {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  fail(location, "expected an array or object collection");
}

function personaCharacterCount(value, location) {
  const personas = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : fail(location, "expected an array or object collection");
  return personas.reduce((total, persona, index) => {
    const record = receiptRecord(persona, `${location}[${index}]`);
    const content = stringValue(record.content, `${location}[${index}].content`);
    return total + content.length;
  }, 0);
}

/** Recompute and inspect the private, operator-held preservation receipts.
 * Their contents never enter the image or repository; only the reviewed hashes
 * live in the manifest. */
export async function verifyPreservationReceiptFiles(manifest, receiptPaths) {
  const parsed = parseLifecycleEvidenceManifest(manifest);
  const paths = strictRecord(receiptPaths, "receiptPaths", [
    "extensionPersonaExport",
    "desktopPersonaExport",
    "desktopDiagnostics",
  ]);
  const extensionExport = receiptRecord(await readReceipt(
    stringValue(paths.extensionPersonaExport, "receiptPaths.extensionPersonaExport"),
    parsed.preservationReceipts.extension.exportSha256,
    "preservationReceipts.extension.file",
  ), "preservationReceipts.extension.file");
  const extensionOrigin = receiptRecord(
    extensionExport.origin,
    "preservationReceipts.extension.file.origin",
  );
  const preservedSnapshot = receiptRecord(
    extensionExport.preservedSnapshot,
    "preservationReceipts.extension.file.preservedSnapshot",
  );
  const snapshotOrigin = receiptRecord(
    preservedSnapshot.origin,
    "preservationReceipts.extension.file.preservedSnapshot.origin",
  );
  const preservedRaw = receiptRecord(
    preservedSnapshot.raw,
    "preservationReceipts.extension.file.preservedSnapshot.raw",
  );
  const currentLegacyData = receiptRecord(
    extensionExport.currentLegacyData,
    "preservationReceipts.extension.file.currentLegacyData",
  );
  expectEqual(extensionExport.schemaVersion, 1, "preservationReceipts.extension.file.schemaVersion");
  expectEqual(extensionOrigin.client, "chatgoose-firefox-extension", "preservationReceipts.extension.file.origin.client");
  expectEqual(
    extensionOrigin.extensionVersion,
    parsed.preservationReceipts.extension.clientVersion,
    "preservationReceipts.extension.file.origin.extensionVersion",
  );
  expectEqual(extensionExport.preservedSnapshotValid, true, "preservationReceipts.extension.file.preservedSnapshotValid");
  expectEqual(
    snapshotOrigin.storageSchemaVersion,
    parsed.preservationReceipts.extension.migration.fromSchemaVersion,
    "preservationReceipts.extension.file.preservedSnapshot.origin.storageSchemaVersion",
  );
  expectEqual(
    collectionCount(preservedRaw.personalities, "preservationReceipts.extension.file.preservedSnapshot.raw.personalities"),
    parsed.preservationReceipts.extension.personaCount,
    "preservationReceipts.extension.file.preservedSnapshot.personaCount",
  );
  expectEqual(
    personaCharacterCount(preservedRaw.personalities, "preservationReceipts.extension.file.preservedSnapshot.raw.personalities"),
    parsed.preservationReceipts.extension.personaCharacters,
    "preservationReceipts.extension.file.preservedSnapshot.personaCharacters",
  );
  expectEqual(
    collectionCount(preservedRaw.accountMappings, "preservationReceipts.extension.file.preservedSnapshot.raw.accountMappings"),
    parsed.preservationReceipts.extension.mappingCount,
    "preservationReceipts.extension.file.preservedSnapshot.mappingCount",
  );
  expectEqual(
    collectionCount(preservedRaw.accountAliases, "preservationReceipts.extension.file.preservedSnapshot.raw.accountAliases"),
    parsed.preservationReceipts.extension.aliasCount,
    "preservationReceipts.extension.file.preservedSnapshot.aliasCount",
  );
  for (const key of ["personalities", "accountMappings", "accountAliases"]) {
    if (!isDeepStrictEqual(currentLegacyData[key], preservedRaw[key])) {
      fail(
        `preservationReceipts.extension.file.currentLegacyData.${key}`,
        "does not exactly match the immutable preserved snapshot",
      );
    }
  }

  const desktopExport = receiptRecord(await readReceipt(
    stringValue(paths.desktopPersonaExport, "receiptPaths.desktopPersonaExport"),
    parsed.preservationReceipts.desktop.exportSha256,
    "preservationReceipts.desktop.personaFile",
  ), "preservationReceipts.desktop.personaFile");
  const desktopRows = receiptRecord(
    desktopExport.rows,
    "preservationReceipts.desktop.personaFile.rows",
  );
  expectEqual(desktopExport.schemaVersion, 1, "preservationReceipts.desktop.personaFile.schemaVersion");
  expectEqual(desktopExport.hubOrigin, TRUSTED_CORE_ORIGIN, "preservationReceipts.desktop.personaFile.hubOrigin");
  expectEqual(
    collectionCount(desktopRows.personalities, "preservationReceipts.desktop.personaFile.rows.personalities"),
    parsed.preservationReceipts.desktop.personaCount,
    "preservationReceipts.desktop.personaFile.personaCount",
  );
  expectEqual(
    collectionCount(desktopRows.accountMappings, "preservationReceipts.desktop.personaFile.rows.accountMappings"),
    parsed.preservationReceipts.desktop.mappingCount,
    "preservationReceipts.desktop.personaFile.mappingCount",
  );

  const diagnostics = receiptRecord(await readReceipt(
    stringValue(paths.desktopDiagnostics, "receiptPaths.desktopDiagnostics"),
    parsed.preservationReceipts.desktop.diagnosticsSha256,
    "preservationReceipts.desktop.diagnosticsFile",
  ), "preservationReceipts.desktop.diagnosticsFile");
  const diagnosticsApp = receiptRecord(
    diagnostics.app,
    "preservationReceipts.desktop.diagnosticsFile.app",
  );
  const diagnosticsDb = receiptRecord(
    diagnostics.db,
    "preservationReceipts.desktop.diagnosticsFile.db",
  );
  const diagnosticsHarvest = receiptRecord(
    diagnostics.harvest,
    "preservationReceipts.desktop.diagnosticsFile.harvest",
  );
  const errorCounts = receiptRecord(
    diagnostics.errorCounts,
    "preservationReceipts.desktop.diagnosticsFile.errorCounts",
  );
  expectEqual(
    diagnosticsApp.version,
    parsed.preservationReceipts.desktop.candidateVersion,
    "preservationReceipts.desktop.diagnosticsFile.app.version",
  );
  expectEqual(
    diagnosticsDb.schemaVersion,
    parsed.preservationReceipts.desktop.migration.toSchemaVersion,
    "preservationReceipts.desktop.diagnosticsFile.db.schemaVersion",
  );
  expectEqual(
    diagnosticsHarvest.machineId,
    parsed.preservationReceipts.desktop.machineId,
    "preservationReceipts.desktop.diagnosticsFile.harvest.machineId",
  );
  expectEqual(
    Object.keys(errorCounts).length,
    0,
    "preservationReceipts.desktop.diagnosticsFile.errorCounts",
  );

  return {
    extensionPersonas: parsed.preservationReceipts.extension.personaCount,
    desktopPersonas: parsed.preservationReceipts.desktop.personaCount,
    machineId: parsed.preservationReceipts.desktop.machineId,
  };
}

async function defaultGhJson(endpoint) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("gh", ["api", "--hostname", "github.com", endpoint], {
      encoding: "utf8",
      maxBuffer: MAX_GITHUB_JSON_BYTES,
    }));
  } catch (error) {
    throw new LifecycleEvidenceError(
      `Authenticated GitHub API request failed for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new LifecycleEvidenceError(`GitHub API returned invalid JSON for ${endpoint}`);
  }
}

async function responseBytes(response, url, maxBytes) {
  if (!response.ok) {
    throw new LifecycleEvidenceError(`HTTP ${response.status} while reading ${url}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new LifecycleEvidenceError(`${url} exceeds the ${maxBytes}-byte safety limit`);
  }
  if (!response.body) throw new LifecycleEvidenceError(`${url} returned no response body`);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw new LifecycleEvidenceError(`${url} exceeds the ${maxBytes}-byte safety limit`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function defaultFetchBytes(url, maxBytes) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: globalThis.AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new LifecycleEvidenceError(
      `Unable to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return responseBytes(response, url, maxBytes);
}

async function spawnToFile(command, args, outputPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output = createWriteStream(outputPath, { flags: "wx" });
    const stderr = [];
    let stderrBytes = 0;
    let childClosed = false;
    let outputFinished = false;
    let exitCode = null;
    let exitSignal = null;
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finishWhenReady = () => {
      if (settled || !childClosed || !outputFinished) return;
      settled = true;
      if (exitCode === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new LifecycleEvidenceError(
        `${command} exited with ${exitCode ?? `signal ${exitSignal ?? "unknown"}`}${detail ? `: ${detail}` : ""}`,
      ));
    };

    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 64 * 1024) return;
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.length;
      stderr.push(bytes);
    });
    child.on("error", rejectOnce);
    output.on("error", rejectOnce);
    output.on("finish", () => {
      outputFinished = true;
      finishWhenReady();
    });
    child.stdout.pipe(output);
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      childClosed = true;
      finishWhenReady();
    });
  });
}

function validateArchiveEntry(entry) {
  if (
    !entry
    || entry.endsWith("/")
    || entry.startsWith("/")
    || entry.includes("\\")
    || entry.includes("\0")
    || entry.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new LifecycleEvidenceError(`Unsafe or non-file ZIP entry ${JSON.stringify(entry)}`);
  }
  return entry;
}

async function defaultDownloadAndExtractArtifact(input) {
  const archivePath = path.join(input.tempDir, "artifact.zip");
  const extractDir = path.join(input.tempDir, "extracted");
  await spawnToFile(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      `repos/${input.repo}/actions/artifacts/${input.artifactId}/zip`,
    ],
    archivePath,
  );
  const archiveBytes = await readFile(archivePath);
  const archiveSha256 = sha256Hex(archiveBytes);

  let stdout;
  try {
    ({ stdout } = await execFileAsync("unzip", ["-Z1", archivePath], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    throw new LifecycleEvidenceError(
      `Unable to inspect downloaded artifact ZIP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = stdout.split(/\r?\n/).filter(Boolean).map(validateArchiveEntry).sort();
  const expected = [...input.expectedPaths].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new LifecycleEvidenceError(
      `Artifact ZIP file list mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(entries)}`,
    );
  }

  await mkdir(extractDir, { recursive: false });
  try {
    await execFileAsync("unzip", ["-qq", archivePath, "-d", extractDir], {
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new LifecycleEvidenceError(
      `Unable to extract downloaded artifact ZIP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { archiveSha256, extractDir };
}

export function createDefaultEvidenceDependencies(artifactParentDirectory) {
  return {
    ghJson: defaultGhJson,
    fetchBytes: defaultFetchBytes,
    downloadAndExtractArtifact: defaultDownloadAndExtractArtifact,
    now: () => new Date(),
    artifactParentDirectory,
  };
}

function expectEqual(actual, expected, location) {
  if (actual !== expected) {
    fail(location, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function verifySource(repo, source, deps, location) {
  const commit = await deps.ghJson(`repos/${repo}/git/commits/${source.commitSha}`);
  expectEqual(commit?.sha, source.commitSha, `${location}.commit.sha`);
  expectEqual(commit?.tree?.sha, source.treeSha, `${location}.commit.tree.sha`);

  const tree = await deps.ghJson(`repos/${repo}/git/trees/${source.treeSha}?recursive=1`);
  expectEqual(tree?.sha, source.treeSha, `${location}.tree.sha`);
  if (tree?.truncated !== false) fail(`${location}.tree.truncated`, "must be exactly false");
  const entries = arrayValue(tree?.tree, `${location}.tree.entries`);
  for (const required of source.requiredBlobs) {
    const matches = entries.filter((entry) => entry?.path === required.path);
    if (matches.length !== 1) {
      fail(`${location}.requiredBlobs.${required.path}`, `expected one tree entry, got ${matches.length}`);
    }
    expectEqual(matches[0]?.type, "blob", `${location}.requiredBlobs.${required.path}.type`);
    expectEqual(matches[0]?.sha, required.sha, `${location}.requiredBlobs.${required.path}.sha`);
  }
}

async function verifyRun(repo, sourceCommit, run, deps, location) {
  const result = await deps.ghJson(`repos/${repo}/actions/runs/${run.runId}`);
  expectEqual(result?.id, run.runId, `${location}.id`);
  expectEqual(result?.workflow_id, run.workflowId, `${location}.workflow_id`);
  expectEqual(result?.run_attempt, run.attempt, `${location}.run_attempt`);
  expectEqual(result?.head_sha, sourceCommit, `${location}.head_sha`);
  expectEqual(result?.head_branch, run.headBranch, `${location}.head_branch`);
  expectEqual(result?.event, run.event, `${location}.event`);
  expectEqual(result?.status, "completed", `${location}.status`);
  expectEqual(result?.conclusion, "success", `${location}.conclusion`);

  const jobsResponse = await deps.ghJson(`repos/${repo}/actions/runs/${run.runId}/jobs?per_page=100`);
  const jobs = arrayValue(jobsResponse?.jobs, `${location}.jobs`);
  expectEqual(jobsResponse?.total_count, jobs.length, `${location}.jobs.total_count`);
  if (jobs.length > 100) fail(`${location}.jobs`, "more than 100 jobs requires explicit pagination support");
  for (const requiredJob of run.requiredJobs) {
    const matches = jobs.filter((job) => job?.name === requiredJob.name);
    if (matches.length !== 1) {
      fail(`${location}.jobs.${requiredJob.name}`, `expected one job, got ${matches.length}`);
    }
    const job = matches[0];
    expectEqual(job?.status, "completed", `${location}.jobs.${requiredJob.name}.status`);
    expectEqual(job?.conclusion, "success", `${location}.jobs.${requiredJob.name}.conclusion`);
    const steps = arrayValue(job?.steps, `${location}.jobs.${requiredJob.name}.steps`);
    for (const requiredStep of requiredJob.requiredSuccessfulSteps) {
      const stepMatches = steps.filter((step) => step?.name === requiredStep);
      if (stepMatches.length !== 1) {
        fail(
          `${location}.jobs.${requiredJob.name}.steps.${requiredStep}`,
          `expected one step, got ${stepMatches.length}`,
        );
      }
      expectEqual(
        stepMatches[0]?.status,
        "completed",
        `${location}.jobs.${requiredJob.name}.steps.${requiredStep}.status`,
      );
      expectEqual(
        stepMatches[0]?.conclusion,
        "success",
        `${location}.jobs.${requiredJob.name}.steps.${requiredStep}.conclusion`,
      );
    }
    for (const requiredStep of requiredJob.requiredSkippedSteps ?? []) {
      const stepMatches = steps.filter((step) => step?.name === requiredStep);
      if (stepMatches.length !== 1) {
        fail(
          `${location}.jobs.${requiredJob.name}.steps.${requiredStep}`,
          `expected one step, got ${stepMatches.length}`,
        );
      }
      expectEqual(
        stepMatches[0]?.status,
        "completed",
        `${location}.jobs.${requiredJob.name}.steps.${requiredStep}.status`,
      );
      expectEqual(
        stepMatches[0]?.conclusion,
        "skipped",
        `${location}.jobs.${requiredJob.name}.steps.${requiredStep}.conclusion`,
      );
    }
  }
}

function parseJsonBytes(bytes, location) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(location, "response is not valid JSON");
  }
}

export async function verifyExtensionEvidence(extension, dependencies) {
  const deps = dependencies ?? createDefaultEvidenceDependencies();
  await verifySource(extension.repo, extension.source, deps, "extension.source");

  const tagName = encodeURIComponent(extension.tag.name);
  const ref = await deps.ghJson(`repos/${extension.repo}/git/ref/tags/${tagName}`);
  expectEqual(ref?.ref, `refs/tags/${extension.tag.name}`, "extension.tag.ref");
  expectEqual(ref?.object?.type, "tag", "extension.tag.ref.object.type");
  expectEqual(ref?.object?.sha, extension.tag.objectSha, "extension.tag.ref.object.sha");

  const tag = await deps.ghJson(`repos/${extension.repo}/git/tags/${extension.tag.objectSha}`);
  expectEqual(tag?.sha, extension.tag.objectSha, "extension.tag.object.sha");
  expectEqual(tag?.tag, extension.tag.name, "extension.tag.object.tag");
  expectEqual(tag?.object?.type, "commit", "extension.tag.object.target.type");
  expectEqual(tag?.object?.sha, extension.source.commitSha, "extension.tag.object.target.sha");
  expectEqual(tag?.message, extension.tag.message, "extension.tag.object.message");

  await verifyRun(extension.repo, extension.source.commitSha, extension.ci, deps, "extension.ci");

  const feedBytes = await deps.fetchBytes(extension.feed.url, MAX_FEED_BYTES);
  const feed = parseJsonBytes(feedBytes, "extension.feed");
  const updates = feed?.addons?.["chatgoose@gosling.agency"]?.updates;
  if (!Array.isArray(updates) || updates.length !== 1) {
    fail("extension.feed.updates", "expected exactly one ChatGoose update entry");
  }
  const update = updates[0];
  expectEqual(update?.version, extension.version, "extension.feed.version");
  expectEqual(update?.update_link, extension.feed.artifactUrl, "extension.feed.update_link");
  expectEqual(update?.update_hash, `sha256:${extension.feed.sha256}`, "extension.feed.update_hash");

  const [versioned, latest] = await Promise.all([
    deps.fetchBytes(extension.feed.artifactUrl, MAX_XPI_BYTES),
    deps.fetchBytes(extension.feed.latestArtifactUrl, MAX_XPI_BYTES),
  ]);
  expectEqual(sha256Hex(versioned), extension.feed.sha256, "extension.feed.artifact.sha256");
  expectEqual(sha256Hex(latest), extension.feed.sha256, "extension.feed.latestArtifact.sha256");
}

async function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const names = await readdir(directory);
  const files = [];
  for (const name of names.sort()) {
    const nextRelative = relative ? `${relative}/${name}` : name;
    const stats = await lstat(path.join(root, nextRelative));
    if (stats.isSymbolicLink()) fail("desktop.candidate.artifact", `symlink is forbidden: ${nextRelative}`);
    if (stats.isDirectory()) {
      files.push(...await listFiles(root, nextRelative));
    } else if (stats.isFile()) {
      files.push(nextRelative);
    } else {
      fail("desktop.candidate.artifact", `non-regular file is forbidden: ${nextRelative}`);
    }
  }
  return files;
}

export async function verifyArtifactDirectory(extractDir, expectedFiles) {
  const actualPaths = (await listFiles(extractDir)).sort();
  const expectedPaths = expectedFiles.map((file) => file.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail(
      "desktop.candidate.artifact.files",
      `expected ${JSON.stringify(expectedPaths)}, got ${JSON.stringify(actualPaths)}`,
    );
  }
  for (const expected of expectedFiles) {
    const filePath = path.join(extractDir, expected.path);
    const stats = await lstat(filePath);
    expectEqual(stats.size, expected.size, `desktop.candidate.artifact.files.${expected.path}.size`);
    const bytes = await readFile(filePath);
    expectEqual(
      sha256Hex(bytes),
      expected.sha256,
      `desktop.candidate.artifact.files.${expected.path}.sha256`,
    );
  }
}

export async function verifyDesktopEvidence(desktop, dependencies) {
  const deps = dependencies ?? createDefaultEvidenceDependencies();
  await verifySource(desktop.repo, desktop.source, deps, "desktop.source");
  await verifyRun(desktop.repo, desktop.source.commitSha, desktop.ci, deps, "desktop.ci");
  await verifyRun(
    desktop.repo,
    desktop.source.commitSha,
    desktop.candidate,
    deps,
    "desktop.candidate",
  );

  const artifactsResponse = await deps.ghJson(
    `repos/${desktop.repo}/actions/runs/${desktop.candidate.runId}/artifacts?per_page=100`,
  );
  const artifacts = arrayValue(artifactsResponse?.artifacts, "desktop.candidate.artifacts");
  expectEqual(artifactsResponse?.total_count, artifacts.length, "desktop.candidate.artifacts.total_count");
  if (artifacts.length !== 1) {
    fail("desktop.candidate.artifacts", `expected exactly one artifact, got ${artifacts.length}`);
  }
  const artifact = artifacts[0];
  const expected = desktop.candidate.artifact;
  expectEqual(artifact?.id, expected.id, "desktop.candidate.artifact.id");
  expectEqual(artifact?.name, expected.name, "desktop.candidate.artifact.name");
  expectEqual(artifact?.digest, expected.digest, "desktop.candidate.artifact.digest");
  const apiExpiresAtDate = new Date(artifact?.expires_at);
  if (Number.isNaN(apiExpiresAtDate.getTime())) {
    fail("desktop.candidate.artifact.expires_at", "GitHub returned an invalid timestamp");
  }
  const apiExpiresAt = apiExpiresAtDate.toISOString();
  expectEqual(apiExpiresAt, expected.expiresAt, "desktop.candidate.artifact.expires_at");
  expectEqual(artifact?.expired, false, "desktop.candidate.artifact.expired");
  if (Date.parse(expected.expiresAt) <= deps.now().getTime()) {
    fail("desktop.candidate.artifact.expiresAt", "artifact has expired");
  }

  const artifactParent = deps.artifactParentDirectory ?? tmpdir();
  await mkdir(artifactParent, { recursive: true });
  const tempDir = await mkdtemp(path.join(artifactParent, "desktop-lifecycle-v2-artifact-"));
  try {
    const downloaded = await deps.downloadAndExtractArtifact({
      repo: desktop.repo,
      artifactId: expected.id,
      tempDir,
      expectedPaths: expected.files.map((file) => file.path),
    });
    expectEqual(
      `sha256:${downloaded.archiveSha256}`,
      expected.digest,
      "desktop.candidate.artifact.downloadedDigest",
    );
    await verifyArtifactDirectory(downloaded.extractDir, expected.files);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function verifyLifecycleEvidence(manifest, dependencies) {
  const parsed = parseLifecycleEvidenceManifest(manifest);
  const deps = dependencies ?? createDefaultEvidenceDependencies();
  await verifyExtensionEvidence(parsed.extension, deps);
  await verifyDesktopEvidence(parsed.desktop, deps);
  return parsed;
}

async function main() {
  if (process.argv.length !== 7) {
    throw new LifecycleEvidenceError(
      "Usage: node scripts/verify-desktop-lifecycle-v2-evidence.mjs <manifest.json> <artifact-parent-directory> <extension-persona-export.json> <desktop-persona-export.json> <desktop-diagnostics.json>",
    );
  }
  const manifest = await readLifecycleEvidenceManifest(process.argv[2]);
  await verifyPreservationReceiptFiles(manifest, {
    extensionPersonaExport: process.argv[4],
    desktopPersonaExport: process.argv[5],
    desktopDiagnostics: process.argv[6],
  });
  await verifyLifecycleEvidence(
    manifest,
    createDefaultEvidenceDependencies(process.argv[3]),
  );
  process.stdout.write(`${JSON.stringify({
    status: "verified",
    capability: manifest.capability,
    extension: {
      version: manifest.extension.version,
      sourceCommit: manifest.extension.source.commitSha,
      ciRunId: manifest.extension.ci.runId,
      xpiSha256: manifest.extension.feed.sha256,
    },
    desktop: {
      version: manifest.desktop.version,
      sourceCommit: manifest.desktop.source.commitSha,
      ciRunId: manifest.desktop.ci.runId,
      candidateRunId: manifest.desktop.candidate.runId,
      artifactDigest: manifest.desktop.candidate.artifact.digest,
    },
    inventoriedMachines: manifest.harvestInventory.length,
  })}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[desktop-lifecycle-v2] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
