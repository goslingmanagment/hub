import { errorResponseSchema } from "./primitives.ts";
import {
  agentSystemCopiesBodySchema,
  agentSystemReportResponseSchema,
  agentSystemRoutinesBodySchema,
  systemStateResponseSchema,
} from "./system-state.ts";

// «Состояние» (ecosystem plan, package P). A reporter's agent key with
// write:system_state sends its whole list of routines or copies; the owner's
// session reads the state of everything with Hub's own facts beside it.
// Database only, and the ledger's own health read GET-only.

const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema,
  // routine_other_reporter: a key another reporter keeps
  409: errorResponseSchema, 429: errorResponseSchema,
} as const;

export const systemStateRouteSchemas = {
  systemState: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Система → Состояние: Hub's own health, every routine of the server, the Mac and the PC, every copy",
    description: "Database only. A routine is judged now: silent (no run for twice its period and ten minutes), failing "
      + "(two failed runs in a row), empty input past its reporter's threshold, and so on; a place whose reporter is "
      + "silent is `unchecked`, never green and never red.",
    response: { 200: systemStateResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
  },
  agentSystemRoutines: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "A reporter's whole list of routines: when each last ran, last did its work, what its last run came to"
      + " (needs write:system_state)",
    description: "Database only. A routine of this reporter it no longer sends is retired (kept, no longer watched). "
      + "A key another reporter keeps is 409 `routine_other_reporter`.",
    body: agentSystemRoutinesBodySchema,
    response: { 200: agentSystemReportResponseSchema, ...agentErrors },
  },
  agentSystemCopies: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "A reporter's whole list of copies: what, from where to where, when the newest was taken, its size, how many"
      + " are kept (needs write:system_state)",
    body: agentSystemCopiesBodySchema,
    response: { 200: agentSystemReportResponseSchema, ...agentErrors },
  },
} as const;
