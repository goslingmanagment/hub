import { useAuthStore } from "@/stores/auth";
import { useLogout } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export function TopBar() {
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();

  return (
    <header className="flex h-12 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4">
      <div />
      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-500">
          {user?.username}
          <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {user?.role}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => logout.mutate()}
          title="Logout"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
