import { useCallback, useState } from "react";
import { CheckCircle2, CircleAlert, RefreshCw, TriangleAlert } from "lucide-react";
import type { PageBrowserEnvBody, PageBrowserProxyCheckBody, PageBrowserProxyCheckResponse } from "@agency_hub_core/contracts";
import type { PastedProxyOrder } from "@agency_hub_core/shared";

import { checkPageBrowserProxy } from "@/api/queries";
import { TONE_NOTICE } from "./loginParts.js";
import { pageBrowserErrorText } from "./pageBrowserErrors.js";
import { checkViewOf, envLine, maskedRows, proxyPreviewOf, type EnvFields } from "./proxyEntryView.js";

// The parts of the one proxy field of a page's server browser (Project
// Browser, owner decision 2026-10-15), shared by the draft page and a new
// page's onboarding: the field with what Hub reads in it, the owner's check
// and its answer, the environment's fields. The pasted text lives in the
// field's state only; a check of it goes straight to the API.

const errorText = (error: unknown) => pageBrowserErrorText(error);

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
    <div className="connect-fields">
      <label htmlFor={id} className="field-label">{label}</label>
      <textarea
        id={id}
        value={text}
        onChange={(event) => { onText(event.target.value); onOrder(null); }}
        rows={2}
        placeholder="host:port:login:password или login:password@host:port"
        className="textarea resize-y font-mono"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        disabled={disabled}
        data-proxy-field
      />
      <p className="field-hint">Вставьте прокси целиком, как её дал поставщик: Hub сам разберёт адрес, порт, логин и пароль.</p>
      {ambiguous.kind === "ambiguous" && (
        <fieldset className="notice notice-warning connect-ambiguous" data-proxy-ambiguous>
          <legend className="connect-ambiguous-title">Строку можно прочитать двумя способами: как правильно?</legend>
          {ambiguous.options.map((option) => (
            <label key={option.order} className="connect-ambiguous-option">
              <input type="radio" name={`${id}-order`} checked={order === option.order} onChange={() => onOrder(option.order)} />
              <span className="font-mono">{option.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {preview.kind === "invalid" && <p role="alert" className="field-error">{preview.reason}</p>}
      {preview.kind === "parsed" && (
        <div className="connect-parsed" data-proxy-parsed>
          <dl className="kv">
            {maskedRows(preview.masked).map((row) => (
              <div key={row.label} className="contents">
                <dt>{row.label}</dt>
                <dd className="truncate font-mono">{row.value}</dd>
              </div>
            ))}
          </dl>
          {preview.problem !== null && <p className="field-error">{preview.problem}</p>}
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
    <div className="connect-fields">
      <div className="connect-check">
        <button type="button" className="btn" disabled={disabled || check.pending} onClick={onCheck} data-proxy-check>
          {check.pending ? <><RefreshCw size={16} className="animate-spin" aria-hidden /> Проверяем… до 30 с</> : "Проверить прокси"}
        </button>
        <span className="field-hint">Hub подключится через прокси и узнает её выходной IP. Fansly при этом не открывается.</span>
      </div>
      {check.failure !== null && <p role="alert" className="field-error">{check.failure}</p>}
      {check.result !== null && <ProxyCheckResult result={check.result} onUseAsSocks5={onUseAsSocks5} />}
    </div>
  );
}

export function ProxyCheckResult({ result, onUseAsSocks5 }: { result: PageBrowserProxyCheckResponse; onUseAsSocks5?: (() => void) | undefined }) {
  const view = checkViewOf(result);
  const Icon = view.tone === "good" ? CheckCircle2 : view.tone === "warning" ? TriangleAlert : CircleAlert;
  return (
    <section className={`${TONE_NOTICE[view.tone]} connect-result`} data-proxy-check-result={result.ok ? "ok" : result.problem?.code ?? "failed"} aria-live="polite">
      <Icon size={18} aria-hidden />
      <div className="notice-body">
      <p className="connect-result-title">{view.title}</p>
      {view.reason !== null && <p>{view.reason}</p>}
      {view.rows.length > 0 && (
        <dl className="kv connect-result-rows">
          {view.rows.map((row) => (
            <div key={row.label} className="contents">
              <dt>{row.label}</dt>
              <dd className="min-w-0 break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.offerSocks5 && onUseAsSocks5 !== undefined && (
        <button type="button" className="btn btn-sm connect-socks" onClick={onUseAsSocks5}>Использовать как SOCKS5</button>
      )}
      {result.exit !== null && (
        <small>IP проверки предварительный: браузер сам проверит свой выходной IP перед тем, как выйти в сеть.</small>
      )}
      </div>
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
    <div className="min-w-0">
      <label htmlFor={`pb-env-${key}`} className="field-label">{label}</label>
      <input id={`pb-env-${key}`} value={fields[key]} placeholder={placeholder} inputMode={inputMode} spellCheck={false}
        onChange={(event) => onFields({ ...fields, [key]: event.target.value })} className="input" />
    </div>
  );
  return (
    <div className="connect-fields" data-env-form>
      {proposal !== null && (
        <div className="notice notice-info">
          <div className="notice-body">По выходу прокси: {envLine(proposal)}</div>
          {onTake !== undefined && <div className="notice-action"><button type="button" className="btn btn-sm" onClick={onTake}>Подставить</button></div>}
        </div>
      )}
      <div className="connect-env-grid">
        {field("timeZone", "Часовой пояс", "Europe/Berlin")}
        {field("languages", "Языки, по порядку", "de-DE, de, en-US, en")}
      </div>
      <div className="connect-env-grid connect-env-grid-3">
        {field("latitude", "Широта", "52.52", "decimal")}
        {field("longitude", "Долгота", "13.405", "decimal")}
        {field("accuracyM", "Точность, м", "1000", "decimal")}
      </div>
      {problem !== null && <p role="alert" className="field-error">{problem}</p>}
      <p className="field-hint">Часовой пояс, языки и геопозиция браузера должны совпадать с местом выхода прокси: Hub предложит их после проверки прокси, а браузер сверит при каждом запуске.</p>
    </div>
  );
}
