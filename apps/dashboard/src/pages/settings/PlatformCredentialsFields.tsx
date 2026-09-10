import { buildProxyConfig, getProxyStringError } from "@agency_hub_core/shared";
import type { UpdateCredentialsBody, VerifyCredentialsBody } from "@agency_hub_core/contracts";
import { Field } from "@/components/shared/Field";
import { ProxyInput } from "@/components/shared/ProxyInput";

export type Platform = "fansly" | "onlyfans";

export interface PlatformCredentialsValues {
  authorization: string;
  fanslyClientId: string;
  fanslyClientCheck: string;
  fanslySessionId: string;
  onlyFansToken: string;
  onlyFansUsername: string;
  proxyRaw: string;
}

interface PlatformCredentialsFieldsProps {
  platform: Platform;
  values: PlatformCredentialsValues;
  onChange: <K extends keyof PlatformCredentialsValues>(field: K, value: PlatformCredentialsValues[K]) => void;
  initialStoredProxy?: { url: string; hasAuth: boolean } | null;
}

export function PlatformCredentialsFields({
  platform,
  values,
  onChange,
  initialStoredProxy,
}: PlatformCredentialsFieldsProps) {
  return (
    <>
      {platform === "fansly" ? (
        <>
          <Field label="Authorization">
            <textarea
              value={values.authorization}
              onChange={(event) => onChange("authorization", event.target.value)}
              rows={4}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
            />
          </Field>
          <Field label="fansly-client-id (optional)">
            <input
              value={values.fanslyClientId}
              onChange={(event) => onChange("fanslyClientId", event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
          <Field label="fansly-client-check (optional)">
            <input
              value={values.fanslyClientCheck}
              onChange={(event) => onChange("fanslyClientCheck", event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
          <Field label="fansly-session-id (optional)">
            <input
              value={values.fanslySessionId}
              onChange={(event) => onChange("fanslySessionId", event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        </>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Connect the account in OFAPI first, then enter its OnlyFans username.
            OFAPI manages access and the connection; no token or proxy is needed here.
          </p>
          <Field label="OnlyFans username">
            <input
              value={values.onlyFansUsername}
              onChange={(event) => onChange("onlyFansUsername", event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        </>
      )}

      {platform === "fansly" && (
        <ProxyInput
          value={values.proxyRaw}
          onChange={(value) => onChange("proxyRaw", value)}
          initialStoredProxy={initialStoredProxy ?? null}
          required
        />
      )}
    </>
  );
}

export function buildCredentialsBody(input: {
  platform: Platform;
  values: PlatformCredentialsValues;
  hadStoredProxy?: boolean;
  initialStoredProxy?: { url: string; hasAuth: boolean } | null;
  requireCredentials?: true;
}): VerifyCredentialsBody;
export function buildCredentialsBody(input: {
  platform: Platform;
  values: PlatformCredentialsValues;
  hadStoredProxy?: boolean;
  initialStoredProxy?: { url: string; hasAuth: boolean } | null;
  requireCredentials: false;
}): UpdateCredentialsBody;
export function buildCredentialsBody({
  platform,
  values,
  hadStoredProxy = false,
  initialStoredProxy = null,
  requireCredentials = true,
}: {
  platform: Platform;
  values: PlatformCredentialsValues;
  hadStoredProxy?: boolean;
  initialStoredProxy?: { url: string; hasAuth: boolean } | null;
  requireCredentials?: boolean;
}): VerifyCredentialsBody | UpdateCredentialsBody {
  if (platform === "onlyfans") {
    if (!requireCredentials) {
      throw new Error("OnlyFans access is managed in OFAPI. Use Sync settings for connection diagnostics.");
    }
    return { platform: "onlyfans", username: values.onlyFansUsername.trim() };
  }

  const proxyError = getProxyStringError(values.proxyRaw);
  if (proxyError) {
    throw new Error(proxyError);
  }

  const proxyConfig = buildProxyConfig(values.proxyRaw);
  if (requireCredentials && !proxyConfig) {
    throw new Error("Proxy is required for Fansly");
  }
  if (!requireCredentials && hadStoredProxy && values.proxyRaw.trim().length === 0) {
    throw new Error(
      "Proxy removal is a separate operation; credentials update cannot clear it",
    );
  }
  const preserveStoredProxyAuth = Boolean(
    initialStoredProxy?.hasAuth &&
      proxyConfig &&
      proxyConfig.url === initialStoredProxy.url &&
      proxyConfig.username == null &&
      proxyConfig.password == null,
  );
  const proxy = preserveStoredProxyAuth
    ? undefined
    : proxyConfig;

  const session = {
    authorization: values.authorization.trim(),
    fanslyClientId: values.fanslyClientId.trim() || undefined,
    fanslyClientCheck: values.fanslyClientCheck.trim() || undefined,
    fanslySessionId: values.fanslySessionId.trim() || undefined,
  };
  const hasSessionInput = Boolean(
    session.authorization ||
      session.fanslyClientId ||
      session.fanslyClientCheck ||
      session.fanslySessionId,
  );

  return {
    platform: "fansly",
    ...(requireCredentials || hasSessionInput ? { session } : {}),
    proxy,
  } as VerifyCredentialsBody | UpdateCredentialsBody;
}
