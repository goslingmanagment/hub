// Stage 32 — named platform substitution (the one-word Fansly↔OnlyFans
// difference between the desktop and extension prompt libraries, recorded in
// decision #108). The prompt unit is stored in its OnlyFans wording (Stage 30
// freeze bytes); a fansly page swaps the word in STATIC sources only.
//
// The strong pin: applyPlatformWording(kernel template, 'fansly') must equal
// the extension's local template file BYTE-FOR-BYTE (sibling checkout;
// skipped when absent — the extension deletes its prompt library at its own
// Task 3 cutover, same lifecycle as the desktop parity harness).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHAT_REVIEW_TEMPLATE,
  FAN_SUMMARY_TEMPLATE,
  FAST_REPLY_TEMPLATE,
  HELP_ME_TEMPLATE,
  HI_GREETING_TEMPLATE,
  IMPROVE_DRAFT_TEMPLATE,
  PING_TEMPLATE,
  applyPlatformWording,
  buildPrompt,
} from '../apps/runtime/src/modules/ai/index.ts';
import type { Personality } from '../apps/runtime/src/modules/ai/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = join(HERE, '..', '..', 'chatgoose');

const TEMPLATES: ReadonlyArray<{ file: string; content: string }> = [
  { file: 'fast-reply.md', content: FAST_REPLY_TEMPLATE },
  { file: 'improve-draft.md', content: IMPROVE_DRAFT_TEMPLATE },
  { file: 'help-me.md', content: HELP_ME_TEMPLATE },
  { file: 'fan-summary.md', content: FAN_SUMMARY_TEMPLATE },
  { file: 'chat-review.md', content: CHAT_REVIEW_TEMPLATE },
  { file: 'ping.md', content: PING_TEMPLATE },
  { file: 'hi-greeting.md', content: HI_GREETING_TEMPLATE },
];

const PERSONALITY: Personality = {
  id: 'p1',
  name: 'Lora',
  content: "You're on OnlyFans because honestly? It's fun.",
  updatedAt: 1,
};

function fanslyPrompt(transcript = 'Fan: hi') {
  return buildPrompt({
    feature: 'fast-reply',
    personality: PERSONALITY,
    platform: 'fansly',
    transcript,
    fanSpendingData: '',
    fanSubscriptionData: '',
    fanDisplayName: 'Fan',
  });
}

describe('applyPlatformWording', () => {
  it('is the identity for onlyfans and swaps the word for fansly', () => {
    expect(applyPlatformWording('a OnlyFans chatter', 'onlyfans')).toBe('a OnlyFans chatter');
    expect(applyPlatformWording('a OnlyFans chatter', 'fansly')).toBe('a Fansly chatter');
  });

  const hasExtensionCheckout = existsSync(join(EXTENSION_ROOT, 'prompts', 'fast-reply.md'));

  it.skipIf(!hasExtensionCheckout).each(TEMPLATES)(
    'fansly wording of $file is byte-identical to the extension template',
    ({ file, content }) => {
      const extensionTemplate = readFileSync(join(EXTENSION_ROOT, 'prompts', file), 'utf8');
      expect(applyPlatformWording(content, 'fansly')).toBe(extensionTemplate);
    },
  );
});

describe('buildPrompt platform wording', () => {
  it('swaps the preamble and persona wording for fansly pages', () => {
    const prompt = fanslyPrompt();
    // The extension's exact preamble opening (src/shared/prompts.ts).
    expect(prompt.system).toContain(
      'You are roleplaying as a specific model on Fansly. You must stay in character at all times.',
    );
    expect(prompt.system).toContain("You're on Fansly because honestly?");
    expect(prompt.system).not.toContain('OnlyFans');
    expect(prompt.user.startsWith(
      'You are generating a reply to send to a fan in a Fansly DM conversation.',
    )).toBe(true);
  });

  it('never rewrites runtime data: fan text mentioning OnlyFans survives verbatim', () => {
    const prompt = fanslyPrompt('Fan: I also follow you on OnlyFans!');
    expect(prompt.user).toContain('I also follow you on OnlyFans!');
  });

  it('defaults to the stored OnlyFans wording (Stage 30 parity fixtures unchanged)', () => {
    const prompt = buildPrompt({
      feature: 'fast-reply',
      personality: PERSONALITY,
      transcript: 'Fan: hi',
      fanSpendingData: '',
      fanSubscriptionData: '',
      fanDisplayName: 'Fan',
    });
    expect(prompt.system).toContain('You are roleplaying as a specific model on OnlyFans.');
  });
});
