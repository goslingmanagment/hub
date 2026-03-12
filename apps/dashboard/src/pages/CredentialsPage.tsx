import { useState } from "react";
import {
  useAdminConnections,
  useAdminVerifyCredentials,
  useAdminCreatePage,
  useAdminCreateModel,
  useAdminVerifyPage,
  useAdminUpdateCredentials,
} from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { RelativeDate } from "@/components/shared/RelativeDate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { CONNECTION_STATUS_LABELS } from "@/lib/constants";

export function CredentialsPage() {
  const { data: connections, isLoading } = useAdminConnections();
  const verifyCredentials = useAdminVerifyCredentials();
  const createPage = useAdminCreatePage();
  const createModel = useAdminCreateModel();
  const verifyPage = useAdminVerifyPage();
  const updateCredentials = useAdminUpdateCredentials();

  const [showAdd, setShowAdd] = useState(false);
  const [addPlatform, setAddPlatform] = useState<"fansly" | "onlyfans">("fansly");
  const [addModelSlug, setAddModelSlug] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addToken, setAddToken] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [verified, setVerified] = useState<any>(null);

  const [rotateLabel, setRotateLabel] = useState("");
  const [rotateToken, setRotateToken] = useState("");
  const [rotateUsername, setRotateUsername] = useState("");

  const handleVerify = () => {
    const body = addPlatform === "fansly"
      ? { platform: "fansly" as const, session: { authorization: addToken } }
      : { platform: "onlyfans" as const, auth: { token: addToken }, username: addUsername };
    verifyCredentials.mutate(body, { onSuccess: (data) => setVerified(data) });
  };

  const handleConnect = () => {
    const body = addPlatform === "fansly"
      ? { platform: "fansly" as const, modelSlug: addModelSlug, label: addLabel, session: { authorization: addToken } }
      : { platform: "onlyfans" as const, modelSlug: addModelSlug, label: addLabel, auth: { token: addToken }, username: addUsername };
    createPage.mutate(body, {
      onSuccess: () => {
        setShowAdd(false);
        setVerified(null);
        setAddToken("");
        setAddLabel("");
      },
    });
  };

  const handleRotateVerify = () => {
    const conn = connections?.find((c: any) => c.label === rotateLabel);
    if (!conn) return;
    const body = conn.platform === "fansly"
      ? { platform: "fansly" as const, session: { authorization: rotateToken } }
      : { platform: "onlyfans" as const, auth: { token: rotateToken }, username: rotateUsername };
    verifyCredentials.mutate(body, {
      onSuccess: () => {
        const updateBody = conn.platform === "fansly"
          ? { platform: "fansly" as const, session: { authorization: rotateToken } }
          : { platform: "onlyfans" as const, auth: { token: rotateToken }, username: rotateUsername };
        updateCredentials.mutate({ pageLabel: rotateLabel, ...updateBody }, {
          onSuccess: () => { setRotateLabel(""); setRotateToken(""); },
        });
      },
    });
  };

  const columns: Column<any>[] = [
    { key: "label", header: "Page", render: (r) => <span className="font-medium text-zinc-100">{r.label}</span> },
    { key: "platform", header: "Platform", render: (r) => <PlatformIcon platform={r.platform} /> },
    { key: "model", header: "Model", render: (r) => <span className="text-zinc-300">{r.modelName}</span> },
    { key: "username", header: "Username", render: (r) => <span className="text-zinc-300">@{r.username}</span> },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.connectionStatus} label={CONNECTION_STATUS_LABELS[r.connectionStatus]} /> },
    { key: "lastSync", header: "Last Sync", render: (r) => <RelativeDate iso={r.lastLightSyncAt} /> },
    { key: "error", header: "Error", render: (r) => r.lastSyncError ? <span className="text-xs text-red-400 truncate max-w-48 block">{r.lastSyncError}</span> : "—" },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => verifyPage.mutate({ pageLabel: r.label })}>
            Re-verify
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRotateLabel(r.label)}>
            Rotate
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Credentials</h1>
        <Button size="sm" onClick={() => setShowAdd(true)}>Add Page</Button>
      </div>

      {showAdd && (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-4 space-y-3">
          <div className="flex gap-3">
            <select value={addPlatform} onChange={(e) => setAddPlatform(e.target.value as any)} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100">
              <option value="fansly">Fansly</option>
              <option value="onlyfans">OnlyFans</option>
            </select>
            <Input placeholder="Model slug" value={addModelSlug} onChange={(e) => setAddModelSlug(e.target.value)} className="w-32" />
            <Input placeholder="Page label" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} className="w-32" />
          </div>
          <div className="flex gap-3">
            <Input placeholder={addPlatform === "fansly" ? "Authorization token" : "Auth token"} value={addToken} onChange={(e) => setAddToken(e.target.value)} className="flex-1" type="password" />
            {addPlatform === "onlyfans" && (
              <Input placeholder="Username" value={addUsername} onChange={(e) => setAddUsername(e.target.value)} className="w-40" />
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleVerify} disabled={verifyCredentials.isPending}>
              {verifyCredentials.isPending ? "Verifying..." : "Verify"}
            </Button>
            {verified && (
              <Button size="sm" onClick={handleConnect} disabled={createPage.isPending}>
                Connect
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setShowAdd(false); setVerified(null); }}>Cancel</Button>
          </div>
          {verified && <p className="text-sm text-emerald-400">Verified: {verified.username} ({verified.displayName})</p>}
          {verifyCredentials.isError && <p className="text-sm text-red-400">{(verifyCredentials.error as any)?.body?.message ?? "Verification failed"}</p>}
        </div>
      )}

      {rotateLabel && (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-4 space-y-3">
          <p className="text-sm text-zinc-400">Rotate credentials for <strong className="text-zinc-100">{rotateLabel}</strong></p>
          <div className="flex gap-3">
            <Input placeholder="New token" value={rotateToken} onChange={(e) => setRotateToken(e.target.value)} className="flex-1" type="password" />
            {connections?.find((c: any) => c.label === rotateLabel)?.platform === "onlyfans" && (
              <Input placeholder="Username" value={rotateUsername} onChange={(e) => setRotateUsername(e.target.value)} className="w-40" />
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleRotateVerify} disabled={verifyCredentials.isPending || updateCredentials.isPending}>
              Verify & Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRotateLabel("")}>Cancel</Button>
          </div>
        </div>
      )}

      {isLoading ? <SkeletonTable /> : <DataTable columns={columns} data={connections ?? []} />}
    </div>
  );
}
