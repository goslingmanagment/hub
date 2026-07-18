// Decision #136 (+ addendum) — the fan-dossier prompt compiler: section
// parsing, the always-drop financial rule, priority-ordered size pressure, and
// the runtime feature allowlist. Volatile sections are NOT age-dropped; the
// prompt disclaimer carries their staleness.
import { describe, expect, it } from 'vitest';

import {
  FAN_PROFILE_HARD_CAP_CHARS,
  FAN_PROFILE_TARGET_CHARS,
  FEATURE_POLICIES,
  OPERATION_FEATURES,
  compileDossierForPrompt,
  isFanProfileFeatureEnabled,
} from '../apps/runtime/src/modules/ai/index.ts';


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

// Production shape: the fan-summary template says "Write in Russian" and the
// dashboard pins the markdown form (## N. ЗАГОЛОВОК, optional H3 subheadings,
// H1 preamble) — see apps/dashboard/src/lib/parseFanProfile.ts.
const RUSSIAN_DOSSIER = [
  '# ПРОФИЛЬ ФАНАТА: Michael',
  '',
  '## 1. ДОСЬЕ',
  '',
  'Имя: Michael (Майкл), 34, Бостон',
  '',
  '### Детали',
  '',
  '- Ездит на красном Ducati',
  '',
  '## 2. ПСИХОЛОГИЧЕСКИЙ ПОРТРЕТ',
  '',
  '- Тревожная привязанность',
  '',
  '## 3. СТАДИЯ И ТРАЕКТОРИЯ',
  '',
  '- Лояльный, стабильный',
  '',
  '## 4. ДИНАМИКА ОБЩЕНИЯ',
  '',
  '- Короткие сообщения, не любит спешку',
  '',
  '## 5. ФИНАНСОВЫЙ ПРОФИЛЬ',
  '',
  '- Кит, типсует каждый вечер',
  '',
  '## 6. ОТКРЫТЫЕ ПЕТЛИ',
  '',
  '- Обещала фото с пляжа',
  '',
  '## 7. СТРАТЕГИЯ',
  '',
  '- Давить на тему путешествий',
].join('\n');

describe('compileDossierForPrompt — production Russian dossiers', () => {
  it('parses the dashboard-pinned Russian markdown shape and applies the financial rule', () => {
    const result = compileDossierForPrompt(RUSSIAN_DOSSIER);
    expect(result.sectioned).toBe(true);
    expect(result.body).toContain('ПРОФИЛЬ ФАНАТА: Michael');
    expect(result.body).toContain('красном Ducati');
    expect(result.body).toContain('### Детали');
    expect(result.body).toContain('Тревожная привязанность');
    expect(result.body).toContain('Обещала фото с пляжа');
    expect(result.body).toContain('Давить на тему путешествий');
    // Stage / open loops / strategy stay in regardless of age (#136 addendum):
    // the prompt disclaimer marks them possibly-stale rather than dropping them.
    expect(result.body).toContain('Лояльный, стабильный');
    expect(result.body).not.toContain('Кит, типсует');
    expect(result.droppedSections).toEqual(['FINANCIAL PROFILE']);
  });

  it('stem-matches translated H2 variants but never bullets or prose', () => {
    const varied = [
      '## Психологический портрет фаната',
      '- Ищет валидацию',
      '## Финансовое поведение ##',
      '- Кит',
      '## Открытые вопросы и петли',
      '- Ждёт голосовое',
    ].join('\n');
    const result = compileDossierForPrompt(varied);
    expect(result.sectioned).toBe(true);
    expect(result.body).toContain('Ищет валидацию');
    expect(result.body).toContain('Ждёт голосовое');
    expect(result.body).not.toContain('Кит');

    const bullets = [
      '## 1. ДОСЬЕ',
      '- Финансы: жалуется на работу',
      '- Стратегия его команды по покеру плохая',
    ].join('\n');
    const bulletResult = compileDossierForPrompt(bullets);
    expect(bulletResult.body).toContain('жалуется на работу');
    expect(bulletResult.body).toContain('по покеру');
  });

  it('keeps H3 subheadings inside their parent section (no stem split)', () => {
    const nested = [
      '## 1. ДОСЬЕ',
      '- Имя: Vlad',
      '### Финансовые заметки',
      '- Упоминал бонус на работе',
    ].join('\n');
    const result = compileDossierForPrompt(nested);
    expect(result.body).toContain('Упоминал бонус на работе');
    expect(result.droppedSections).toEqual([]);
  });
});

