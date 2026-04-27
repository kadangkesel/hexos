import { create } from "zustand";
import { apiFetch } from "@/lib/api";

interface YepAPIConnection {
  id: string;
  label: string;
  status: string;
  provider: string;
}

interface YepAPIState {
  connections: YepAPIConnection[];
  loading: boolean;
  error: string | null;

  // Actions
  fetchConnections: () => Promise<void>;
  addApiKey: (apiKey: string, label?: string) => Promise<{ ok: boolean; error?: string }>;
  removeConnection: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

export const useYepAPIStore = create<YepAPIState>()((set, get) => ({
  connections: [],
  loading: false,
  error: null,

  fetchConnections: async () => {
    set({ loading: true, error: null });
    try {
      const res = await apiFetch<{ data: any[]; pagination: any }>("/api/connections?provider=yepapi&limit=100");
      set({ connections: res.data, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to fetch", loading: false });
    }
  },

  addApiKey: async (apiKey, label) => {
    try {
      const res = await apiFetch<any>("/api/yepapi/add", {
        method: "POST",
        body: JSON.stringify({ apiKey, label }),
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

  removeConnection: async (id) => {
    try {
      const res = await apiFetch<any>(`/api/connections/${id}`, {
        method: "DELETE",
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
}));
