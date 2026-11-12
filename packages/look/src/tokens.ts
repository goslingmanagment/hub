/**
 * The design token VALUES of Hub's look, as data: one source for every place
 * that draws with them. A sheet of paper and ink (design-language 2026-11-03):
 * a warm grey ground, a white sheet with hairlines, black exact numbers, blue
 * ink only where something is current or waits for a person. Colour is an event.
 *
 * Two copies exist in Hub and both are GENERATED from here (`node --import tsx/esm
 * packages/look/generate.ts`; CI checks they are fresh):
 *   - packages/ui/src/styles/tokens.css   `--ui-*`, Workboard and the shared components;
 *   - apps/dashboard/src/styles/tokens.css `--color-*` and the type scale under
 *     Tailwind's `@theme static`, the console.
 * Other repositories take the values through `scripts/vendor-look.mjs` (the
 * extension keeps its own dock palette; ContentOps and TaskIndex keep their
 * component names and take the values).
 *
 * A colour is written for both themes: `[light, dark]`. Text clears 4.5:1 on its
 * own ground in both themes (the console's checked values). A token names its
 * place in each copy: `ui` (`--ui-<name>`), `console` (`--color-<name>`); a token
 * without a name in a copy is not in it. Changing a value here changes every copy;
 * renaming changes nothing anyone sees and breaks the apps that read the name.
 */

/** `[light, dark]`, or one value for both themes. */
export type ThemeValue = readonly [light: string, dark: string] | string;

export interface ColorToken {
  value: ThemeValue;
  /** The name after `--ui-` in Workboard's copy; absent: not in that copy. */
  ui?: string;
  /** The name after `--color-` in the console's copy; absent: not in that copy. */
  console?: string;
  /** What the colour is for. */
  note: string;
}

const both = (light: string, dark: string): ThemeValue => [light, dark];

/**
 * The colours, in the order the copies list them. Grouped by what they mean;
 * the console's few legacy names sit at the end until its last old screen moves.
 */
