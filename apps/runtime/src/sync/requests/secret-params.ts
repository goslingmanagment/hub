import { decryptJsonWithKeyVersion, encryptJson, type AppConfig } from "@agency_hub_core/shared";

import type { SecretBox } from "../engine/ports.ts";

// The secret parameters of a work row (`sync_work.secret_params`, design J7):
// a signed CDN URL, a candidate session or proxy. Encrypted with the box of
// `page_credentials.encrypted_session` (the app's encryption key, by version),
// written when the work is created (`enqueueAndWait`) or by the apply that
// learns the next hop, read only by the live page transport right before its
// request, and dropped in the transaction that closes the work. Never in
// `params`, `result`, `sync_attempts.request` or a log line.

/** The ciphertext of `value`, as `sync_work.secret_params` stores it. */
export function encryptSyncWorkSecret(
  config: Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion">,
  value: unknown,
): string {
  return JSON.stringify(encryptJson(value, config.encryptionKey, config.encryptionKeyVersion));
}

/** The value of a `sync_work.secret_params` ciphertext. Throws when it is not
 *  one this app's keys open. */
export function decryptSyncWorkSecret<T>(config: Pick<AppConfig, "encryptionKeysByVersion">, ciphertext: string): T {
  return decryptJsonWithKeyVersion<T>(ciphertext, config.encryptionKeysByVersion);
}

/** The secret box of the `sync` process (`CommitDeps.secrets`). */
export function createSyncWorkSecretBox(config: Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion">): SecretBox {
  return { seal: (value) => encryptSyncWorkSecret(config, value) };
}
