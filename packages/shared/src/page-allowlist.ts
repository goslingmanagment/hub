/**
 * A per-page allowlist kept as a CSV of page labels (e.g. `voiceNotesPageAllowlist`).
 * It FAILS CLOSED: an empty, blank or unset CSV allows NO page. Labels match
 * exactly after trimming whitespace around each entry.
 */
export function isPageAllowlisted(csv: string | undefined, pageLabel: string): boolean {
  if (!csv) {
    return false;
  }
  return csv
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(pageLabel);
}
