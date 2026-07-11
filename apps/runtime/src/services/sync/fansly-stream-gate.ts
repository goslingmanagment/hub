// Stage 16 ramp gate, extracted (W8.1, decision #133): the executor gate and
// the pageTopSpenders `source` reporter MUST share one allowlist semantic —
// two hand-rolled copies would drift and the API would lie about why a
// stream is not running. Flags gate platform EGRESS, never capture.

/** Empty/blank CSV = every page allowed (the ramp's "fully open" state). */
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
