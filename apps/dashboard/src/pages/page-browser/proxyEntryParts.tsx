import { useCallback, useState } from "react";
import { CheckCircle2, CircleAlert, RefreshCw, TriangleAlert } from "lucide-react";
import type { PageBrowserEnvBody, PageBrowserProxyCheckBody, PageBrowserProxyCheckResponse } from "@agency_hub_core/contracts";
import type { PastedProxyOrder } from "@agency_hub_core/shared";

import { checkPageBrowserProxy } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { INPUT, PLAIN, TONES } from "./loginParts.js";
import { checkViewOf, envLine, maskedRows, proxyPreviewOf, type EnvFields } from "./proxyEntryView.js";

// The parts of the one proxy field of a page's server browser (Project
// Browser, owner decision 2026-10-15), shared by the draft page and a new
// page's onboarding: the field with what Hub reads in it, the owner's check
// and its answer, the environment's fields. The pasted text lives in the
// field's state only; a check of it goes straight to the API.

const errorText = (error: unknown) => (error instanceof KernelApiError ? error.message : "Не удалось. Повторите попытку.");

/** One field for the whole proxy, and what Hub reads in it. */
export function ProxyPasteField({ id, label, text, onText, order, onOrder, disabled = false }: {
  id: string;
  label: string;
  text: string;
  onText: (text: string) => void;
  order: PastedProxyOrder | null;
  onOrder: (order: PastedProxyOrder | null) => void;
  disabled?: boolean;
}) {
  const preview = proxyPreviewOf(text, order);
  const ambiguous = proxyPreviewOf(text, null);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm text-text-secondary">{label}</label>
      <textarea
        id={id}
        value={text}
        onChange={(event) => { onText(event.target.value); onOrder(null); }}
        rows={2}
        placeholder="host:port:login:password или login:password@host:port"
        className={`${INPUT} resize-y font-mono`}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        disabled={disabled}
        data-proxy-field
      />
      <p className="text-xs text-text-muted">Вставьте прокси целиком, как её дал поставщик: Hub поймёт адрес, порт, логин и пароль в любом привычном виде.</p>
      {ambiguous.kind === "ambiguous" && (
        <fieldset className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2" data-proxy-ambiguous>
          <legend className="px-1 text-xs font-semibold text-warning-dark">Строку можно прочитать двумя способами — как правильно?</legend>
          {ambiguous.options.map((option) => (
            <label key={option.order} className="mt-1 flex items-center gap-2 text-sm text-text-secondary">
              <input type="radio" name={`${id}-order`} checked={order === option.order} onChange={() => onOrder(option.order)} />
              <span className="font-mono text-xs">{option.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {preview.kind === "invalid" && <p role="alert" className="text-xs text-danger">{preview.reason}</p>}
      {preview.kind === "parsed" && (
        <div className="rounded-lg border border-border bg-hover-alt px-3 py-2" data-proxy-parsed>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            {maskedRows(preview.masked).map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-text-muted">{row.label}</dt>
                <dd className="truncate font-mono text-text-primary">{row.value}</dd>
              </div>
            ))}
          </dl>
          {preview.problem !== null && <p className="mt-2 text-xs text-warning-dark">{preview.problem}</p>}
        </div>
      )}
    </div>
  );
}

/** The owner's check: one at a time; its answer, or why it was not made. */
export function useProxyCheck() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PageBrowserProxyCheckResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run = useCallback(async (source: PageBrowserProxyCheckBody["source"]) => {
    setPending(true);
    setFailure(null);
    setResult(null);
    try {
      const answer = await checkPageBrowserProxy(source);
      setResult(answer);
      return answer;
    } catch (error) {
      setFailure(errorText(error));
      return null;
    } finally {
      setPending(false);
    }
  }, []);
  const reset = useCallback(() => {
    setResult(null);
    setFailure(null);
  }, []);
  return { pending, result, failure, run, reset };
}

/** «Проверить прокси» and what it found. */
export function ProxyCheckPanel({ check, onCheck, disabled = false, onUseAsSocks5 }: {
  check: ReturnType<typeof useProxyCheck>;
  onCheck: () => void;
  disabled?: boolean;
  onUseAsSocks5?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={PLAIN} disabled={disabled || check.pending} onClick={onCheck} data-proxy-check>
          {check.pending ? <><RefreshCw size={14} className="animate-spin" aria-hidden /> Проверяем… до 30 с</> : "Проверить прокси"}
        </button>
        <span className="text-xs text-text-muted">Hub подключится через прокси и спросит, где её выход. Fansly не трогается.</span>
      </div>
      {check.failure !== null && <p role="alert" className="text-sm text-danger">{check.failure}</p>}
      {check.result !== null && <ProxyCheckResult result={check.result} onUseAsSocks5={onUseAsSocks5} />}
    </div>
  );
}

export function ProxyCheckResult({ result, onUseAsSocks5 }: { result: PageBrowserProxyCheckResponse; onUseAsSocks5?: (() => void) | undefined }) {
  const view = checkViewOf(result);
  const Icon = view.tone === "good" ? CheckCircle2 : view.tone === "warning" ? TriangleAlert : CircleAlert;
  return (
    <section className={`rounded-lg border px-3 py-3 ${TONES[view.tone]}`} data-proxy-check-result={result.ok ? "ok" : result.problem?.code ?? "failed"} aria-live="polite">
      <p className="flex items-center gap-2 text-sm font-semibold"><Icon size={16} aria-hidden /> {view.title}</p>
      {view.reason !== null && <p className="mt-1 text-sm">{view.reason}</p>}
      {view.rows.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-text-secondary">
          {view.rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-text-muted">{row.label}</dt>
              <dd className="min-w-0 break-words font-mono text-text-primary">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.offerSocks5 && onUseAsSocks5 !== undefined && (
        <button type="button" className={`${PLAIN} mt-2`} onClick={onUseAsSocks5}>Использовать как SOCKS5</button>
      )}
      {result.exit !== null && (
        <p className="mt-2 text-xs text-text-muted">IP проверки — предварительный: браузер сам проверит свой выходной IP перед тем, как выйти в сеть.</p>
      )}
    </section>
  );
}

/** The environment's fields, with the proposal from the proxy's exit. */
export function EnvForm({ fields, onFields, proposal, onTake, problem }: {
  fields: EnvFields;
  onFields: (fields: EnvFields) => void;
  proposal: PageBrowserEnvBody | null;
  /** Put the proposal into the fields (shown while they differ from it). */
  onTake?: (() => void) | undefined;
  problem: string | null;
}) {
  const field = (key: keyof EnvFields, label: string, placeholder: string, inputMode?: "decimal") => (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`pb-env-${key}`} className="text-xs text-text-secondary">{label}</label>
      <input id={`pb-env-${key}`} value={fields[key]} placeholder={placeholder} inputMode={inputMode} spellCheck={false}
        onChange={(event) => onFields({ ...fields, [key]: event.target.value })} className={`${INPUT} font-mono`} />
    </div>
  );
  return (
    <div className="flex flex-col gap-3" data-env-form>
      {proposal !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-secondary">
          <span className="min-w-0 flex-1">По выходу прокси: <span className="font-mono text-text-primary">{envLine(proposal)}</span></span>
          {onTake !== undefined && <button type="button" className={PLAIN} onClick={onTake}>Подставить</button>}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("timeZone", "Часовой пояс", "Europe/Berlin")}
        {field("languages", "Языки, по порядку", "de-DE, de, en-US, en")}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {field("latitude", "Широта", "52.52", "decimal")}
        {field("longitude", "Долгота", "13.405", "decimal")}
        {field("accuracyM", "Точность, м", "1000", "decimal")}
      </div>
      {problem !== null && <p role="alert" className="text-xs text-danger">{problem}</p>}
      <p className="text-xs text-text-muted">Как в антидетект-браузерах: часовой пояс, языки и геопозиция браузера совпадают с местом выхода прокси. Браузер сверит их при каждом запуске.</p>
    </div>
  );
}
