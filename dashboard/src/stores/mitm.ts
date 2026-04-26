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
  /** Local selection state — which tools to enable DNS for on start */
  selectedTools: Record<string, boolean>;

  fetch: () => Promise<void>;
  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  /** Toggle local tool selection (no API call) */
  toggleTool: (tool: string) => void;
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
  selectedTools: {},

  fetch: async () => {
    // Only show loading spinner on initial fetch, not on polls
    const isInitial = !get().status;
    if (isInitial) set({ loading: true, error: null });
    try {
      const status = await apiFetch<MitmStatus>("/api/mitm");
      // On first fetch, sync selectedTools from server dnsStatus
      // so CLI-enabled tools show as selected
      if (isInitial && status.dnsStatus) {
        const current = get().selectedTools;
        const hasAny = Object.keys(current).length > 0;
        if (!hasAny) {
          set({ selectedTools: { ...status.dnsStatus } });
        }
      }
      set({ status, loading: false, error: null });
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
      const { selectedTools, sudoPassword } = get();
      // Collect selected tool IDs
      const tools = Object.entries(selectedTools)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const result = await apiFetch<{ running: boolean; pid: number }>(
        "/api/mitm/start",
        {
          method: "POST",
          body: JSON.stringify({ sudoPassword, tools }),
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

  toggleTool: (tool) => {
    set((s) => ({
      selectedTools: {
        ...s.selectedTools,
        [tool]: !s.selectedTools[tool],
      },
    }));
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
