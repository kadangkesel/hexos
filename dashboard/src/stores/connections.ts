import { create } from "zustand";
import { apiFetch } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Connection {
  id: string;
  email: string;
  label?: string;
  status: "active" | "disabled" | "expired";
  enabled?: boolean;
  tokenValid?: boolean;
  lastChecked?: string;
  credit?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BatchConnectRequest {
  accounts: { email: string; password: string; label?: string }[];
  concurrency?: number;
  headless?: boolean;
  providers?: string[];  // ["codebuddy", "cline", "kiro"] - which providers to login to
}

export interface BatchTaskLog {
  time: string;
  level: "info" | "error" | "success";
  message: string;
}

export interface BatchTask {
  taskId: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  results?: unknown[];
  logs?: BatchTaskLog[];
  [key: string]: unknown;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface FetchParams {
  page?: number;
  limit?: number;
  search?: string;
  provider?: string;
  status?: string;
}

export interface ConnectionsState {
  connections: Connection[];
  pagination: PaginationInfo;
  loading: boolean;
  error: string | null;

  // Current filter/pagination params
  fetchParams: FetchParams;

  batchTaskId: string | null;
  batchTask: BatchTask | null;
  batchLoading: boolean;
  batchError: string | null;

  fetch: (params?: FetchParams) => Promise<void>;
  setFetchParams: (params: FetchParams) => void;
  remove: (id: string) => Promise<void>;
  enable: (id: string) => Promise<void>;
  disable: (id: string) => Promise<void>;
  checkToken: (id: string) => Promise<void>;
  checkAllCredits: () => Promise<void>;
  removeExhausted: () => Promise<number>;
  removeExpired: () => Promise<number>;
  removeBanned: () => Promise<number>;
  exportData: () => Promise<unknown>;
  importData: (data: unknown) => Promise<{ imported: number; skipped: number } | null>;
  batchConnect: (req: BatchConnectRequest) => Promise<string>;
  cancelBatch: (taskId: string) => Promise<void>;
  fetchBatchStatus: (taskId: string) => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export const useConnectionsStore = create<ConnectionsState>()((set, get) => ({
  connections: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
  loading: false,
  error: null,

  fetchParams: { page: 1, limit: 20 },

  batchTaskId: null,
  batchTask: null,
  batchLoading: false,
  batchError: null,

  setFetchParams: (params) => {
    const merged = { ...get().fetchParams, ...params };
    set({ fetchParams: merged });
  },

  fetch: async (params) => {
    const merged = params ? { ...get().fetchParams, ...params } : get().fetchParams;
    // Persist params so subsequent fetch() calls (e.g. after enable/disable) use the same filters
    if (params) set({ fetchParams: merged });

    set({ loading: true, error: null });
    try {
      const qs = new URLSearchParams();
      if (merged.page) qs.set("page", String(merged.page));
      if (merged.limit) qs.set("limit", String(merged.limit));
      if (merged.search) qs.set("search", merged.search);
      if (merged.provider) qs.set("provider", merged.provider);
      if (merged.status) qs.set("status", merged.status);

      const result = await apiFetch<{ data: Connection[]; pagination: PaginationInfo }>(
        `/api/connections?${qs.toString()}`,
      );
      set({ connections: result.data, pagination: result.pagination, loading: false });
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to fetch connections",
        loading: false,
      });
    }
  },

  remove: async (id) => {
    try {
      await apiFetch(`/api/connections/${id}`, { method: "DELETE" });
      // Re-fetch to update pagination counts; go back a page if current page is now empty
      const { pagination, connections, fetchParams } = get();
      if (connections.length <= 1 && pagination.page > 1) {
        await get().fetch({ ...fetchParams, page: pagination.page - 1 });
      } else {
        await get().fetch();
      }
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to remove connection",
      });
    }
  },

  enable: async (id) => {
    try {
      await apiFetch(`/api/connections/${id}/enable`, { method: "POST" });
      set((s) => ({
        connections: s.connections.map((c) =>
          c.id === id ? { ...c, status: "active" as const } : c,
        ),
      }));
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to enable connection",
      });
    }
  },

  disable: async (id) => {
    try {
      await apiFetch(`/api/connections/${id}/disable`, { method: "POST" });
      set((s) => ({
        connections: s.connections.map((c) =>
          c.id === id ? { ...c, status: "disabled" as const } : c,
        ),
      }));
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to disable connection",
      });
    }
  },

  checkToken: async (id) => {
    try {
      const result = await apiFetch<{ valid: boolean }>(
        `/api/connections/${id}/check`,
        { method: "POST" },
      );
      set((s) => ({
        connections: s.connections.map((c) =>
          c.id === id
            ? { ...c, tokenValid: result.valid, lastChecked: new Date().toISOString() }
            : c,
        ),
      }));
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to check token",
      });
    }
  },

  checkAllCredits: async () => {
    try {
      await apiFetch("/api/connections/check-credits", { method: "POST" });
      await get().fetch();
    } catch {}
  },

  removeExhausted: async () => {
    try {
      const { removed } = await apiFetch<{ removed: number }>(
        "/api/connections/remove-exhausted",
        { method: "POST" },
      );
      if (removed > 0) await get().fetch();
      return removed;
    } catch {
      return 0;
    }
  },

  removeExpired: async () => {
    try {
      const { removed } = await apiFetch<{ removed: number }>(
        "/api/connections/remove-expired",
        { method: "POST" },
      );
      if (removed > 0) await get().fetch();
      return removed;
    } catch {
      return 0;
    }
  },

  removeBanned: async () => {
    try {
      const { removed } = await apiFetch<{ removed: number }>(
        "/api/connections/remove-banned",
        { method: "POST" },
      );
      if (removed > 0) await get().fetch();
      return removed;
    } catch {
      return 0;
    }
  },

  exportData: async () => {
    try {
      return await apiFetch("/api/export");
    } catch {
      return null;
    }
  },

  importData: async (data) => {
    try {
      const result = await apiFetch<{ imported: number; skipped: number }>(
        "/api/import",
        { method: "POST", body: JSON.stringify(data) },
      );
      await get().fetch();
      return result;
    } catch {
      return null;
    }
  },

  batchConnect: async (req) => {
    set({ batchLoading: true, batchError: null });
    try {
      const result = await apiFetch<{ taskId: string }>("/api/batch-connect", {
        method: "POST",
        body: JSON.stringify(req),
      });
      set({ batchLoading: false, batchTaskId: result.taskId });
      return result.taskId;
    } catch (err) {
      set({
        batchError:
          err instanceof Error ? err.message : "Failed to start batch connect",
        batchLoading: false,
      });
      throw err;
    }
  },

  cancelBatch: async (taskId) => {
    try {
      await apiFetch(`/api/batch-connect/${taskId}/cancel`, { method: "POST" });
    } catch {}
  },

  fetchBatchStatus: async (taskId) => {
    try {
      const task = await apiFetch<BatchTask>(
        `/api/batch-connect/${taskId}`,
      );
      set({ batchTask: task });

      // Refresh the connections list when the batch is done
      if (task.status === "completed" || task.status === "done" || task.status === "cancelled" || task.status === "failed") {
        get().fetch();
      }
    } catch (err) {
      set({
        batchError:
          err instanceof Error
            ? err.message
            : "Failed to fetch batch status",
      });
    }
  },
}));
