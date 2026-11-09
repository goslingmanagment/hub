import { toast } from "@agency_hub_core/ui";

/** Writes the sheet's text to the clipboard and says so; a refused clipboard says what to do instead (TeamPayoutsPage.tsx:443-453). */
export async function copySheet(text: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  } catch {
    toast.error("Буфер обмена недоступен. Выделите таблицу и скопируйте вручную.");
  }
}
