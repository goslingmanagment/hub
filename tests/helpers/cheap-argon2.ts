/**
 * argon2 at minimum cost for DB integration fixtures (owner decision after the
 * 2026-09 test audit). A test file opts in with one line:
 *
 *   vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));
 *
 * `hash` keeps the caller's own options (production passes `type: argon2id`)
 * and overrides only the cost fields: about 1 ms per fixture password instead
 * of about 25 ms at the library defaults (64 MiB, t=3, p=4). `verify` is the
 * real function. It reads the parameters from the encoded hash, so the real
 * sign-in accepts a cheap fixture hash, and a production-cost hash such as the
 * unknown-user DUMMY_PASSWORD_HASH still verifies at full cost.
 *
 * Nothing else changes: createUserAccount still writes its user.created audit
 * row, and /auth/login still runs the real check.
 *
 * Do not opt in files that test password flows themselves: auth-*,
 * device-token-*, account-links and cli-admin keep production-cost hashing.
 */
import type * as Argon2 from "argon2";
import { vi } from "vitest";

const actual = await vi.importActual<typeof Argon2>("argon2");

export const CHEAP_ARGON2_COST = { memoryCost: 1024, timeCost: 1, parallelism: 1 } as const;

export const hash = ((password: Parameters<typeof Argon2.hash>[0], options?: Parameters<typeof Argon2.hash>[1]) =>
  actual.hash(password, { ...options, ...CHEAP_ARGON2_COST })) as typeof Argon2.hash;

export const { argon2d, argon2i, argon2id, needsRehash, verify } = actual;

export default { ...actual.default, hash };
