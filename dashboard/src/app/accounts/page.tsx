"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useConnectionsStore } from "@/stores/connections";
import { PageHeader } from "@/components/PageHeader";
import { toast } from "sonner";

import type { AccountStats } from "./_components/account-helpers";
import { AccountSummaryCards } from "./_components/AccountSummaryCards";
import { ProviderCreditCards } from "./_components/ProviderCreditCards";
import { ConnectionsTable } from "./_components/ConnectionsTable";
import { BatchAddSection } from "./_components/BatchAddSection";
import { FilterUnconnectedSection } from "./_components/FilterUnconnectedSection";
import { BatchLogsSection } from "./_components/BatchLogsSection";

export default function AccountsPage() {
  const {
    connections,
    pagination,
    loading,
    error,
    fetch,
    fetchParams,
    enable,
    disable,
    checkToken,
    checkAllCredits,
    removeExhausted,
    removeExpired,
    removeBanned,
    exportData,
    importData,
    remove,
  } = useConnectionsStore();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkingCredits, setCheckingCredits] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [creditByProvider, setCreditByProvider] = useState<Record<string, { total: number; used: number; remaining: number; count: number; active: number; exhausted: number }>>({});

  // Fetch connections + stats on mount
  useEffect(() => {
    fetch();
    import("@/lib/api").then(({ apiFetch }) =>
      apiFetch<AccountStats & { byProvider?: Record<string, any> }>("/api/connections/credit-summary").then((data) => {
        setStats(data);
        if (data.byProvider) setCreditByProvider(data.byProvider);
      }).catch(() => { }),
    );
  }, [fetch]);

  // Refresh stats after credit check or remove actions
  const refreshStats = useCallback(() => {
    import("@/lib/api").then(({ apiFetch }) =>
      apiFetch<AccountStats & { byProvider?: Record<string, any> }>("/api/connections/credit-summary").then((data) => {
        setStats(data);
        if (data.byProvider) setCreditByProvider(data.byProvider);
      }).catch(() => { }),
    );
  }, []);

  /* ---- pagination helpers ---- */
  const goToPage = useCallback((page: number) => {
    fetch({ page });
  }, [fetch]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      fetch({ search: value || undefined, page: 1 });
    }, 300);
  }, [fetch]);

  const handleProviderFilter = useCallback((provider: string) => {
    fetch({ provider: provider || undefined, page: 1 });
  }, [fetch]);

  const handleStatusFilter = useCallback((status: string) => {
    fetch({ status: status || undefined, page: 1 });
  }, [fetch]);

  const handleLimitChange = useCallback((limit: number) => {
    fetch({ limit, page: 1 });
  }, [fetch]);

  /* ---- actions ---- */
  const handleToggle = useCallback(
    async (id: string, currentlyActive: boolean) => {
      setBusyId(id);
      try {
        if (currentlyActive) {
          await disable(id);
          toast.success("Account disabled");
        } else {
          await enable(id);
          toast.success("Account enabled");
        }
        await fetch();
      } catch {
        toast.error("Failed to toggle account");
      } finally {
        setBusyId(null);
      }
    },
    [enable, disable, fetch],
  );

  const handleCheck = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await checkToken(id);
        const conn = useConnectionsStore
          .getState()
          .connections.find((c) => c.id === id);
        if (conn?.tokenValid) {
          toast.success("Token is valid");
        } else {
          toast.error("Token is invalid");
        }
        await fetch();
      } catch {
        toast.error("Token check failed");
      } finally {
        setBusyId(null);
      }
    },
    [checkToken, fetch],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await remove(id);
        toast.success("Account removed");
      } catch {
        toast.error("Failed to remove account");
      } finally {
        setBusyId(null);
      }
    },
    [remove],
  );

  const onCheckCredits = useCallback(async () => {
    setCheckingCredits(true);
    await checkAllCredits();
    setCheckingCredits(false);
    refreshStats();
    toast.success("Credits updated");
  }, [checkAllCredits, refreshStats]);

  const onExport = useCallback(async () => {
    const data = await exportData();
    if (!data) { toast.error("Export failed"); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hexos-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Exported successfully");
  }, [exportData]);

  const onImport = useCallback(async (data: unknown) => {
    try {
      const result = await importData(data);
      if (result) {
        toast.success(`Imported ${result.imported} accounts (${result.skipped} skipped)`);
      } else {
        toast.error("Import failed");
      }
    } catch {
      toast.error("Invalid JSON file");
    }
  }, [importData]);

  return (
    <>
      <PageHeader title="Accounts" subtitle="Manage connected accounts" />

      {/* Summary Stats */}
      {stats && (
        <AccountSummaryCards stats={stats} />
      )}

      {/* Credits by provider */}
      {Object.keys(creditByProvider).length > 0 && (
        <ProviderCreditCards creditByProvider={creditByProvider} />
      )}

      {/* Account List */}
      <ConnectionsTable
        connections={connections}
        pagination={pagination}
        loading={loading}
        error={error}
        fetchParams={fetchParams}
        busyId={busyId}
        onToggle={handleToggle}
        onCheck={handleCheck}
        onRemove={handleRemove}
        onPageChange={goToPage}
        onLimitChange={handleLimitChange}
        searchInput={searchInput}
        onSearchChange={handleSearchChange}
        onProviderFilter={handleProviderFilter}
        onStatusFilter={handleStatusFilter}
        checkingCredits={checkingCredits}
        onCheckCredits={onCheckCredits}
        onRemoveExpired={removeExpired}
        onRemoveBanned={removeBanned}
        onRemoveExhausted={removeExhausted}
        onExport={onExport}
        onImport={onImport}
        onRefresh={() => fetch()}
        refreshStats={refreshStats}
      />

      {/* Batch Add + Filter (stacked left) | Logs (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <div className="flex flex-col gap-4">
          <BatchAddSection />
          <FilterUnconnectedSection />
        </div>
        <BatchLogsSection />
      </div>
    </>
  );
}
