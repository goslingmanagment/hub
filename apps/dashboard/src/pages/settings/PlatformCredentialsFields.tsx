import { buildProxyConfig } from "@agency_hub_core/shared";
import type { VerifyCredentialsBody } from "@agency_hub_core/contracts";
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

export function buildCredentialsBody({
  platform,
  values,
  hadStoredProxy = false,
}: {
  platform: Platform;
  values: PlatformCredentialsValues;
  hadStoredProxy?: boolean;
}): VerifyCredentialsBody {
  const proxyConfig = buildProxyConfig(values.proxyRaw);
  const proxy = proxyConfig !== undefined
    ? proxyConfig
    : hadStoredProxy
      ? null
      : undefined;

  if (platform === "fansly") {
    return {
      platform: "fansly",
      session: {
        authorization: values.authorization.trim(),
        fanslyClientId: values.fanslyClientId.trim() || undefined,
        fanslyClientCheck: values.fanslyClientCheck.trim() || undefined,
        fanslySessionId: values.fanslySessionId.trim() || undefined,
      },
      proxy,
    };
  }

  return {
    platform: "onlyfans",
    auth: {
      token: values.onlyFansToken.trim(),
    },
    username: values.onlyFansUsername.trim(),
    proxy,
  };
}

