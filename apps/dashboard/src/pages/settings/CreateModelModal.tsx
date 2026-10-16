import { useState } from "react";
import type { CreateModelBody } from "@agency_hub_core/contracts";
import { useAdminCreateModel } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";

const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l",
  м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** A short name proposed from the model's name: Latin, lower case, words
 *  joined by a dash ("Лора Вип" → "lora-vip"). The owner may type another. */
export function slugFromName(name: string): string {
  return [...name.trim().toLowerCase()]
    .map((char) => CYRILLIC[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function CreateModelModal({ onClose }: { onClose: () => void }) {
  const createModel = useAdminCreateModel();
  const [name, setName] = useState("");
  // null: the short name follows the name until the owner types one himself.
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  const slug = typedSlug ?? slugFromName(name);

  async function handleSubmit() {
    const body: CreateModelBody = {
      slug: slug.trim(),
      name: name.trim(),
    };

    try {
      await createModel.mutateAsync(body);
      toast.success("Модель добавлена");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось добавить модель");
    }
  }

  return (
    <ModalShell title="Новая модель" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Имя модели">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="например, Лора"
            autoComplete="off"
            className="input"
          />
        </Field>
        <Field label="Короткое имя" hint="Внутреннее имя модели в Hub. Подставляется из имени — менять не обязательно.">
          <input
            value={slug}
            onChange={(event) => setTypedSlug(event.target.value)}
            placeholder="lora"
            autoComplete="off"
            spellCheck={false}
            className="input"
          />
        </Field>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="btn">
          Отмена
        </button>
        <button
          type="button"
          disabled={createModel.isPending || !slug.trim() || !name.trim()}
          onClick={handleSubmit}
          className="btn btn-primary"
        >
          {createModel.isPending ? "Добавляем…" : "Добавить модель"}
        </button>
      </div>
    </ModalShell>
  );
}
