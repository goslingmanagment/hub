import { useState } from "react";
import {
  useAdminUsers,
  useAdminCreateUser,
  useAdminSetPassword,
  useAdminAssignPage,
  useAdminUnassignPage,
  useAdminIssueApiKey,
  useAdminRevokeApiKeys,
  useOverview,
} from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { ROLE_LABELS } from "@/lib/constants";

export function UsersPage() {
  const { data: users, isLoading } = useAdminUsers();
  const { data: overview } = useOverview();
  const createUser = useAdminCreateUser();
  const setPassword = useAdminSetPassword();
  const assignPage = useAdminAssignPage();
  const unassignPage = useAdminUnassignPage();
  const issueKey = useAdminIssueApiKey();
  const revokeKeys = useAdminRevokeApiKeys();

  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState("chatter");
  const [newPassword, setNewPassword] = useState("");

  const [pwUser, setPwUser] = useState("");
  const [pwValue, setPwValue] = useState("");

  const [assignUser, setAssignUser] = useState("");
  const [assignPageLabel, setAssignPageLabel] = useState("");

  const [issuedKey, setIssuedKey] = useState<string | null>(null);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createUser.mutate(
      { username: newUsername, role: newRole, password: newPassword || undefined },
      {
        onSuccess: () => {
          setShowCreate(false);
          setNewUsername("");
          setNewPassword("");
        },
      },
    );
  };

  const handleSetPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setPassword.mutate({ username: pwUser, password: pwValue }, { onSuccess: () => { setPwUser(""); setPwValue(""); } });
  };

  const columns: Column<any>[] = [
    { key: "username", header: "Username", render: (r) => <span className="font-medium text-zinc-100">{r.username}</span> },
    { key: "role", header: "Role", render: (r) => <Badge>{ROLE_LABELS[r.role] ?? r.role}</Badge> },
    {
      key: "pages",
      header: "Assigned Pages",
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {(r.assignedPages ?? []).map((p: any) => (
            <span key={p.pageLabel} className="inline-flex items-center gap-1">
              <Badge variant="outline">{p.pageLabel}</Badge>
              <button
                onClick={(e) => { e.stopPropagation(); unassignPage.mutate({ username: r.username, pageLabel: p.pageLabel }); }}
                className="text-xs text-zinc-500 hover:text-red-400"
                title="Remove"
              >
                x
              </button>
            </span>
          ))}
        </div>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (r) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setPwUser(r.username)}>Password</Button>
          <Button variant="ghost" size="sm" onClick={() => setAssignUser(r.username)}>Assign Page</Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              issueKey.mutate(
                { username: r.username },
                { onSuccess: (data) => setIssuedKey(data.key) },
              )
            }
          >
            Issue Key
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400"
            onClick={() => revokeKeys.mutate({ username: r.username })}
          >
            Revoke Keys
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Users</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>Create User</Button>
      </div>

      {issuedKey && (
        <div className="rounded border border-emerald-800 bg-emerald-950/50 p-3">
          <p className="text-sm text-emerald-400">API Key (shown once):</p>
          <code className="block mt-1 text-xs text-zinc-100 break-all">{issuedKey}</code>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setIssuedKey(null)}>Dismiss</Button>
        </div>
      )}

      {showCreate && (
        <form onSubmit={handleCreate} className="flex gap-2 items-end rounded border border-zinc-800 bg-zinc-900 p-3">
          <Input placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="w-40" />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100">
            <option value="owner">Owner</option>
            <option value="team_lead">Team Lead</option>
            <option value="chatter">Chatter</option>
            <option value="content_manager">Content Manager</option>
          </select>
          <Input type="password" placeholder="Password (optional)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-40" />
          <Button type="submit" size="sm" disabled={createUser.isPending}>Create</Button>
          <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
        </form>
      )}

      {pwUser && (
        <form onSubmit={handleSetPassword} className="flex gap-2 items-end rounded border border-zinc-800 bg-zinc-900 p-3">
          <span className="text-sm text-zinc-400">Set password for {pwUser}:</span>
          <Input type="password" placeholder="New password" value={pwValue} onChange={(e) => setPwValue(e.target.value)} className="w-48" />
          <Button type="submit" size="sm" disabled={setPassword.isPending}>Set</Button>
          <Button variant="ghost" size="sm" onClick={() => setPwUser("")}>Cancel</Button>
        </form>
      )}

      {assignUser && (
        <div className="flex gap-2 items-end rounded border border-zinc-800 bg-zinc-900 p-3">
          <span className="text-sm text-zinc-400">Assign page to {assignUser}:</span>
          <select value={assignPageLabel} onChange={(e) => setAssignPageLabel(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100">
            <option value="">Select page</option>
            {(overview?.pages ?? []).map((p: any) => (
              <option key={p.label} value={p.label}>{p.label}</option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!assignPageLabel}
            onClick={() => {
              assignPage.mutate({ username: assignUser, pageLabel: assignPageLabel });
              setAssignUser("");
              setAssignPageLabel("");
            }}
          >
            Assign
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAssignUser("")}>Cancel</Button>
        </div>
      )}

      {isLoading ? <SkeletonTable /> : <DataTable columns={columns} data={users ?? []} />}
    </div>
  );
}
