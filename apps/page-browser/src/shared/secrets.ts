// Secrets the page's processes hold in memory and must never write anywhere
// (plan §4.5, §4.11): the engine's RPC token, the page's SOCKS5 login and
// password. What is never passed to a log is the first rule; this is the
// second: every line a log or a journal writes goes through `scrub`, and a
// registered value that slipped into it anyway is cut out.

const secrets = new Set<string>();

/** Remember a value that must never be written (and its JSON-escaped form). */
export function registerSecret(value: string): void {
  // Shorter values would cut ordinary words — and JSON's own `true`,
  // `false`, `null` — out of the lines.
  if (value.length < 6) return;
  secrets.add(value);
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) secrets.add(escaped);
}

/** A line with every registered secret replaced by "[secret]". */
export function scrub(line: string): string {
  let out = line;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("[secret]");
  }
  return out;
}

/** Tests only: forget what was registered. */
export function forgetSecrets(): void {
  secrets.clear();
}
