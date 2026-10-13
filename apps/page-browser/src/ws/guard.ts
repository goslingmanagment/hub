// The socket guard's policy and source (plan §4.3; spec §2.6), and what the
// operator makes of the guard's reports.
//
// The guard itself is inpage/ws-guard.js: plain JavaScript Chrome runs in
// every context of the page before the site (ws/install.ts puts it there).
// Here:
// - the allow-list of outgoing messages, spec §2.6 — what Hub's own socket
//   code sends (apps/runtime/src/services/fansly-ws/connection.ts): the
//   authorization {"t":1,"d":"{\"token\":…,\"v\":3}"} — `t` is 1, `d` is
//   JSON with exactly `token` (a string; its value is not compared) and `v`
//   equal to 3 — and the ping "p". Everything else is not sent. What else
//   the site sends is stage 1, item 9: on the test account, after the login,
//   one authorization and then the ping every ~20 s (stage1-stand.md §9);
// - the guard's expression for one binding and one policy;
// - the same check in Node (`allowedMessage`), for what CDP says left: a
//   message that should not have left means the guard was bypassed;
// - the guard's reports, read as untrusted text, and what of a message's
//   shape may reach a log or an alarm: never a value, and names only when
//   they look like names (a long or odd one may be a token).

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export interface FieldRule {
  name: string;
  /** The field's value is of this type... */
  type?: "string" | "number" | "boolean";
  /** ...or equals this value. */
  equals?: string | number | boolean;
}

export interface JsonRule {
  /** The message's `t`. */
  t: number | string;
  /** Exactly these own keys. */
  keys: string[];
  /** `d` is JSON text of an object with exactly these fields; null: `d` is
   *  not looked into. */
  d: FieldRule[] | null;
}

export interface GuardPolicy {
  /** Messages allowed as they are. */
  exact: string[];
  json: JsonRule[];
}

/** Spec §2.6. */
export const SOCKET_POLICY: GuardPolicy = {
  exact: ["p"],
  json: [{ t: 1, keys: ["t", "d"], d: [{ name: "token", type: "string" }, { name: "v", equals: 3 }] }],
};

const GUARD_FILE = new URL("../inpage/ws-guard.js", import.meta.url);
let guardFile: string | null = null;

/** inpage/ws-guard.js as it is. */
export function guardSource(): string {
  guardFile ??= readFileSync(GUARD_FILE, "utf8");
  return guardFile;
}

/** A binding name nobody could guess (the guard removes it before the site
 *  runs anyway). */
export function newBindingName(): string {
  return `pb${randomBytes(9).toString("hex")}`;
}

/** The expression that installs the guard in a context: nothing of it stays
 *  global. */
export function guardExpression(binding: string, policy: GuardPolicy = SOCKET_POLICY): string {
  return `(() => {\n${guardSource()}\npbWsGuard(${JSON.stringify(binding)}, ${JSON.stringify(policy)});\n})()`;
}

function objectOf(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || !text.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function keysAre(object: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(object);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(object, key));
}

/** The guard's check, in Node: the same rules as inpage/ws-guard.js. */
export function allowedMessage(data: unknown, policy: GuardPolicy = SOCKET_POLICY): boolean {
  if (typeof data !== "string") return false;
  if (policy.exact.includes(data)) return true;
  const m = objectOf(data);
  if (m === null || !Object.hasOwn(m, "t")) return false;
  const t = m.t;
  if (typeof t !== "number" && typeof t !== "string") return false;
  const rule = policy.json.find((candidate) => candidate.t === t);
  if (!rule || !keysAre(m, rule.keys)) return false;
  if (rule.d === null) return true;
  const inner = objectOf(m.d);
  if (inner === null || !keysAre(inner, rule.d.map((field) => field.name))) return false;
  return rule.d.every((field) => (Object.hasOwn(field, "equals") ? inner[field.name] === field.equals : typeof inner[field.name] === field.type));
}

/** What a message that left is, for the journal of outgoing messages. */
export function messageKind(data: string): "ping" | "auth" | "other" {
  if (data === "p") return "ping";
  return allowedMessage(data) ? "auth" : "other";
}

/** The shape of a message — never a value. */
export interface MessageShape {
  form: "text" | "json" | "non-text";
  len: number | null;
  /** The JSON `t`, when it is a number or a short name. */
  msgType: number | string | null;
  keys: string[] | null;
  dKeys: string[] | null;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const WHY = /^[A-Za-z ]{1,80}$/;
const TYPE_NAME = /^[A-Za-z0-9_.:-]{1,32}$/;

function safeNames(names: unknown): string[] | null {
  if (!Array.isArray(names) || names.length > 20) return null;
  return names.map((name) => (typeof name === "string" && NAME.test(name) ? name : "?"));
}

function safeType(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return TYPE_NAME.test(value) ? value : "?";
  return null;
}

/** The shape of a message that left (CDP's word), as the guard reports it. */
export function shapeOf(data: string): MessageShape {
  const m = objectOf(data);
  if (m === null) return { form: "text", len: data.length, msgType: null, keys: null, dKeys: null };
  const inner = objectOf(m.d);
  return { form: "json", len: data.length, msgType: safeType(m.t), keys: safeNames(Object.keys(m)), dKeys: inner === null ? null : safeNames(Object.keys(inner)) };
}

/** A shape as log and alarm fields: primitives only. */
export function shapeFields(shape: MessageShape): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = { form: shape.form };
  if (shape.len !== null) fields.len = shape.len;
  if (shape.msgType !== null) fields.msgType = shape.msgType;
  if (shape.keys !== null) fields.keys = shape.keys.join(",");
  if (shape.dKeys !== null) fields.dKeys = shape.dKeys.join(",");
  return fields;
}

export type GuardReport =
  | { k: "installed"; ws: boolean; where: string }
  | { k: "blocked_send"; shape: MessageShape; where: string }
  | { k: "guard_failed"; why: string; where: string };

/** The longest report the operator reads. */
const MAX_REPORT = 8192;

function namesFrom(text: unknown): string[] | null {
  if (typeof text !== "string") return null;
  try {
    return safeNames(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A report of the guard, from the page: untrusted text. Null when it is not
 *  one. */
export function parseGuardReport(payload: string): GuardReport | null {
  if (payload.length > MAX_REPORT) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const where = typeof r.where === "string" ? r.where : "";
  switch (r.k) {
    case "installed":
      return { k: "installed", ws: r.ws === true, where };
    case "guard_failed":
      // The guard's own words; anything else is not repeated.
      return { k: "guard_failed", why: typeof r.why === "string" && WHY.test(r.why) ? r.why : "?", where };
    case "blocked_send": {
      const form = r.form === "json" || r.form === "text" ? r.form : "non-text";
      const len = typeof r.len === "number" && Number.isFinite(r.len) ? r.len : null;
      return { k: "blocked_send", where, shape: { form, len, msgType: safeType(r.msgType), keys: namesFrom(r.keys), dKeys: namesFrom(r.dKeys) } };
    }
    default:
      return null;
  }
}
