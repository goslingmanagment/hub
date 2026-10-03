// The client SDK contract hashes this hub serves (H-1b): its own contract
// hash plus every frozen SDK in the hub-side registry. /api/v1/health lists
// them as `compatibleClientSdks`, so a client release gate can refuse to
// ship an SDK the production hub does not serve; startup's
// print-compatible-client-sdks mode prints them, so the deploy script can
// compare the running image with a candidate before replacing it.
//
// Registry rows are keyed by the bundle digest, and several builds may share
// one contract hash: the lists here carry each hash once.

import { KERNEL_CONTRACT_HASH } from "@agency_hub_core/contracts";

import { CLIENT_SDK_REGISTRY, type ClientSdkRegistryRow } from "./client-sdk-registry.ts";

type RegistryHashes = ReadonlyArray<Pick<ClientSdkRegistryRow, "contractHash">>;

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

/** startup's `print-compatible-client-sdks` line: `{"own":"<hash>","registered":[…]}`. */
export function describeCompatibleClientSdks(
  own: string = KERNEL_CONTRACT_HASH,
  rows: RegistryHashes = CLIENT_SDK_REGISTRY,
): { own: string; registered: string[] } {
  return { own, registered: registeredClientSdkContractHashes(rows) };
}
