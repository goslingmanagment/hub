// The client SDK contract hashes this hub serves (H-1b): its own contract
// hash plus every frozen SDK in the hub-side registry. /api/v1/health lists
// them as `compatibleClientSdks`, so a client release gate can refuse to
// ship an SDK the production hub does not serve; startup's
// print-compatible-client-sdks mode prints them, so the deploy script can
// compare the running image with a candidate before replacing it.
//
// Registry rows are keyed by the bundle digest, and several builds may share
// one contract hash: the hash lists here carry each hash once. The startup
// line also carries every row's bundle digest, so the deploy gate can see a
// dropped build even while another build with the same hash stays.

import { KERNEL_CONTRACT_HASH } from "@agency_hub_core/contracts";

import { CLIENT_SDK_REGISTRY, type ClientSdkRegistryRow } from "./client-sdk-registry.ts";

type RegistryHashes = ReadonlyArray<Pick<ClientSdkRegistryRow, "contractHash">>;
type RegistryRows = ReadonlyArray<Pick<ClientSdkRegistryRow, "contractHash" | "bundleSha256">>;

/** Every registered contract hash once, sorted (released and candidate rows alike:
 *  a candidate must be served before its client may ship it). */
export function registeredClientSdkContractHashes(rows: RegistryHashes = CLIENT_SDK_REGISTRY): string[] {
  return [...new Set(rows.map((row) => row.contractHash))].sort();
}

/** `health.compatibleClientSdks`: this hub's own contract hash first, then the
 *  registered ones, no repeats. */
export function listCompatibleClientSdks(
  own: string = KERNEL_CONTRACT_HASH,
  rows: RegistryHashes = CLIENT_SDK_REGISTRY,
): string[] {
  return [...new Set([own, ...registeredClientSdkContractHashes(rows)])];
}

/** startup's `print-compatible-client-sdks` line:
 *  `{"own":"<hash>","registered":[…],"bundles":[…]}`. `registered` is the
 *  hash set health lists; `bundles` is every row key (bundleSha256), sorted,
 *  so the deploy gate can also compare at row level. */
export function describeCompatibleClientSdks(
  own: string = KERNEL_CONTRACT_HASH,
  rows: RegistryRows = CLIENT_SDK_REGISTRY,
): { own: string; registered: string[]; bundles: string[] } {
  return {
    own,
    registered: registeredClientSdkContractHashes(rows),
    bundles: rows.map((row) => row.bundleSha256).sort(),
  };
}
