// What an API answer carries, without keeping it: the key names of its JSON
// (paths like `response.accounts[].username`), with the names that look
// sensitive marked. Values never leave this function. Stage 1 runs this in
// memory before any body of a real account is written to disk (Astra
// review 13: which fields Fansly's answers carry, the self-account included).

/** Key names that may hold a secret or a person's contact. Over-marking is
 *  fine: the list is for a person to read. */
const SENSITIVE = /e-?mail|passw|token|secret|session|phone|twofa|2fa|otp|cookie|api_?key|ssn|iban|birth/i;

/** A key that is data rather than a name (an id, a hash, an address) is
 *  reported as a placeholder: the inventory carries names only. */
function keyName(key: string): string {
  if (/^\d+$/.test(key)) return "{id}";
  if (key.includes("@") || /^[A-Za-z0-9_-]{24,}$/.test(key)) return "{key}";
  return key;
}

const MAX_PATHS = 3000;
const MAX_DEPTH = 16;

export interface Inventory {
  inspected: boolean;
  reason?: string;
  json?: boolean;
  /** Fansly's own `success` flag, when the answer has one. */
  success?: boolean | null;
  paths?: string[];
  /** Paths whose last name looks sensitive. */
  sensitive?: string[];
  /** The walk stopped at MAX_PATHS or MAX_DEPTH. */
  truncated?: boolean;
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
  let truncated = false;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (paths.size >= MAX_PATHS || depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, `${path}[]`, depth + 1);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const next = path === "" ? keyName(key) : `${path}.${keyName(key)}`;
        paths.add(next);
        walk(child, next, depth + 1);
      }
    }
  };
  walk(value, "", 0);
  const sorted = [...paths].sort();
  const success = value !== null && typeof value === "object" && typeof (value as { success?: unknown }).success === "boolean" ? (value as { success: boolean }).success : null;
  return {
    inspected: true,
    json: true,
    success,
    paths: sorted,
    sensitive: sorted.filter((path) => SENSITIVE.test(path.split(".").at(-1)!.replace(/(\[\])+$/, ""))),
    truncated,
  };
}
