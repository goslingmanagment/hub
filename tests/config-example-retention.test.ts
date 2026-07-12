import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const templates = [".env.example", ".env.docker.example", ".env.production.example"];

describe("retention defaults in env templates", () => {
  for (const template of templates) {
    it(`${template} keeps the fact-bearing OFAPI journal effectively forever`, () => {
      const text = readFileSync(resolve(root, template), "utf8");
      expect(text).toMatch(/^OFAPI_EVENT_RETENTION_DAYS=36500$/m);
      expect(text).not.toMatch(/^ONLYMONSTER_BASE_URL=/m);
    });
  }
});
