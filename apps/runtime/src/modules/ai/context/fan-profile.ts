import { findPlatformFan, getLatestPromptEligibleFanProfile } from "@agency_hub_core/db";

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

/** The lite dossier's whole budget (fast-reply; Lora persona audit,
 * 2026-10-16): target and hard cap at once. */
export const FAN_PROFILE_LITE_MAX_CHARS = 5_000;
/** Under size pressure the lite dossier never drops OPEN LOOPS (they feed the
 * reply's callbacks); it cuts a longer one down to this, at a line boundary. */
export const FAN_PROFILE_LITE_LOOPS_MAX_CHARS = 1_500;

/** Ends a lite section that was cut at a line boundary. */
const SECTION_CUT_MARKER = "\n[section truncated]";

/** Features that read the lite dossier: a quick reply and a Ping need the fan's
 * facts, how he talks and what is still open (a Ping's callback to a silent fan
 * often lies past its window); the portrait, stage and strategy are the
 * chatter's analysis of him, not material for the model's next text. */
const LITE_DOSSIER_FEATURES: ReadonlySet<string> = new Set(["fast-reply", "ping"]);

export function usesLiteDossier(feature: string): boolean {
  return LITE_DOSSIER_FEATURES.has(feature);
}

/** The section vocabulary of the fan-summary template (templates/fan-summary.md
 * "## Sections"). The template instructs "Write in Russian", so PRODUCTION
 * dossiers carry Russian headings in the dashboard-pinned markdown shape
 * (`## 1. ДОСЬЕ` — see apps/dashboard/src/lib/parseFanProfile.ts and
 * tests/parseFanProfile.test.ts); English names cover the template's own
 * vocabulary and legacy bodies. `stems` catch translation variance, but only
 * on markdown `#` heading lines — prose or list bullets never stem-match.
 * `keepPriority` orders size-pressure drops (higher = dropped first). `kind`
 * only distinguishes FINANCIAL PROFILE, which is ALWAYS dropped: fresh
 * spending/subscription data rides its own prompt sections, so an aged
 * financial snapshot would only duplicate and contradict the live numbers. The
 * `volatile` label is retained for documentation — those sections (stage, open
 * loops, strategy) are NOT age-dropped: the prompt already stamps the dossier's
 * generation date and marks it possibly-stale-history, so the model weighs
 * their age rather than losing the context outright.
 * `lite` marks the sections the lite dossier keeps (facts, communication
 * dynamics, open loops); it drops the portrait, stage and strategy as well as
 * the financial profile. */
