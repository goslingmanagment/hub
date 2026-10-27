// The owner's setting `crossSpendersLists` (CROSS_SPENDERS_LISTS): the pages
// whose Fansly list of cross-page spenders Hub keeps, each with the knobs of
// its set. A JSON object keyed by the page's label; a page that is not named
// has no list (the default `{}`: off for every page). An empty object takes
// every default:
//
//   {"lora-1": {}, "lilly-1": {"sources": ["lilly-2"], "minSourceSpendMills": 5000}}
//
// - `sources`: "model" (the default: the other pages of the target's model on
//   its platform), "all" (every other page of the platform), or page labels;
// - `minSourceSpendMills`: the fan paid the sources together at least this
//   (default 1 mill: any spend);
// - `maxTargetSpendMills`: ...and the page itself at most this (default 0:
//   never paid it; null: any);
// - `audience`: "any" (default), "followers" or "subscribers" of the page;
// - `label`: the list's label on Fansly (default below).
//
// The set's rules are services/cross-page-spenders.ts; the list's sync is the
// Fansly engine's `fan-set-lists.sync`. Pure (no Node API): the dashboard
// reads the registry too.

export type CrossSpendersListAudience = "followers" | "subscribers" | "any";

/** One page's list, every knob decided. */
export interface CrossSpendersListSetting {
  sources: "model" | "all" | string[];
  minSourceSpendMills: number;
  maxTargetSpendMills: number | null;
  audience: CrossSpendersListAudience;
  label: string;
}

/** The label of the list on Fansly when the setting names none. */
export const CROSS_SPENDERS_LIST_DEFAULT_LABEL = "Спендеры других страниц · хаб";

/** The longest label Hub gives a list (its own bound). */
export const CROSS_SPENDERS_LIST_LABEL_MAX = 60;

/** Pages one setting names at most. */
export const CROSS_SPENDERS_LISTS_MAX_PAGES = 50;

const AUDIENCES: readonly CrossSpendersListAudience[] = ["followers", "subscribers", "any"];
const KNOBS = new Set(["sources", "minSourceSpendMills", "maxTargetSpendMills", "audience", "label"]);

export type CrossSpendersListsParse =
  | { ok: true; value: Map<string, CrossSpendersListSetting> }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingOf(label: string, raw: unknown): CrossSpendersListSetting | string {
  const where = `page ${label}`;
  if (!isRecord(raw)) return `${where}: takes an object of knobs ({} for the defaults)`;
  for (const key of Object.keys(raw)) {
    if (!KNOBS.has(key)) return `${where}: unknown knob ${key} (sources, minSourceSpendMills, maxTargetSpendMills, audience, label)`;
  }
  let sources: CrossSpendersListSetting["sources"] = "model";
  if (raw.sources !== undefined) {
    if (raw.sources === "model" || raw.sources === "all") {
      sources = raw.sources;
    } else if (Array.isArray(raw.sources)) {
      const labels = raw.sources.map((value) => (typeof value === "string" ? value.trim() : ""));
      if (labels.length === 0 || labels.length > 20 || labels.some((value) => value === "" || value === "model" || value === "all")) {
        return `${where}: sources is "model", "all" or 1 to 20 page labels`;
      }
      if (labels.includes(label)) return `${where}: a page is never its own source`;
      sources = [...new Set(labels)].sort();
    } else {
      return `${where}: sources is "model", "all" or a list of page labels`;
    }
  }
  const min = raw.minSourceSpendMills ?? 1;
  if (typeof min !== "number" || !Number.isSafeInteger(min) || min < 1) return `${where}: minSourceSpendMills is a whole number of mills, at least 1`;
  const max = raw.maxTargetSpendMills === undefined ? 0 : raw.maxTargetSpendMills;
  if (max !== null && (typeof max !== "number" || !Number.isSafeInteger(max) || max < 0)) {
    return `${where}: maxTargetSpendMills is a whole number of mills, at least 0, or null (any)`;
  }
  const audience = raw.audience ?? "any";
  if (typeof audience !== "string" || !AUDIENCES.includes(audience as CrossSpendersListAudience)) {
    return `${where}: audience is followers, subscribers or any`;
  }
  const listLabel = raw.label === undefined ? CROSS_SPENDERS_LIST_DEFAULT_LABEL : typeof raw.label === "string" ? raw.label.trim() : "";
  if (listLabel === "" || listLabel.length > CROSS_SPENDERS_LIST_LABEL_MAX) return `${where}: label is 1 to ${CROSS_SPENDERS_LIST_LABEL_MAX} characters`;
  // Chatters read the label in the mass message composer: no long dash (the owner, 2026-10-26).
  if (listLabel.includes("—")) return `${where}: label has a long dash «—»; use a colon, a comma or «·»`;
  return { sources, minSourceSpendMills: min, maxTargetSpendMills: max as number | null, audience: audience as CrossSpendersListAudience, label: listLabel };
}

/** The setting, every page's knobs decided; or why it is refused. */
export function parseCrossSpendersLists(text: string): CrossSpendersListsParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "is not JSON: an object keyed by page label, e.g. {\"lora-1\": {}}" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "is an object keyed by page label, e.g. {\"lora-1\": {}}" };
  const entries = Object.entries(parsed);
  if (entries.length > CROSS_SPENDERS_LISTS_MAX_PAGES) return { ok: false, error: `names at most ${CROSS_SPENDERS_LISTS_MAX_PAGES} pages` };
  const value = new Map<string, CrossSpendersListSetting>();
  for (const [rawLabel, raw] of entries) {
    const label = rawLabel.trim();
    if (label === "" || label !== rawLabel) return { ok: false, error: `page label ${JSON.stringify(rawLabel)} is blank or padded` };
    const setting = settingOf(label, raw);
    if (typeof setting === "string") return { ok: false, error: setting };
    value.set(label, setting);
  }
  return { ok: true, value };
}

/** One page's list, or null when the setting does not name the page (or
 *  does not parse: a stored value is checked on write, so that is off). */
export function crossSpendersListFor(text: string | undefined, pageLabel: string | null): CrossSpendersListSetting | null {
  if (text === undefined || pageLabel === null) return null;
  const parsed = parseCrossSpendersLists(text);
  return parsed.ok ? parsed.value.get(pageLabel) ?? null : null;
}

/** The setting as one text, its keys in one order: equal texts are the same
 *  set and the same list (a change of any knob starts a new sync). */
export function crossSpendersListKey(setting: CrossSpendersListSetting): string {
  return JSON.stringify({
    sources: setting.sources,
    minSourceSpendMills: setting.minSourceSpendMills,
    maxTargetSpendMills: setting.maxTargetSpendMills,
    audience: setting.audience,
    label: setting.label,
  });
}