export const COLORS = {
  // --- Neutrals: the ground, the sheet, the lines, the ink of text ---
  bg: { value: both("#f6f5f3", "#141211"), ui: "bg", console: "bg", note: "The ground." },
  surface: { value: both("#ffffff", "#1c1a18"), ui: "surface", console: "card", note: "The sheet: a card, a table." },
  raised: { value: both("#ffffff", "#2a2724"), ui: "raised", console: "raised", note: "A menu, a window, a tooltip: raised over the sheet." },
  hover: { value: both("#f1efec", "#262321"), ui: "hover", console: "hover", note: "A control under the pointer." },
  hoverSoft: { value: both("#faf9f7", "#211e1c"), ui: "hover-soft", console: "hover-alt", note: "A row under the pointer: quieter than a button's hover." },
  active: { value: both("#ebe8e3", "#2e2a27"), ui: "active", console: "active-bg", note: "The current item of the menu, the avatar." },
  track: { value: both("#ebe8e3", "#262321"), ui: "track", console: "track", note: "The track of a segmented control." },
  picked: { value: both("#ffffff", "#403b37"), ui: "picked", console: "picked", note: "The picked segment on its track." },
  line: { value: both("#e6e3de", "#2f2b28"), ui: "line", console: "border", note: "A hairline." },
  lineSoft: { value: both("#efede9", "#262321"), ui: "line-soft", console: "border-light", note: "A hairline inside a sheet." },
  lineStrong: { value: both("#d3cec7", "#403b37"), ui: "line-strong", console: "border-strong", note: "A field's border." },
  text: { value: both("#1c1917", "#ece8e2"), ui: "text", console: "text-primary", note: "Text, numbers." },
  text2: { value: both("#57534e", "#bdb6ad"), ui: "text-2", console: "text-secondary", note: "Secondary text." },
  text3: { value: both("#736b65", "#a1998f"), ui: "text-3", console: "text-muted", note: "Quiet text: a hint, a header of a column." },
  backdrop: { value: both("rgb(28 25 23 / 0.32)", "rgb(0 0 0 / 0.6)"), ui: "backdrop", console: "backdrop", note: "Under a window." },
  veil: { value: both("rgb(28 25 23 / 0.08)", "rgb(0 0 0 / 0.32)"), ui: "veil", note: "Under a side panel: lighter than a window's, the page stays readable." },

  // --- The one accent: ink. Three uses only: the main button, the current place
  //     (menu, tab, selected row, focus), and what waits for the owner. ---
  accent: { value: both("#34467b", "#95a9df"), ui: "accent", console: "accent", note: "Ink: the current place, a link, focus." },
  accentHover: { value: both("#41558d", "#a9bdef"), console: "accent-hover", note: "Ink under the pointer (the console's links)." },
  accentFill: { value: both("#34467b", "#4f66ab"), ui: "accent-fill", console: "accent-fill", note: "The main button." },
  accentFillHover: { value: both("#41558d", "#5d75bd"), ui: "accent-fill-hover", console: "accent-fill-hover", note: "The main button under the pointer." },
  accentSoft: { value: both("#ebf0fb", "#21293e"), ui: "accent-soft", console: "accent-soft", note: "The ground of a selected row." },
  accentLine: { value: both("#c6d1ec", "#3f4c6e"), ui: "accent-line", console: "accent-border", note: "The line around what is selected." },
  onFill: { value: "#ffffff", ui: "on-fill", console: "on-fill", note: "Text on a filled button." },

  // --- States: calm, never a whole painted panel ---
  good: { value: both("#15803d", "#5bc98a"), ui: "good", console: "green", note: "Good: a small green dot." },
  goodText: { value: both("#14532d", "#86dca9"), ui: "good-text", console: "success-text", note: "Good: a dark-green word." },
  goodSoft: { value: both("#e8f5ec", "#16301f"), ui: "good-soft", console: "success-soft", note: "Good: a soft ground." },
  goodLine: { value: both("#bfe3cc", "#24503a"), ui: "good-line", console: "success-border", note: "Good: its line." },
  warn: { value: both("#d97706", "#f0a33a"), ui: "warn", console: "warning", note: "Attention: not broken, worth a look." },
  warnText: { value: both("#7a4708", "#f5bd6e"), ui: "warn-text", console: "warning-text", note: "Attention: its word." },
  warnSoft: { value: both("#fdf3e2", "#33240f"), ui: "warn-soft", console: "warning-soft", note: "Attention: a soft ground." },
  warnLine: { value: both("#f1d9b5", "#5a4020"), ui: "warn-line", console: "warning-border", note: "Attention: its line." },
  bad: { value: both("#c53a3a", "#f27c7c"), ui: "bad", console: "danger", note: "Error: broken, a person must act." },
  badText: { value: both("#8f2525", "#f6a0a0"), ui: "bad-text", console: "danger-text", note: "Error: its word." },
  badSoft: { value: both("#fbeaea", "#3a1d1d"), ui: "bad-soft", console: "danger-soft", note: "Error: a soft ground." },
  badLine: { value: both("#f1c4c4", "#5c2b2b"), ui: "bad-line", console: "danger-border", note: "Error: its line." },
  dangerFill: { value: both("#c53a3a", "#b84848"), ui: "danger-fill", console: "danger-fill", note: "A button that deletes or ends something." },
  dangerFillHover: { value: both("#a92f2f", "#c55656"), ui: "danger-fill-hover", console: "danger-fill-hover", note: "That button under the pointer." },

  // --- Better / worse than before: muted text colours, not statuses. A drop of
  //     income is not an alarm, so it is never the error red. ---
  up: { value: both("#356748", "#94c5a4"), ui: "up", console: "up", note: "Better than the period before." },
  down: { value: both("#874b3c", "#dda596"), ui: "down", console: "down", note: "Worse than the period before." },

  // --- An outlier against the team: one calm colour, no grading ---
  markSoft: { value: both("#f6eedd", "#2d2618"), ui: "mark-soft", note: "An outlier: its ground." },
  markText: { value: both("#6b4c12", "#e6c88f"), ui: "mark-text", note: "An outlier: its word." },
  markBar: { value: both("#7a5a1f", "#9d8458"), ui: "mark-bar", note: "A bar worse than the team: the same warmth, never a bright gold in the dark." },

  // --- Chart series (validated as a categorical set in both themes: lightness
  //     band, chroma floor, neighbours apart for colour-blind and normal vision,
  //     3:1 on the sheet). Never a status. ---
  series1: { value: both("#2f5fb3", "#4d86e0"), ui: "series-1", console: "chart-blue", note: "Series 1." },
  series2: { value: both("#d9572a", "#d9612e"), ui: "series-2", console: "chart-orange", note: "Series 2." },
  series3: { value: both("#119467", "#199e70"), ui: "series-3", console: "chart-aqua", note: "Series 3." },
  series4: { value: both("#6250d6", "#8f80f0"), ui: "series-4", console: "chart-violet", note: "Series 4." },
  series5: { value: both("#d4568a", "#d55181"), ui: "series-5", console: "chart-magenta", note: "Series 5." },
  series6: { value: both("#4d7c0f", "#7a9a1e"), ui: "series-6", console: "chart-lime", note: "Series 6." },
  seriesGreen: { value: both("#15803d", "#2e9e5b"), console: "chart-green", note: "The console's seventh series." },
  seriesCompare: { value: both("#9a948b", "#6f685f"), ui: "series-compare", console: "chart-compare", note: "The last period's line, the team's mark on a bar." },

  // --- The console's legacy names, until its last old screen moves. Platform
  //     tints (labels are plain text now); the pairs of `bg-accent` with
  //     `text-on-accent` stay readable in the dark (the cabinet, /join); new code
  //     uses accentFill and onFill. ---
  fansly: { value: both("#2f5fb3", "#82a8ec"), console: "fansly", note: "Legacy: Fansly's tint." },
  fanslySoft: { value: both("#e9f0fb", "#1b2638"), console: "fansly-soft", note: "Legacy: Fansly's soft tint." },
  onlyfans: { value: both("#9a5d0e", "#e2a95c"), console: "onlyfans", note: "Legacy: OnlyFans's tint." },
  onlyfansSoft: { value: both("#fcf1e1", "#33260f"), console: "onlyfans-soft", note: "Legacy: OnlyFans's soft tint." },
  telegram: { value: both("#1f7fb5", "#6cc0ec"), console: "telegram", note: "Legacy: Telegram's tint." },
  telegramSoft: { value: both("#e6f3fa", "#13293a"), console: "telegram-soft", note: "Legacy: Telegram's soft tint." },
  warningDark: { value: both("#7a4708", "#f5bd6e"), console: "warning-dark", note: "Legacy: the same as warnText." },
  onAccent: { value: both("#ffffff", "#0c0f18"), console: "on-accent", note: "Legacy: text on `bg-accent`." },
  onDanger: { value: both("#ffffff", "#1a0a0a"), console: "on-danger", note: "Legacy: text on a danger fill." },
  dangerHover: { value: both("#a92f2f", "#f59696"), console: "danger-hover", note: "Legacy: danger under the pointer." },
} as const satisfies Record<string, ColorToken>;

