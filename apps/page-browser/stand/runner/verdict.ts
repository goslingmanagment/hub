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

export function violationsOf(checks: Checks): string[] {
  return Object.entries(checks).flatMap(([name, found]) => found.map((violation) => `${name}: ${violation}`));
}

/** The common checks a counted run lacks: without one of them the run says
 *  nothing about that criterion, and is not a pass. */
export function missingChecks(checks: Checks): string[] {
  return COMMON_CHECKS.filter((name) => !Array.isArray(checks[name]));
}

/** Passed? An ordinary run: every common check there, no violation at all.
 *  A control: each check it exists for shows each of its violations, and no
 *  other check shows any. */
export function judge(checks: Checks, control: Control | null): { ok: boolean; why: string[] } {
  const why: string[] = missingChecks(checks).map((name) => `the run has no check "${name}"`);
  if (control === null) {
    why.push(...violationsOf(checks));
    return { ok: why.length === 0, why };
  }
  const tripped = Object.keys(control);
  for (const prefix of tripped) {
    const found = Object.entries(checks)
      .filter(([name]) => name.startsWith(prefix))
      .flatMap(([, violations]) => violations);
    for (const wanted of control[prefix]!) {
      if (!found.some((violation) => violation.includes(wanted))) why.push(`the control did not show "${wanted}" in ${prefix}`);
    }
  }
  for (const [name, found] of Object.entries(checks)) {
    if (found.length > 0 && !tripped.some((prefix) => name.startsWith(prefix))) why.push(`a check the control is not about failed — ${name}: ${found[0]!}`);
  }
  return { ok: why.length === 0, why };
}
