import { toast } from "sonner";
import { KernelApiError } from "@/api/sdk";

export const UNKNOWN_OUTCOME = "Hub не ответил: неизвестно, сохранилось ли.";

export function errorStatus(error: unknown): number | null {
  return error instanceof KernelApiError ? error.status : null;
}

export function errorCode(error: unknown): string | null {
  return error instanceof KernelApiError ? error.code : null;
}

/** No answer, or the hub broke: the write may or may not have happened. */
export function isUnknownOutcome(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status >= 500;
}

export function isConflict(error: unknown): boolean {
  return errorStatus(error) === 409;
}

/** The raw text, for a title attribute only. */
export function rawError(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}

/** An error stays until it is closed: it is read, not glanced at. */
export function toastError(text: string): void {
  toast.error(text, {
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Закрыть", onClick: () => undefined },
    classNames: { actionButton: "btn btn-sm" },
  });
}

/** A write's error by its kind: unknown outcome, or the screen's own words. */
export function toastWriteError(error: unknown, known: string): void {
  toastError(isUnknownOutcome(error) ? UNKNOWN_OUTCOME : known);
}
