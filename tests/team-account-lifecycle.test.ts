import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@agency_hub_core/contracts";

const queries = vi.hoisted(() => ({
  useAuthMe: vi.fn(),
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
  useAdminDeleteUser: vi.fn(),
  useAdminPages: vi.fn(),
  useAdminAssignPage: vi.fn(),
  useAdminUnassignPage: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);

interface ConfirmationProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}
const confirmation = vi.hoisted(() => ({ current: null as ConfirmationProps | null }));
vi.mock("../apps/dashboard/src/components/shared/ConfirmModal.tsx", async () => {
  const { createElement: element } = await import("react");
  return {
    ConfirmModal: (props: ConfirmationProps) => {
      confirmation.current = props;
      return element("section", null, props.title, props.message, props.confirmLabel);
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TeamMemberDetail } from "../apps/dashboard/src/pages/settings/team/TeamTab.tsx";
import { ConfirmationDialog, UserDetailModal } from "../apps/dashboard/src/pages/settings/team/UserDetailModal.tsx";

function member(id: number, username = "Nikita"): AdminUser {
  return {
    id, username, role: "chatter", assignedPages: [], apiKeyStatus: null,
    mustChangePassword: false, disabledAt: null, deletedAt: null,
    lastActiveAt: null, registrationState: "active",
  };
}

function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(async () => ({ ok: true })), isPending: false };
}

function query<T>(data: T) {
  return { data, isLoading: false, isError: false, error: null, isFetching: false, refetch: vi.fn() };
}

beforeEach(() => {
  for (const mock of Object.values(queries)) mock.mockReset();
  for (const name of ["useUserDevices", "useUserLinks", "useAdminPages", "useAdminUsers"] as const) {
    queries[name].mockReturnValue(query([]));
  }
  for (const name of [
    "useCreateInvite", "useCreateAccountLink", "useRevokeDevice", "useRevokeAllDevices", "useRevokeLink",
    "useTerminateAccess", "useAdminDeactivateUser", "useAdminReactivateUser", "useAdminDeleteUser",
    "useAdminAssignPage", "useAdminUnassignPage",
  ] as const) queries[name].mockReturnValue(mutation());
  queries.useAuthMe.mockReturnValue(query({ user: { id: 1, role: "owner" } }));
  confirmation.current = null;
});

function renderCard(user: AdminUser) {
  return renderToStaticMarkup(createElement(UserDetailModal, {
    user, createLink: queries.useCreateAccountLink(), onClose: vi.fn(), onLinkCreated: vi.fn(),
  }));
}

describe("permanent account deletion", () => {
  it("offers a separate deletion action without sending a request", () => {
    const markup = renderCard(member(17));
    expect(markup).toContain("Отключить доступ");
    expect(markup).toContain("Удалить аккаунт");
    expect(markup).toContain("логин освободится");
    expect(markup).toContain("История работы сохранится");
    expect(queries.useAdminDeleteUser).not.toHaveBeenCalled();
    expect(confirmation.current).toBeNull();
  });

  it("waits for explicit confirmation and targets the selected immutable ID", async () => {
    const deletion = mutation();
    queries.useAdminDeleteUser.mockReturnValue(deletion);
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    const markup = renderToStaticMarkup(createElement(ConfirmationDialog, {
      kind: "deleteAccount", user: member(17), onClose, onDeleted,
    }));

    expect(markup).toContain("без возможности восстановления");
    expect(markup).toContain("Все его входы, ссылки и доступ к страницам будут отозваны");
    expect(markup).toContain("Логин освободится");
    expect(markup).toContain("новый участник с этим логином получит отдельный аккаунт");
    expect(markup).toContain("финансовые записи останутся за прежним участником");
    expect(queries.useAdminDeleteUser).toHaveBeenCalledWith(17);
    expect(deletion.mutateAsync).not.toHaveBeenCalled();

    await confirmation.current!.onConfirm();

    expect(deletion.mutateAsync).toHaveBeenCalledExactlyOnceWith();
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancelling the confirmation never requests deletion", () => {
    const deletion = mutation();
    queries.useAdminDeleteUser.mockReturnValue(deletion);
    const onClose = vi.fn();
    renderToStaticMarkup(createElement(ConfirmationDialog, {
      kind: "deleteAccount", user: member(17), onClose, onDeleted: vi.fn(),
    }));

    confirmation.current!.onClose();

    expect(onClose).toHaveBeenCalledOnce();
    expect(deletion.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not offer deletion for an owner or the signed-in user", () => {
    expect(renderCard({ ...member(17), role: "owner" })).not.toContain("Удалить аккаунт");
    expect(renderCard(member(1))).not.toContain("Удалить аккаунт");
    queries.useAuthMe.mockReturnValue(query(undefined));
    expect(renderCard(member(17))).not.toContain("Удалить аккаунт");
  });
});

describe("open cards when a login is reused", () => {
  it("shows a gone card for the old ID instead of editing its namesake", () => {
    const replacement = member(29);
    const markup = renderToStaticMarkup(createElement(TeamMemberDetail, {
      users: [replacement], userId: 17, createLink: queries.useCreateAccountLink(),
      onClose: vi.fn(), onLinkCreated: vi.fn(),
    }));

    expect(markup).toContain("Участник больше недоступен");
    expect(markup).not.toContain("Удалить аккаунт");
    expect(queries.useUserDevices).not.toHaveBeenCalled();
    expect(queries.useUserLinks).not.toHaveBeenCalled();
  });

  it("opens the new account only when its new ID is selected", () => {
    const replacement = member(29);
    const markup = renderToStaticMarkup(createElement(TeamMemberDetail, {
      users: [replacement], userId: replacement.id, createLink: queries.useCreateAccountLink(),
      onClose: vi.fn(), onLinkCreated: vi.fn(),
    }));

    expect(markup).toContain("Nikita");
    expect(markup).not.toContain("Участник больше недоступен");
    expect(queries.useUserDevices).toHaveBeenCalledWith(29);
    expect(queries.useUserLinks).toHaveBeenCalledWith(29);
    expect(queries.useAdminAssignPage).toHaveBeenCalledWith(29);
  });
});
