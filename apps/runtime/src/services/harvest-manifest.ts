import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface HarvestManifest {
  machineId: string;
  appVersion?: string;
  harvestFormatVersion?: number;
  reconcileUsing?: string;
  tables: Array<{
    table: string;
    kind: string;
    walked: number;
    uploaded: number;
    duplicates: number;
    minObservedAt?: string | null;
    maxObservedAt?: string | null;
  }>;
}

function parseManifest(text: string, path: string): HarvestManifest {
  const manifest = JSON.parse(text) as Partial<HarvestManifest>;
  if (
    typeof manifest.machineId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      manifest.machineId,
    )
  ) {
    throw new Error(`Harvest manifest ${path} must carry a UUID machineId`);
  }
  if (!Array.isArray(manifest.tables)) {
    throw new Error(`Harvest manifest ${path} must carry tables[]`);
  }
  return manifest as HarvestManifest;
}

async function readManifest(path: string): Promise<HarvestManifest> {
  return parseManifest(await readFile(path, "utf8"), path);
}

function canonicalName(manifest: HarvestManifest): string {
  const declared = manifest.reconcileUsing;
  if (declared !== undefined) {
    if (
      basename(declared) !== declared ||
      !declared.startsWith("chatgoose-harvest-manifest-") ||
      !declared.endsWith("-latest.json")
    ) {
      throw new Error(`Unsafe harvest reconcileUsing path: ${declared}`);
    }
    return declared;
  }
  return `chatgoose-harvest-manifest-${manifest.machineId}-latest.json`;
}

/** Resolve a timestamped/audit snapshot to the canonical cumulative manifest
 * when Desktop v2 has published one beside it. Legacy v1 manifests still work
 * when no canonical sibling exists. */
export async function resolveHarvestManifest(inputPath: string): Promise<{
  path: string;
  manifest: HarvestManifest;
  supersededPath: string | null;
}> {
  const requestedPath = resolve(inputPath);
  const requested = await readManifest(requestedPath);
  const latestPath = join(dirname(requestedPath), canonicalName(requested));
  if (latestPath === requestedPath) {
    return { path: requestedPath, manifest: requested, supersededPath: null };
  }

  try {
    const latest = await readManifest(latestPath);
    if (latest.machineId !== requested.machineId) {
      throw new Error(
        `Canonical harvest manifest machine ${latest.machineId} does not match ${requested.machineId}`,
      );
    }
    return { path: latestPath, manifest: latest, supersededPath: requestedPath };
  } catch (error) {
    if (
      requested.reconcileUsing === undefined &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { path: requestedPath, manifest: requested, supersededPath: null };
    }
    throw error;
  }
}
