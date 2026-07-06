// MIGRATED VERBATIM (Stage 30) from chatgoose_desktop_fable
// prompts/escape.ts @ 1db76a4ae13d (2026-07-06); adapted ONLY in imports.
// Prompts are tuned production assets — do not reword outside
// the parity harness.
/**
 * Escapes untrusted text (fan messages, drafts, spending data) before it is
 * interpolated into a prompt template.
 *
 * Replacement order is load-bearing: `&` must be escaped first, otherwise the
 * `&` produced by `&lt;`/`&gt;` would be double-escaped.
 */
export function escapeForPrompt(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
