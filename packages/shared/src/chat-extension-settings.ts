// The owner's switches for the chat extension (the hub's third client,
// chat-extension docs/hub-pr-plan.md H-2b) as the config store holds them, and
// the client version the extension stamps on every request.
//
// ONE parser per stored shape, used on both sides of the store:
// - on write, validateConfigOverride (config-settings.ts) REJECTS a value that
//   does not parse instead of trimming it into shape: a typo must reach the
//   owner as an error, never as a silently narrower setting;
// - on read, the runtime parses the effective value again and fails closed
//   (apps/runtime/src/services/client-switches.ts).
//
// Pure and dependency-free, like the rest of the config layer. Records are
// rebuilt with Object.fromEntries, and `__proto__` is refused as a key, so a
// stored value can never reach an object's prototype.

import type { ConfigStringFormat } from "./config-registry.ts";

export type ChatExtensionParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ── versions ─────────────────────────────────────────────────────────────────

/** MAJOR.MINOR.PATCH: no leading zero, at most 9 digits a part (a Firefox
 *  add-on version part fits), no pre-release or build suffix. */
const SEMVER_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export type ClientSemver = readonly [major: number, minor: number, patch: number];

export function parseClientSemver(text: string): ClientSemver | null {
  const match = SEMVER_PATTERN.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareClientSemver(a: ClientSemver, b: ClientSemver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The chat extension's `x-client-version`: `chat-extension/<MAJOR.MINOR.PATCH>`. */
export const CHAT_EXTENSION_CLIENT_VERSION_PREFIX = "chat-extension/";

/**
 * The chat extension's version from its `x-client-version` header, or null when
 * the header is absent, repeated, another client's, or not exactly
 * `chat-extension/<MAJOR.MINOR.PATCH>`. A caller that gets null treats the
 * client as outdated: an unreadable version is never a pass.
 */
export function parseChatExtensionClientVersion(header: unknown): ClientSemver | null {
  if (typeof header !== "string" || !header.startsWith(CHAT_EXTENSION_CLIENT_VERSION_PREFIX)) {
    return null;
  }
  return parseClientSemver(header.slice(CHAT_EXTENSION_CLIENT_VERSION_PREFIX.length));
}

// ── stored shapes ────────────────────────────────────────────────────────────

/** `chatExtensionFeatures`: scope (`"*"` or a page label) → flag name → on. */
export type ChatExtensionFeatureSwitches = Readonly<Record<string, Readonly<Record<string, boolean>>>>;
/** `chatExtensionHostBindings`: host account (`"onlymonster:36408"`) → page label. */
export type ChatExtensionHostBindings = Readonly<Record<string, string>>;
/** One entry of `chatExtensionPreviewSendReceiptProfiles`: the same shape as the
 *  bootstrap's `limits.previewSendReceiptProfiles[]` (contracts routes-client.ts). */
export interface ChatExtensionReceiptProfile {
  id: string;
  adapterVersion: string;
  /** Module role → fingerprint. */
  modules: Record<string, string>;
}

/** The bootstrap's own bounds for these values (contracts routes-client.ts). */
const PAGE_LABEL_MAX = 120;
const FLAG_NAME_MAX = 64;
const HOST_KEY_MAX = 128;
const RECEIPT_PROFILES_MAX = 32;
/** `<host>:<account id on that host>`, e.g. `onlymonster:36408`. */
const HOST_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,64}$/;

class ShapeError extends Error {}

function fail(message: string): never {
  throw new ShapeError(message);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail("the value is not valid JSON");
  }
}

function plainObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, where: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    fail(`${where} must be a non-empty string of at most ${max} characters without surrounding spaces`);
  }
  return value;
}

function key(name: string, where: string, max: number): string {
  if (name === "__proto__") {
    fail(`${where} may not use the key "__proto__"`);
  }
  return boundedString(name, `${where} key "${name}"`, max);
}

