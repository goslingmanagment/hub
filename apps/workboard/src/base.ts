/**
 * Where Workboard lives: the one constant behind Vite's `base` (vite.config.ts)
 * and so behind the router's basename (`import.meta.env.BASE_URL`, src/main.tsx).
 *
 * Today Workboard is served by Hub on the console's host: hub.gosling-agency.ru/workboard/.
 * A later own host (workboard.gosling-agency.ru) serves it at the root: build
 * with WORKBOARD_BASE=/ — no code changes, an nginx/DNS change and a second
 * sign-in (spec §2.3).
 */
export const WORKBOARD_BASE = "/workboard/";
