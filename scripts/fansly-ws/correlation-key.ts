import { createHmac } from "node:crypto";
import { readPrivateFile } from "./private-file.ts";

const FINGERPRINT_DOMAIN = "fansly-w0-correlation-key-v1";

function validateKey(key: Buffer) {
  if (key.length !== 32) throw new Error("invalid_key");
  return key;
}

export async function readCorrelationKey(path: string) {
  return validateKey(await readPrivateFile(path, 32));
}

/** Identifies equal experiment keys without exporting their values. */
export function correlationKeyFingerprint(key: Buffer) {
  return createHmac("sha256", validateKey(key)).update(FINGERPRINT_DOMAIN).digest("hex");
}
