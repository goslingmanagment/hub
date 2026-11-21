// The owner's setting `customTierOverrides` (CUSTOM_TIER_OVERRIDES): which subscription tiers include a custom,
// where the wording match of the custom checks is wrong (customs facts spec §8). The tiers table is a projection
// rebuilt from events and cannot hold a flag, so the correction lives here: a JSON list, one entry per tier,
//
//   [{"pageLabel": "page-1", "tierRef": "123456789", "includesCustom": true}]
//
// `includesCustom` true makes a tier one that includes a custom whatever its words; false makes it one that does not.
// A tier not named keeps the wording match. The default `[]` corrects nothing. Nothing reads it yet: the checks pass
// that finds a custom paid with no order takes it with the switch `customsFacts`. Pure (no Node API): the dashboard
// reads the registry too.

export interface CustomTierOverride {
  pageLabel: string;
  tierRef: string;
  includesCustom: boolean;
}

/** Tiers one setting names at most. */
export const CUSTOM_TIER_OVERRIDES_MAX = 200;

const EXAMPLE = `[{"pageLabel": "page-1", "tierRef": "123456789", "includesCustom": true}]`;
const FIELDS = new Set(["pageLabel", "tierRef", "includesCustom"]);

type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The setting, every entry checked; or why it is refused. A tier named twice is refused, never resolved by order. */
export function parseCustomTierOverrides(text: string): Parse<CustomTierOverride[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `is not JSON: a list of tiers, e.g. ${EXAMPLE}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: `is a list of tiers, e.g. ${EXAMPLE}` };
  if (parsed.length > CUSTOM_TIER_OVERRIDES_MAX) return { ok: false, error: `names at most ${CUSTOM_TIER_OVERRIDES_MAX} tiers` };
  const value: CustomTierOverride[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of parsed.entries()) {
    const where = `entry ${index + 1}`;
    if (!isRecord(raw)) return { ok: false, error: `${where} must be {"pageLabel", "tierRef", "includesCustom"}` };
    const unknown = Object.keys(raw).filter((key) => !FIELDS.has(key));
    if (unknown.length > 0) return { ok: false, error: `${where} has unknown fields ${unknown.join(", ")}; only pageLabel, tierRef and includesCustom` };
    const { pageLabel, tierRef, includesCustom } = raw;
    if (typeof pageLabel !== "string" || pageLabel.trim() === "" || pageLabel !== pageLabel.trim() || pageLabel.length > 120) {
      return { ok: false, error: `${where}: pageLabel is the page's label, 1 to 120 characters, not padded` };
    }
    if (typeof tierRef !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tierRef)) {
      return { ok: false, error: `${where}: tierRef is the tier's id on the platform, as a string (latin, digits, _ or -)` };
    }
    if (typeof includesCustom !== "boolean") return { ok: false, error: `${where}: includesCustom is true or false` };
    const key = `${pageLabel}\u0000${tierRef}`;
    if (seen.has(key)) return { ok: false, error: `${where}: the tier ${tierRef} of ${pageLabel} is named twice` };
    seen.add(key);
    value.push({ pageLabel, tierRef, includesCustom });
  }
  return { ok: true, value };
}

/** The stored value, parsed; an unset or unparsable one corrects nothing. */
export function customTierOverridesOf(text: string | undefined): CustomTierOverride[] {
  if (text === undefined) return [];
  const parsed = parseCustomTierOverrides(text);
  return parsed.ok ? parsed.value : [];
}
