import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";
import type { HubFeature } from "./featureCatalog.js";

export type FeatureState = { kind: "on" | "off" | "limited" | "unknown" | "pending" | "unavailable"; label: string; detail: string };

/** This is configuration readiness, never usage, success or business impact. */
export function featureState(feature: HubFeature, data: ConfigViewResponse): FeatureState {
  const items = new Map(data.subsystems.flatMap((group) => group.items).map((item) => [item.key, item]));
  const keys = [...feature.gates.map((entry) => entry.key), ...(feature.scope ? [feature.scope.key] : [])];
  const valueOf = (item: ConfigItem) => reportedValue(item, data.roleStatuses.map((entry) => entry.role));
  if (keys.some((key) => !items.has(key))) return { kind: "unavailable", label: "Нет в этой версии", detail: "Сервер не сообщил необходимые настройки." };
  if (feature.keys.some((key) => items.get(key)?.pendingApply)) return { kind: "pending", label: "Ждёт применения", detail: "Сохранённое значение ещё не подтверждено всеми процессами." };
  // Match the API's expected api/worker/sync roles and include every additional observed role.
  const fleetKnown = ["api", "worker", "sync"].every((role) => data.roleStatuses.some((entry) => entry.role === role && entry.status === "active"))
    && data.roleStatuses.every((entry) => entry.status === "active");
  if (!fleetKnown || keys.some((key) => valueOf(items.get(key)!) === undefined)) {
    return { kind: "unknown", label: "Нужно проверить", detail: "Нет согласованного актуального значения от всех частей Hub." };
  }
  for (const entry of feature.gates) {
    const item = items.get(entry.key)!;
    const value = valueOf(item)!;
    // Server-computed boolean state remains authoritative for staged flags.
    if (item.kind === "boolean" && item.runningState === "unknown") return { kind: "unknown", label: "Нужно проверить", detail: "Применение переключателя не подтверждено сервером." };
    if ((item.kind === "boolean" && item.runningState === "off") || (entry.off ?? [false]).includes(value as string | boolean)) return { kind: "off", label: "Выключено", detail: "Один из необходимых переключателей выключен." };
  }
  let scopeDetail = "Разрешено настройками. Выполнение проверяется отдельно.";
  if (feature.scope) {
    const scope = feature.scope;
    const raw = String(valueOf(items.get(scope.key)!)).trim();
    const entries = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if ((entries.length === 0 && scope.empty === "none") || (scope.none !== undefined && raw === scope.none)) {
      return { kind: "off", label: "Нет выбранных страниц", detail: "Настройки не разрешают ни одной страницы." };
    }
    if ((entries.length === 0 && scope.empty === "all") || (scope.all !== undefined && raw === scope.all)) scopeDetail = "Все страницы в охвате этой функции.";
    else scopeDetail = `Выбрано: ${entries.join(", ")}.`;
  }
  const modes = feature.gates.map((entry) => valueOf(items.get(entry.key)!));
  if (modes.includes("shadow")) return { kind: "limited", label: "Режим проверки", detail: "Вычисляет результат для проверки; применение зависит от выбранного режима." };
  if (modes.includes("request_only")) return { kind: "limited", label: "Только заявки", detail: "Новые заявки принимаются без исполнения." };
  if (modes.includes("read_only")) return { kind: "limited", label: "Проверочный доступ", detail: "Чтение разрешено с ограничением достоверности выводов." };
  return { kind: "on", label: "Включено", detail: scopeDetail };
}

function reportedValue(item: ConfigItem, expectedRoles: string[]): string | number | boolean | undefined {
  if (item.secret || item.drift || item.running.length === 0 || !expectedRoles.every((role) => item.running.some((entry) => entry.role === role)) || item.running.some((entry) => entry.masked || entry.state === "unknown" || entry.value === null)) return undefined;
  const first = item.running[0]!.value;
  if (!item.running.every((entry) => entry.value === first)) return undefined;
  return first ?? undefined;
}
