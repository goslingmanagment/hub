import { useEffect, useRef, useState } from "react";
import { KernelApiError, ofapiCollectionJobSchema } from "@agency_hub_core/contracts";
import type { OfapiCollectionJobBody, OfapiCollectionJobCreateResult } from "@/api/adminOfapiCollection";

export interface CollectionJobLaunch {
  ownerId: number;
  launchId: string;
  pageLabel: string;
  body: OfapiCollectionJobBody;
  startedAt: string;
  phase: "sending" | "uncertain" | "confirmed" | "refused";
  jobId: string | null;
  error: string;
}

const changedEvent = "hub:collection-job-launch-changed";
export const collectionJobStorageKey = (ownerId: number) => `hub:collection-job-launch:v1:owner:${ownerId}`;
export const collectionJobUnresolved = (launch: CollectionJobLaunch | null) => launch?.phase === "sending" || launch?.phase === "uncertain";

interface CollectionJobWorkspace { launch: CollectionJobLaunch | null; history: CollectionJobLaunch[] }

function restoreLaunch(value: unknown, ownerId: number, recoverInterrupted: boolean): CollectionJobLaunch {
  const launch = value as Partial<CollectionJobLaunch> | null;
  if (!launch || launch.ownerId !== ownerId || typeof launch.launchId !== "string"
    || typeof launch.pageLabel !== "string" || typeof launch.startedAt !== "string" || !Number.isFinite(Date.parse(launch.startedAt))
    || !["sending", "uncertain", "confirmed", "refused"].includes(launch.phase ?? "") || typeof launch.error !== "string"
    || !(launch.jobId === null || typeof launch.jobId === "string")) throw new Error("Invalid saved collection launch");
  if (launch.phase === "confirmed" && !launch.jobId) throw new Error("Missing collection job receipt");
  const interrupted = recoverInterrupted && launch.phase === "sending";
  return {
    ...launch as CollectionJobLaunch,
    body: ofapiCollectionJobSchema.parse(launch.body),
    phase: interrupted ? "uncertain" : launch.phase as CollectionJobLaunch["phase"],
    error: interrupted ? "Страница была закрыта во время отправки. Задача могла попасть в очередь." : launch.error,
  };
}

function restoreWorkspace(raw: string | null, ownerId: number, recoverInterrupted = true): CollectionJobWorkspace {
  if (raw === null) return { launch: null, history: [] };
  const value = JSON.parse(raw) as { version?: number; launch?: unknown; history?: unknown };
  if (value.version !== 1 || !(value.history === undefined || Array.isArray(value.history))) throw new Error("Invalid collection launch history");
  return {
    launch: value.launch === null ? null : restoreLaunch(value.launch, ownerId, recoverInterrupted),
    history: (value.history ?? []).map((entry: unknown) => restoreLaunch(entry, ownerId, true)),
  };
}

export function restoreCollectionJobLaunch(raw: string | null, ownerId: number, recoverInterrupted = true) {
  return restoreWorkspace(raw, ownerId, recoverInterrupted).launch;
}

export function serializeCollectionJobLaunch(launch: CollectionJobLaunch | null, history: CollectionJobLaunch[] = []) {
  return JSON.stringify({ version: 1, launch, history });
}

export function collectionJobFailure(error: unknown) {
  const refused = error instanceof KernelApiError && error.category !== "contract"
    && error.status !== null && [400, 401, 403, 404, 405, 409, 422, 429].includes(error.status);
  return {
    phase: refused ? "refused" as const : "uncertain" as const,
    error: refused
      ? `Сервер отказал в создании задачи. ${error instanceof Error ? error.message : String(error)}`
      : "Подтверждение не получено. Задача могла попасть в очередь; повтор создаст другую задачу с отдельным расходом.",
  };
}

function read(ownerId: number, recoverInterrupted = true) {
  return restoreWorkspace(typeof window === "undefined" ? null : window.sessionStorage.getItem(collectionJobStorageKey(ownerId)), ownerId, recoverInterrupted);
}

