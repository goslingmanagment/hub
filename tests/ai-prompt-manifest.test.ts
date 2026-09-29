// Stage 30 — the prompt migration manifest: every migrated prompt file matches
// its recorded hash, and every template is either byte-identical to the frozen
// source or carries a note naming the decision that changed it. File reads and
// hashes only; no database.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("prompt migration manifest (Stage 30)", () => {
  const root = join(__dirname, "..", "apps", "runtime", "src", "modules", "ai", "prompts");
  const manifest = JSON.parse(readFileSync(join(root, "prompt-manifest.json"), "utf8")) as {
    files: Record<string, { coreSha256: string; byteIdenticalToSource: boolean; note?: string }>;
  };

  it("every migrated file matches its recorded hash (drift pin)", () => {
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const digest = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
      expect(digest, rel).toBe(entry.coreSha256);
    }
  });

  it("prompt templates match the frozen sources or carry a documented post-freeze note", () => {
    const templates = Object.entries(manifest.files).filter(([rel]) => rel.startsWith("templates/"));
    expect(templates.length).toBeGreaterThanOrEqual(7);
    for (const [rel, entry] of templates) {
      // Stage 30 froze templates byte-identical to the desktop snapshot. The
      // desktop twin is deleted (kernel files are the living copy), so
      // post-freeze evolution is allowed — but ONLY with a note naming the
      // decision that changed the template (first use: #127, ping fanSilenceDays).
      if (!entry.byteIdenticalToSource) {
        expect(
          entry.note,
          `${rel}: template diverged from the frozen source without a documenting note`,
        ).toBeTruthy();
      }
    }
    // And no template exists outside the manifest.
    for (const file of readdirSync(join(root, "templates"))) {
      expect(manifest.files[`templates/${file}`], file).toBeDefined();
    }
  });
});
