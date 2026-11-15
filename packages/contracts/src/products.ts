/**
 * The agency's products a person crosses between with the switcher at the top of a product's frame (products plan
 * §2.1): Hub (the owner's place, `hub.`), Workboard (the chat team's, `chatgoose.…/workboard/`), ContentOps, and the
 * owner's two outside tools. `auth/me` names the ones this person has; the frames draw the list from it.
 */
export const PRODUCTS = ["hub", "workboard", "contentops", "tasks", "monitor"] as const;
export type Product = (typeof PRODUCTS)[number];

/**
 * The products of a person, in the switcher's order: the owner has all of them; a team lead and a chatter have
 * Workboard alone, and so does a narrow session from the extension, whatever the person's role (it opens the team's
 * place only). Hub belongs to the owner: a team lead has no Hub (products plan §2.2, decided for the owner).
 */
export function productsOf(role: string, narrow: boolean): Product[] {
  if (!narrow && role === "owner") return [...PRODUCTS];
  return ["workboard"];
}