const DOSSIER_SECTIONS = [
  {
    label: "DOSSIER",
    lite: true,
    kind: "stable",
    keepPriority: 0,
    aliases: ["DOSSIER", "ДОСЬЕ"],
    stems: ["DOSSIER", "ДОСЬЕ"],
  },
  {
    label: "PSYCHOLOGICAL PORTRAIT",
    lite: false,
    kind: "stable",
    keepPriority: 4,
    aliases: ["PSYCHOLOGICAL PORTRAIT", "ПСИХОЛОГИЧЕСКИЙ ПОРТРЕТ", "ПОРТРЕТ"],
    stems: ["PORTRAIT", "ПОРТРЕТ"],
  },
  {
    label: "STAGE AND TRAJECTORY",
    lite: false,
    kind: "volatile",
    keepPriority: 5,
    aliases: ["STAGE AND TRAJECTORY", "СТАДИЯ И ТРАЕКТОРИЯ", "ЭТАП И ТРАЕКТОРИЯ"],
    stems: ["STAGE", "TRAJECTOR", "СТАДИ", "ЭТАП", "ТРАЕКТОР"],
  },
  {
    label: "COMMUNICATION DYNAMICS",
    lite: true,
    kind: "stable",
    keepPriority: 1,
    aliases: ["COMMUNICATION DYNAMICS", "ДИНАМИКА ОБЩЕНИЯ", "КОММУНИКАЦИОННАЯ ДИНАМИКА"],
    stems: ["COMMUNICATION", "DYNAMIC", "КОММУНИК", "ОБЩЕНИ", "ДИНАМИК"],
  },
  {
    label: "FINANCIAL PROFILE",
    lite: false,
    kind: "dropped",
    keepPriority: 6,
    aliases: ["FINANCIAL PROFILE", "ФИНАНСОВЫЙ ПРОФИЛЬ"],
    stems: ["FINANC", "ФИНАНС"],
  },
  {
    label: "OPEN LOOPS",
    lite: true,
    kind: "volatile",
    keepPriority: 2,
    aliases: ["OPEN LOOPS", "ОТКРЫТЫЕ ПЕТЛИ", "НЕЗАКРЫТЫЕ ТЕМЫ", "ОТКРЫТЫЕ ВОПРОСЫ"],
    stems: ["LOOP", "ПЕТЛ", "НЕЗАКРЫТ"],
  },
  {
    label: "STRATEGY",
    lite: false,
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
  /** Section labels omitted (the financial rule or size pressure). */
  droppedSections: string[];
  /** False when the body didn't parse into known sections (head-slice fallback). */
  sectioned: boolean;
}

export interface CompileDossierOptions {
  targetChars?: number;
  hardCapChars?: number;
  /** The lite dossier (see usesLiteDossier): only the `lite` sections under
   * their own size policy (compileLiteSections), both budgets default to
   * FAN_PROFILE_LITE_MAX_CHARS, and every markdown heading of the body is
   * demoted below the prompt's own `##` level. */
  lite?: boolean;
}

/** Shift every markdown heading of a dossier body two levels down (H1 -> H3,
 * H2 -> H4, deeper ones down to H6), so no line of the injected body reads as a
 * `#` or `##` heading at the prompt's own level while the section hierarchy is
 * kept. Lines without the ATX heading form are untouched. */
export function demoteDossierHeadings(text: string): string {
  return text.replace(/^([ \t]*)(#{1,6})(?=\s)/gm, (_match, indent: string, hashes: string) =>
    indent + "#".repeat(Math.min(6, hashes.length + 2)),
  );
}

/** The longest head of `text` of at most `maxChars` UTF-16 units that never
 * splits a code point (an emoji stays whole). */
function headOnCodePoints(text: string, maxChars: number): string {
  let head = "";
  for (const codePoint of text) {
    if (head.length + codePoint.length > maxChars) {
      break;
    }
    head += codePoint;
  }
  return head;
}

/** Head-cut on a code point boundary, preferring the last line break in the
 * second half of the budget so a bullet is not cut mid-sentence. */
function cutLiteBody(body: string, maxChars: number): string {
  const head = headOnCodePoints(body, maxChars);
  const lineBreak = head.lastIndexOf("\n");
  return (lineBreak > maxChars / 2 ? head.slice(0, lineBreak) : head).trimEnd();
}

/** Cut one lite section to at most `maxChars`, marker included, at the last
 * line boundary that fits (its heading line always stays when it fits). Null
 * when not even the marker fits. */
function cutSectionAtLine(text: string, maxChars: number): string | null {
  const room = maxChars - SECTION_CUT_MARKER.length;
  if (room <= 0) {
    return null;
  }
  const head = headOnCodePoints(text, room);
  const lineBreak = head.lastIndexOf("\n");
  return (lineBreak > 0 ? head.slice(0, lineBreak) : head).trimEnd() + SECTION_CUT_MARKER;
}

/** The lite dossier's size policy (Lora persona audit, 2026-10-16). Over the
 * budget it first drops COMMUNICATION DYNAMICS; still over, it cuts OPEN LOOPS
 * down to FAN_PROFILE_LITE_LOOPS_MAX_CHARS and then cuts the facts (DOSSIER) at
 * a line boundary to fit. OPEN LOOPS is never dropped. The kept sections keep
 * their order. Only a preamble too long for the budget ever reaches the final
 * whole-body cut. */
function compileLiteSections(
  preamble: string,
  sections: ReadonlyArray<{ label: string; text: string }>,
  budget: number,
  hardCapChars: number,
  dropped: Set<string>,
): { body: string; truncated: boolean } {
  let parts = sections.map((section) => ({ ...section }));
  const join = (): string =>
    [preamble, ...parts.map((part) => part.text)].filter((part) => part.length > 0).join("\n\n");
  let truncated = false;

  if (join().length > budget && parts.some((part) => part.label === "COMMUNICATION DYNAMICS")) {
    parts = parts.filter((part) => part.label !== "COMMUNICATION DYNAMICS");
    dropped.add("COMMUNICATION DYNAMICS");
  }
  if (join().length > budget) {
    for (const part of parts) {
      if (part.label === "OPEN LOOPS" && part.text.length > FAN_PROFILE_LITE_LOOPS_MAX_CHARS) {
        part.text = cutSectionAtLine(part.text, FAN_PROFILE_LITE_LOOPS_MAX_CHARS)!;
        truncated = true;
      }
    }
  }
  // The facts take the cut that is left, the last facts section first.
  for (let index = parts.length - 1; index >= 0 && join().length > budget; index -= 1) {
    const part = parts[index]!;
    if (part.label !== "DOSSIER") {
      continue;
    }
    const cut = cutSectionAtLine(part.text, part.text.length - (join().length - budget));
    if (cut === null) {
      parts.splice(index, 1);
      dropped.add("DOSSIER");
    } else {
      part.text = cut;
    }
    truncated = true;
  }

  let body = join();
  if (body.length > hardCapChars) {
    body = cutLiteBody(body, hardCapChars) + TRUNCATION_MARKER;
    truncated = true;
  }
  return { body, truncated };
}

export function compileDossierForPrompt(
  raw: string,
  options: CompileDossierOptions = {},
): CompiledDossier {
  const lite = options.lite === true;
  const targetChars =
    options.targetChars ?? (lite ? FAN_PROFILE_LITE_MAX_CHARS : FAN_PROFILE_TARGET_CHARS);
  const hardCapChars =
    options.hardCapChars ?? (lite ? FAN_PROFILE_LITE_MAX_CHARS : FAN_PROFILE_HARD_CAP_CHARS);
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
    if (lite) {
      const demoted = demoteDossierHeadings(trimmedRaw);
      const truncated = demoted.length > targetChars;
      return {
        body: truncated ? cutLiteBody(demoted, targetChars) + TRUNCATION_MARKER : demoted,
        truncated,
        droppedSections: [],
        sectioned: false,
      };
    }
    const truncated = trimmedRaw.length > targetChars;
    return {
      body: truncated ? trimmedRaw.slice(0, targetChars) + TRUNCATION_MARKER : trimmedRaw,
      truncated,
      droppedSections: [],
      sectioned: false,
    };
  }

  const dropped = new Set<string>();
  // Only FINANCIAL PROFILE is dropped by rule (it duplicates the live spending
  // blocks); volatile sections are kept and the prompt marks them possibly-stale
  // by generation date. Everything else is subject only to size pressure below.
  // The lite dossier also drops every section outside its `lite` set.
  let kept = sections.filter(({ def }) => {
    const drop = def.kind === "dropped" || (lite && !def.lite);
    if (drop) {
      dropped.add(def.label);
    }
    return !drop;
  });

  if (lite) {
    // The lite body is measured as injected, demoted headings included.
    const compiled = compileLiteSections(
      demoteDossierHeadings(parsed[0]!.lines.join("\n").trim()),
      kept.map((entry) => ({
        label: entry.def.label,
        text: demoteDossierHeadings(entry.lines.join("\n").trim()),
      })),
      targetChars,
      hardCapChars,
      dropped,
    );
    return { ...compiled, droppedSections: [...dropped], sectioned: true };
  }

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
  /** The RAW stored dossier body, before compilation (P2-10). The coach recap
   * dedupe compares this against the raw recap completion: the compiler drops
   * the financial section and can shed others, so a compiled body almost never
   * stays byte-identical to the summary it came from — comparing raw-vs-raw is
   * what makes the dedupe fire on real sectioned dossiers. */
  rawBody: string;
  version: number;
  /** Core-recorded completion time of the full summary proving this body. */
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
    now: number;
    /** The generating feature: fast-reply and ping read the lite dossier
     * (usesLiteDossier); every other feature the full compile. */
    feature: string;
  },
): Promise<FanProfilePromptContext | undefined> {
  const fan = await findPlatformFan(app.db, input.platform, input.fanRef);
  if (!fan || fan.deletedDetectedAt !== null) {
    return undefined;
  }

  const profile = await getLatestPromptEligibleFanProfile(app.db, {
    fanId: fan.id,
    platformAccountId: input.pageId,
    platformUserId: fan.platformUserId,
  });
  if (!profile || profile.body.trim().length === 0) {
    return undefined;
  }

  // The proof row is Core's own successful full fan-summary terminal record.
  // Client sourceGeneratedAt and Hub append time are useful profile metadata,
  // but neither proves that the stored body was complete and non-exhausted.
  const generatedAt = profile.proofCreatedAt;
  const ageDays = Math.max(0, Math.floor((input.now - generatedAt.getTime()) / DAY_MS));
  const compiled = compileDossierForPrompt(profile.body, { lite: usesLiteDossier(input.feature) });
  if (compiled.body.length === 0) {
    return undefined;
  }

  return {
    body: compiled.body,
    rawBody: profile.body,
    version: profile.version,
    generatedAt,
    ageDays,
    truncated: compiled.truncated,
    droppedSections: compiled.droppedSections,
  };
}
