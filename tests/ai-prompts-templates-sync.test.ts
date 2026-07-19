// MIGRATED VERBATIM (Stage 30) from chatgoose_desktop_fable
// packages/shared/tests/templates-sync.test.ts @ 1db76a4ae13d (2026-07-06);
// adapted ONLY in imports (+ template paths where noted).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHAT_REVIEW_TEMPLATE,
  COACH_CHAT_TEMPLATE,
  FAN_SUMMARY_SHORT_TEMPLATE,
  FAN_SUMMARY_TEMPLATE,
  FAST_REPLY_TEMPLATE,
  HELP_ME_TEMPLATE,
  HI_GREETING_TEMPLATE,
  IMPROVE_DRAFT_TEMPLATE,
  PING_TEMPLATE,
  VOICE_SCRIPT_TEMPLATE,
} from '../apps/runtime/src/modules/ai/index.ts';

const TEMPLATE_FILES: ReadonlyArray<[file: string, constant: string]> = [
  ['fast-reply.md', FAST_REPLY_TEMPLATE],
  ['improve-draft.md', IMPROVE_DRAFT_TEMPLATE],
  ['help-me.md', HELP_ME_TEMPLATE],
  ['fan-summary.md', FAN_SUMMARY_TEMPLATE],
  ['fan-summary-short.md', FAN_SUMMARY_SHORT_TEMPLATE],
  ['chat-review.md', CHAT_REVIEW_TEMPLATE],
  ['ping.md', PING_TEMPLATE],
  ['hi-greeting.md', HI_GREETING_TEMPLATE],
  ['coach-chat.md', COACH_CHAT_TEMPLATE],
  ['voice-script.md', VOICE_SCRIPT_TEMPLATE],
];

function readTemplateFile(file: string): string {
  return readFileSync(new URL(`../apps/runtime/src/modules/ai/prompts/templates/${file}`, import.meta.url), 'utf8');
}

describe('templates.ts ↔ templates/*.md byte-sync', () => {
  for (const [file, constant] of TEMPLATE_FILES) {
    it(`${file} matches its exported constant byte-for-byte`, () => {
      expect(constant).toBe(readTemplateFile(file));
    });
  }

  it('covers every .md template file', () => {
    expect(TEMPLATE_FILES).toHaveLength(10);
  });

  for (const [file, constant] of TEMPLATE_FILES) {
    it(`${file} carries the platform rename (no Fansly mentions)`, () => {
      expect(constant).not.toMatch(/fansly/i);
      expect(constant).toContain('OnlyFans');
    });
  }
});

// Round-2 P2-7: the compact recap must pin its output language the way the full
// recap does — otherwise the model answers in the template's own (English)
// language and a Russian full recap sits beside an English short recap in the
// same coach prompt (and in the extension UI).
describe("fan-summary short template language pinning", () => {
  it("carries the Russian directive in both the full recap's spots", () => {
    // Mirrors fan-summary.md line 9 (the Rules directive) and line 83 (the task
    // line) — both present so the compact recap is written in Russian.
    expect(FAN_SUMMARY_SHORT_TEMPLATE).toContain(
      "Write the recap in Russian. English terms are acceptable where they sound more natural",
    );
    expect(FAN_SUMMARY_SHORT_TEMPLATE).toContain("Write in Russian.");
    // And the full recap keeps the same directive it always had (no drift).
    expect(FAN_SUMMARY_TEMPLATE).toContain("Write the review in Russian.");
    expect(FAN_SUMMARY_TEMPLATE).toContain("Write in Russian.");
  });
});

// Legacy behavior facts about template content (re-expressed from the legacy
// "paid-media state rule" suite).
describe('paid-media state rule', () => {
  const NO_REPITCH_PHRASE = 'do NOT pitch buying or unlocking it again';
  const NO_LABEL_LEAK_PHRASE = 'never quote them back to the fan';
  const LISTED_PRICE_PHRASE = 'LISTED asking price';
  const BUNDLE_SHAPE_PHRASE = '[Media Bundle: N Photos, M Videos';
  const REPLY_TEMPLATES_WITH_RULE: ReadonlyArray<[string, string]> = [
    ['fast-reply', FAST_REPLY_TEMPLATE],
    ['improve-draft', IMPROVE_DRAFT_TEMPLATE],
    ['help-me', HELP_ME_TEMPLATE],
    ['ping', PING_TEMPLATE],
  ];
  const TEMPLATES_WITHOUT_RULE: ReadonlyArray<[string, string]> = [
    ['chat-review', CHAT_REVIEW_TEMPLATE],
    ['fan-summary', FAN_SUMMARY_TEMPLATE],
    ['hi-greeting', HI_GREETING_TEMPLATE],
  ];

  for (const [name, template] of REPLY_TEMPLATES_WITH_RULE) {
    it(`${name} template carries the no-repitch rule with all three label states`, () => {
      expect(template).toContain('PPV $X.XX, purchased');
      expect(template).toContain('PPV $X.XX, not purchased');
      expect(template).toContain('PPV $X.XX, unknown');
      expect(template).not.toContain('PPV $X.XX, locked');
      expect(template).toContain(NO_REPITCH_PHRASE);
    });

    it(`${name} template clarifies that the price tag is the listed asking price`, () => {
      expect(template).toContain(LISTED_PRICE_PHRASE);
    });

    it(`${name} template documents the bundle-with-counts shape`, () => {
      expect(template).toContain(BUNDLE_SHAPE_PHRASE);
    });

    it(`${name} template forbids quoting internal labels back to the fan`, () => {
      expect(template).toContain(NO_LABEL_LEAK_PHRASE);
    });
  }

  for (const [name, template] of TEMPLATES_WITHOUT_RULE) {
    it(`${name} template intentionally omits the no-repitch rule`, () => {
      expect(template).not.toContain(NO_REPITCH_PHRASE);
    });
  }
});
