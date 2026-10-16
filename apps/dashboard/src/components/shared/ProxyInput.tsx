import { useState, useEffect } from "react";
import { buildProxyConfig, getProxyStringError } from "@agency_hub_core/shared";
import { useAdminTestProxy } from "@/api/queries";
import { Field } from "./Field.js";

/** The proxy parser's verdict in the owner's words. The parser itself speaks
 *  English (it is shared with the server), so its two messages are mapped. */
export function proxyErrorText(error: string): string {
  if (error.startsWith("Unsupported proxy protocol")) {
    return "Такой тип прокси не подходит: нужен socks5://, http:// или https://.";
  }
  if (error === "Invalid proxy URL") {
    return "Не получается прочитать прокси. Формат: логин:пароль@адрес:порт.";
  }
  return error;
}

export function ProxyInput({
  value,
  onChange,
  initialStoredProxy,
  required = false,
  label = "Прокси",
}: {
  value: string;
  onChange: (value: string) => void;
  initialStoredProxy?: { url: string; hasAuth: boolean } | null | undefined;
  required?: boolean | undefined;
  label?: string | undefined;
}) {
  const testProxy = useAdminTestProxy();
  const [testResult, setTestResult] = useState<{ ip: string } | null>(null);
  const [testError, setTestError] = useState("");

  // Reset test result when input changes
  useEffect(() => {
    setTestResult(null);
    setTestError("");
  }, [value]);

  const proxyConfig = buildProxyConfig(value);
  const proxyError = getProxyStringError(value);
  const keepsStoredAuth = Boolean(initialStoredProxy?.hasAuth && value === initialStoredProxy.url);
  const hasAuth = proxyConfig ? proxyConfig.username !== null || proxyConfig.password !== null : false;

  async function handleTest() {
    if (!proxyConfig) return;
    setTestResult(null);
    setTestError("");
    try {
      const result = await testProxy.mutateAsync({ proxy: proxyConfig });
      setTestResult(result);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "Проверка не удалась");
    }
  }

  return (
    <div className="space-y-2">
      <Field label={`${label}${required || initialStoredProxy ? "" : " (необязательно)"}`}>
        <div className="flex gap-2">
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="логин:пароль@адрес:порт"
            spellCheck={false}
            autoComplete="off"
            className="input flex-1"
          />
          <button
            type="button"
            disabled={!proxyConfig || Boolean(proxyError) || testProxy.isPending}
            onClick={handleTest}
            className="btn"
          >
            {testProxy.isPending ? "Проверяем…" : "Проверить"}
          </button>
        </div>
      </Field>

      {proxyConfig && !proxyError && (
        <p className="field-hint">
          {proxyConfig.url}
          {keepsStoredAuth
            ? " · сохранённые логин и пароль прокси останутся"
            : hasAuth ? " · с логином и паролем" : " · без логина"}
        </p>
      )}
      {proxyError && (
        <p role="alert" className="field-hint text-danger">
          {proxyErrorText(proxyError)}
        </p>
      )}

      {testResult && (
        <div className="notice notice-success">
          Прокси работает · выходной IP {testResult.ip}
        </div>
      )}
      {testError && (
        <div role="alert" className="notice notice-danger">
          {testError}
        </div>
      )}
    </div>
  );
}