export type ColorName = keyof typeof COLORS;

/** Inter 400/500/600, the system's sans after it. */
export const FONT = {
  family: "\"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  weightBold: 600,
} as const;

/**
 * The one type scale: size → line height, in px. Nothing below 13 px; 13 only for
 * axes, heat maps and keys.
 */
export const TYPE_SCALE = {
  13: 18,
  14: 20,
  15: 22,
  16: 24,
  17: 24,
  20: 28,
  24: 32,
  28: 36,
  32: 40,
  40: 48,
} as const;

export type TypeSize = keyof typeof TYPE_SCALE;

/** The sizes Workboard names `--ui-fs-<size>` / `--ui-lh-<size>`. */
export const UI_TYPE_SIZES: readonly TypeSize[] = [13, 14, 15, 16, 20, 24, 32];

/** The console's Tailwind names (`text-<name>`) and the size each one is. */
export const CONSOLE_TYPE_SIZES: Readonly<Record<string, TypeSize>> = {
  "2xs": 13,
  xs: 14,
  sm: 15,
  base: 17,
  lg: 17,
  xl: 24,
  "2xl": 24,
  "3xl": 28,
  "4xl": 40,
};

/** Long reading (a conversation): 16 on 26; a line of reading never wider than 72ch. */
export const READING = { lineHeight: 26, measure: "72ch" } as const;

/** Space: 4 8 12 16 24 32 48 64, nothing else. The key is the step (`--ui-space-<step>`). */
export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 16: 64 } as const;

/** Corners, px: inner (a badge, a field's part), a control, a card. */
export const RADIUS = { inner: 6, control: 8, card: 12 } as const;

/** Heights of a control, px. */
export const CONTROL = { sm: 32, md: 36, lg: 44 } as const;

/** Almost no shadows: a sheet has none. `floatRing` is Workboard's hairline around a float. */
export const SHADOW = {
  raised: "0 1px 2px light-dark(rgb(28 25 23 / 0.1), rgb(0 0 0 / 0.4))",
  float: "0 8px 24px light-dark(rgb(28 25 23 / 0.12), rgb(0 0 0 / 0.5))",
  floatRing: "0 0 0 1px light-dark(rgb(28 25 23 / 0.04), rgb(255 255 255 / 0.04))",
} as const;

/** Keyboard focus: 2 px of ink, 2 px away. */
export const FOCUS = { width: 2, offset: 2 } as const;

/** Motion: a colour change, a panel sliding in. Nothing else moves. */
export const MOTION = { fast: "150ms", slide: "200ms" } as const;

/** Layers. */
export const LAYERS = { sticky: 4, header: 5, drawer: 10, menu: 20, modal: 30, toast: 40, tooltip: 50 } as const;

/** Every value above in one object: what `tokens.json` of a vendored copy holds. */
export const TOKENS = {
  colors: COLORS,
  font: FONT,
  typeScale: TYPE_SCALE,
  uiTypeSizes: UI_TYPE_SIZES,
  consoleTypeSizes: CONSOLE_TYPE_SIZES,
  reading: READING,
  space: SPACE,
  radius: RADIUS,
  control: CONTROL,
  shadow: SHADOW,
  focus: FOCUS,
  motion: MOTION,
  layers: LAYERS,
} as const;
