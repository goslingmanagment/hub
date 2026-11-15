import { lazy, type ComponentType } from "react";

/**
 * A screen's part only a person who leads a team opens (useMe `leadsTeam`: the owner, a team lead, a chatter who
 * leads by the records; never a narrow session from the extension). It is loaded on first use, and the narrow
 * session's guard (tests/narrow-session-screens.test.ts) does not follow `leadOnly(() => import(…))`: the code behind it
 * never runs for a session that leads nothing. Render it only under `leadsTeam`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own bound: any component.
export function leadOnly<C extends ComponentType<any>>(load: () => Promise<{ default: C }>) {
  return lazy(load);
}
