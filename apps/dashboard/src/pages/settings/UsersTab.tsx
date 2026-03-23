import { useState } from "react";
import type { AdminCreateUserBody, AuthUser } from "@agency_hub_core/contracts";
import { creatableUserRoles } from "@agency_hub_core/shared";
import { useAdminUsers, useAdminCreateUser } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";
import { UserPageAssignmentModal } from "./UserPageAssignmentModal";

export function UsersTab() {
  const { data: users, isLoading } = useAdminUsers();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [assignUser, setAssignUser] = useState<AuthUser | null>(null);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading users...</div>
    );
  }

  const items = users ?? [];

  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-text-primary">Users</h2>
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
          >
            Create User
          </button>
        </div>

        {items.length === 0 && (
          <p className="text-sm text-text-muted">No users found.</p>
        )}
        {items.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {["Username", "Role", "Assigned Pages", "Actions"].map((col) => (
                    <th
                      key={col}
                      className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((user) => (
                  <tr key={user.id} className="border-t border-border">
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">
                      {user.username}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary capitalize">
                      {user.role.replaceAll("_", " ")}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {user.assignedPages.length > 0
                        ? user.assignedPages.map((page) => page.label).join(", ")
                        : "\u2014"}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setAssignUser(user)}
                        className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                      >
                        Manage Pages
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {isModalOpen && <CreateUserModal onClose={() => setIsModalOpen(false)} />}
      {assignUser && (
        <UserPageAssignmentModal
          user={assignUser}
          onClose={() => setAssignUser(null)}
        />
      )}
    </>
  );
}

function CreateUserModal({ onClose }: { onClose: () => void }) {
  const createUser = useAdminCreateUser();
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<AdminCreateUserBody["role"]>("team_lead");
  const [password, setPassword] = useState("");

  const requiresPassword = role === "owner" || role === "team_lead";
  async function handleSubmit() {
    const body: AdminCreateUserBody = {
      username: username.trim(),
      role,
      password: requiresPassword ? password : undefined,
    };

    try {
      await createUser.mutateAsync(body);
      toast.success("User created");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create user");
    }
  }

  return (
    <ModalShell title="Create User" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Username">
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(event) => {
              const nextRole = event.target.value as AdminCreateUserBody["role"];
              setRole(nextRole);
              if (nextRole !== "owner" && nextRole !== "team_lead") {
                setPassword("");
              }
            }}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {creatableUserRoles.map((option) => (
              <option key={option} value={option}>
                {option.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        {requiresPassword && (
          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={createUser.isPending}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </ModalShell>
  );
}
