import { create } from "zustand";
import { apiFetch } from "@/lib/api";

interface CodexConnection {
  id: string;
  label: string;
  email?: string;
  status: string;
  planType?: string;
  usageCount?: number;
  rateLimits?: {
    primaryUsedPercent: number;
    secondaryUsedPercent: number;
    primaryWindowMinutes: number;
    secondaryWindowMinutes: number;
  };
}

interface CodexAuthData {
  authUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

interface CodexState {
  connections: CodexConnection[];
  loading: boolean;
  error: string | null;
  authData: CodexAuthData | null;
  authPolling: boolean;

  fetchConnections: () => Promise<void>;
  importTokens: (accessToken: string, refreshToken: string) => Promise<{ ok: boolean; error?: string; email?: string }>;
  importFromCli: () => Promise<{ ok: boolean; error?: string; email?: string }>;
  startOAuth: () => Promise<{ ok: boolean; authUrl?: string; error?: string }>;
  exchangeCode: (code: string) => Promise<{ ok: boolean; error?: string; email?: string }>;
  removeConnection: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

export const useCodexStore = create<CodexState>((set, get) => ({
  connections: [],
  loading: false,
  error: null,
  authData: null,
  authPolling: false,

  fetchConnections: async () => {
    set({ loading: true, error: null });
    try {
      // Fetch ALL pages to find codex connections (they may be on any page)
      let allConns: any[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const res = await apiFetch<{ data: any[]; pagination: { totalPages: number } }>(`/api/connections?page=${page}&limit=50`);
        allConns = allConns.concat(res.data || []);
        totalPages = res.pagination?.totalPages || 1;
        page++;
      } while (page <= totalPages);

      const codexConns = allConns
        .filter((c) => c.provider === "codex")
        .map((c) => ({
          id: c.id,
          label: c.label || c.email || "Codex Account",
          email: c.label,
          status: c.status || "active",
          planType: c.credit?.packageName,
          usageCount: c.usageCount,
        }));
      set({ connections: codexConns, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  importTokens: async (accessToken, refreshToken) => {
    try {
      const res = await apiFetch<{ success: boolean; connection?: { id: string; email: string; plan: string }; error?: string }>("/api/codex/import", {
        method: "POST",
        body: JSON.stringify({ accessToken, refreshToken }),
      });
      if (res.success) {
        await get().fetchConnections();
        return { ok: true, email: res.connection?.email };
      }
      return { ok: false, error: res.error || "Import failed" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  importFromCli: async () => {
    try {
      const res = await apiFetch<{ success: boolean; connection?: { id: string; email: string }; error?: string }>("/api/codex/import-cli", { method: "POST" });
      if (res.success) {
        await get().fetchConnections();
        return { ok: true, email: res.connection?.email };
      }
      return { ok: false, error: res.error || "No Codex CLI auth found" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  startOAuth: async () => {
    try {
      const data = await apiFetch<CodexAuthData>("/api/codex/auth-url");
      set({ authData: data });
      return { ok: true, authUrl: data.authUrl };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  exchangeCode: async (code) => {
    const { authData } = get();
    if (!authData) return { ok: false, error: "No auth session" };
    try {
      const res = await apiFetch<{ success: boolean; connection?: { id: string; email: string }; error?: string }>("/api/codex/exchange", {
        method: "POST",
        body: JSON.stringify({
          code,
          codeVerifier: authData.codeVerifier,
          redirectUri: authData.redirectUri,
        }),
      });
      set({ authData: null });
      if (res.success) {
        await get().fetchConnections();
        return { ok: true, email: res.connection?.email };
      }
      return { ok: false, error: res.error || "Exchange failed" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  removeConnection: async (id) => {
    try {
      await apiFetch(`/api/connections/${id}`, { method: "DELETE" });
      await get().fetchConnections();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
}));
