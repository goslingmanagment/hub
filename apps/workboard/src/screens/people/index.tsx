/**
 * Люди (one row per person of the registry) and Человек. The router
 * (src/app/routes.tsx) loads `PeopleScreen` for `/people` and `PersonScreen`
 * for `/people/:ref[/work|sales|access|schedule]` — a person's code, or a
 * login's number that lands on its person (`/shifts` redirects to Работа).
 */
export { PeopleScreen } from "./PeopleScreen.js";
export { PersonScreen } from "./PersonRoute.js";
