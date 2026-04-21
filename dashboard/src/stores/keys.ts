import { create } from "zustand";
import { apiFetch } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ApiKey {
  id: string;
  key: string;
  masked: string;
  name?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface KeysState {
  keys: ApiKey[];
  loading: boolean;
  error: string | null;
  fetch: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export const useKeysStore = create<KeysState>()((set) => ({
  keys: [],
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const keys = await apiFetch<ApiKey[]>("/api/keys");
      set({ keys, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch API keys",
        loading: false,
      });
    }
  },
}));
