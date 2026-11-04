import { ofapiActionSchema } from "@agency_hub_core/contracts";
import { KernelApiError } from "@kernel/sdk";
import type { OfapiActionField, OfapiActionFormDefinition } from "./form-types.ts";
export type FormValues = Record<string, unknown>;
export function initialActionValues(fields: OfapiActionField[]): FormValues {
  return Object.fromEntries(fields.flatMap(field => field.defaultValue !== undefined
    ? [[field.name, field.defaultValue]]
    : field.type === "boolean" && field.required ? [[field.name, false]] : []));
}
function cents(value: unknown) {
  const text = String(value).trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("Укажите сумму с точностью до цента");
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Сумма слишком большая");
  return Number(amount);
}
function numeric(value: unknown, label: string) {
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(Number(text))) throw new Error(`Укажите число: ${label}`);
  return Number(text);
}
/** Reject impossible local times instead of silently moving them to another day/hour. */
export function localActionDateTimeToIso(value: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
  if (!match) throw new Error("Укажите местную дату и время");
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part ?? 0));
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second)
    throw new Error("Эта дата или местное время не существует. Проверьте дату и переход часового пояса.");
  return date.toISOString();
}
export function actionFieldValues(fields: OfapiActionField[], values: FormValues): FormValues {
  const body: FormValues = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.allowEmptyText && value === null) { body[field.name] = ""; continue; }
    if (field.allowEmptyText && typeof value === "string" && !value.trim()) throw new Error(`Заполните поле «${field.label}» или явно выберите очистку текста`);
    if (value === undefined || (typeof value === "string" && !value.trim() && !field.required && field.defaultValue !== "")) continue;
    switch (field.type) {
      case "money": body[field.name] = cents(value); break;
      case "number": body[field.name] = numeric(value, field.label); break;
      case "datetime": body[field.name] = localActionDateTimeToIso(value); break;
      case "select": {
        const option = field.options?.find(option => String(option.value) === String(value));
        if (!option) throw new Error(`Выберите значение: ${field.label}`);
        body[field.name] = option.value; break;
      }
      case "strings": case "numbers": case "money-list": {
        // Newlines/semicolons or comma+space separate monetary values; a decimal
        // comma within one amount remains a decimal comma, never two amounts.
        const separator = field.listSeparator === "newline" ? /\r?\n/ : field.type === "money-list" ? /[\n;]+|,\s+/ : /[\n,]+/;
        const items = Array.isArray(value) ? value : String(value).split(separator).map(item => item.trim()).filter(Boolean);
        body[field.name] = field.type === "money-list" ? items.map(cents) : field.type === "numbers" ? items.map(item => numeric(item, field.label)) : items;
        break;
      }
      case "rows": {
        if (!Array.isArray(value) || value.some(row => row === null || typeof row !== "object" || Array.isArray(row))) throw new Error(`Проверьте строки: ${field.label}`);
        body[field.name] = value.map(row => actionFieldValues(field.fields ?? [], row as FormValues)); break;
      }
      default: body[field.name] = value;
    }
  }
  return body;
}
export function buildOfapiAction(form: OfapiActionFormDefinition, pageId: number, values: FormValues) {
  const parsed = ofapiActionSchema.safeParse({ action: form.action, pageId, ...actionFieldValues(form.fields, values) });
  if (!parsed.success) throw new Error("Проверьте обязательные поля и ограничения действия. " + (parsed.error.issues[0]?.message ?? ""));
  return parsed.data;
}

/** Amounts in frozen intents are cents; the owner review always renders USD. */
export function reviewActionFieldValue(field: OfapiActionField, value: unknown): unknown {
  if (field.allowEmptyText && value === "") return "Текст будет очищен";
  const usd = (amount: unknown) => {
    if (typeof amount !== "number" || !Number.isSafeInteger(amount)) return "Некорректная сумма";
    const cents = BigInt(amount);
    return `${(cents / 100n).toLocaleString("ru-RU")},${String(cents % 100n).padStart(2, "0")} USD`;
  };
  if (field.type === "money") return usd(value);
  if (field.type === "money-list" && Array.isArray(value)) return value.map(usd);
  if (field.type === "select") return field.options?.find(option => option.value === value)?.label ?? value;
  if (field.type === "strings" && field.options && Array.isArray(value)) return value.map(item => field.options?.find(option => option.value === item)?.label ?? item);
  if (field.type === "datetime" && typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return `${date.toLocaleString("ru-RU")} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n${date.toISOString()} (UTC)`;
  }
  if (field.type === "rows" && Array.isArray(value)) return value.map(row => Object.fromEntries((field.fields ?? []).filter(child => row !== null && typeof row === "object" && child.name in row).map(child => [child.label, reviewActionFieldValue(child, (row as FormValues)[child.name])])));
  return value;
}

/** A draft edit or lost HTTP reply must never allocate another identity for the same intent. */
export function createActionAdmissionRegistry(createId: () => string) {
  const ids = new Map<string, string>();
  const key = (command: unknown): string => JSON.stringify(command);
  return {
    forCommand(command: unknown) {
      const fingerprint = key(command);
      if (!ids.has(fingerprint)) ids.set(fingerprint, createId());
      return ids.get(fingerprint)!;
    },
    startNew(command: unknown) { ids.set(key(command), createId()); },
  };
}

export function actionDraftMatches(form: OfapiActionFormDefinition, pageId: number | null, values: FormValues, command: unknown): boolean {
  if (pageId === null) return false;
  try { return JSON.stringify(buildOfapiAction(form, pageId, values)) === JSON.stringify(command); }
  catch { return false; }
}

/** Kernel 4xx refusal is definite; a lost reply or unreadable success needs GET recovery. */
export function isUncertainActionFailure(reason: unknown): boolean {
  return !(reason instanceof KernelApiError && reason.category !== "contract" && reason.status !== null && reason.status >= 400 && reason.status < 500);
}
