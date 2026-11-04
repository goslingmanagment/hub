import { useState } from "react";
import { applyOfapiKeyScope, readOfapiKeyScope } from "@/api/ofapiVendor";

const capabilities = ["reads", "commands", "webhooks", "exports", "uploads", "links"] as const;
const capabilityLabels = { reads: "Чтение", commands: "Команды", webhooks: "События", exports: "Экспорты", uploads: "Загрузки", links: "Ссылки и пиксели" };
const preflightLabels: Record<string, string> = {
  verified: "подтверждена", unknown: "не проверена", mismatch: "не совпадает", denied: "доступ запрещён",
};
type Scope = Awaited<ReturnType<typeof readOfapiKeyScope>>;

/**
 * «Права ключа», the second half of the old «Сверка с провайдером и права ключа»:
 * an explicit read of the key's declared scope and its local declaration. The two
 * calls are the old ones (`ofapiKeyScopeGet`, `ofapiKeyScopeApply` with the read
 * fingerprint and version). Without a key the server answers 503, so both wait
 * while the API is off.
 */
export function KeyScopeCard({ blocked }: { blocked: string | null }) {
  const [scope, setScope] = useState<Scope | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [accounts, setAccounts] = useState("");
  const [known, setKnown] = useState(false);
  const [visibility, setVisibility] = useState<Scope["visibility"]>("unknown");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setPending(true); setError(null);
    try { await action(); } catch { setError("Не удалось прочитать или сохранить права."); }
    finally { setPending(false); }
  };
  return (
    <div className="sys-stack-16">
      <div className="sys-row-between">
        <p className="text-text-secondary">Какие операции разрешены текущему ключу, по вашей декларации.</p>
        <button
          type="button"
          className="btn"
          disabled={pending || blocked !== null}
          title={blocked ?? undefined}
          onClick={() => void run(async () => {
            const value = await readOfapiKeyScope(); setScope(value); setSelected(value.capabilities ?? []);
            setKnown(value.capabilities !== null); setAccounts(value.accountIds?.join(", ") ?? ""); setVisibility(value.visibility);
          })}
        >
          Прочитать права ключа
        </button>
      </div>
      {scope && (
        <form
          className="sys-stack-16"
          onSubmit={(event) => {
            event.preventDefault(); void run(async () => {
              const accountIds = accounts.trim() ? accounts.split(",").map((value) => value.trim()) : null;
              const updated = await applyOfapiKeyScope({ credentialFingerprint: scope.credentialFingerprint, expectedVersion: scope.version,
                capabilities: known ? capabilities.filter((value) => selected.includes(value)) : null, accountIds, visibility });
              setScope(updated);
            });
          }}
        >
          <p>Команда у OnlyFans API: {scope.observedTeam ?? "неизвестна"} · проверка: {preflightLabels[scope.preflightStatus] ?? scope.preflightStatus}</p>
          <p className="text-text-secondary sys-measure">
            Это локальная декларация ограничений. Выдайте права в консоли OnlyFans API, затем отразите их здесь. Hub не меняет ключ у
            OnlyFans API и не проверяет права на запись пробной отправкой.
          </p>
          <label className="sys-check"><input type="checkbox" checked={known} onChange={(e) => setKnown(e.target.checked)} /><span>Набор разрешённых операций известен</span></label>
          <fieldset disabled={!known || pending} className="sys-inline-checks">
            <legend className="sr-only">Разрешённые операции</legend>
            {capabilities.map((value) => (
              <label key={value} className="sys-check">
                <input type="checkbox" checked={selected.includes(value)} onChange={(e) => setSelected(e.target.checked ? [...selected, value] : selected.filter((item) => item !== value))} />
                <span>{capabilityLabels[value]}</span>
              </label>
            ))}
          </fieldset>
          <label className="block sys-measure">
            <span className="field-label">ID доступных аккаунтов через запятую</span>
            <input className="input" value={accounts} onChange={(e) => setAccounts(e.target.value)} />
            <span className="field-hint block">Пусто: ограничение не задано.</span>
          </label>
          <label className="block sys-measure">
            <span className="field-label">Область отчётов</span>
            <select className="select" value={visibility} onChange={(e) => setVisibility(e.target.value as Scope["visibility"])}>
              <option value="unknown">Неизвестна</option>
              <option value="declared_restricted">Ограниченные аккаунты</option>
              <option value="declared_team">Вся команда: подтверждено владельцем</option>
            </select>
          </label>
          <div>
            <button className="btn btn-primary" disabled={pending || blocked !== null} title={blocked ?? undefined} type="submit">Сохранить ограничения для этого ключа</button>
          </div>
        </form>
      )}
      {pending && <p className="text-text-secondary" role="status">Проверяем…</p>}
      {error && <p className="sys-error" role="alert">{error} Черновик сохранён. При конфликте сначала перечитайте права.</p>}
    </div>
  );
}
