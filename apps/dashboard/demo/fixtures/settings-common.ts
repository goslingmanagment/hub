import { demoError, hashString, type DemoRequest } from "../core.ts";

/** Helpers the settings fixtures share. */

export function ownerOnly(request: DemoRequest) {
  return request.role === "owner" ? null : demoError(403, "Forbidden", "Только владелец видит этот раздел");
}

const PREFIX_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function prefixFrom(seed: string, length: number): string {
  let hash = hashString(seed);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += PREFIX_ALPHABET[hash % PREFIX_ALPHABET.length];
    hash = hashString(`${seed}:${index}:${hash}`);
  }
  return out;
}

export function uuidFrom(seed: string): string {
  const hex = Array.from({ length: 4 }, (_, index) => hashString(`${seed}#${index}`).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

