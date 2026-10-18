// What the operator tells Hub of itself for audits (protocol minor 5):
//
// - a transition's note goes to Hub (`browser.transition`): it is scrubbed as
//   every journal line is (shared/secrets.ts), every IP address in it is
//   masked (egress/ip-mask.ts) — an exit IP, the proxy's — and it is cut to
//   its limit;
// - Chrome's crash dumps on the profile (Crashpad's `completed` and `pending`)
//   are counted by root before Chrome starts and once it exited
//   (s6/scripts/crash-dumps: the profile is Chrome's user's alone), into a
//   small JSON file the operator reads — how many and the newest one's time,
//   never a dump: they hold the session's memory.

import { readFileSync } from "node:fs";

import { maskIps } from "../egress/ip-mask.ts";
import { TRANSITION_NOTE_MAX, type CrashDumpCount, type State } from "../rpc/protocol.ts";
import { scrub } from "../shared/secrets.ts";

/** A transition's note as it goes to Hub: scrubbed, its IPs masked, cut. */
export function transitionNote(note: string): string {
  const masked = maskIps(scrub(note));
  return masked.length <= TRANSITION_NOTE_MAX ? masked : `${masked.slice(0, TRANSITION_NOTE_MAX - 1)}…`;
}

/** Where root writes the count (s6/scripts/crash-dumps). */
export const CRASH_DUMPS_PATH = "/run/pb/crash-dumps.json";

function countOf(value: unknown): CrashDumpCount | null {
  if (value === null || typeof value !== "object") return null;
  const { count, newestAtWall } = value as { count?: unknown; newestAtWall?: unknown };
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  if (newestAtWall !== null && (typeof newestAtWall !== "number" || !Number.isSafeInteger(newestAtWall) || newestAtWall < 0)) return null;
  return { count, newestAtWall: count === 0 ? null : newestAtWall };
}

/** The count as root last wrote it; null: none written, unreadable, or not
 *  the shape it is written in. */
export function readCrashDumps(path: string): NonNullable<State["crashDumps"]> | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, 4096));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { countedAtWall, completed, pending } = value as { countedAtWall?: unknown; completed?: unknown; pending?: unknown };
  if (typeof countedAtWall !== "number" || !Number.isSafeInteger(countedAtWall) || countedAtWall <= 0) return null;
  const done = countOf(completed);
  const waiting = countOf(pending);
  if (done === null || waiting === null) return null;
  return { completed: done, pending: waiting, countedAtWall };
}