function parseWith<T>(text: string, parse: (json: unknown) => T): ChatExtensionParseResult<T> {
  try {
    return { ok: true, value: parse(parseJson(text)) };
  } catch (error) {
    if (error instanceof ShapeError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * `{"*": {"coach": true}, "lora-of": {"coach": false}}`. Every flag value is a
 * boolean. A flag name the hub does not know is kept (the owner may switch a
 * flag on before the hub that serves it ships) and ignored by the evaluation.
 */
export function parseChatExtensionFeatures(text: string): ChatExtensionParseResult<ChatExtensionFeatureSwitches> {
  return parseWith(text, (json) => Object.fromEntries(
    Object.entries(plainObject(json, "the value")).map(([scope, flags]) => {
      key(scope, "the value", PAGE_LABEL_MAX);
      const where = `scope "${scope}"`;
      return [scope, Object.fromEntries(Object.entries(plainObject(flags, where)).map(([flag, on]) => {
        key(flag, where, FLAG_NAME_MAX);
        if (typeof on !== "boolean") {
          fail(`${where} flag "${flag}" must be true or false`);
        }
        return [flag, on];
      }))];
    }),
  ));
}

/** `{"onlymonster:36408": "lora-vip-of"}`: host account → page label. */
export function parseChatExtensionHostBindings(text: string): ChatExtensionParseResult<ChatExtensionHostBindings> {
  return parseWith(text, (json) => Object.fromEntries(
    Object.entries(plainObject(json, "the value")).map(([host, label]) => {
      key(host, "the value", HOST_KEY_MAX);
      if (!HOST_KEY_PATTERN.test(host)) {
        fail(`host account "${host}" must read <host>:<account id>, e.g. onlymonster:36408`);
      }
      return [host, boundedString(label, `host account "${host}" page label`, PAGE_LABEL_MAX)];
    }),
  ));
}

const RECEIPT_PROFILE_KEYS = ["id", "adapterVersion", "modules"] as const;

/** `[{"id": "…", "adapterVersion": "…", "modules": {"<role>": "<fingerprint>"}}]`:
 *  at most 32 profiles, ids unique, no other keys. `[]` admits none (X8 off). */
export function parseChatExtensionReceiptProfiles(
  text: string,
): ChatExtensionParseResult<readonly ChatExtensionReceiptProfile[]> {
  return parseWith(text, (json) => {
    if (!Array.isArray(json)) {
      fail("the value must be a JSON array");
    }
    if (json.length > RECEIPT_PROFILES_MAX) {
      fail(`the value lists more than ${RECEIPT_PROFILES_MAX} profiles`);
    }
    const ids = new Set<string>();
    return json.map((entry, index): ChatExtensionReceiptProfile => {
      const where = `profile ${index}`;
      const profile = plainObject(entry, where);
      const extra = Object.keys(profile).filter((name) => !(RECEIPT_PROFILE_KEYS as readonly string[]).includes(name));
      if (extra.length > 0) {
        fail(`${where} has unknown keys: ${extra.join(", ")}`);
      }
      const id = boundedString(profile.id, `${where} id`, 64);
      if (ids.has(id)) {
        fail(`${where} repeats the id "${id}"`);
      }
      ids.add(id);
      const modulesWhere = `${where} modules`;
      return {
        id,
        adapterVersion: boundedString(profile.adapterVersion, `${where} adapterVersion`, 64),
        modules: Object.fromEntries(Object.entries(plainObject(profile.modules, modulesWhere)).map(([role, fingerprint]) => [
          key(role, modulesWhere, 64),
          boundedString(fingerprint, `${modulesWhere} "${role}"`, 128),
        ])),
      };
    });
  });
}

/** `chatExtensionMinVersion`: MAJOR.MINOR.PATCH. */
export function parseChatExtensionMinVersion(text: string): ChatExtensionParseResult<string> {
  return parseClientSemver(text) === null
    ? { ok: false, error: "the value must read MAJOR.MINOR.PATCH, e.g. 1.4.0 (no leading zeros, no suffix)" }
    : { ok: true, value: text };
}

/**
 * The write-time check of a string config value whose descriptor declares a
 * `format` (config-registry.ts). Returns the reason the value is refused, or
 * null when it parses.
 */
export function configStringFormatError(format: ConfigStringFormat, value: string): string | null {
  const result = parseConfigStringFormat(format, value);
  return result.ok ? null : result.error;
}

function parseConfigStringFormat(format: ConfigStringFormat, value: string): ChatExtensionParseResult<unknown> {
  switch (format) {
    case "semver":
      return parseChatExtensionMinVersion(value);
    case "chat-extension-features":
      return parseChatExtensionFeatures(value);
    case "chat-extension-host-bindings":
      return parseChatExtensionHostBindings(value);
    case "chat-extension-receipt-profiles":
      return parseChatExtensionReceiptProfiles(value);
    default: {
      // A new format without a parser fails closed, and fails the build first.
      const unhandled: never = format;
      return { ok: false, error: `has an unknown format ${String(unhandled)}` };
    }
  }
}
