import { findUserByUsername } from "@agency_hub_core/db";
import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";

/** Resolve a seeded fixture before exercising the ID-only admin contract.
 * Deletion/reuse regressions must retain the original returned ID instead. */
export async function fixtureUserId(app: Pick<AppContext, "db"> | null, username: string) {
  if (!app) throw new Error("User fixture requires an initialized app");
  const user = await findUserByUsername(app.db, username);
  if (!user) throw new Error(`Missing user fixture: ${username}`);
  return user.id;
}
