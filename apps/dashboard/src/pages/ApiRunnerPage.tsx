import { useState, useEffect } from "react";
import { useOpenApiSpec } from "@/api/queries";
import { useApiRunnerStore } from "@/stores/api-runner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonTable } from "@/components/shared/SkeletonTable";

interface EndpointInfo {
  method: string;
  path: string;
  summary: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: any }>;
  requestBody?: any;
}

function parseEndpoints(spec: any): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  for (const [path, methods] of Object.entries(spec?.paths ?? {})) {
    for (const [method, info] of Object.entries(methods as Record<string, any>)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) {
        endpoints.push({
          method: method.toUpperCase(),
          path,
          summary: info.summary ?? "",
          parameters: info.parameters,
          requestBody: info.requestBody,
        });
      }
    }
  }
  return endpoints;
}

export function ApiRunnerPage() {
  const { data: spec, isLoading } = useOpenApiSpec();
  const { endpoint, params, response, history, setEndpoint, setParams, setResponse, addHistory } = useApiRunnerStore();
  const [bodyText, setBodyText] = useState("{}");

  const endpoints = spec ? parseEndpoints(spec) : [];
  const selected = endpoints.find((e) => `${e.method} ${e.path}` === endpoint);

  useEffect(() => {
    if (selected?.parameters) {
      const initial: Record<string, string> = {};
      for (const p of selected.parameters) {
        if (p.in === "path") initial[p.name] = params[p.name] ?? "";
      }
      setParams(initial);
    }
  }, [endpoint]);

  const handleSend = async () => {
    if (!selected) return;
    let url = selected.path;
    for (const [key, value] of Object.entries(params)) {
      url = url.replace(`{${key}}`, encodeURIComponent(value));
    }

    // Add query params
    const queryParams = selected.parameters?.filter((p) => p.in === "query") ?? [];
    if (queryParams.length > 0) {
      const qs = new URLSearchParams();
      for (const p of queryParams) {
        if (params[p.name]) qs.set(p.name, params[p.name]);
      }
      const qsStr = qs.toString();
      if (qsStr) url += `?${qsStr}`;
    }

    const init: RequestInit = {
      method: selected.method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    };
    if (["POST", "PUT", "PATCH"].includes(selected.method) && bodyText.trim()) {
      init.body = bodyText;
    }

    const start = performance.now();
    try {
      const res = await fetch(url, init);
      const durationMs = Math.round(performance.now() - start);
      const body = await res.json().catch(() => null);
      setResponse({ status: res.status, body, durationMs });
      addHistory({ method: selected.method, path: url, status: res.status, durationMs, timestamp: Date.now() });
    } catch (err) {
      setResponse({ status: 0, body: { error: String(err) }, durationMs: Math.round(performance.now() - start) });
    }
  };

  if (isLoading) return <SkeletonTable rows={3} cols={2} />;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">API Runner</h1>

      <div className="flex gap-3">
        <select
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100"
        >
          <option value="">Select endpoint</option>
          {endpoints.map((e) => (
            <option key={`${e.method} ${e.path}`} value={`${e.method} ${e.path}`}>
              {e.method} {e.path} — {e.summary}
            </option>
          ))}
        </select>
        <Button onClick={handleSend} disabled={!selected}>Send</Button>
      </div>

      {selected && (
        <div className="space-y-3">
          {/* Path + Query params */}
          {selected.parameters?.map((p) => (
            <div key={p.name} className="flex items-center gap-2">
              <label className="text-xs text-zinc-500 w-24">{p.name} ({p.in})</label>
              <Input
                value={params[p.name] ?? ""}
                onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                placeholder={p.required ? "required" : "optional"}
                className="flex-1"
              />
            </div>
          ))}

          {/* Body */}
          {["POST", "PUT", "PATCH"].includes(selected.method) && (
            <div>
              <label className="text-xs text-zinc-500">Request Body (JSON)</label>
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 font-mono h-32"
              />
            </div>
          )}
        </div>
      )}

      {response && (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-4 space-y-2">
          <div className="flex items-center gap-3 text-sm">
            <span className={response.status >= 200 && response.status < 300 ? "text-emerald-400" : "text-red-400"}>
              {response.status}
            </span>
            <span className="text-zinc-500">{response.durationMs}ms</span>
          </div>
          <pre className="max-h-96 overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-300 font-mono">
            {JSON.stringify(response.body, null, 2)}
          </pre>
        </div>
      )}

      {history.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-400 mb-2">History</h2>
          <div className="space-y-1">
            {history.map((h, i) => (
              <div key={i} className="flex gap-3 text-xs text-zinc-500">
                <span className={h.status >= 200 && h.status < 300 ? "text-emerald-400" : "text-red-400"}>
                  {h.status}
                </span>
                <span className="text-zinc-300">{h.method} {h.path}</span>
                <span>{h.durationMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
