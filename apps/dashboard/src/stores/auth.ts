import type { AuthState } from "@fansly-connect/contracts";
import { create } from "zustand";

type User = AuthState["user"];

interface AuthStore {
  user: User | null;
  authMethod: string | null;
  isOwner: boolean;
  setAuth: (user: User, authMethod: string) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  authMethod: null,
  isOwner: false,
  setAuth: (user, authMethod) =>
    set({ user, authMethod, isOwner: user.role === "owner" }),
  clearAuth: () => set({ user: null, authMethod: null, isOwner: false }),
}));
