import { Navigate, Outlet } from "react-router";
import { useAuthMe } from "@/api/queries";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function ProtectedLayout() {
  const { data, isLoading, isError } = useAuthMe();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (isError || !data) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar user={data.user} />
      <div className="ml-[248px] flex-1">
        <Topbar user={data.user} />
        <main className="mt-[56px] p-8 max-w-[1200px]">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
