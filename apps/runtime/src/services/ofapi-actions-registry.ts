import {
  ofapiAccountActionOptions, ofapiActionSchema, ofapiCollectionActionOptions, ofapiCollectionActionSchema, ofapiPublishingActionOptions, ofapiPublishingAdmissionIssue,
  type OfapiAccountAction, type OfapiAction, type OfapiCollectionAction, type OfapiPublishingAction,
} from "@agency_hub_core/contracts";
import { ofapiAccountRequest, ofapiAccountResultConfirmed } from "./ofapi-actions-account.ts";
import { ofapiCollectionRequest, ofapiCollectionResultConfirmed } from "./ofapi-actions-collections.ts";
import { ofapiPublishingRequest, ofapiPublishingResultConfirmed } from "./ofapi-actions-publishing.ts";
import { asRecord, negativeReceipt } from "./ofapi-payloads.ts";
import type { OfapiActionRequest } from "./ofapi-actions-types.ts";

export type OfapiActionModule = "publishing" | "account" | "collection";

/** Every option schema is a strict object whose `action` is a literal; the literal is the discriminant this registry routes on. */
const actionNames = (options: readonly { shape: { action: { value: string } } }[]): ReadonlySet<string> => new Set(options.map(option => option.shape.action.value));

const MODULE_ACTIONS: Readonly<Record<OfapiActionModule, ReadonlySet<string>>> = {
  publishing: actionNames(ofapiPublishingActionOptions),
  account: actionNames(ofapiAccountActionOptions),
  collection: actionNames(ofapiCollectionActionOptions),
};

/**
 * The pin: the three modules PARTITION the OfapiAction union — no action name is
 * owned by two modules, none is orphaned, none is foreign to the union. Checked
 * once at module load (below) so a contract edit that breaks it cannot boot the
 * runtime; exported so a test can prove the check itself bites.
 */
export function assertOfapiActionModulesPartition(modules: Readonly<Record<OfapiActionModule, ReadonlySet<string>>>, union: ReadonlySet<string>): void {
  const owners = new Map<string, OfapiActionModule[]>();
  for (const [module, names] of Object.entries(modules) as [OfapiActionModule, ReadonlySet<string>][]) {
    for (const name of names) owners.set(name, [...(owners.get(name) ?? []), module]);
  }
  const shared = [...owners].filter(([, list]) => list.length > 1).map(([name, list]) => `${name} (${list.join(", ")})`);
  const orphaned = [...union].filter(name => !owners.has(name));
  const foreign = [...owners.keys()].filter(name => !union.has(name));
  if (shared.length || orphaned.length || foreign.length) {
    throw new Error(`OFAPI action modules do not partition the action union: shared=[${shared.join(", ")}] orphaned=[${orphaned.join(", ")}] foreign=[${foreign.join(", ")}]`);
  }
}
assertOfapiActionModulesPartition(MODULE_ACTIONS, actionNames(ofapiActionSchema.options));

export function ofapiActionModule(action: OfapiAction["action"]): OfapiActionModule {
  if (MODULE_ACTIONS.publishing.has(action)) return "publishing";
  if (MODULE_ACTIONS.account.has(action)) return "account";
  if (MODULE_ACTIONS.collection.has(action)) return "collection";
  // Unreachable while the partition pin above holds; kept so a bypassed pin fails loudly, not as a collection request.
  throw new Error(`Unknown OFAPI action: ${String(action)}`);
}

type RoutedOfapiAction =
  | { module: "publishing"; command: OfapiPublishingAction }
  | { module: "account"; command: OfapiAccountAction }
  | { module: "collection"; command: OfapiCollectionAction };

/** The ONE cast in the action path: the load-time partition pin proves `action`
 *  names exactly one module, so narrowing the union by that discriminant is
 *  sound here. Callees keep their narrow parameter types; no call site casts. */
function route(command: OfapiAction): RoutedOfapiAction {
  return { module: ofapiActionModule(command.action), command } as RoutedOfapiAction;
}

export function ofapiActionRequest(command: OfapiAction, accountId: string): OfapiActionRequest {
  const routed = route(command);
  switch (routed.module) {
    case "publishing": return ofapiPublishingRequest(routed.command, accountId);
    case "account": return ofapiAccountRequest(routed.command, accountId);
    // Publishing and account definitions re-parse inside; the collection definitions do not, so the parse stays at the seam.
    case "collection": return ofapiCollectionRequest(ofapiCollectionActionSchema.parse(routed.command), accountId);
  }
}
export function ofapiActionResultConfirmed(command: OfapiAction, status: number, body: unknown): boolean {
  const routed = route(command);
  switch (routed.module) {
    case "publishing": return ofapiPublishingResultConfirmed(routed.command, status, body);
    case "account": return ofapiAccountResultConfirmed(routed.command, status, body);
    case "collection": {
      // Collection modules read `data` only; the envelope is judged here by the same rule the other modules apply themselves.
      const envelope = asRecord(body);
      return status === 200 && envelope !== null && !negativeReceipt(envelope) && ofapiCollectionResultConfirmed(ofapiCollectionActionSchema.parse(routed.command), envelope.data);
    }
  }
}
export function ofapiActionAdmissionIssue(command: OfapiAction, now: Date): string | null {
  const routed = route(command);
  return routed.module === "publishing" ? ofapiPublishingAdmissionIssue(routed.command, now) : null;
}
