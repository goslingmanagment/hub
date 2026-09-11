import { useConfigPages } from "@/api/adminConfig";
import { CONFIG_MODE_CHOICES, configPageScope, selectedConfigPages, serializeConfigPages } from "./configurationChoices.js";

export interface ConfigChoiceProps {
  configKey: string;
  label: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  isDraft: boolean;
  onChange: (value: string) => void;
}

export function ConfigChoiceField(props: ConfigChoiceProps) {
  const choices = CONFIG_MODE_CHOICES[props.configKey];
  if (choices) return <select className="settings-input min-w-0 w-full" aria-label={`${props.label} value`} value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)}>
    {!choices.some((entry) => entry.value === props.value) && <option value={props.value}>Текущее: {props.value}</option>}
    {choices.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
  </select>;
  return <ConfigPageChoices {...props} />;
}

function ConfigPageChoices(props: ConfigChoiceProps) {
  const query = useConfigPages();
  const scope = configPageScope(props.configKey)!;
  const labels = (query.data ?? []).filter((page) => page.platform === "fansly").map((page) => page.label).sort();
  const selected = selectedConfigPages(props.value, props.configKey, labels, props.isDraft);
  // Unknown/retired labels are retained until the owner deliberately removes them.
  const choices = [...new Set([...labels, ...selected])];
  const unavailable = !query.data || query.isError;
  return <div className="min-w-0 w-full"><fieldset className="rounded-lg border border-border p-3" disabled={props.disabled || unavailable} aria-invalid={props.invalid}>
    <legend className="px-1 text-sm font-medium">Выбранные страницы</legend>
    <div className="max-h-52 space-y-1 overflow-y-auto">
      {choices.map((label) => <label key={label} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" className="size-4 accent-accent" checked={selected.includes(label)} onChange={(event) => props.onChange(serializeConfigPages(props.configKey, event.target.checked ? [...selected, label] : selected.filter((entry) => entry !== label)))} />
        <span>{label}{query.data && !labels.includes(label) && <span className="text-text-secondary"> · нет в текущем каталоге</span>}</span>
      </label>)}
    </div>
    {query.isLoading && <p role="status" className="text-sm text-text-secondary">Загружаем страницы…</p>}
    {query.isError && <p role="alert" className="text-sm text-danger">Не удалось обновить каталог. Ваш выбор не потерян.</p>}
    {!unavailable && choices.length === 0 && <p className="text-sm text-text-secondary">В каталоге нет страниц Fansly.</p>}
    {!unavailable && !selected.length && <p className="mt-2 text-sm text-text-secondary">{scope.none ? "Ни одной страницы: сохранение выключит эту проверку." : "Чтобы отключить функцию, используйте её переключатель. Для сохранения списка выберите хотя бы одну страницу."}</p>}
    {scope.empty === "all" && props.value === "" && !props.isDraft && <p className="mt-2 text-sm text-text-secondary">Сейчас разрешены все страницы, включая будущие. После выбора сохранится только конкретный список.</p>}
  </fieldset>
    {query.isError && <button type="button" className="mt-2 min-h-9 text-sm text-accent underline" disabled={props.disabled || query.isFetching} onClick={() => void query.refetch()}>Обновить каталог страниц</button>}
  </div>;
}
