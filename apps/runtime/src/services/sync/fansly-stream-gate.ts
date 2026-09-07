// The Fansly page-allowlist primitives. Both live here on purpose: their
// empty-CSV semantics are OPPOSITE, and one file makes that visible instead of
// leaving it to be rediscovered per lane.
//
//   - isPageAllowlisted      — the canonical fail-closed gate (empty = NO page)
//   - fanslyNewStreamAllowed — the frozen Stage 16 ramp legacy (empty = ALL)
//
// Stage 16 ramp gate, extracted (W8.1, decision #133): the executor gate and
// the pageTopSpenders `source` reporter MUST share one allowlist semantic —
// two hand-rolled copies would drift and the API would lie about why a
// stream is not running. Flags gate platform EGRESS, never capture.

/**
 * The CANONICAL fail-closed allowlist: an empty, blank or unset CSV allows NO
 * page. Every new gated mode uses this one; `fanslyNewStreamAllowed` below is
 * NOT a template for new code.
 */
export function isPageAllowlisted(csv: string | undefined, pageLabel: string): boolean {
  // Empty (or unset) = NONE — the allowlist fails CLOSED.
  if (!csv) {
    return false;
  }
  return csv
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(pageLabel);
}

/**
 * FROZEN legacy semantic — empty/blank CSV = every page allowed (the Stage 16
 * ramp's "fully open" state). It gates ONLY `fan_earnings` and
 * `purchase_history`; wherever their allowlist key is empty, tightening this
 * to fail-closed would silently stop both streams. New modes
 * use `isPageAllowlisted` above.
 */
export function fanslyNewStreamAllowed(
  allowlistCsv: string | undefined,
  pageLabel: string,
) {
  const entries = (allowlistCsv ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 || entries.includes(pageLabel);
}

export type FanslyNewStreamState =
  | "ramped"
  | "flag_off"
  | "not_allowlisted"
  | "unsupported_platform";

/** The reporter side of the gate: same checks, same order, as the executor's
 *  skip ladder (platform → flag → allowlist) so the reported state can never
 *  disagree with what the executor would actually do. */
export function resolveFanslyNewStreamState(input: {
  platform: string;
  pageLabel: string;
  streamEnabled: boolean;
  allowlistCsv: string | undefined;
}): FanslyNewStreamState {
  if (input.platform !== "fansly") {
    return "unsupported_platform";
  }
  if (!input.streamEnabled) {
    return "flag_off";
  }
  if (!fanslyNewStreamAllowed(input.allowlistCsv, input.pageLabel)) {
    return "not_allowlisted";
  }
  return "ramped";
}
