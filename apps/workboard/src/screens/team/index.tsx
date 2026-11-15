/**
 * «Команда» (one row per person of the team at work) and the person's card. The router (src/app/routes.tsx) loads
 * `TeamScreen` for `/team` and `PersonScreen` for `/team/:ref[/work|sales|schedule]` — a person's code, or a login's
 * number that lands on its person. Its old address `/people…` leads here (packages/ui old-addresses.ts).
 */
export { TeamScreen } from "./TeamScreen.js";
export { PersonScreen } from "./PersonRoute.js";
