import {
  accountChatterStatsQuerySchema,
  chatterStatsSchema,
  teamChatterStatsQuerySchema,
  teamChatterStatsResponseSchema,
} from "./chatter-stats.ts";
import { errorResponseSchema } from "./primitives.ts";

// A chatter's statistics (chatter-stats.ts): their own in the cabinet, and a
// chatter's for the owner and team leads. Read-only and database only.

const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema } as const;

export const chatterStatsRouteSchemas = {
  accountChatterStats: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "The caller's own statistics: the money of their shifts, how they write and sell, their records",
    description: "The chatter's cabinet; read-only, database only. Shifts are the caller's actual shifts (by the chat "
      + "extension) that began in the last `days` Moscow days, on the pages they work now; a shift's money is the net of "
      + "the sales on a page they had open during it. A guide, not a basis for pay.",
    querystring: accountChatterStatsQuerySchema,
    response: { 200: chatterStatsSchema, ...errors },
  },
  teamChatterStats: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "A chatter's statistics, as their cabinet shows them, for the owner and team leads",
    description: "Read-only, database only. `people` — the chatters active on the viewer's pages lately; `stats` — the "
      + "chosen one's (`userId`, else the first) on their pages the viewer reaches. A guide, not a basis for pay.",
    querystring: teamChatterStatsQuerySchema,
    response: { 200: teamChatterStatsResponseSchema, ...errors },
  },
} as const;
