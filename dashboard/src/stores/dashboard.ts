import { create } from "zustand";
import { apiFetch } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DashboardStats {
  totalAccounts: number;
  activeAccounts: number;
  totalModels: number;
  totalRequests: number;
  totalTokens: number;
  uptime: number;
  totalCost: number;
  [key: string]: unknown; // allow extra fields from the API
}

export interface DashboardState {
  stats: DashboardStats | null;
  loading: boolean;
  error: string | null;
  fetch: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export const useDashboardStore = create<DashboardState>()((set) => ({
  stats: null,
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const stats = await apiFetch<DashboardStats>("/api/dashboard");
      set({ stats, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch dashboard",
        loading: false,
      });
    }
  },
}));
