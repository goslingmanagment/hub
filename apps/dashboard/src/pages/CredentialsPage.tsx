import { useEffect, useState } from "react";
import type {
  ConnectionItem,
  VerifyCredentialsResponse,
} from "@fansly-connect/contracts";
import {
  useAdminConnections,
  useModels,
  useAdminVerifyCredentials,
  useAdminCreatePage,
  useAdminCreateModel,
  useAdminVerifyPage,
  useAdminUpdateCredentials,
} from "@/api/queries";
import { ApiError } from "@/api/client";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { RelativeDate } from "@/components/shared/RelativeDate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { CONNECTION_STATUS_LABELS } from "@/lib/constants";

export function CredentialsPage() {
  const { data: models } = useModels();
  const { data: connections, isLoading } = useAdminConnections();
  const verifyCredentials = useAdminVerifyCredentials();
  const createPage = useAdminCreatePage();
  const createModel = useAdminCreateModel();
  const verifyPage = useAdminVerifyPage();
  const updateCredentials = useAdminUpdateCredentials();

  const [showAdd, setShowAdd] = useState(false);
  const [addPlatform, setAddPlatform] = useState<"fansly" | "onlyfans">("fansly");
  const [modelMode, setModelMode] = useState<"existing" | "create">("existing");
  const [selectedModelSlug, setSelectedModelSlug] = useState("");
  const [newModelSlug, setNewModelSlug] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addToken, setAddToken] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [verified, setVerified] = useState<VerifyCredentialsResponse | null>(null);

  const [rotateLabel, setRotateLabel] = useState("");
  const [rotateToken, setRotateToken] = useState("");
  const [rotateUsername, setRotateUsername] = useState("");

  useEffect(() => {
    if (models?.length && !selectedModelSlug) {
      setSelectedModelSlug(models[0]!.slug);
    }
    if ((models?.length ?? 0) === 0) {
      setModelMode("create");
    }
  }, [models, selectedModelSlug]);

  const resetAddForm = () => {
    setShowAdd(false);
    setModelMode((models?.length ?? 0) > 0 ? "existing" : "create");
    setSelectedModelSlug(models?.[0]?.slug ?? "");
    setNewModelSlug("");
    setNewModelName("");
    setAddLabel("");
    setAddToken("");
    setAddUsername("");
    setVerified(null);
  };

  const getErrorMessage = (error: unknown, fallback: string) => {
    if (error instanceof ApiError) {
      return error.body.message;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return fallback;
  };

  const handleVerify = () => {
    const body = addPlatform === "fansly"
      ? { platform: "fansly" as const, session: { authorization: addToken } }
      : { platform: "onlyfans" as const, auth: { token: addToken }, username: addUsername };
    verifyCredentials.mutate(body, {
      onSuccess: (data) => setVerified(data),
      onError: () => setVerified(null),
    });
  };

  const handleConnect = async () => {
    try {
      let modelSlug = selectedModelSlug;
      if (modelMode === "create") {
        const createdModel = await createModel.mutateAsync({
          slug: newModelSlug,
          name: newModelName,
        });
        modelSlug = createdModel.slug;
        setSelectedModelSlug(createdModel.slug);
        setModelMode("existing");
      }

      const body = addPlatform === "fansly"
        ? {
          platform: "fansly" as const,
          modelSlug,
          label: addLabel,
          session: { authorization: addToken },
        }
        : {
          platform: "onlyfans" as const,
          modelSlug,
          label: addLabel,
          auth: { token: addToken },
          username: addUsername,
        };
      await createPage.mutateAsync(body);
      resetAddForm();
    } catch {
      // Mutation state already carries the typed error for rendering.
    }
  };

  const handleRotateVerify = () => {
    const conn = connections?.find((connection) => connection.label === rotateLabel);
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

  const addError = createModel.error ?? createPage.error;
  const rotateConnection = connections?.find((connection) => connection.label === rotateLabel);
  const canConnect = Boolean(
    verified
    && addLabel.trim()
    && (
      modelMode === "existing"
        ? !!selectedModelSlug
        : !!newModelSlug.trim() && !!newModelName.trim()
    )
    && (addPlatform === "fansly" || !!addUsername.trim())
  );

  const columns: Column<ConnectionItem>[] = [
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
            <Input placeholder="Page label" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} className="w-32" />
          </div>
          <div className="space-y-3 rounded border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={modelMode === "existing" ? "default" : "outline"}
                onClick={() => setModelMode("existing")}
                disabled={(models?.length ?? 0) === 0}
              >
                Existing Model
              </Button>
              <Button
                type="button"
                size="sm"
                variant={modelMode === "create" ? "default" : "outline"}
                onClick={() => setModelMode("create")}
              >
                New Model
              </Button>
            </div>
            {modelMode === "existing" ? (
              <select
                value={selectedModelSlug}
                onChange={(e) => setSelectedModelSlug(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
                disabled={(models?.length ?? 0) === 0}
              >
                <option value="">Select model</option>
                {(models ?? []).map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.name} ({model.slug})
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex gap-3">
                <Input
                  placeholder="Model slug"
                  value={newModelSlug}
                  onChange={(e) => setNewModelSlug(e.target.value)}
                  className="w-40"
                />
                <Input
                  placeholder="Model name"
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  className="flex-1"
                />
              </div>
            )}
            {modelMode === "existing" && (models?.length ?? 0) === 0 && (
              <p className="text-sm text-zinc-400">
                No models exist yet. Create one inline before connecting the page.
              </p>
            )}
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
              <Button
                size="sm"
                onClick={() => void handleConnect()}
                disabled={!canConnect || createModel.isPending || createPage.isPending}
              >
                Connect
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={resetAddForm}>Cancel</Button>
          </div>
          {verified && <p className="text-sm text-emerald-400">Verified: {verified.username} ({verified.displayName})</p>}
          {verifyCredentials.isError && (
            <p className="text-sm text-red-400">
              {getErrorMessage(verifyCredentials.error, "Verification failed")}
            </p>
          )}
          {addError && (
            <p className="text-sm text-red-400">
              {getErrorMessage(addError, "Page connection failed")}
            </p>
          )}
        </div>
      )}

      {rotateLabel && (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-4 space-y-3">
          <p className="text-sm text-zinc-400">Rotate credentials for <strong className="text-zinc-100">{rotateLabel}</strong></p>
          <div className="flex gap-3">
            <Input placeholder="New token" value={rotateToken} onChange={(e) => setRotateToken(e.target.value)} className="flex-1" type="password" />
            {rotateConnection?.platform === "onlyfans" && (
              <Input placeholder="Username" value={rotateUsername} onChange={(e) => setRotateUsername(e.target.value)} className="w-40" />
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleRotateVerify} disabled={verifyCredentials.isPending || updateCredentials.isPending}>
              Verify & Save
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRotateLabel("")}>Cancel</Button>
          </div>
          {(verifyCredentials.error || updateCredentials.error) && (
            <p className="text-sm text-red-400">
              {getErrorMessage(verifyCredentials.error ?? updateCredentials.error, "Credential update failed")}
            </p>
          )}
        </div>
      )}

      {isLoading ? <SkeletonTable /> : <DataTable columns={columns} data={connections ?? []} />}
    </div>
  );
}
