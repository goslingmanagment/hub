export interface FanProfileNavigationState {
  backTo: string;
}

export type SettingsTab = "credentials" | "sync" | "models" | "pages" | "users";

const SETTINGS_TABS = new Set<SettingsTab>([
  "credentials",
  "sync",
  "models",
  "pages",
  "users",
]);

export function buildPageRoute(pageLabel: string) {
  return `/pages/${pageLabel}`;
}

export function buildPageSectionRoute(pageLabel: string, section: string) {
  return `${buildPageRoute(pageLabel)}/${section}`;
}

export function buildFanProfileRoute(
  pageLabel: string,
  platform: string,
  platformUserId: string,
) {
  return `${buildPageRoute(pageLabel)}/fans/${platform}/${platformUserId}`;
}

export function buildFanProfileNavigation(
  pageLabel: string,
  platform: string,
  platformUserId: string,
  backTo: string,
) {
  return {
    to: buildFanProfileRoute(pageLabel, platform, platformUserId),
    state: { backTo } satisfies FanProfileNavigationState,
  };
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
