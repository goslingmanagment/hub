import { findPlatformFan, getLatestFanProfile } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";

// Fan-dossier context: the latest stored fan profile (the Scan dossier the
// clients write via upsertFanProfile) compiled down to a prompt-safe excerpt.
// The dossier is optional ENRICHMENT — every consumer treats a miss (no fan,
// deleted fan, no profile, lookup error) as "no section", never as a failed
// generation. Compilation happens BEFORE prompt escaping (the builder escapes
// the compiled body like any other fan-derived value).

type Db = Pick<AppContext, "db">;

/** Soft budget: prefer dropping whole sections over exceeding this. */
export const FAN_PROFILE_TARGET_CHARS = 10_000;
/** Absolute guard against cost/latency creep (write cap on bodies is 50k). */
export const FAN_PROFILE_HARD_CAP_CHARS = 20_000;

const TRUNCATION_MARKER = "\n\n[dossier truncated]";

/** The section vocabulary of the fan-summary template (templates/fan-summary.md
 * "## Sections"). The template instructs "Write in Russian", so PRODUCTION
 * dossiers carry Russian headings in the dashboard-pinned markdown shape
 * (`## 1. ДОСЬЕ` — see apps/dashboard/src/lib/parseFanProfile.ts and
 * tests/parseFanProfile.test.ts); English names cover the template's own
 * vocabulary and legacy bodies. `stems` catch translation variance, but only
 * on markdown `#` heading lines — prose or list bullets never stem-match.
 * `keepPriority` orders size-pressure drops (higher = dropped first); `kind`
 * drives the age policy — volatile sections (stage, open loops, strategy)
 * mislead once the dossier is old, stable ones age well. FINANCIAL PROFILE is
 * always dropped: fresh spending/subscription data rides its own prompt
 * sections. */
const DOSSIER_SECTIONS = [
  {
    label: "DOSSIER",
    kind: "stable",
    keepPriority: 0,
    aliases: ["DOSSIER", "ДОСЬЕ"],
    stems: ["DOSSIER", "ДОСЬЕ"],
  },
  {
    label: "PSYCHOLOGICAL PORTRAIT",
    kind: "stable",
    keepPriority: 4,
    aliases: ["PSYCHOLOGICAL PORTRAIT", "ПСИХОЛОГИЧЕСКИЙ ПОРТРЕТ", "ПОРТРЕТ"],
    stems: ["PORTRAIT", "ПОРТРЕТ"],
  },
  {
    label: "STAGE AND TRAJECTORY",
    kind: "volatile",
    keepPriority: 5,
    aliases: ["STAGE AND TRAJECTORY", "СТАДИЯ И ТРАЕКТОРИЯ", "ЭТАП И ТРАЕКТОРИЯ"],
    stems: ["STAGE", "TRAJECTOR", "СТАДИ", "ЭТАП", "ТРАЕКТОР"],
  },
  {
    label: "COMMUNICATION DYNAMICS",
    kind: "stable",
    keepPriority: 1,
    aliases: ["COMMUNICATION DYNAMICS", "ДИНАМИКА ОБЩЕНИЯ", "КОММУНИКАЦИОННАЯ ДИНАМИКА"],
    stems: ["COMMUNICATION", "DYNAMIC", "КОММУНИК", "ОБЩЕНИ", "ДИНАМИК"],
  },
  {
    label: "FINANCIAL PROFILE",
    kind: "dropped",
    keepPriority: 6,
    aliases: ["FINANCIAL PROFILE", "ФИНАНСОВЫЙ ПРОФИЛЬ"],
    stems: ["FINANC", "ФИНАНС"],
  },
  {
    label: "OPEN LOOPS",
    kind: "volatile",
    keepPriority: 2,
    aliases: ["OPEN LOOPS", "ОТКРЫТЫЕ ПЕТЛИ", "НЕЗАКРЫТЫЕ ТЕМЫ", "ОТКРЫТЫЕ ВОПРОСЫ"],
    stems: ["LOOP", "ПЕТЛ", "НЕЗАКРЫТ"],
  },
  {
    label: "STRATEGY",
    kind: "volatile",
    keepPriority: 3,
    aliases: ["STRATEGY", "СТРАТЕГИЯ"],
    stems: ["STRATEG", "СТРАТЕГ"],
  },
] as const;

