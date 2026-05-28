import { useState, useEffect } from "react";
import { formatProxyPreview, buildProxyConfig, getProxyStringError } from "@agency_hub_core/shared";
import { useAdminTestProxy } from "@/api/queries";
import { Field } from "./Field.js";

export function ProxyInput({
  value,
  onChange,
  initialStoredProxy,
}: {
  value: string;
  onChange: (value: string) => void;
  initialStoredProxy?: { url: string; hasAuth: boolean } | null;
}) {
  const testProxy = useAdminTestProxy();
  const [testResult, setTestResult] = useState<{ ip: string } | null>(null);
  const [testError, setTestError] = useState("");

  // Reset test result when input changes
  useEffect(() => {
    setTestResult(null);
    setTestError("");
  }, [value]);

  const preview = formatProxyPreview(value);
  const proxyConfig = buildProxyConfig(value);
  const proxyError = getProxyStringError(value);

  async function handleTest() {
    if (!proxyConfig) return;
    setTestResult(null);
    setTestError("");
    try {
      const result = await testProxy.mutateAsync({ proxy: proxyConfig });
      setTestResult(result);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "Test failed");
    }
  }

  return (
    <div className="space-y-2">
      <Field label={`Proxy${initialStoredProxy ? "" : " (optional)"}`}>
        <div className="flex gap-2">
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="user:pass@host:port"
            className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={!proxyConfig || Boolean(proxyError) || testProxy.isPending}
            onClick={handleTest}
            className="shrink-0 rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
          >
            {testProxy.isPending ? "Testing..." : "Test"}
          </button>
        </div>
      </Field>

      {preview && (
        <div className="px-1 text-xs text-text-tertiary">
          {preview}
          {initialStoredProxy?.hasAuth && value === initialStoredProxy.url && (
            <span> &middot; stored auth will be preserved</span>
          )}
        </div>
      )}
      {proxyError && (
        <div className="px-1 text-xs text-danger">
          {proxyError}
        </div>
      )}

      {testResult && (
        <div className="rounded-lg border border-green/30 bg-green/5 px-3 py-2 text-sm text-green">
          Proxy OK &middot; IP: {testResult.ip}
        </div>
      )}
      {testError && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {testError}
        </div>
      )}
    </div>
  );
}
