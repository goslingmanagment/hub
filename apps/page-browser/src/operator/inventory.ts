// What an API answer carries, without keeping it: the shape of its JSON as
// paths of vetted field names (`response.accounts[].username`), with the
// fields whose names look sensitive marked by category. Values never leave
// this function, and neither do keys that are not vetted names: a key off
// the vocabulary of Hub's own Fansly code is printed as `{id}` (digits),
// `{<category>}` (a sensitive-looking name) or `{?}` — a key can be data (a
// phone number, a token). Stage 1 runs this in memory before any body of a
// real account is written to disk (Astra reviews 13 and 14).

import { VOCABULARY } from "./inventory-vocabulary.ts";

/** Categories of names that may hold a secret or a person's contact, tried
 *  on the raw key before it is masked. Over-marking is fine. */
const CATEGORIES: Array<[string, RegExp]> = [
  ["email", /e-?mail/i],
  ["password", /passw/i],
  ["token", /token|jwt|bearer/i],
  ["secret", /secret/i],
  ["session", /session/i],
  ["phone", /phone|mobile/i],
  ["twofa", /twofa|2fa|otp|totp/i],
  ["cookie", /cookie/i],
  ["apikey", /api_?key/i],
  ["id_number", /ssn|passport|taxid|tax_id/i],
  ["bank", /iban|swift|routing|card_?number/i],
  ["birth", /birth|dob\b/i],
];

/** Hard bounds of one inspection: nodes visited, distinct paths kept, the
 *  characters of all kept paths, depth, one path's length; of an array only
 *  the first items are walked (a shape, not a census). */
export const BOUNDS = { nodes: 200_000, paths: 1_000, pathChars: 64_000, depth: 16, pathLength: 300, arraySample: 200 };

export interface Inventory {
  inspected: boolean;
  reason?: string;
  json?: boolean;
  /** Fansly's own `success` flag, when the answer has one. */
  success?: boolean | null;
  paths?: string[];
  /** Paths ending in a field whose name looks sensitive, with its category. */
  sensitive?: Array<{ path: string; category: string }>;
  /** Keys printed as `{?}`. */
  unknownKeys?: number;
  /** Arrays longer than the sample, walked in part. */
  sampledArrays?: number;
  /** A bound was reached; the inventory is partial. */
  truncated?: boolean;
}

function category(key: string): string | null {
  for (const [name, pattern] of CATEGORIES) if (pattern.test(key)) return name;
  return null;
}

function label(key: string, cat: string | null): string {
  if (VOCABULARY.has(key)) return key;
  if (/^\d+$/.test(key)) return "{id}";
  return cat !== null ? `{${cat}}` : "{?}";
}

export function inspectBody(chunks: Buffer[] | null, over: boolean, maxBytes: number): Inventory {
  if (over || chunks === null) return { inspected: false, reason: `over ${maxBytes} bytes` };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { inspected: true, json: false };
  }
  const paths = new Set<string>();
  const sensitive = new Map<string, string>();
  let nodes = 0;
  let chars = 0;
  let unknownKeys = 0;
  let sampledArrays = 0;
  let truncated = false;
  const full = () => nodes >= BOUNDS.nodes || paths.size >= BOUNDS.paths || chars >= BOUNDS.pathChars;
  const keep = (path: string) => {
    if (paths.has(path)) return;
    paths.add(path);
    chars += path.length;
  };
  // Iterative, so that depth and every bound are checked before each step.
  const stack: Array<{ node: unknown; path: string; depth: number }> = [{ node: value, path: "", depth: 0 }];
  while (stack.length > 0) {
    if (full()) {
      truncated = true;
      break;
    }
    const { node, path, depth } = stack.pop()!;
    nodes += 1;
    if (depth > BOUNDS.depth || path.length > BOUNDS.pathLength) {
      truncated = true;
      continue;
    }
    if (Array.isArray(node)) {
      const take = Math.min(node.length, BOUNDS.arraySample);
      if (take < node.length) sampledArrays += 1;
      for (let i = take - 1; i >= 0; i--) {
        if (stack.length + nodes >= BOUNDS.nodes) {
          truncated = true;
          break;
        }
        stack.push({ node: node[i], path: `${path}[]`, depth: depth + 1 });
      }
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    for (const [key, child] of Object.entries(node)) {
      if (full() || stack.length + nodes >= BOUNDS.nodes) {
        truncated = true;
        break;
      }
      const cat = category(key);
      const name = label(key, cat);
      if (name === "{?}") unknownKeys += 1;
      const next = path === "" ? name : `${path}.${name}`;
      if (next.length > BOUNDS.pathLength) {
        truncated = true;
        continue;
      }
      keep(next);
      if (cat !== null && sensitive.size < 100) sensitive.set(next, cat);
      stack.push({ node: child, path: next, depth: depth + 1 });
    }
  }
  const success = value !== null && typeof value === "object" && typeof (value as { success?: unknown }).success === "boolean" ? (value as { success: boolean }).success : null;
  return {
    inspected: true,
    json: true,
    success,
    paths: [...paths].sort(),
    sensitive: [...sensitive].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, cat]) => ({ path, category: cat })),
    unknownKeys,
    sampledArrays,
    truncated,
  };
}
