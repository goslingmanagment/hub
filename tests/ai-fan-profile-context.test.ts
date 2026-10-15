// Decision #136 (+ addendum) — the fan-dossier prompt compiler: section
// parsing, the always-drop financial rule, priority-ordered size pressure, and
// the runtime feature allowlist. Volatile sections are NOT age-dropped; the
// prompt disclaimer carries their staleness.
import { describe, expect, it } from 'vitest';

import {
  FAN_PROFILE_HARD_CAP_CHARS,
  FAN_PROFILE_LITE_LOOPS_MAX_CHARS,
  FAN_PROFILE_LITE_MAX_CHARS,
  FAN_PROFILE_TARGET_CHARS,
  FEATURE_POLICIES,
  OPERATION_FEATURES,
  compileDossierForPrompt,
  demoteDossierHeadings,
  isFanProfileFeatureEnabled,
  usesLiteDossier,
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

// Lora persona audit (2026-10-16): fast-reply reads a lite dossier: the fan's
// facts, how he talks and what is still open, at most 5000 chars, with every
// heading demoted below the prompt's own `##` level. Over the budget it drops
// the dynamics first, then cuts open loops over 1500 chars and the facts at a
// line boundary; open loops are never dropped. Every other feature keeps the
// full compile above.
describe('compileDossierForPrompt — the lite dossier (fast-reply)', () => {
  const MARKER = '\n\n[dossier truncated]';
  const SECTION_MARKER = '\n[section truncated]';
  const promptLevelHeading = /^[ \t]*#{1,2}\s/m;
  /** A section of `count` whole bullet lines, `- <word> <n> about him`. */
  const lined = (heading: string, word: string, count: number) =>
    [heading, ...Array.from({ length: count }, (_, index) => `- ${word} ${index} about him`)].join('\n');
  /** The text of one demoted section of a compiled body, up to the next section. */
  const sectionOf = (body: string, heading: string) => {
    const start = body.indexOf(heading);
    const next = body.indexOf('\n\n####', start + heading.length);
    return start < 0 ? '' : body.slice(start, next < 0 ? body.length : next);
  };

  it('keeps facts, dynamics and open loops and drops portrait, stage, strategy and money', () => {
    const result = compileDossierForPrompt(RUSSIAN_DOSSIER, { lite: true });
    expect(result.sectioned).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.body).toContain('красном Ducati');
    expect(result.body).toContain('Короткие сообщения, не любит спешку');
    expect(result.body).toContain('Обещала фото с пляжа');
    expect(result.body).not.toContain('Тревожная привязанность');
    expect(result.body).not.toContain('Лояльный, стабильный');
    expect(result.body).not.toContain('Давить на тему путешествий');
    expect(result.body).not.toContain('Кит, типсует');
    expect([...result.droppedSections].sort()).toEqual([
      'FINANCIAL PROFILE',
      'PSYCHOLOGICAL PORTRAIT',
      'STAGE AND TRAJECTORY',
      'STRATEGY',
    ]);
  });

  it('demotes every heading below the prompt level and keeps the hierarchy', () => {
    const result = compileDossierForPrompt(RUSSIAN_DOSSIER, { lite: true });
    expect(result.body).not.toMatch(promptLevelHeading);
    expect(result.body).toContain('### ПРОФИЛЬ ФАНАТА: Michael');
    expect(result.body).toContain('#### 1. ДОСЬЕ');
    expect(result.body).toContain('##### Детали');
    expect(result.body).toContain('#### 4. ДИНАМИКА ОБЩЕНИЯ');
    expect(result.body).toContain('#### 6. ОТКРЫТЫЕ ПЕТЛИ');
  });

  it('reads the English section names as well', () => {
    const result = compileDossierForPrompt(FULL_DOSSIER, { lite: true });
    expect(result.body).toContain('Charles, 34, Boston');
    expect(result.body).toContain('hates being rushed');
    expect(result.body).toContain('Promised beach photos');
    expect(result.body).not.toContain('Anxious attachment');
    expect(result.body).not.toContain('trending stable');
    expect(result.body).not.toContain('avoid hard sells');
    expect(result.body).not.toContain('Big spender');
  });

  it('leaves the full compile (every other feature) as it was', () => {
    const full = compileDossierForPrompt(RUSSIAN_DOSSIER);
    expect(full).toEqual(compileDossierForPrompt(RUSSIAN_DOSSIER, { lite: false }));
    expect(full.body).toContain('## 1. ДОСЬЕ');
    expect(full.body).toContain('Давить на тему путешествий');
  });

  it('drops the dynamics first and keeps facts and open loops whole when that fits', () => {
    const result = compileDossierForPrompt(
      [
        lined('## 1. ДОСЬЕ', 'fact', 130),
        lined('## 4. ДИНАМИКА ОБЩЕНИЯ', 'style', 80),
        lined('## 6. ОТКРЫТЫЕ ПЕТЛИ', 'loop', 60),
        lined('## 7. СТРАТЕГИЯ', 'plan', 60),
      ].join('\n'),
      { lite: true },
    );
    expect(result.truncated).toBe(false);
    expect(result.body.length).toBeLessThanOrEqual(FAN_PROFILE_LITE_MAX_CHARS);
    expect(result.droppedSections).toContain('COMMUNICATION DYNAMICS');
    expect(result.droppedSections).not.toContain('OPEN LOOPS');
    expect(result.body).not.toContain('ДИНАМИКА');
    expect(result.body).toContain('- fact 129 about him');
    expect(result.body).toContain('- loop 59 about him');
  });

  it('then cuts the facts at a line boundary to fit, never the open loops', () => {
    const result = compileDossierForPrompt(
      [
        lined('## 1. ДОСЬЕ', 'fact', 220),
        lined('## 4. ДИНАМИКА ОБЩЕНИЯ', 'style', 40),
        lined('## 6. ОТКРЫТЫЕ ПЕТЛИ', 'loop', 55),
      ].join('\n'),
      { lite: true },
    );
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(FAN_PROFILE_LITE_MAX_CHARS);
    expect(result.droppedSections).toEqual(['COMMUNICATION DYNAMICS']);
    // The open loops stay whole and after the facts.
    const loops = sectionOf(result.body, '#### 6. ОТКРЫТЫЕ ПЕТЛИ');
    expect(loops).toBe(lined('#### 6. ОТКРЫТЫЕ ПЕТЛИ', 'loop', 55));
    const facts = sectionOf(result.body, '#### 1. ДОСЬЕ');
    expect(result.body.indexOf(facts)).toBe(0);
    expect(facts.endsWith(SECTION_MARKER)).toBe(true);
    expect(facts).toContain('- fact 0 about him');
    expect(facts).not.toContain('- fact 219 about him');
    // Cut at a line boundary: every kept line is a whole bullet.
    for (const line of facts.slice(0, -SECTION_MARKER.length).split('\n').slice(1)) {
      expect(line).toMatch(/^- fact \d+ about him$/);
    }
    // The budget is used, not wasted.
    expect(result.body.length).toBeGreaterThan(FAN_PROFILE_LITE_MAX_CHARS - 40);
  });

  it('cuts open loops over 1500 chars at a line boundary under pressure and keeps them otherwise', () => {
    const pressed = compileDossierForPrompt(
      [lined('## 1. ДОСЬЕ', 'fact', 150), lined('## 6. ОТКРЫТЫЕ ПЕТЛИ', 'loop', 150)].join('\n'),
      { lite: true },
    );
    expect(pressed.truncated).toBe(true);
    expect(pressed.droppedSections).toEqual([]);
    expect(pressed.body.length).toBeLessThanOrEqual(FAN_PROFILE_LITE_MAX_CHARS);
    const loops = sectionOf(pressed.body, '#### 6. ОТКРЫТЫЕ ПЕТЛИ');
    expect(loops.length).toBeLessThanOrEqual(FAN_PROFILE_LITE_LOOPS_MAX_CHARS);
    expect(loops.length).toBeGreaterThan(FAN_PROFILE_LITE_LOOPS_MAX_CHARS - 40);
    expect(loops.endsWith(SECTION_MARKER)).toBe(true);
    for (const line of loops.slice(0, -SECTION_MARKER.length).split('\n').slice(1)) {
      expect(line).toMatch(/^- loop \d+ about him$/);
    }
    // The facts fit once the loops are cut, so they stay whole.
    expect(pressed.body).toContain('- fact 149 about him');

    const roomy = compileDossierForPrompt(
      [lined('## 1. ДОСЬЕ', 'fact', 40), lined('## 6. ОТКРЫТЫЕ ПЕТЛИ', 'loop', 120)].join('\n'),
      { lite: true },
    );
    expect(sectionOf(roomy.body, '#### 6. ОТКРЫТЫЕ ПЕТЛИ').length).toBeGreaterThan(FAN_PROFILE_LITE_LOOPS_MAX_CHARS);
    expect(roomy.truncated).toBe(false);
    expect(roomy.body).toContain('- loop 119 about him');
  });

  it('cuts an oversized facts section on a line and never inside an emoji', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `- fact ${index} 😘 about him`);
    const result = compileDossierForPrompt(['## 1. ДОСЬЕ', ...lines].join('\n'), { lite: true });
    expect(result.truncated).toBe(true);
    expect(result.body.endsWith(SECTION_MARKER)).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(FAN_PROFILE_LITE_MAX_CHARS);
    const head = result.body.slice(0, -SECTION_MARKER.length);
    expect(head.length).toBeGreaterThan(FAN_PROFILE_LITE_MAX_CHARS - 40);
    expect(head.endsWith('about him')).toBe(true);
    expect(head).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('bounds and demotes a body of unknown shape too', () => {
    const blob = '# Notes\n' + 'freeform notes about the fan without any known headings. '.repeat(400);
    const result = compileDossierForPrompt(blob, { lite: true });
    expect(result.sectioned).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.body.startsWith('### Notes\n')).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(FAN_PROFILE_LITE_MAX_CHARS + MARKER.length);
    expect(result.body).not.toMatch(promptLevelHeading);
  });

  it('demotes only ATX heading lines', () => {
    expect(demoteDossierHeadings('# A\n## B\n### C\n##### D\n###### E\n#hashtag\n- # not first\ntext # mid')).toBe(
      '### A\n#### B\n##### C\n###### D\n###### E\n#hashtag\n- # not first\ntext # mid',
    );
  });

  it('is read by fast-reply alone', () => {
    const lite = OPERATION_FEATURES.filter((feature) => usesLiteDossier(feature));
    expect(lite).toEqual(['fast-reply']);
    expect(FEATURE_POLICIES['fast-reply'].usesFanProfile).toBe(true);
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
