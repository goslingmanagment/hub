import { hoursAgo, iso, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_OFAPI_OFF_AT, DEMO_PAGES, demoUserByRole, type DemoPage } from "../world.ts";

function principal(request: DemoRequest) {
  const user = demoUserByRole(request.role);
  return {
    authMethod: "session" as const,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: false,
      assignedPages: DEMO_PAGES.filter((page) => user.pages.includes(page.label)).map(pageRef),
    },
  };
}

function pageRef(page: DemoPage) {
  return { id: page.id, label: page.label, platform: page.platform, modelSlug: page.modelSlug, modelName: page.modelName };
}

/** On production it is empty on an OnlyFans page and on a Telegram one. */
function lastLightSync(page: DemoPage, now: Date): string | null {
  return page.platform === "fansly" ? iso(hoursAgo(now, page.health === "attention" ? 5.2 : 0.3)) : null;
}

function syncUx(page: DemoPage, now: Date) {
  if (page.platform === "telegram") {
    return {
      state: "off" as const,
      label: "Сбор не нужен",
      headline: "Hub не собирает данные Telegram",
      detail: null,
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: null,
      requiresAction: false,
    };
  }
  if (page.health === "off") {
    return {
      state: "off" as const,
      label: "Нет доступа",
      headline: "Сбор OnlyFans выключен",
      detail: "Доступ к OnlyFans через сервис выключен с 1 ноября.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: iso(new Date(DEMO_OFAPI_OFF_AT)),
      requiresAction: false,
    };
  }
  if (page.health === "attention") {
    return {
      state: "attention" as const,
      label: "Нужен вход",
      headline: "Fansly вышел из аккаунта",
      detail: "Fansly signed the page's browser out; a new login is needed.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: iso(hoursAgo(now, 5.2)),
      requiresAction: true,
    };
  }
  return {
    state: "healthy" as const,
    label: "В порядке",
    headline: "Данные свежие",
    detail: null,
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: iso(hoursAgo(now, 0.2)),
    requiresAction: false,
  };
}

export const shellHandlers: DemoHandlers = {
  me: (request) => principal(request),
  login: (request) => principal(request),
  logout: () => ({ ok: true as const }),

  pages: (request) => {
    const user = demoUserByRole(request.role);
    return DEMO_PAGES.filter((page) => user.pages.includes(page.label)).map((page) => ({
      ...pageRef(page),
      username: page.username,
      displayName: page.displayName,
      followerCount: { value: page.followers, available: page.followers !== null },
      subscriberCount: { value: page.subscribers, available: true },
      lastLightSyncAt: lastLightSync(page, request.now),
      lastFollowerSyncAt: page.platform === "fansly" ? iso(hoursAgo(request.now, page.health === "attention" ? 5.2 : 1)) : null,
    }));
  },

  adminConnections: (request) => DEMO_PAGES.map((page) => ({
    ...pageRef(page),
    username: page.username,
    displayName: page.displayName,
    connectionStatus: page.health === "off" ? "expired" as const : page.health === "attention" ? "stale" as const : "active" as const,
    lastLightSyncAt: lastLightSync(page, request.now),
    lastFollowerSyncAt: page.platform === "fansly" ? iso(hoursAgo(request.now, page.health === "attention" ? 5.2 : 1)) : null,
    lastSyncError: page.health === "off" ? "Сбор OnlyFans выключен" : null,
    subscriberCount: { value: page.subscribers, available: true },
    followerCount: { value: page.followers, available: page.followers !== null },
    proxyUrl: page.platform === "fansly" ? "socks5://proxy.demo.invalid:1080" : null,
    proxyHasAuth: page.platform === "fansly",
    syncUx: syncUx(page, request.now),
  })),
};
