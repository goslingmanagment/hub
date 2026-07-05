import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { PgBoss } from "pg-boss";

import type { RequestAuth } from "../api/request-auth.ts";
import type { AppContext } from "../bootstrap.ts";

type AppLogger = NonNullable<AppContext["logger"]>;

// Kernel Stage 19: what buildApiServer (the composition root) hands each
// bounded-context module. Handlers moved out of server.ts verbatim keep calling
// the same helper names via destructuring — behavior change zero by
// construction. Authorization itself is the declarative middleware in server.ts
// (route `auth` blocks); the in-handler guards these modules carry are the
// legacy layer that dies in the post-enforce-flip cleanup slice, not here.

export type ApiServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  AppLogger,
  ZodTypeProvider
>;

export interface ApiModuleContext {
  appContext: AppContext;
  auth: RequestAuth;
  /** Job-queue handle; null when the API boots without a database (contract generation). */
  boss: PgBoss | null;
}
