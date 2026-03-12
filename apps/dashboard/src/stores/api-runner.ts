import { create } from "zustand";

interface HistoryEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  timestamp: number;
}

interface ApiRunnerStore {
  endpoint: string;
  params: Record<string, string>;
  response: { status: number; body: unknown; durationMs: number } | null;
  history: HistoryEntry[];
  setEndpoint: (v: string) => void;
  setParams: (v: Record<string, string>) => void;
  setResponse: (v: { status: number; body: unknown; durationMs: number }) => void;
  addHistory: (entry: HistoryEntry) => void;
}

export const useApiRunnerStore = create<ApiRunnerStore>((set) => ({
  endpoint: "",
  params: {},
  response: null,
  history: [],
  setEndpoint: (v) => set({ endpoint: v, params: {}, response: null }),
  setParams: (v) => set({ params: v }),
  setResponse: (v) => set({ response: v }),
  addHistory: (entry) =>
    set((s) => ({ history: [entry, ...s.history].slice(0, 50) })),
}));
