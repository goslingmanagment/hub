import { toast } from "@agency_hub_core/ui";

/** Writes a text to the clipboard and says so; a refused clipboard says what to do instead. */
export async function copyText(text: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  } catch {
    toast.error("Буфер обмена недоступен. Выделите текст и скопируйте вручную.");
  }
}
