import { create } from "zustand";
import { apiFetch } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface MitmStatus {
  running: boolean;
  pid: number | null;
  certExists: boolean;
  certTrusted: boolean;
  dnsStatus: Record<string, boolean>;
  aliases: Record<string, Record<string, string>>;
}

export interface MitmState {
  status: MitmStatus | null;
  loading: boolean;
  error: string | null;
  sudoPassword: string;

  fetch: () => Promise<void>;
  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  enableTool: (tool: string) => Promise<boolean>;
  disableTool: (tool: string) => Promise<boolean>;
  setAlias: (
    tool: string,
    sourceModel: string,
    targetModel: string,
  ) => Promise<boolean>;
  removeAlias: (tool: string, sourceModel: string) => Promise<boolean>;
  setSudoPassword: (password: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export const useMitmStore = create<MitmState>()((set, get) => ({
  status: null,
  loading: false,
  error: null,
  sudoPassword: "",

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const status = await apiFetch<MitmStatus>("/api/mitm");
      set({ status, loading: false });
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to fetch MITM status",
        loading: false,
      });
    }
  },

  start: async () => {
    try {
      const result = await apiFetch<{ running: boolean; pid: number }>(
        "/api/mitm/start",
        {
          method: "POST",
          body: JSON.stringify({ sudoPassword: get().sudoPassword }),
        },
      );
      set((s) => ({
        status: s.status
          ? { ...s.status, running: result.running, pid: result.pid }
          : null,
      }));
      await get().fetch();
      return true;
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to start MITM proxy",
      });
      return false;
    }
  },

  stop: async () => {
    try {
      await apiFetch("/api/mitm/stop", {
        method: "POST",
        body: JSON.stringify({ sudoPassword: get().sudoPassword }),
      });
      set((s) => ({
        status: s.status
          ? { ...s.status, running: false, pid: null }
          : null,
      }));
      await get().fetch();
      return true;
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to stop MITM proxy",
      });
      return false;
    }
  },

  enableTool: async (tool) => {
    try {
      await apiFetch("/api/mitm/enable", {
        method: "POST",
        body: JSON.stringify({ tool, sudoPassword: get().sudoPassword }),
      });
      await get().fetch();
      return true;
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : `Failed to enable ${tool}`,
      });
      return false;
    }
  },

  disableTool: async (tool) => {
    try {
      await apiFetch("/api/mitm/disable", {
        method: "POST",
        body: JSON.stringify({ tool, sudoPassword: get().sudoPassword }),
      });
      await get().fetch();
      return true;
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : `Failed to disable ${tool}`,
      });
      return false;
    }
  },

  setAlias: async (tool, sourceModel, targetModel) => {
    try {
      await apiFetch("/api/mitm/alias", {
        method: "POST",
        body: JSON.stringify({ tool, sourceModel, targetModel }),
      });
      await get().fetch();
      return true;
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to set alias",
      });
      return false;
    }
  },

  removeAlias: async (tool, sourceModel) => {
    try {
      await apiFetch("/api/mitm/alias", {
        method: "DELETE",
        body: JSON.stringify({ tool, sourceModel }),
      });
      await get().fetch();
      return true;
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to remove alias",
      });
      return false;
    }
  },

  setSudoPassword: (password) => {
    set({ sudoPassword: password });
  },
}));
