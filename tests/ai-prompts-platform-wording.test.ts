// Stage 32 — named platform substitution (the one-word Fansly↔OnlyFans
// difference between the desktop and extension prompt libraries, recorded in
// decision #108). The prompt unit is stored in its OnlyFans wording (Stage 30
// freeze bytes); a fansly page swaps the word in STATIC sources only.
//
// The strong pin: applyPlatformWording(kernel template, 'fansly') must equal
// the extension's local template file BYTE-FOR-BYTE (sibling checkout;
// skipped when absent — the extension deletes its prompt library at its own
// Task 3 cutover, same lifecycle as the desktop parity harness).

import { createHash } from 'node:crypto';
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
import type { Personality, PromptBuildInput } from '../apps/runtime/src/modules/ai/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = join(HERE, '..', '..', 'fansly-ext');

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

describe('manual OnlyFans ping (Decision #295)', () => {
  const pingInput: PromptBuildInput = {
    feature: 'ping',
    personality: PERSONALITY,
    transcript: 'Fan: I also follow you on OnlyFans!',
    fanSpendingData: '',
    fanSubscriptionData: '',
    fanDisplayName: 'Charles',
  };

  // Recorded from buildPrompt at c0cd21c3 before #295. Pin the entire Fansly
  // payload, including cache boundaries, independently of the new wording table.
  // Decision 319 changed only the context block's cache hint from 5m to none;
  // restoring that one hint must reproduce the recorded bytes exactly.
  it.each([
    ['active', 'c6a25b2c72857f566d722c1d1bde65ef0bfad42e64348ff28f9fe0486e7ea2fe'],
    ['segment-a', '99c6afebf2645548d2e15003f43b48c1c8c9fb28ed3342026313e25e3534983b'],
    ['segment-b', '507f3cc82cf93675b92b982d40a5c9b4b380740f7f3945b70a16297a4eaa70e5'],
  ] as const)('keeps the Fansly %s prompt byte-for-byte', (pingSegment, expectedHash) => {
    const prompt = buildPrompt({
      ...pingInput,
      platform: 'fansly',
      pingSegment,
      fanSilenceDays: pingSegment === 'active' ? 0 : 12,
    });
    expect(prompt.userBlocks[1]?.cache).toBe('none');
    const recordedShape = {
      ...prompt,
      userBlocks: prompt.userBlocks.map((block, index) => (index === 1 ? { ...block, cache: '5m' } : block)),
    };
    expect(createHash('sha256').update(JSON.stringify(recordedShape)).digest('hex')).toBe(expectedHash);
  });

  it.each(['onlyfans', undefined] as const)(
    'uses truthful active context with platform %s and leaves the writing decision to the chatter',
    (platform) => {
      const prompt = buildPrompt({ ...pingInput, platform, pingSegment: 'active', fanSilenceDays: 0 });
      expect(prompt.user).toContain('The chatter chose to reach out now.');
      expect(prompt.user).toContain('Active conversation: the fan wrote recently.');
      expect(prompt.user).toContain('not a recommendation about when to write');
      expect(prompt.user).toContain('If the latest fan message asks a question, acknowledge it');
      expect(prompt.user).toContain("Fan silence: the fan's last message was 0 days ago.");
      expect(prompt.user).toContain('Fan: I also follow you on OnlyFans!');
      expect(prompt.user).toContain('Output ONLY the message text.');
      expect(prompt.user).not.toContain('Segment A');
      expect(prompt.user).not.toContain('to send to a fan who has gone quiet');
      expect(prompt.user).not.toContain('The fan has not said anything recently');
      expect(prompt.user).not.toContain('This segment should not be used for ping generation');
      expect(prompt.user).not.toContain('notice the silence in your own words');
      expect(prompt.user).not.toMatch(/\{ping\w+\}/);
      expect(prompt.userBlocks.map((block) => block.cache)).toEqual(['1h', 'none', 'none']);
      expect(prompt.userBlocks[0]?.text).not.toContain('Active conversation:');
      expect(prompt.userBlocks[2]?.text).toContain('Active conversation:');
    },
  );

  it('keeps the OnlyFans static prefix independent of segment and recency', () => {
    const active = buildPrompt({ ...pingInput, pingSegment: 'active', fanSilenceDays: 0 });
    for (const pingSegment of ['segment-a', 'segment-b'] as const) {
      const older = buildPrompt({ ...pingInput, pingSegment, fanSilenceDays: 45 });
      expect(older.userBlocks[0]).toEqual(active.userBlocks[0]);
      expect(older.user).not.toContain('Was active, went silent');
    }
  });
});
