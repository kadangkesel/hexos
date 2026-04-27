"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  Loader2,
  Download,
  Upload,
  Trash2,
  Search,
} from "lucide-react";
import { toast } from "sonner";

interface ConnectionsToolbarProps {
  total: number;
  checkingCredits: boolean;
  onCheckCredits: () => void;
  onRemoveExpired: () => Promise<number>;
  onRemoveBanned: () => Promise<number>;
  onRemoveExhausted: () => Promise<number>;
  onExport: () => void;
  onImport: (data: unknown) => void;
  onRefresh: () => void;
  loading: boolean;
  searchInput: string;
  onSearchChange: (value: string) => void;
  fetchParams: { provider?: string; status?: string; search?: string };
  onProviderFilter: (provider: string) => void;
  onStatusFilter: (status: string) => void;
  refreshStats: () => void;
}

export function ConnectionsToolbar({
  total,
  checkingCredits,
  onCheckCredits,
  onRemoveExpired,
  onRemoveBanned,
  onRemoveExhausted,
  onExport,
  onImport,
  onRefresh,
  loading,
  searchInput,
  onSearchChange,
  fetchParams,
  onProviderFilter,
  onStatusFilter,
  refreshStats,
}: ConnectionsToolbarProps) {
  const importRef = useRef<HTMLInputElement>(null);

  return (
    <>
      {/* Header actions */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h3 className="text-lg font-semibold">Connections</h3>
        <Badge variant="secondary">{total}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCheckCredits}
            disabled={checkingCredits}
          >
            {checkingCredits ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Check Credits
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-amber-500/50 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
            onClick={async () => {
              const removed = await onRemoveExpired();
              if (removed > 0) { toast.success(`Removed ${removed} invalid token accounts`); refreshStats(); }
              else toast("No invalid token accounts");
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove Invalid
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-high-impact/50 text-high-impact hover:bg-high-impact/10"
            onClick={async () => {
              const removed = await onRemoveBanned();
              if (removed > 0) { toast.success(`Removed ${removed} banned accounts`); refreshStats(); }
              else toast("No banned accounts");
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove Banned
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-high-impact/50 text-high-impact hover:bg-high-impact/10"
            onClick={async () => {
              const removed = await onRemoveExhausted();
              if (removed > 0) { toast.success(`Removed ${removed} exhausted accounts`); refreshStats(); }
              else toast("No exhausted accounts");
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove Exhausted
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => importRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" />
            Import
          </Button>
          <input
            ref={importRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const text = await file.text();
                const data = JSON.parse(text);
                onImport(data);
              } catch {
                toast.error("Invalid JSON file");
              }
              e.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search accounts..."
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 w-[200px] pl-8 text-xs"
          />
        </div>
        <Select value={fetchParams.provider || "all"} onValueChange={(v: string | null) => onProviderFilter(!v || v === "all" ? "" : v)}>
          <SelectTrigger size="sm" className="text-xs">
            <SelectValue placeholder="All Providers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Providers</SelectItem>
            <SelectItem value="Service">Service (CB)</SelectItem>
            <SelectItem value="cline">Cline (CL)</SelectItem>
            <SelectItem value="kiro">Kiro (KR)</SelectItem>
            <SelectItem value="qoder">Qoder (QD)</SelectItem>
            <SelectItem value="codex">Codex (CX)</SelectItem>
            <SelectItem value="yepapi">YepAPI (YP)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={fetchParams.status || "all"} onValueChange={(v: string | null) => onStatusFilter(!v || v === "all" ? "" : v)}>
          <SelectTrigger size="sm" className="text-xs">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
