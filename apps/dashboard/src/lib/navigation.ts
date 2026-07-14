import { pathSegment } from "./path.js";

export interface FanProfileNavigationState {
  backTo: string;
  fanLabel?: string;
}

export type SettingsTab = "credentials" | "sync" | "models" | "personas" | "pages" | "users" | "configuration";

const SETTINGS_TABS = new Set<SettingsTab>([
  "credentials",
  "sync",
  "models",
  "personas",
  "pages",
  "users",
  "configuration",
]);

export function buildPageRoute(pageLabel: string) {
  return `/pages/${pathSegment(pageLabel)}`;
}

export function decodeRouteSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildPageSectionRoute(pageLabel: string, section: string) {
  return `${buildPageRoute(pageLabel)}/${section}`;
}

export function buildPageSpenderAutoListRoute(pageLabel: string, bucketKey: string) {
  return `${buildPageSectionRoute(pageLabel, "spender-autolists")}/${pathSegment(bucketKey)}`;
}

export function buildWorkboardRoute(pageLabel: string) {
  return buildPageSectionRoute(pageLabel, "workboard");
}

export function buildAiAnalyticsRoute(pageLabel?: string | null) {
  if (!pageLabel) {
    return "/ai-analytics";
  }
  const query = new URLSearchParams({ page: pageLabel }).toString();
  return `/ai-analytics?${query}`;
}

export function resolveLegacyWorkboardRedirect(pageLabel: string | undefined) {
  return pageLabel ? buildWorkboardRoute(pageLabel) : "/";
}

export function buildFanProfileRoute(
  pageLabel: string,
  platform: string,
  platformUserId: string,
) {
  return `${buildPageRoute(pageLabel)}/fans/${pathSegment(platform)}/${pathSegment(platformUserId)}`;
}

export function buildFanProfileNavigation(
  pageLabel: string,
  platform: string,
  platformUserId: string,
  backTo: string,
  fanLabel?: string,
) {
  return {
    to: buildFanProfileRoute(pageLabel, platform, platformUserId),
    state: { backTo, fanLabel } satisfies FanProfileNavigationState,
  };
}

export function resolveFanLabelFromState(state: unknown): string | undefined {
  if (
    typeof state === "object"
    && state !== null
    && "fanLabel" in state
    && typeof state.fanLabel === "string"
  ) {
    return state.fanLabel;
  }
  return undefined;
}

export function buildSettingsRoute(tab: SettingsTab) {
  return `/settings?tab=${tab}`;
}

export function resolveSettingsTab(value: string | null | undefined): SettingsTab {
  return typeof value === "string" && SETTINGS_TABS.has(value as SettingsTab)
    ? value as SettingsTab
    : "credentials";
}

function isSafeInAppPath(value: string) {
  return value.startsWith("/") && !value.startsWith("//");
}

export function resolveFanProfileBackTarget(
  state: unknown,
  pageLabel: string | undefined,
) {
  if (
    typeof state === "object"
    && state !== null
    && "backTo" in state
    && typeof state.backTo === "string"
    && isSafeInAppPath(state.backTo)
  ) {
    return state.backTo;
  }

  return pageLabel ? buildPageRoute(pageLabel) : "/";
}
