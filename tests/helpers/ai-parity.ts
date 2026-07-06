import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Stage 30 Task 5 — the parity harness core. The passport rule: compare
// ASSEMBLED PROMPTS, not model outputs. The desktop's live builder is
// imported straight from the sibling checkout (the freeze makes that a
// stable reference); the kernel's migrated builder must produce
// byte-identical PromptPayloads for identical fixture inputs.

export const DESKTOP_ROOT = "/Users/dmitriy/code/chatgoose_desktop_fable";
export const FROZEN_DESKTOP_COMMIT = "1db76a4ae13dd1cb4180f73b854426d490fd3f7c";
const DESKTOP_SHARED_SRC = join(DESKTOP_ROOT, "packages", "shared", "src");
const KERNEL_PROMPTS_ROOT = join(
  HERE, "..", "..", "apps", "runtime", "src", "modules", "ai", "prompts",
);

export function desktopRepoPresent(): boolean {
  return existsSync(join(DESKTOP_SHARED_SRC, "prompts", "builder.ts"));
}

interface ManifestEntry {
  sourceSha256: string;
  coreSha256: string;
  byteIdenticalToSource: boolean;
}

export interface ManifestCheckResult {
  file: string;
  ok: boolean;
  detail: string;
}

/** The freeze check: every migrated file's SOURCE must still hash to the
 * snapshot value — a mismatch means prompt tuning happened in the desktop
 * repo after the freeze (or a re-snapshot is due). */
export function checkManifestAgainstSources(): ManifestCheckResult[] {
  const manifest = JSON.parse(
    readFileSync(join(KERNEL_PROMPTS_ROOT, "prompt-manifest.json"), "utf8"),
  ) as { files: Record<string, ManifestEntry> };

  const sourcePathFor = (rel: string): string => {
    if (rel === "types.ts") {
      return join(DESKTOP_SHARED_SRC, "types.ts");
    }
    if (rel === "feature-policies.ts") {
      return join(DESKTOP_SHARED_SRC, "features.ts");
    }
    if (rel.startsWith("templates/")) {
      return join(DESKTOP_SHARED_SRC, "prompts", rel);
    }
    if (rel.startsWith("output/") || rel.startsWith("transcript/") || rel.startsWith("context/")) {
      return join(DESKTOP_SHARED_SRC, rel);
    }
    return join(DESKTOP_SHARED_SRC, "prompts", rel);
  };

  return Object.entries(manifest.files).map(([rel, entry]) => {
    const sourcePath = sourcePathFor(rel);
    if (!existsSync(sourcePath)) {
      return { file: rel, ok: false, detail: `source missing: ${sourcePath}` };
    }
    const digest = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    return digest === entry.sourceSha256
      ? { file: rel, ok: true, detail: "frozen" }
      : { file: rel, ok: false, detail: "SOURCE CHANGED since snapshot (freeze violation or re-snapshot due)" };
  });
}

// ---------------------------------------------------------------------------
// Fixture inputs — one per feature, exercising that feature's policy branches.

const FIXTURE_PERSONALITY = {
  id: "parity-persona",
  name: "Parity Persona",
  content: "## Who you are\nYou are the parity fixture persona. Keep replies warm and short.",
  updatedAt: 1_751_000_000_000,
};

const FIXTURE_TRANSCRIPT = [
  "[10:00] Fan: hey babe, missed you",
  "[10:05] Model: hey you 😘 where have you been",
  "[10:10] Fan: [Tip: $5.00] sent you a little something",
  "[10:12] Fan: [PPV $15.00, purchased] that was so worth it",
].join("\n");

const FIXTURE_SPENDING = [
  "<fan_spending_data>",
  "Total spent: $120.00 (subscriptions $30.00, tips $40.00, messages $50.00)",
  "</fan_spending_data>",
].join("\n");

const FIXTURE_SUBSCRIPTION = [
  "<fan_subscription_data>",
  "Subscribed: yes (since 2026-06-01, renews)",
  "</fan_subscription_data>",
].join("\n");

export interface ParityFixture {
  feature: string;
  input: Record<string, unknown>;
}

export function buildParityFixtures(): ParityFixture[] {
  const base = {
    personality: FIXTURE_PERSONALITY,
    transcript: FIXTURE_TRANSCRIPT,
    fanSpendingData: FIXTURE_SPENDING,
    fanSubscriptionData: FIXTURE_SUBSCRIPTION,
    fanDisplayName: "Big Spender",
  };
  return [
    { feature: "fast-reply", input: { ...base, feature: "fast-reply", replyTone: "flirty", replyMode: "preferSplit" } },
    { feature: "fast-reply (default tone)", input: { ...base, feature: "fast-reply" } },
    { feature: "improve-draft", input: { ...base, feature: "improve-draft", draftText: "hey love, wanna see more? xx" } },
    { feature: "help-me", input: { ...base, feature: "help-me" } },
    { feature: "fan-summary", input: { ...base, feature: "fan-summary" } },
    { feature: "chat-review", input: { ...base, feature: "chat-review" } },
    { feature: "ping (segment-a)", input: { ...base, feature: "ping", pingSegment: "segment-a" } },
    { feature: "ping (active)", input: { ...base, feature: "ping", pingSegment: "active" } },
    { feature: "hi-greeting", input: { ...base, feature: "hi-greeting", fanBio: "into gym and anime, from Texas" } },
  ];
}

export interface ParityComparison {
  fixture: string;
  equal: boolean;
  firstDifference: string | null;
}

type BuildPromptFn = (input: Record<string, unknown>) => unknown;

export async function loadDesktopBuildPrompt(): Promise<BuildPromptFn> {
  const module = await import(join(DESKTOP_SHARED_SRC, "prompts", "builder.ts")) as {
    buildPrompt: BuildPromptFn;
  };
  return module.buildPrompt;
}

export async function loadKernelBuildPrompt(): Promise<BuildPromptFn> {
  const module = await import(
    join(KERNEL_PROMPTS_ROOT, "builder.ts")
  ) as { buildPrompt: BuildPromptFn };
  return module.buildPrompt;
}

function firstDiff(left: string, right: string): string {
  const max = Math.min(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (left[index] !== right[index]) {
      return `at char ${index}: kernel ${JSON.stringify(left.slice(index, index + 60))} vs desktop ${JSON.stringify(right.slice(index, index + 60))}`;
    }
  }
  return `length differs: kernel ${left.length} vs desktop ${right.length}`;
}

export async function compareAssembledPrompts(): Promise<ParityComparison[]> {
  const desktopBuild = await loadDesktopBuildPrompt();
  const kernelBuild = await loadKernelBuildPrompt();
  return buildParityFixtures().map((fixture) => {
    const kernel = JSON.stringify(kernelBuild(fixture.input), null, 1);
    const desktop = JSON.stringify(desktopBuild(fixture.input), null, 1);
    return {
      fixture: fixture.feature,
      equal: kernel === desktop,
      firstDifference: kernel === desktop ? null : firstDiff(kernel, desktop),
    };
  });
}
