import { create } from "zustand";
import { apiFetch } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Model {
  id: string;
  name: string;
  provider?: string;
  [key: string]: unknown;
}

export interface ModelsState {
  models: Model[];
  loading: boolean;
  error: string | null;
  fetch: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export const useModelsStore = create<ModelsState>()((set) => ({
  models: [],
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const models = await apiFetch<Model[]>("/api/models");
      set({ models, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch models",
        loading: false,
      });
    }
  },
}));