export function useCollectionJobCustody(ownerId: number) {
  const [initial] = useState(() => {
    try { return { workspace: read(ownerId), error: "" }; }
    catch { return { workspace: { launch: null, history: [] } as CollectionJobWorkspace, error: "Сохранённый результат запуска недоступен. Новые задачи заблокированы до восстановления записи; чтение очереди доступно." }; }
  });
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [storageError, setStorageError] = useState(initial.error);
  const workspaceRef = useRef(workspace);
  const sending = useRef(false);

  useEffect(() => {
    if (initial.workspace.launch?.phase === "uncertain") {
      try {
        const saved = read(ownerId, false);
        // A request from the previous mount can settle between render and this
        // effect. Its receipt must never be downgraded to an unknown outcome.
        const interrupted = saved.launch?.launchId === initial.workspace.launch.launchId && saved.launch.phase === "sending";
        const next = interrupted ? { ...saved, launch: initial.workspace.launch } : saved;
        if (interrupted) window.sessionStorage.setItem(collectionJobStorageKey(ownerId), serializeCollectionJobLaunch(next.launch, next.history));
        workspaceRef.current = next;
        setWorkspace(next);
      }
      catch { setStorageError("Не удалось сохранить неопределённый исход запуска. Новые задачи пока недоступны."); }
    }
    const update = () => {
      try { const next = read(ownerId, false); workspaceRef.current = next; setWorkspace(next); setStorageError(""); }
      catch { setStorageError("Не удалось прочитать результат запуска. Новые задачи пока недоступны."); }
    };
    window.addEventListener(changedEvent, update);
    return () => window.removeEventListener(changedEvent, update);
  }, [initial.workspace, ownerId]);

  function persist(next: CollectionJobWorkspace) {
    if (next.launch || next.history.length) window.sessionStorage.setItem(collectionJobStorageKey(ownerId), serializeCollectionJobLaunch(next.launch, next.history));
    else window.sessionStorage.removeItem(collectionJobStorageKey(ownerId));
    workspaceRef.current = next;
    setWorkspace(next);
    setStorageError("");
    window.dispatchEvent(new Event(changedEvent));
  }

  async function submit(body: OfapiCollectionJobBody, pageLabel: string, send: (body: OfapiCollectionJobBody) => Promise<OfapiCollectionJobCreateResult>) {
    if (sending.current || storageError || collectionJobUnresolved(workspaceRef.current.launch)) return false;
    sending.current = true;
    let prepared: CollectionJobLaunch;
    try {
      const saved = read(ownerId, false);
      if (collectionJobUnresolved(saved.launch)) { sending.current = false; return false; }
      prepared = { ownerId, launchId: crypto.randomUUID(), pageLabel, body: ofapiCollectionJobSchema.parse(body),
        startedAt: new Date().toISOString(), phase: "sending", jobId: null, error: "" };
      persist({ ...saved, launch: prepared });
    } catch {
      setStorageError("Не удалось сохранить параметры запуска в этой вкладке. Отправка не началась; разрешите хранилище браузера и повторите проверку.");
      sending.current = false;
      return false;
    }
    try {
      const result = await send(prepared.body);
      const outcome: CollectionJobLaunch = { ...prepared, phase: "confirmed", jobId: result.id };
      try { settle(outcome); }
      catch { retainUnsaved(outcome); setStorageError("Задача создана, но результат не сохранился в этой вкладке. Сохраните её номер перед уходом."); }
      return true;
    } catch (error) {
      const outcome: CollectionJobLaunch = { ...prepared, ...collectionJobFailure(error) };
      try { settle(outcome); }
      catch { retainUnsaved(outcome); setStorageError("Не удалось сохранить исход запуска. Сверьте очередь перед следующим действием."); }
      return false;
    } finally { sending.current = false; }
  }

  function withOutcome(current: CollectionJobWorkspace, outcome: CollectionJobLaunch) {
    if (current.launch?.launchId === outcome.launchId) return { ...current, launch: outcome };
    return { ...current, history: current.history.map(entry => entry.launchId === outcome.launchId ? outcome : entry) };
  }
  function settle(outcome: CollectionJobLaunch) { persist(withOutcome(read(ownerId, false), outcome)); }
  function retainUnsaved(outcome: CollectionJobLaunch) {
    const next = withOutcome(workspaceRef.current, outcome);
    workspaceRef.current = next; setWorkspace(next);
  }

  function dismiss() {
    if (sending.current || collectionJobUnresolved(workspaceRef.current.launch)) return;
    try {
      const saved = read(ownerId, false);
      if (collectionJobUnresolved(saved.launch) || saved.launch?.launchId !== workspaceRef.current.launch?.launchId) return;
      persist({ ...saved, launch: null });
    } catch { setStorageError("Не удалось закрыть сохранённый результат."); }
  }
  function allowSeparateJob(acknowledged: boolean) {
    if (!acknowledged || sending.current || storageError || workspaceRef.current.launch?.phase !== "uncertain") return false;
    try {
      const saved = read(ownerId, false);
      if (saved.launch?.launchId !== workspaceRef.current.launch.launchId || !collectionJobUnresolved(saved.launch)) return false;
      persist({ launch: null, history: [...saved.history, { ...saved.launch, phase: "uncertain" }] });
      return true;
    } catch { setStorageError("Не удалось сохранить предыдущий исход. Новая задача пока недоступна."); return false; }
  }
  function recover() {
    if (sending.current) return;
    try { const next = read(ownerId); workspaceRef.current = next; setWorkspace(next); setStorageError(""); }
    catch { setStorageError("Запись запуска не восстановлена. Не создавайте повторную задачу до сверки исхода."); }
  }
  return { ...workspace, storageError, submit, dismiss, allowSeparateJob, recover, blocked: Boolean(storageError) || collectionJobUnresolved(workspace.launch), pending: workspace.launch?.phase === "sending" };
}
