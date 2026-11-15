import { Toaster } from "sonner";
import { useThemeStore } from "@/lib/theme";

/** A short result, in the console's theme and look: no loud colours. */
export function ConsoleToaster() {
  const theme = useThemeStore((state) => state.theme);
  return (
    <Toaster
      position="bottom-right"
      theme={theme}
      style={{ zIndex: 40 }}
      toastOptions={{
        unstyled: true,
        classNames: { toast: "toast", success: "toast-success", error: "toast-error", warning: "toast-warning" },
      }}
    />
  );
}
