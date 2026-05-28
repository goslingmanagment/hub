import { buildProxyConfig } from "@agency_hub_core/shared";
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
          <Field label="Auth token">
            <textarea
              value={values.onlyFansToken}
              onChange={(event) => onChange("onlyFansToken", event.target.value)}
              rows={4}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
            />
          </Field>
          <Field label="Username">
            <input
              value={values.onlyFansUsername}
              onChange={(event) => onChange("onlyFansUsername", event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        </>
      )}

      <ProxyInput
        value={values.proxyRaw}
        onChange={(value) => onChange("proxyRaw", value)}
        initialStoredProxy={initialStoredProxy ?? null}
      />
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
  const proxyConfig = buildProxyConfig(values.proxyRaw);
  const preserveStoredProxyAuth = Boolean(
    initialStoredProxy?.hasAuth &&
      proxyConfig &&
      proxyConfig.url === initialStoredProxy.url &&
      proxyConfig.username == null &&
      proxyConfig.password == null,
  );
  const proxy = preserveStoredProxyAuth
    ? undefined
    : proxyConfig !== undefined
    ? proxyConfig
    : hadStoredProxy
      ? null
      : undefined;

  if (platform === "fansly") {
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

  const auth = {
    token: values.onlyFansToken.trim(),
  };
  const username = values.onlyFansUsername.trim();
  const hasAuthInput = Boolean(auth.token);
  const hasUsernameInput = Boolean(username);

  return {
    platform: "onlyfans",
    ...(requireCredentials || hasAuthInput ? { auth } : {}),
    ...(requireCredentials || hasUsernameInput ? { username } : {}),
    proxy,
  } as VerifyCredentialsBody | UpdateCredentialsBody;
}
