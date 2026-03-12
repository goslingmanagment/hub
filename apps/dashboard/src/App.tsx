import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Toaster } from "sonner";
import { handle401 } from "@/api/queries";
import { ProtectedLayout } from "@/components/layout/ProtectedLayout";
import { LoginPage } from "@/pages/LoginPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { PagesListPage } from "@/pages/PagesListPage";
import { PageDetailPage } from "@/pages/PageDetailPage";
import { ModelsListPage } from "@/pages/ModelsListPage";
import { ModelDetailPage } from "@/pages/ModelDetailPage";
import { TransactionsPage } from "@/pages/TransactionsPage";
import { FansSearchPage } from "@/pages/FansSearchPage";
import { FanDetailPage } from "@/pages/FanDetailPage";
import { SpendersPage } from "@/pages/SpendersPage";
import { SpenderDetailPage } from "@/pages/SpenderDetailPage";
import { UsersPage } from "@/pages/UsersPage";
import { CredentialsPage } from "@/pages/CredentialsPage";
import { SyncPage } from "@/pages/SyncPage";
import { ApiRunnerPage } from "@/pages/ApiRunnerPage";

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: handle401,
  }),
  mutationCache: new MutationCache({
    onError: (error) => handle401(error),
  }),
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedLayout />}>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="overview" element={<OverviewPage />} />
            <Route path="pages" element={<PagesListPage />} />
            <Route path="pages/:pageLabel" element={<PageDetailPage />} />
            <Route path="models" element={<ModelsListPage />} />
            <Route path="models/:modelSlug" element={<ModelDetailPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="fans" element={<FansSearchPage />} />
            <Route path="fans/:platform/:platformUserId" element={<FanDetailPage />} />
            <Route path="spenders" element={<SpendersPage />} />
            <Route path="spenders/:platform/:platformUserId" element={<SpenderDetailPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="settings/credentials" element={<CredentialsPage />} />
            <Route path="settings/sync" element={<SyncPage />} />
            <Route path="api-runner" element={<ApiRunnerPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster theme="dark" position="bottom-right" />
    </QueryClientProvider>
  );
}
