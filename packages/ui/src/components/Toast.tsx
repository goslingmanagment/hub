import { Toaster as SonnerToaster, toast } from "sonner";
import { useThemeStore } from "../theme.js";

/**
 * Short results of an action, bottom right, in the app's theme (sonner, as in
 * the console). Success: what, how many, where — gone after 4 s. Error: what did
 * not work and what happened to the data — stays until closed. Never Hub's raw
 * English; never for something to read and decide (that is a Notice or a window).
 * Mount once in the app; call `toast.success(…)` / `toast.error(…)` anywhere.
 */
export function Toaster() {
  const theme = useThemeStore((state) => state.theme);
  return (
    <SonnerToaster
      position="bottom-right"
      theme={theme}
      closeButton
      style={{ zIndex: 40 }}
      toastOptions={{
        unstyled: true,
        duration: 4000,
        classNames: { toast: "ui-toast" },
      }}
    />
  );
}

export { toast };
