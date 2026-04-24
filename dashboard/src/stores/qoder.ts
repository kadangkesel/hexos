import { create } from "zustand";
import { apiFetch } from "@/lib/api";

interface QoderConnection {
  id: string;
  label: string;
  status: string;
  uid: string;
  email?: string;
  plan?: string;
  isQuotaExceeded?: boolean;
  credit?: {
    totalCredits: number;
    remainingCredits: number;
    packageName: string;
  };
}

interface QoderState {
  connections: QoderConnection[];
  loading: boolean;
  error: string | null;
  loginLoading: boolean;

  // Actions
  fetchConnections: () => Promise<void>;
  addManual: (uid: string, token: string, refreshToken?: string, label?: string) => Promise<{ ok: boolean; error?: string }>;
  importFromCli: (authDir?: string, label?: string) => Promise<{ ok: boolean; error?: string }>;
  importFromIde: () => Promise<{ ok: boolean; error?: string; email?: string; name?: string }>;
  loginWithGoogle: (email: string, password: string, label?: string, headless?: boolean) => Promise<{ ok: boolean; error?: string }>;
}

export const useQoderStore = create<QoderState>()((set, get) => ({
  connections: [],
  loading: false,
  error: null,
  loginLoading: false,

  fetchConnections: async () => {
    set({ loading: true, error: null });
    try {
      // Fetch all connections and filter for qoder
      const res = await apiFetch<{ data: any[]; pagination: any }>("/api/connections?limit=500");
      const qoderConns = res.data.filter((c: any) => c.provider === "qoder");
      set({ connections: qoderConns, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to fetch", loading: false });
    }
  },

  addManual: async (uid, token, refreshToken, label) => {
    try {
      const res = await apiFetch<any>("/api/qoder/add", {
        method: "POST",
        body: JSON.stringify({ uid, token, refreshToken, label }),
      });
      if (res.ok) {
        await get().fetchConnections();
        return { ok: true };
      }
      return { ok: false, error: res.error || "Unknown error" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed" };
    }
  },

  importFromCli: async (authDir, label) => {
    try {
      const res = await apiFetch<any>("/api/qoder/import-cli", {
        method: "POST",
        body: JSON.stringify({ authDir, label }),
      });
      if (res.ok) {
        await get().fetchConnections();
        return { ok: true };
      }
      return { ok: false, error: res.error || "Unknown error" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed" };
    }
  },

  importFromIde: async () => {
    try {
      const res = await apiFetch<any>("/api/qoder/import-ide", {
        method: "POST",
        body: "{}",
      });
      if (res.ok) {
        await get().fetchConnections();
        return { ok: true, email: res.email, name: res.name };
      }
      return { ok: false, error: res.error || "Unknown error" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed" };
    }
  },

  loginWithGoogle: async (email, password, label, headless) => {
    set({ loginLoading: true });
    try {
      const res = await apiFetch<any>("/api/qoder/login", {
        method: "POST",
        body: JSON.stringify({ email, password, label, headless: headless ?? true }),
      });
      set({ loginLoading: false });
      if (res.ok) {
        await get().fetchConnections();
        return { ok: true };
      }
      return { ok: false, error: res.error || "Unknown error" };
    } catch (err) {
      set({ loginLoading: false });
      return { ok: false, error: err instanceof Error ? err.message : "Failed" };
    }
  },
}));
