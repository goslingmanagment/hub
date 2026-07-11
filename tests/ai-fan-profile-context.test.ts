// Decision #136 — the fan-dossier prompt compiler: section parsing, the
// always-drop financial rule, the volatile age policy, priority-ordered size
// pressure, and the runtime feature allowlist.
import { describe, expect, it } from 'vitest';

import {
  FAN_PROFILE_HARD_CAP_CHARS,
  FAN_PROFILE_TARGET_CHARS,
  FEATURE_POLICIES,
  OPERATION_FEATURES,
  compileDossierForPrompt,
  isFanProfileFeatureEnabled,
} from '../apps/runtime/src/modules/ai/index.ts';

const FRESH = { ageDays: 3, volatileMaxAgeDays: 21 };
const STALE = { ageDays: 45, volatileMaxAgeDays: 21 };

const FULL_DOSSIER = `1. DOSSIER
- Name: Charles, 34, Boston, works in finance

2. PSYCHOLOGICAL PORTRAIT
- Anxious attachment, seeks validation

3. STAGE AND TRAJECTORY
- Loyal, trending stable

4. COMMUNICATION DYNAMICS
- Short messages, emoji-heavy, hates being rushed

5. FINANCIAL PROFILE
- Big spender, tips on attention

6. OPEN LOOPS
- Promised beach photos from the trip

7. STRATEGY
- Lean into travel talk, avoid hard sells`;

describe('compileDossierForPrompt — sections and age policy', () => {
  it('keeps all sections except FINANCIAL PROFILE for a fresh dossier', () => {
    const result = compileDossierForPrompt(FULL_DOSSIER, FRESH);
    expect(result.sectioned).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.body).toContain('Charles, 34, Boston');
    expect(result.body).toContain('Anxious attachment');
    expect(result.body).toContain('Loyal, trending stable');
    expect(result.body).toContain('hates being rushed');
    expect(result.body).toContain('Promised beach photos');
    expect(result.body).toContain('Lean into travel talk');
    // Fresh spending/subscription data rides its own prompt sections.
    expect(result.body).not.toContain('Big spender');
    expect(result.droppedSections).toEqual(['FINANCIAL PROFILE']);
  });

  it('drops the volatile sections (stage, open loops, strategy) once the dossier is old', () => {
    const result = compileDossierForPrompt(FULL_DOSSIER, STALE);
    expect(result.body).toContain('Charles, 34, Boston');
    expect(result.body).toContain('Anxious attachment');
    expect(result.body).toContain('hates being rushed');
    expect(result.body).not.toContain('Loyal, trending stable');
    expect(result.body).not.toContain('Promised beach photos');
    expect(result.body).not.toContain('Lean into travel talk');
    expect([...result.droppedSections].sort()).toEqual([
      'FINANCIAL PROFILE',
      'OPEN LOOPS',
      'STAGE AND TRAJECTORY',
      'STRATEGY',
    ]);
  });

  it('recognizes decorated headings (markdown, bold, numbering variants)', () => {
    const decorated = [
      '## 1. DOSSIER',
      '- Name: Vlad',
      '**OPEN LOOPS:**',
      '- Owes him a voice note',
      '3) STAGE AND TRAJECTORY',
      '- Cooling off',
    ].join('\n');
    const result = compileDossierForPrompt(decorated, FRESH);
    expect(result.sectioned).toBe(true);
    expect(result.body).toContain('Owes him a voice note');
    const stale = compileDossierForPrompt(decorated, STALE);
    expect(stale.body).toContain('Name: Vlad');
    expect(stale.body).not.toContain('Owes him a voice note');
    expect(stale.body).not.toContain('Cooling off');
  });

  it('does not split on prose that merely mentions a section word', () => {
    const prose = 'He said the strategy of the team is bad. '.repeat(20);
    const result = compileDossierForPrompt(prose, FRESH);
    expect(result.sectioned).toBe(false);
    expect(result.body).toBe(prose.trim());
  });
});

