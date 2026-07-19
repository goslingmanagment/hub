// Voice-notes shared canonicalization + script validation (Task 5).
//
// The canonicalization and hashing rules here are LAW shared with the Fansly
// extension (through docs, not code): the extension canonicalizes the same way
// and computes the same request_hash so a retry is recognised as a replay
// rather than a fresh — and separately billable — synthesis. Keep both sides
// byte-identical.

import { createHash } from "node:crypto";

/**
 * The ONLY audio tags a voice script may carry (case-sensitive, exact strings).
 * Anything else in `[...]` is rejected. Mirrors the extension's allowlist.
 */
export const VOICE_SCRIPT_ALLOWED_TAGS = [
  "[warmly]",
  "[cheerfully]",
  "[thoughtful]",
  "[excited]",
  "[whispers]",
  "[chuckles]",
  "[giggles]",
  "[sighs]",
  "[short pause]",
  "[long pause]",
] as const;

const ALLOWED_TAG_SET: ReadonlySet<string> = new Set(VOICE_SCRIPT_ALLOWED_TAGS);

// Any well-formed bracketed group with no nested brackets: `[warmly]`,
// `[short pause]`, `[shouting]`, `[]`. Stray unmatched brackets are literal
// text, not a "group", and are not tag-validated.
const BRACKET_GROUP = /\[[^[\]]*\]/g;

/**
 * NFC-normalise, fold CRLF to LF, then trim. Applied to the submitted script
 * before hashing/validation so trailing-whitespace and line-ending noise never
 * splits one logical request into two request hashes.
 */
export function canonicalizeVoiceScript(raw: string): string {
  return raw.normalize("NFC").replace(/\r\n/g, "\n").trim();
}

export type VoiceScriptRejection =
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "too_long"; chars: number; max: number }
  | { ok: false; reason: "markup" }
  | { ok: false; reason: "bad_tag"; tag: string };

export type VoiceScriptValidation =
  | { ok: true; canonical: string; chars: number }
  | VoiceScriptRejection;

/**
 * Validate an already-canonicalised script: non-empty, within `maxChars`, no
 * `<`/`>` markup anywhere, and every `[...]` group in the allowlist. Returns a
 * structured verdict the caller maps to `voice_script_invalid`.
 */
export function validateVoiceScript(canonical: string, maxChars: number): VoiceScriptValidation {
  if (canonical.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (canonical.length > maxChars) {
    return { ok: false, reason: "too_long", chars: canonical.length, max: maxChars };
  }
  // No SSML / markup: a bare `<` or `>` anywhere is refused, checked before tag
  // parsing so markup can never ride inside a bracket group.
  if (canonical.includes("<") || canonical.includes(">")) {
    return { ok: false, reason: "markup" };
  }
  const groups = canonical.match(BRACKET_GROUP) ?? [];
  for (const group of groups) {
    if (!ALLOWED_TAG_SET.has(group)) {
      return { ok: false, reason: "bad_tag", tag: group };
    }
  }
  return { ok: true, canonical, chars: canonical.length };
}

/** sha256 hex digest of a string or buffer. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * request_hash = sha256(pageId + "\n" + conversationRef + "\n" +
 * sourceGenerationRef + "\n" + canonicalScript). `pageId` is the numeric kernel
 * page id (stable across label renames); the extension computes the identical
 * digest from the same fields.
 */
export function computeVoiceRequestHash(input: {
  pageId: number;
  conversationRef: string;
  sourceGenerationRef: string;
  canonicalScript: string;
}): string {
  return sha256Hex(
    `${input.pageId}\n${input.conversationRef}\n${input.sourceGenerationRef}\n${input.canonicalScript}`,
  );
}
