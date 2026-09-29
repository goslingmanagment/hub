import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";

// Opted in exactly as the DB integration files do: auth.ts reaches argon2
// through a default import, so the mock must serve that shape.
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

describe("cheap argon2 fixture mock", () => {
  it("keeps the caller's argon2id type and lowers only the cost", async () => {
    const encoded = await argon2.hash("fixture-password", { type: argon2.argon2id });

    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  it("leaves verify real", async () => {
    const encoded = await argon2.hash("fixture-password", { type: argon2.argon2id });

    await expect(argon2.verify(encoded, "fixture-password")).resolves.toBe(true);
    await expect(argon2.verify(encoded, "wrong-password")).resolves.toBe(false);
  });
});