type DossierSectionDef = (typeof DOSSIER_SECTIONS)[number];

/** Reduce a candidate heading line to the bare section name: markdown heading
 * marks, list markers, "1." / "1)" numbering, bold/underscore wrappers,
 * a trailing colon and ATX closing hashes are stripped. The remainder must
 * EQUAL a known alias — except on markdown `#` heading lines, where a stem
 * CONTAINS match is allowed too (production headings are model-translated
 * Russian and vary in wording). Prose that merely mentions "strategy" and
 * list bullets like "- Финансы: …" never split a section. */
function matchSectionHeading(line: string): DossierSectionDef | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return undefined;
  }
  // Stem matching is limited to H1/H2 — production sections are H2 and an
  // H3+ is a SUBHEADING inside a section (e.g. "### Финансовые заметки"
  // under ДОСЬЕ must not split off and get dropped as financial).
  const isMarkdownHeading = /^#{1,2}\s/.test(trimmed);
  const normalized = trimmed
    .replace(/^#{1,6}\s*/, "")
    .replace(/\s*#+\s*$/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d{1,2}\s*[.)]\s*/, "")
    .replace(/^[*_]{1,3}|[*_]{1,3}$/g, "")
    .replace(/:$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  if (normalized.length === 0) {
    return undefined;
  }
  const exact = DOSSIER_SECTIONS.find((section) =>
    (section.aliases as readonly string[]).includes(normalized),
  );
  if (exact || !isMarkdownHeading) {
    return exact;
  }
  return DOSSIER_SECTIONS.find((section) =>
    section.stems.some((stem) => normalized.includes(stem)),
  );
}

export interface CompiledDossier {
  body: string;
  truncated: boolean;
  /** Section labels omitted (age policy, size pressure, or the financial rule). */
  droppedSections: string[];
  /** False when the body didn't parse into known sections (head-slice fallback). */
  sectioned: boolean;
}

export interface CompileDossierOptions {
  ageDays: number;
  volatileMaxAgeDays: number;
  targetChars?: number;
  hardCapChars?: number;
}

export function compileDossierForPrompt(
  raw: string,
  options: CompileDossierOptions,
): CompiledDossier {
  const targetChars = options.targetChars ?? FAN_PROFILE_TARGET_CHARS;
  const hardCapChars = options.hardCapChars ?? FAN_PROFILE_HARD_CAP_CHARS;
  const trimmedRaw = raw.trim();

  const lines = trimmedRaw.split(/\r?\n/);
  const parsed: Array<{ def: DossierSectionDef | null; lines: string[] }> = [
    { def: null, lines: [] },
  ];
  for (const line of lines) {
    const heading = matchSectionHeading(line);
    if (heading) {
      parsed.push({ def: heading, lines: [line] });
    } else {
      parsed[parsed.length - 1]!.lines.push(line);
    }
  }
  const sections = parsed.filter(
    (entry) => entry.def !== null && entry.lines.join("\n").trim().length > 0,
  ) as Array<{ def: DossierSectionDef; lines: string[] }>;

  if (sections.length === 0) {
    // Unknown shape (hand-written or a future template): bounded head, never
    // the full body — the tail-heavy sections we'd want are unidentifiable.
    const truncated = trimmedRaw.length > targetChars;
    return {
      body: truncated ? trimmedRaw.slice(0, targetChars) + TRUNCATION_MARKER : trimmedRaw,
      truncated,
      droppedSections: [],
      sectioned: false,
    };
  }

  const dropped = new Set<string>();
  const volatileStale = options.ageDays > options.volatileMaxAgeDays;
  let kept = sections.filter(({ def }) => {
    const drop = def.kind === "dropped" || (def.kind === "volatile" && volatileStale);
    if (drop) {
      dropped.add(def.label);
    }
    return !drop;
  });

  const preamble = parsed[0]!.lines.join("\n").trim();
  const assemble = (entries: typeof kept): string => {
    const parts = entries.map((entry) => entry.lines.join("\n").trim());
    return [preamble, ...parts].filter((part) => part.length > 0).join("\n\n");
  };

  // Size pressure: drop whole sections (highest keepPriority first) before
  // resorting to a mid-section cut.
  let body = assemble(kept);
  while (body.length > targetChars && kept.length > 1) {
    const dropIndex = kept.reduce(
      (worst, entry, index) =>
        entry.def.keepPriority > kept[worst]!.def.keepPriority ? index : worst,
      0,
    );
    dropped.add(kept[dropIndex]!.def.label);
    kept = kept.filter((_, index) => index !== dropIndex);
    body = assemble(kept);
  }

  // A single oversized section survives whole up to the hard cap — a mid-text
  // cut loses more meaning than a few thousand extra chars cost.
  let truncated = false;
  if (body.length > hardCapChars) {
    body = body.slice(0, hardCapChars) + TRUNCATION_MARKER;
    truncated = true;
  }

  return {
    body,
    truncated,
    droppedSections: [...dropped],
    sectioned: true,
  };
}

/** Runtime allowlist (chatMuseAiFanProfileContextFeatures): "all" trusts the
 * per-feature policy flag, "none"/empty is the off/rollback switch, anything
 * else is a CSV of feature keys for staged rollout. An absent value means OFF
 * — matching the registry default, so a config path that loses the field can
 * never silently enable the feature. */
export function isFanProfileFeatureEnabled(
  allowlist: string | undefined,
  feature: string,
): boolean {
  const normalized = (allowlist ?? "none").trim().toLowerCase();
  if (normalized === "all") {
    return true;
  }
  if (normalized === "none" || normalized.length === 0) {
    return false;
  }
  return normalized
    .split(",")
    .map((entry) => entry.trim())
    .includes(feature);
}

export interface FanProfilePromptContext {
  /** Compiled, prompt-ready (but unescaped) dossier body. */
  body: string;
  version: number;
  /** createdAt of the latest profile version. */
  generatedAt: Date;
  ageDays: number;
  truncated: boolean;
  droppedSections: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Latest stored dossier for the fan on this page, or undefined when there is
 * nothing safe to inject (unknown fan, deleted fan, no profile, empty body).
 * Fan resolution mirrors the other context loaders: fans are unique on
 * (platform, platform_user_id) — R3-2 — and the profile read itself is
 * page-scoped, so no page-membership join is needed. */
export async function loadFanProfileContext(
  app: Db,
  input: {
    pageId: number;
    fanRef: string;
    platform: "fansly" | "onlyfans";
    volatileMaxAgeDays: number;
    now: number;
  },
): Promise<FanProfilePromptContext | undefined> {
  const fan = await findPlatformFan(app.db, input.platform, input.fanRef);
  if (!fan || fan.deletedDetectedAt !== null) {
    return undefined;
  }

  const profile = await getLatestFanProfile(app.db, {
    fanId: fan.id,
    platformAccountId: input.pageId,
  });
  if (!profile || profile.body.trim().length === 0) {
    return undefined;
  }

  // sourceGeneratedAt is when the Scan actually RAN; createdAt is only the
  // hub append time (a delayed client re-push must not zero the age).
  const generatedAt = profile.sourceGeneratedAt ?? profile.createdAt;
  const ageDays = Math.max(0, Math.floor((input.now - generatedAt.getTime()) / DAY_MS));
  const compiled = compileDossierForPrompt(profile.body, {
    ageDays,
    volatileMaxAgeDays: input.volatileMaxAgeDays,
  });
  if (compiled.body.length === 0) {
    return undefined;
  }

  return {
    body: compiled.body,
    version: profile.version,
    generatedAt,
    ageDays,
    truncated: compiled.truncated,
    droppedSections: compiled.droppedSections,
  };
}
