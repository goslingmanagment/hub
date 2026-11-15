/**
 * The agency's products a person crosses between with the switcher at the top of a product's frame (products plan
 * §2.1): Hub (the owner's place, `hub.`), Workboard (the chat team's, `chatgoose.…/workboard/`), ContentOps, and the
 * owner's two outside tools. `auth/me` names the ones this person has; the frames draw the list from it.
 */
export const PRODUCTS = ["hub", "workboard", "contentops", "tasks", "monitor"] as const;
export type Product = (typeof PRODUCTS)[number];

/** Who asks: the login's role, whether the session is a narrow one from the extension, the test realm, the person's role in the registry. */
export interface ProductsAsker {
  role: string;
  narrow: boolean;
  /** A test person's login (the test team on production): never the owner's outside tools. */
  test?: boolean;
  /** The role of the person holding the login (`people.role`), when one does: a content manager has ContentOps. */
  personRole?: string | null;
}

/**
 * The products of a person, in the switcher's order (products plan §2.1–2.2, decided for the owner):
 * - the owner: all of them; the test team's owner: Hub, Workboard, ContentOps (the hand-off refuses a test person
 *   TaskIndex and the monitor);
 * - a content manager: Workboard and ContentOps;
 * - a team lead, a chatter, and a narrow session from the extension whatever the person's role: Workboard alone. A
 *   team lead has no Hub.
 */
export function productsOf(asker: ProductsAsker): Product[] {
  if (asker.narrow) return ["workboard"];
  if (asker.role === "owner") return asker.test ? ["hub", "workboard", "contentops"] : [...PRODUCTS];
  if (asker.personRole === "content_manager") return ["workboard", "contentops"];
  return ["workboard"];
}