describe('compileDossierForPrompt — size pressure', () => {
  const filler = (label: string, chars: number) => `${label}\n${'x '.repeat(chars / 2)}`;

  it('sheds whole sections by keep-priority before cutting text', () => {
    const big = [
      filler('1. DOSSIER', 4000),
      filler('2. PSYCHOLOGICAL PORTRAIT', 4000),
      filler('3. STAGE AND TRAJECTORY', 4000),
      filler('4. COMMUNICATION DYNAMICS', 4000),
      filler('6. OPEN LOOPS', 4000),
      filler('7. STRATEGY', 4000),
    ].join('\n');
    const result = compileDossierForPrompt(big, FRESH);
    expect(result.body.length).toBeLessThanOrEqual(FAN_PROFILE_TARGET_CHARS);
    expect(result.truncated).toBe(false);
    // Highest keep-priority numbers go first: stage, then psych portrait.
    expect(result.droppedSections).toContain('STAGE AND TRAJECTORY');
    expect(result.droppedSections).toContain('PSYCHOLOGICAL PORTRAIT');
    // The facts core survives.
    expect(result.body).toContain('1. DOSSIER');
    expect(result.body).toContain('4. COMMUNICATION DYNAMICS');
  });

  it('lets a single oversized section run past the target but never the hard cap', () => {
    const midsize = compileDossierForPrompt(filler('1. DOSSIER', 14_000), FRESH);
    expect(midsize.truncated).toBe(false);
    expect(midsize.body.length).toBeGreaterThan(FAN_PROFILE_TARGET_CHARS);

    const oversized = compileDossierForPrompt(filler('1. DOSSIER', 30_000), FRESH);
    expect(oversized.truncated).toBe(true);
    expect(oversized.body).toContain('[dossier truncated]');
    expect(oversized.body.length).toBeLessThanOrEqual(
      FAN_PROFILE_HARD_CAP_CHARS + '\n\n[dossier truncated]'.length,
    );
  });

  it('falls back to a bounded head for unrecognized shapes', () => {
    const blob = 'freeform notes about the fan without any known headings. '.repeat(400);
    const result = compileDossierForPrompt(blob, FRESH);
    expect(result.sectioned).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.body).toContain('[dossier truncated]');
    expect(result.body.length).toBeLessThanOrEqual(
      FAN_PROFILE_TARGET_CHARS + '\n\n[dossier truncated]'.length,
    );
  });
});

describe('isFanProfileFeatureEnabled — runtime allowlist', () => {
  it('trusts the policy on "all" (and on an unset value)', () => {
    expect(isFanProfileFeatureEnabled('all', 'fast-reply')).toBe(true);
    expect(isFanProfileFeatureEnabled(undefined, 'ping')).toBe(true);
    expect(isFanProfileFeatureEnabled(' ALL ', 'help-me')).toBe(true);
  });

  it('"none" and empty are the rollback switch', () => {
    expect(isFanProfileFeatureEnabled('none', 'fast-reply')).toBe(false);
    expect(isFanProfileFeatureEnabled('', 'fast-reply')).toBe(false);
    expect(isFanProfileFeatureEnabled('   ', 'fast-reply')).toBe(false);
  });

  it('a CSV narrows the set for staged rollout', () => {
    expect(isFanProfileFeatureEnabled('fast-reply', 'fast-reply')).toBe(true);
    expect(isFanProfileFeatureEnabled('fast-reply', 'improve-draft')).toBe(false);
    expect(isFanProfileFeatureEnabled('fast-reply, ping', 'ping')).toBe(true);
    expect(isFanProfileFeatureEnabled(' Fast-Reply ', 'fast-reply')).toBe(true);
  });
});

describe('usesFanProfile policy mapping', () => {
  it('is enabled for exactly fast-reply, improve-draft, help-me and ping', () => {
    const enabled = OPERATION_FEATURES.filter(
      (feature) => FEATURE_POLICIES[feature].usesFanProfile,
    );
    expect([...enabled].sort()).toEqual(['fast-reply', 'help-me', 'improve-draft', 'ping']);
  });
});
