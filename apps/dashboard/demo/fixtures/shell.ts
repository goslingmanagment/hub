import { daysAgo, hoursAgo, iso, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_PAGES, demoUserByRole, type DemoPage } from "../world.ts";

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

function syncUx(page: DemoPage, now: Date) {
  if (page.health === "off") {
    return {
      state: "off" as const,
      label: "Нет доступа",
      headline: "Сбор OnlyFans выключен",
      detail: "Доступ к OnlyFans через сервис выключен с 1 ноября.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: iso(daysAgo(now, 2)),
      requiresAction: false,
    };
  }
  if (page.health === "attention") {
    return {
      state: "attention" as const,
      label: "Нужна проверка",
      headline: "Подписчики давно не обновлялись",
      detail: "Последнее обновление списка подписчиков было 9 часов назад.",
      progressLabel: null,
      nextRetryAt: iso(hoursAgo(now, -1)),
      updatedAt: iso(hoursAgo(now, 9)),
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
      lastLightSyncAt: page.health === "off" ? iso(daysAgo(request.now, 2)) : iso(hoursAgo(request.now, 0.3)),
      lastFollowerSyncAt: page.platform === "fansly" ? iso(hoursAgo(request.now, page.health === "attention" ? 9 : 1)) : null,
    }));
  },

  adminConnections: (request) => DEMO_PAGES.map((page) => ({
    ...pageRef(page),
    username: page.username,
    displayName: page.displayName,
    connectionStatus: page.health === "off" ? "expired" as const : page.health === "attention" ? "stale" as const : "active" as const,
    lastLightSyncAt: page.health === "off" ? iso(daysAgo(request.now, 2)) : iso(hoursAgo(request.now, 0.3)),
    lastFollowerSyncAt: page.platform === "fansly" ? iso(hoursAgo(request.now, page.health === "attention" ? 9 : 1)) : null,
    lastSyncError: page.health === "off" ? "Сбор OnlyFans выключен" : null,
    subscriberCount: { value: page.subscribers, available: true },
    followerCount: { value: page.followers, available: page.followers !== null },
    proxyUrl: page.platform === "fansly" ? "socks5://proxy.demo.invalid:1080" : null,
    proxyHasAuth: page.platform === "fansly",
    syncUx: syncUx(page, request.now),
  })),
};
