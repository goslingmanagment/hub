// The page's time zone and languages, handed to Chrome's start (plan §3.1
// "Запуск Chrome", §4.1 step 2). On Linux Chrome takes its time zone from
// TZ and its UI language and navigator.language(s) from LANGUAGE/LANG of its
// process and the ForcedLanguages policy, not from --lang (stage 1,
// amendment 10). Chrome runs as pb-chrome, started by s6 through a run
// script that is root until s6-setuidgid; the operator, pb-operator, can set
// neither another service's environment nor Chrome's policies. So:
//
// 1. the operator writes the page's environment here, in its own directory
//    (/run/pb/operator, pb-operator's alone), whole or not at all (a
//    temporary file renamed over), before it starts Chrome — every start;
// 2. Chrome's run script (s6-rc.d/chrome/run), as root, reads it as
//    pb-operator — a link to a file only root may read reads nothing —,
//    checks every value again by the rules of env/rules.ts, writes the page
//    policy (ForcedLanguages) next to hub.json from the checked tags only,
//    and starts Chrome with TZ, LANGUAGE and LANG. A value that fails there
//    stops Chrome's start (and is never printed): the operator sees no
//    DevTools connection and the start fails.
//
// The file has exactly two lines:
//
//   TZ=<zone>
//   LANGUAGES=<tag>,<tag>,…
//
// Before the engine's first hello there is none (init-net removes what a
// previous run left), and the script takes the container's defaults
// (PB_TZ, PB_LANG). The position does not go here: the operator sets it
// over CDP in every page target (cdp/control.ts).

import { renameSync, rmSync, writeFileSync } from "node:fs";

import { LANGUAGES_SYNTAX, validateEnv, type PageEnv } from "./rules.ts";

export const HANDOVER_PATH = "/run/pb/operator/chrome-env";

/** The file's text, of a checked environment. */
export function handoverText(env: PageEnv): string {
  const checked = validateEnv(env);
  const languages = checked.languages.join(",");
  // validateEnv's tags make this list; the script expects nothing else.
  if (!new RegExp(LANGUAGES_SYNTAX).test(languages)) throw new Error("the languages do not make a hand-over list");
  return `TZ=${checked.timeZone}\nLANGUAGES=${languages}\n`;
}

/** Writes the hand-over for Chrome's next start: all of it, or nothing. */
export function writeHandover(path: string, env: PageEnv): void {
  const text = handoverText(env);
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
