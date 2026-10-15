import { buildProxyConfig, getProxyStringError } from "@agency_hub_core/shared";
import type { UpdateCredentialsBody, VerifyCredentialsBody } from "@agency_hub_core/contracts";
import { Field } from "@/components/shared/Field";
import { ProxyInput, proxyErrorText } from "@/components/shared/ProxyInput";

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
  initialStoredProxy?: { url: string; hasAuth: boolean } | null | undefined;
}

/** The three optional Fansly headers, by the name the browser shows them. */
const OPTIONAL_FANSLY_HEADERS = [
  { field: "fanslyClientId", header: "fansly-client-id" },
  { field: "fanslyClientCheck", header: "fansly-client-check" },
  { field: "fanslySessionId", header: "fansly-session-id" },
] as const;

export function PlatformCredentialsFields({
  platform,
  values,
  onChange,
  initialStoredProxy,
}: PlatformCredentialsFieldsProps) {
  if (platform === "onlyfans") {
    return (
      <Field
        label="Имя пользователя на OnlyFans"
        hint="Сначала подключите этот аккаунт в OnlyFans API — Hub читает страницу через него, прокси и пароль здесь не нужны."
      >
        <input
          value={values.onlyFansUsername}
          onChange={(event) => onChange("onlyFansUsername", event.target.value)}
          placeholder="например, devlora"
          autoComplete="off"
          spellCheck={false}
          className="input"
        />
      </Field>
    );
  }

  return (
    <div className="space-y-4">
      <Field
        label="Заголовок Authorization"
        hint="Из браузера, где вы уже вошли в Fansly: инструменты разработчика → «Сеть» → любой запрос к apiv3.fansly.com."
      >
        <textarea
          value={values.authorization}
          onChange={(event) => onChange("authorization", event.target.value)}
          rows={3}
          spellCheck={false}
          className="textarea"
        />
      </Field>
      <details className="help">
        <summary>Другие заголовки (необязательно)</summary>
        <div className="help-body">
          {OPTIONAL_FANSLY_HEADERS.map(({ field, header }) => (
            <Field key={field} label={header}>
              <input
                value={values[field]}
                onChange={(event) => onChange(field, event.target.value)}
                spellCheck={false}
                autoComplete="off"
                className="input"
              />
            </Field>
          ))}
        </div>
      </details>
      <ProxyInput
        label="Прокси страницы"
        value={values.proxyRaw}
        onChange={(value) => onChange("proxyRaw", value)}
        initialStoredProxy={initialStoredProxy ?? null}
        required
      />
    </div>
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
      throw new Error("Доступ к OnlyFans настраивается в OnlyFans API, а не здесь.");
    }
    return { platform: "onlyfans", username: values.onlyFansUsername.trim() };
  }

  const proxyError = getProxyStringError(values.proxyRaw);
  if (proxyError) {
    throw new Error(proxyErrorText(proxyError));
  }

  const proxyConfig = buildProxyConfig(values.proxyRaw);
  if (requireCredentials && !proxyConfig) {
    throw new Error("Для страницы Fansly нужен прокси");
  }
  if (!requireCredentials && hadStoredProxy && values.proxyRaw.trim().length === 0) {
    throw new Error(
      "Прокси нельзя удалить, обновляя данные входа: оставьте поле прокси заполненным",
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
