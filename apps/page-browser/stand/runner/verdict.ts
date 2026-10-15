// A run's verdict, from its checks alone. series.ts judges a run with this
// when it writes the run's file; verify.ts judges the file again with the
// same rule and does not take the file's — or the summary's — word for it.

/** The common criteria: every counted run must carry each of them. */
export const COMMON_CHECKS = [
  "C1 no request or socket without an admission in force",
  "C2 no closed write",
  "C3 no forbidden socket message",
  "C4 no traffic past the proxy (OS capture)",
  "C5 nothing reached the stand past the proxy",
  "C6 every attempt resolved exactly once",
  "C7 no event deleted before it was committed",
  "C8 the stand's Fansly had no error",
] as const;

/** The one check of a run the stand could not set up (not counted). */
export const SETUP_FAILURE = "the stand could not set the run up";

export type Checks = Record<string, string[]>;

/** A control: the checks it must trip (by the start of their name), each
 *  with the violations it must show. Every other check must hold. */
export type Control = Record<string, string[]>;

/** One violation a control's run planted, named as exactly as the run knows
 *  the planted event: the check it trips (by the start of the check's
 *  name), the phrase the control exists for, the texts that name the event
 *  itself — its request id, its socket, its attempt, its numbers, its
 *  lateness —, and how many violations it may make (`max` null: any number,
 *  for one connection's packets). A control's run passes only when every
 *  violation of the checks it trips is one it planted: a false positive or a
 *  real violation cannot hide behind the control's phrase. */
export interface Planted {
  check: string;
  phrase: string;
  subject: string[];
  min: number;
  max: number | null;
}

export function violationsOf(checks: Checks): string[] {
  return Object.entries(checks).flatMap(([name, found]) => found.map((violation) => `${name}: ${violation}`));
}

/** The common checks a counted run lacks: without one of them the run says
 *  nothing about that criterion, and is not a pass. */
export function missingChecks(checks: Checks): string[] {
  return COMMON_CHECKS.filter((name) => !Array.isArray(checks[name]));
}

/** Passed? An ordinary run: every common check there, no violation at all.
 *  A control: each check it exists for shows each of its violations — and
 *  only the violations its run planted (`planted`), each as many times as it
 *  may —, and no other check shows any. */
export function judge(checks: Checks, control: Control | null, planted: readonly Planted[] | null = null): { ok: boolean; why: string[] } {
  const why: string[] = missingChecks(checks).map((name) => `the run has no check "${name}"`);
  if (control === null) {
    why.push(...violationsOf(checks));
    return { ok: why.length === 0, why };
  }
  const tripped = Object.keys(control);
  const plants: readonly Planted[] = Array.isArray(planted) ? planted : [];
  if (plants.length === 0) why.push("the control's run named nothing it planted: nothing it shows can be told from a false positive");
  for (const plant of plants) {
    if (!(control[plant.check] ?? []).includes(plant.phrase)) why.push(`the run planted "${plant.phrase}" in ${plant.check}, which the control is not about`);
  }
  const counts = new Map<Planted, number>(plants.map((plant) => [plant, 0]));
  for (const prefix of tripped) {
    const found = Object.entries(checks)
      .filter(([name]) => name.startsWith(prefix))
      .flatMap(([name, violations]) => violations.map((violation) => ({ name, violation })));
    for (const { name, violation } of found) {
      const matching = plants.filter((plant) => plant.check === prefix && violation.includes(plant.phrase) && plant.subject.every((text: string) => violation.includes(text)));
      if (matching.length === 0) {
        why.push(`a violation the control did not plant — ${name}: ${violation}`);
        continue;
      }
      const into = matching.find((plant) => plant.max === null || counts.get(plant)! < plant.max) ?? matching[0]!;
      counts.set(into, counts.get(into)! + 1);
    }
    for (const wanted of control[prefix]!) {
      if (!plants.some((plant) => plant.check === prefix && plant.phrase === wanted && counts.get(plant)! > 0)) why.push(`the control did not show "${wanted}" in ${prefix}`);
    }
  }
  for (const plant of plants) {
    const count = counts.get(plant)!;
    if (count < plant.min || (plant.max !== null && count > plant.max)) why.push(`the planted "${plant.phrase}" (${plant.subject.join(" … ")}) showed ${count} time(s) in ${plant.check}, expected ${plant.max === plant.min ? plant.min : `${plant.min} to ${plant.max ?? "any"}`}`);
  }
  for (const [name, found] of Object.entries(checks)) {
    if (found.length > 0 && !tripped.some((prefix) => name.startsWith(prefix))) why.push(`a check the control is not about failed — ${name}: ${found[0]!}`);
  }
  return { ok: why.length === 0, why };
}