describe('compileDossierForPrompt — sections and the financial rule', () => {
  it('keeps every section except FINANCIAL PROFILE — no age-dropping (#136 addendum)', () => {
    const result = compileDossierForPrompt(FULL_DOSSIER);
    expect(result.sectioned).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.body).toContain('Charles, 34, Boston');
    expect(result.body).toContain('Anxious attachment');
    expect(result.body).toContain('hates being rushed');
    // Volatile sections (stage, open loops, strategy) survive — the prompt
    // disclaimer carries their possible staleness instead of dropping them.
    expect(result.body).toContain('Loyal, trending stable');
    expect(result.body).toContain('Promised beach photos');
    expect(result.body).toContain('Lean into travel talk');
    // FINANCIAL is still dropped: fresh spend/subscription rides its own sections.
    expect(result.body).not.toContain('Big spender');
    expect(result.droppedSections).toEqual(['FINANCIAL PROFILE']);
  });

  it('recognizes decorated headings (markdown, bold, numbering variants) and keeps them', () => {
    const decorated = [
      '## 1. DOSSIER',
      '- Name: Vlad',
      '**OPEN LOOPS:**',
      '- Owes him a voice note',
      '3) STAGE AND TRAJECTORY',
      '- Cooling off',
    ].join('\n');
    const result = compileDossierForPrompt(decorated);
    expect(result.sectioned).toBe(true);
    expect(result.body).toContain('Name: Vlad');
    expect(result.body).toContain('Owes him a voice note');
    expect(result.body).toContain('Cooling off');
    expect(result.droppedSections).toEqual([]);
  });

  it('does not split on prose that merely mentions a section word', () => {
    const prose = 'He said the strategy of the team is bad. '.repeat(20);
    const result = compileDossierForPrompt(prose);
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
    const result = compileDossierForPrompt(big);
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
    const midsize = compileDossierForPrompt(filler('1. DOSSIER', 14_000));
    expect(midsize.truncated).toBe(false);
    expect(midsize.body.length).toBeGreaterThan(FAN_PROFILE_TARGET_CHARS);

    const oversized = compileDossierForPrompt(filler('1. DOSSIER', 30_000));
    expect(oversized.truncated).toBe(true);
    expect(oversized.body).toContain('[dossier truncated]');
    expect(oversized.body.length).toBeLessThanOrEqual(
      FAN_PROFILE_HARD_CAP_CHARS + '\n\n[dossier truncated]'.length,
    );
  });

  it('falls back to a bounded head for unrecognized shapes', () => {
    const blob = 'freeform notes about the fan without any known headings. '.repeat(400);
    const result = compileDossierForPrompt(blob);
    expect(result.sectioned).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.body).toContain('[dossier truncated]');
    expect(result.body.length).toBeLessThanOrEqual(
      FAN_PROFILE_TARGET_CHARS + '\n\n[dossier truncated]'.length,
    );
  });
});

describe('isFanProfileFeatureEnabled — runtime allowlist', () => {
  it('trusts the policy on "all"', () => {
    expect(isFanProfileFeatureEnabled('all', 'fast-reply')).toBe(true);
    expect(isFanProfileFeatureEnabled(' ALL ', 'help-me')).toBe(true);
  });

  it('"none", empty and ABSENT are all off — a deploy alone never enables it', () => {
    expect(isFanProfileFeatureEnabled('none', 'fast-reply')).toBe(false);
    expect(isFanProfileFeatureEnabled(undefined, 'ping')).toBe(false);
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
  it('is enabled for exactly fast-reply, improve-draft, help-me, ping and coach-chat', () => {
    const enabled = OPERATION_FEATURES.filter(
      (feature) => FEATURE_POLICIES[feature].usesFanProfile,
    );
    expect([...enabled].sort()).toEqual(['coach-chat', 'fast-reply', 'help-me', 'improve-draft', 'ping']);
  });
});
