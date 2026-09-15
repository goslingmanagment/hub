import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountLinkItem, AdminUser, DeviceTokenItem } from "@agency_hub_core/contracts";

/**
 * Decision 350 — the Team tab, replacing tests/users-tab.test.ts.
 *
 * What is worth pinning here is the owner's side of the invite story: who
 * shows as waiting for their registration, which revocation each button
 * actually performs, and that the link a person receives is shown once and
 * carries its secret in the URL fragment. The api layer is mocked: TanStack is
 * not resolvable from the root test suite.
 */

const queries = vi.hoisted(() => ({
  useAdminUsers: vi.fn(),
  useCreateInvite: vi.fn(),
  useCreateAccountLink: vi.fn(),
  useUserDevices: vi.fn(),
  useUserLinks: vi.fn(),
  useRevokeDevice: vi.fn(),
  useRevokeAllDevices: vi.fn(),
  useRevokeLink: vi.fn(),
  useTerminateAccess: vi.fn(),
  useAdminDeactivateUser: vi.fn(),
  useAdminReactivateUser: vi.fn(),
  useAdminPages: vi.fn(),
  useAdminAssignPage: vi.fn(),
  useAdminUnassignPage: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);

import { TeamTab } from "../apps/dashboard/src/pages/settings/team/TeamTab.tsx";
import { InviteModal } from "../apps/dashboard/src/pages/settings/team/InviteModal.tsx";
import { LinkRevealModal } from "../apps/dashboard/src/pages/settings/team/LinkRevealModal.tsx";
import { UserDetailModal } from "../apps/dashboard/src/pages/settings/team/UserDetailModal.tsx";
import {
  buildJoinLink,
  daysToHours,
  deviceRevokedReasonLabel,
  findTeamMember,
  formatRelativeRu,
  groupPagesByPlatform,
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  isValidUsername,
  linkRevokedReasonLabel,
  linkStateLabel,
  REVOCATION_LABEL,
  splitDevices,
  sortTeamByActivity,
  teamStatus,
  telegramMessage,
} from "../apps/dashboard/src/pages/settings/team/teamView.ts";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const HOUR = 3_600_000;

function user(overrides: Partial<AdminUser> & { username: string }): AdminUser {
  return {
    id: overrides.username.length,
    role: "chatter",
    mustChangePassword: false,
    assignedPages: [],
    apiKeyStatus: null,
    disabledAt: null,
    lastActiveAt: null,
    registrationState: "active",
    ...overrides,
  };
}

function device(overrides: Partial<DeviceTokenItem> & { id: number; label: string }): DeviceTokenItem {
  return {
    keyPrefix: "agency_hub_device_aaaa",
    harvestMachineId: null,
    isActive: true,
    expiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
    lastUsedAt: null,
    lastClientVersion: null,
    createdAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function link(overrides: Partial<AccountLinkItem> & { id: number }): AccountLinkItem {
  return {
    kind: "invite",
    keyPrefix: "aaaaaaaaaa",
    state: "active",
    expiresAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
    usedAt: null,
    revokedAt: null,
    revokedReason: null,
    createdAt: new Date(Date.now() - HOUR).toISOString(),
    createdBy: 1,
    ...overrides,
  };
}

function query<T>(data: T | undefined, overrides: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function mutation(overrides: Record<string, unknown> = {}) {
  return { mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})), isPending: false, ...overrides };
}

function render(component: ComponentType<Record<string, unknown>>, props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(component, props));
}

function mockEverything() {
  queries.useCreateInvite.mockReturnValue(mutation());
  queries.useCreateAccountLink.mockReturnValue(mutation());
  queries.useUserDevices.mockReturnValue(query<DeviceTokenItem[]>([]));
  queries.useUserLinks.mockReturnValue(query<AccountLinkItem[]>([]));
  queries.useRevokeDevice.mockReturnValue(mutation());
  queries.useRevokeAllDevices.mockReturnValue(mutation());
  queries.useRevokeLink.mockReturnValue(mutation());
  queries.useTerminateAccess.mockReturnValue(mutation());
  queries.useAdminDeactivateUser.mockReturnValue(mutation());
  queries.useAdminReactivateUser.mockReturnValue(mutation());
  queries.useAdminPages.mockReturnValue(query<unknown[]>([]));
  queries.useAdminAssignPage.mockReturnValue(mutation());
  queries.useAdminUnassignPage.mockReturnValue(mutation());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/*  View logic                                                         */
/* ------------------------------------------------------------------ */

describe("teamStatus", () => {
  it("reads an account without a password as waiting for its invite", () => {
    expect(teamStatus(user({ username: "grisha", registrationState: "invited" }))).toBe("invited");
  });

  it("reads a finished registration as active", () => {
    expect(teamStatus(user({ username: "grisha" }))).toBe("active");
  });

  it("lets deactivation win over an unfinished registration", () => {
    expect(teamStatus(user({
      username: "ivan",
      registrationState: "invited",
      disabledAt: "2026-09-01T00:00:00.000Z",
    }))).toBe("disabled");
  });
});

describe("findTeamMember", () => {
  it("returns the freshest record, so a modal never edits a stale copy", () => {
    const stale = user({ username: "anton" });
    const refreshed = user({
      username: "anton",
      assignedPages: [{ id: 11, label: "lana", platform: "fansly", modelSlug: "lana", modelName: "Lana" }],
      lastActiveAt: "2026-09-15T00:00:00.000Z",
    });
    expect(findTeamMember([refreshed], stale.username)).toEqual(refreshed);
  });

  it("returns null when the person is no longer in the list", () => {
    expect(findTeamMember([], "missing")).toBeNull();
    expect(findTeamMember([user({ username: "grisha" })], "sveta")).toBeNull();
  });
});

describe("sortTeamByActivity", () => {
  it("puts freshest activity first and never-active rows last, alphabetically", () => {
    const sorted = sortTeamByActivity([
      user({ username: "codex-probe-b" }),
      user({ username: "ivan", lastActiveAt: "2026-05-15T00:00:00.000Z" }),
      user({ username: "codex-probe-a" }),
      user({ username: "maxim", lastActiveAt: "2026-07-10T00:00:00.000Z" }),
    ]);
    expect(sorted.map((item) => item.username)).toEqual(["maxim", "ivan", "codex-probe-a", "codex-probe-b"]);
  });
});

describe("groupPagesByPlatform", () => {
  it("groups by platform in the canonical order and omits platforms with no pages", () => {
    const groups = groupPagesByPlatform([
      { id: 1, platform: "onlyfans" as const, label: "lora-of" },
      { id: 2, platform: "fansly" as const, label: "lora" },
      { id: 3, platform: "onlyfans" as const, label: "lilly-of" },
    ]);
    expect(groups.map((group) => group.platform)).toEqual(["fansly", "onlyfans"]);
    expect(groups.map((group) => group.pages.map((page) => page.label))).toEqual([
      ["lora"],
      ["lora-of", "lilly-of"],
    ]);
    expect(groupPagesByPlatform([{ id: 1, platform: "fansly" as const }]).map((g) => g.label)).toEqual(["Fansly"]);
  });
});

describe("the invite link", () => {
  it("carries its secret in the URL fragment, so no server log ever sees it", () => {
    expect(buildJoinLink("https://gosling-agency.ru", "s3cr3t")).toBe("https://gosling-agency.ru/join#s3cr3t");
  });

  it("writes a Telegram message a person can act on without being told anything else", () => {
    const message = telegramMessage("invite", "grisha", "https://gosling-agency.ru/join#s3cr3t");
    expect(message).toContain("https://gosling-agency.ru/join#s3cr3t");
    expect(message).toContain("Логин: grisha");
    expect(message).toContain("https://ext.gosling-agency.ru/start.html");
  });

  it("says «новый пароль», not «приглашение», for a reset", () => {
    const message = telegramMessage("password_reset", "grisha", "https://hub/join#x");
    expect(message).toContain("новый пароль");
    expect(message).not.toContain("Как начать");
  });

  it("accepts the usernames the kernel accepts and refuses the rest", () => {
    expect(isValidUsername("grisha")).toBe(true);
    expect(isValidUsername("gri.sha_1-2")).toBe(true);
    expect(isValidUsername("_grisha")).toBe(false);
    expect(isValidUsername("гриша")).toBe(false);
    expect(isValidUsername("a".repeat(101))).toBe(false);
  });

  it("converts the owner's days into the contract's hours, inside the 30-day ceiling", () => {
    expect(daysToHours(INVITE_DEFAULT_DAYS)).toBe(168);
    expect(daysToHours(INVITE_MAX_DAYS)).toBe(720);
  });
});

describe("linkStateLabel", () => {
  const formatDate = (iso: string) => iso.slice(0, 10);

  it("tells the owner what became of each link", () => {
    expect(linkStateLabel(link({ id: 1, expiresAt: "2026-09-22T00:00:00.000Z" }), formatDate))
      .toBe("действует до 2026-09-22");
    expect(linkStateLabel(link({ id: 2, state: "used", usedAt: "2026-09-16T00:00:00.000Z" }), formatDate))
      .toBe("использована 2026-09-16");
    expect(linkStateLabel(link({ id: 3, state: "expired", expiresAt: "2026-09-01T00:00:00.000Z" }), formatDate))
      .toBe("истекла 2026-09-01");
    expect(linkStateLabel(link({ id: 4, state: "revoked", revokedReason: "superseded" }), formatDate))
      .toBe("отозвана — заменена новой");
    expect(linkStateLabel(link({ id: 5, state: "revoked", revokedReason: null }), formatDate))
      .toBe("отозвана");
  });
});

describe("revocation reasons", () => {
  it("translates the reasons it knows", () => {
    expect(deviceRevokedReasonLabel("password_set")).toBe("пароль изменён");
    expect(linkRevokedReasonLabel("superseded")).toBe("заменена новой");
  });

  it("drops a reason it does not know instead of printing the machine word", () => {
    expect(deviceRevokedReasonLabel("some_future_kernel_reason")).toBeNull();
    expect(linkRevokedReasonLabel("some_future_kernel_reason")).toBeNull();
    expect(deviceRevokedReasonLabel(null)).toBeNull();
    expect(linkRevokedReasonLabel(null)).toBeNull();
  });

  it("falls back to the plain state for an unknown link reason", () => {
    const formatDate = (iso: string) => iso.slice(0, 10);
    expect(linkStateLabel(link({ id: 9, state: "revoked", revokedReason: "future_reason" }), formatDate))
      .toBe("отозвана");
  });
});

describe("splitDevices", () => {
  it("shows live sign-ins by freshness and keeps two sign-ins from one laptop apart", () => {
    const devices = [
      device({ id: 1, label: "Firefox · Windows", lastUsedAt: new Date(Date.now() - 5 * HOUR).toISOString() }),
      device({ id: 2, label: "Firefox · Windows", lastUsedAt: new Date(Date.now() - HOUR).toISOString() }),
      device({
        id: 3,
        label: "Desktop · MacBook-Air",
        isActive: false,
        revokedAt: new Date(Date.now() - 10 * HOUR).toISOString(),
        revokedReason: "revoked_by_owner",
      }),
    ];
    const { active, history } = splitDevices(devices);
    expect(active.map((item) => item.id)).toEqual([2, 1]);
    expect(history.map((item) => item.id)).toEqual([3]);
  });
});

describe("formatRelativeRu", () => {
  it("speaks Russian about how long ago something happened", () => {
    const now = Date.parse("2026-09-15T12:00:00.000Z");
    expect(formatRelativeRu("2026-09-15T11:59:40.000Z", now)).toBe("только что");
    expect(formatRelativeRu("2026-09-15T11:30:00.000Z", now)).toBe("30 мин назад");
    expect(formatRelativeRu("2026-09-15T09:00:00.000Z", now)).toBe("3 ч назад");
    expect(formatRelativeRu("2026-09-13T12:00:00.000Z", now)).toBe("2 дн назад");
  });
});

/* ------------------------------------------------------------------ */
/*  The tab                                                            */
/* ------------------------------------------------------------------ */

describe("TeamTab", () => {
  it("shows each person with their role, state and last activity", () => {
    mockEverything();
    queries.useAdminUsers.mockReturnValue(query([
      user({
        username: "grisha",
        lastActiveAt: new Date(Date.now() - 3 * HOUR).toISOString(),
        assignedPages: [{ id: 1, label: "lora", platform: "fansly", modelSlug: "lora", modelName: "Lora" }],
      }),
      user({ username: "sveta", registrationState: "invited" }),
      user({ username: "boss", role: "owner" }),
    ]));

    const markup = render(TeamTab);
    expect(markup).toContain("grisha");
    expect(markup).toContain("чаттер");
    expect(markup).toContain("3 ч назад");
    expect(markup).toContain("ждёт регистрации");
    expect(markup).toContain("ещё не работал");
    expect(markup).toContain("владелец");
    expect(markup).toContain("Пригласить");
    expect(markup).toContain("lora");
  });

  it("keeps deactivated people as a tombstoned, collapsed list (#126)", () => {
    mockEverything();
    queries.useAdminUsers.mockReturnValue(query([
      user({ username: "ivan", disabledAt: new Date(Date.now() - 24 * HOUR).toISOString() }),
    ]));

    const markup = render(TeamTab);
    expect(markup).toContain("Деактивированные (1)");
    expect(markup).toContain("В команде");
    expect(markup).toContain("пока никого");
  });

  // Р8: the human key surface is gone, not hidden behind a role check.
  it("offers no way to issue, rotate or reveal a key", () => {
    mockEverything();
    queries.useAdminUsers.mockReturnValue(query([user({ username: "grisha" })]));

    const markup = render(TeamTab);
    for (const gone of ["Issue Key", "New Key", "Key Status", "No key", "Add Chatter", "Create User"]) {
      expect(markup).not.toContain(gone);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  The person's card                                                  */
/* ------------------------------------------------------------------ */

describe("UserDetailModal", () => {
  function renderCard(target: AdminUser) {
    return render(UserDetailModal as ComponentType<Record<string, unknown>>, {
      user: target,
      createLink: mutation(),
      onClose: vi.fn(),
      onLinkCreated: vi.fn(),
    });
  }

  it("names each revocation for how far it actually reaches (§4.4)", () => {
    mockEverything();
    queries.useUserDevices.mockReturnValue(query([device({ id: 1, label: "Firefox · Windows" })]));
    const markup = renderCard(user({ username: "grisha" }));
    expect(markup).toContain(REVOCATION_LABEL.device);
    expect(markup).toContain(REVOCATION_LABEL.allDevices);
    expect(markup).toContain(REVOCATION_LABEL.allAccess);
  });

  it("shows a live sign-in by its label, client version and last use", () => {
    mockEverything();
    queries.useUserDevices.mockReturnValue(query([
      device({
        id: 1,
        label: "Firefox · Windows",
        lastClientVersion: "2.2.2",
        lastUsedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      }),
    ]));

    const markup = renderCard(user({ username: "grisha" }));
    expect(markup).toContain("Firefox · Windows");
    expect(markup).toContain("версия 2.2.2");
    expect(markup).toContain("2 ч назад");
  });

  it("offers a repeat invite while a registration is unfinished, and a password link after", () => {
    mockEverything();
    const waiting = renderCard(user({ username: "sveta", registrationState: "invited" }));
    expect(waiting).toContain("Отправить приглашение заново");
    expect(waiting).not.toContain("Сбросить пароль ссылкой");
    expect(waiting).toContain("ещё не открыл приглашение");

    const working = renderCard(user({ username: "grisha" }));
    expect(working).toContain("Сбросить пароль ссылкой");
    expect(working).not.toContain("Отправить приглашение заново");
  });

  it("never offers a link reset for an owner — owners change their own password (§4.1 п.8)", () => {
    mockEverything();
    const markup = renderCard(user({ username: "admin", role: "owner" }));
    expect(markup).not.toContain("Сбросить пароль ссылкой");
    expect(markup).not.toContain("Отправить приглашение заново");
  });

  // The kernel answers 400 to both, in English. A button that can only produce
  // a foreign error message is worse than no button.
  it("offers an owner no dead end: no termination, no deactivation, no link reset", () => {
    mockEverything();
    queries.useUserDevices.mockReturnValue(query([device({ id: 1, label: "Firefox · Windows" })]));
    const markup = renderCard(user({ username: "admin", role: "owner" }));

    expect(markup).not.toContain(REVOCATION_LABEL.allAccess);
    expect(markup).not.toContain("Деактивировать");
    expect(markup).not.toContain("Сбросить пароль ссылкой");
    expect(markup).not.toContain("Отправить приглашение заново");
    // What an owner CAN do to their own sign-ins stays available.
    expect(markup).toContain(REVOCATION_LABEL.device);
    expect(markup).toContain(REVOCATION_LABEL.allDevices);
    expect(markup).toContain("Владельца нельзя деактивировать");
  });

  it("still offers both to everyone else", () => {
    mockEverything();
    queries.useUserDevices.mockReturnValue(query([device({ id: 1, label: "Firefox · Windows" })]));
    const markup = renderCard(user({ username: "grisha", role: "chatter" }));
    expect(markup).toContain(REVOCATION_LABEL.allAccess);
    expect(markup).toContain("Деактивировать");
  });

  it("prints the link history with its state and offers to revoke a live one", () => {
    mockEverything();
    queries.useUserLinks.mockReturnValue(query([
      link({ id: 1, kind: "password_reset", state: "used", usedAt: new Date(Date.now() - HOUR).toISOString() }),
      link({ id: 2 }),
    ]));

    const markup = renderCard(user({ username: "grisha" }));
    expect(markup).toContain("сброс пароля");
    expect(markup).toContain("использована");
    expect(markup).toContain("приглашение");
    expect(markup).toContain("Отозвать ссылку");
  });

  it("gives the shared page editor the owner's language", () => {
    mockEverything();
    const markup = renderCard(user({ username: "grisha" }));
    expect(markup).toContain("Страниц пока нет.");
    expect(markup).toContain("Закрыть");
    expect(markup).not.toContain("Assigned Pages");
    expect(markup).not.toContain("No pages assigned.");
    expect(markup).not.toContain(">Close<");
  });

  it("offers deactivation for a working person and a return for a deactivated one", () => {
    mockEverything();
    expect(renderCard(user({ username: "grisha" }))).toContain("Деактивировать");
    expect(renderCard(user({ username: "ivan", disabledAt: "2026-09-01T00:00:00.000Z" })))
      .toContain("Вернуть в команду");
  });
});

/* ------------------------------------------------------------------ */
/*  Invite and reveal                                                  */
/* ------------------------------------------------------------------ */

describe("InviteModal", () => {
  it("groups the pages by platform and keeps role and expiry out of the way", () => {
    mockEverything();
    queries.useAdminPages.mockReturnValue(query([
      { id: 1, label: "lora-of", platform: "onlyfans", modelName: "Lora" },
      { id: 2, label: "lora", platform: "fansly", modelName: "Lora" },
    ]));

    const markup = render(InviteModal as ComponentType<Record<string, unknown>>, {
      create: mutation(),
      onClose: vi.fn(),
      onCreated: vi.fn(),
    });

    expect(markup.indexOf("Fansly")).toBeLessThan(markup.indexOf("OnlyFans"));
    expect(markup).toContain("lora-of");
    expect(markup).toContain("Создать приглашение");
    expect(markup).toContain("Дополнительно");
    // Advanced is collapsed: role and expiry are not on the first screen.
    expect(markup).not.toContain("Срок ссылки");
    expect(markup).toContain("Пароль он придумает сам");
  });

  it("refuses to submit an empty login", () => {
    mockEverything();
    queries.useAdminPages.mockReturnValue(query([]));
    const markup = render(InviteModal as ComponentType<Record<string, unknown>>, {
      create: mutation(),
      onClose: vi.fn(),
      onCreated: vi.fn(),
    });
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Создать приглашение<\/button>/);
  });
});

describe("LinkRevealModal", () => {
  it("shows the link once, on this origin, with a message ready for Telegram", () => {
    vi.stubGlobal("window", { location: { origin: "https://gosling-agency.ru" } });

    const markup = render(LinkRevealModal as ComponentType<Record<string, unknown>>, {
      link: {
        username: "grisha",
        kind: "invite",
        secret: "s3cr3t",
        expiresAt: "2026-09-22T00:00:00.000Z",
      },
      onClose: vi.fn(),
    });

    expect(markup).toContain("https://gosling-agency.ru/join#s3cr3t");
    expect(markup).toContain("показывается один раз");
    expect(markup).toContain("Скопировать");
    expect(markup).toContain("Логин: grisha");
    expect(markup).toContain("Приглашение для grisha");
  });

  it("cannot be dismissed by a stray backdrop click — the link is unrecoverable", () => {
    vi.stubGlobal("window", { location: { origin: "https://gosling-agency.ru" } });
    const onClose = vi.fn();
    const markup = render(LinkRevealModal as ComponentType<Record<string, unknown>>, {
      link: { username: "grisha", kind: "invite", secret: "s3cr3t", expiresAt: "2026-09-22T00:00:00.000Z" },
      onClose,
    });
    // The backdrop carries no click handler, so only the explicit buttons close it.
    expect(markup).toContain("Готово");
    expect(markup).toContain("Закрыть");
    expect(markup).not.toContain(">Close<");
  });

  it("titles a password link for what it is", () => {
    vi.stubGlobal("window", { location: { origin: "https://gosling-agency.ru" } });
    const markup = render(LinkRevealModal as ComponentType<Record<string, unknown>>, {
      link: {
        username: "grisha",
        kind: "password_reset",
        secret: "s3cr3t",
        expiresAt: "2026-09-22T00:00:00.000Z",
      },
      onClose: vi.fn(),
    });
    expect(markup).toContain("Ссылка для нового пароля — grisha");
  });
});
