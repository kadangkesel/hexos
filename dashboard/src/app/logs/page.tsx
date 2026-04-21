"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useUsageStore, type UsageRecordsParams } from "@/stores/usage";
import { useModelsStore } from "@/stores/models";
import { useConnectionsStore } from "@/stores/connections";
import { RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;

  if (isNaN(then)) return timestamp;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

function formatTokens(value: unknown): string {
  if (value == null) return "-";
  const num = Number(value);
  if (isNaN(num)) return "-";
  return num.toLocaleString();
}

function formatCost(value: unknown): string {
  if (value == null) return "-";
  const num = Number(value);
  if (isNaN(num)) return "-";
  return num.toFixed(4);
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const LIMIT_OPTIONS = [20, 50, 100, 200] as const;

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function LogsPage() {
  const { records, recordsLoading, recordsError, fetchRecords } =
    useUsageStore();
  const { models, fetch: fetchModels } = useModelsStore();
  const { connections, fetch: fetchConnections } = useConnectionsStore();

  const [filterModel, setFilterModel] = useState("");
  const [filterAccount, setFilterAccount] = useState("");
  const [limit, setLimit] = useState<number>(50);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build params from current filter state
  const buildParams = useCallback((): UsageRecordsParams => {
    const params: UsageRecordsParams = { limit };
    if (filterModel) params.model = filterModel;
    if (filterAccount) params.accountId = filterAccount;
    return params;
  }, [limit, filterModel, filterAccount]);

  // Fetch data on mount
  useEffect(() => {
    fetchModels();
    fetchConnections();
    fetchRecords(buildParams());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh handler
  const handleRefresh = useCallback(() => {
    fetchRecords(buildParams());
  }, [fetchRecords, buildParams]);

  // Re-fetch when filters change
  useEffect(() => {
    fetchRecords(buildParams());
  }, [limit, filterModel, filterAccount, fetchRecords, buildParams]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        fetchRecords(buildParams());
      }, 10_000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, fetchRecords, buildParams]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Logs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Request logs and usage records
        </p>
      </div>

      {/* Filter bar */}
      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">

          {/* Limit buttons */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Limit</Label>
            <div className="flex gap-1">
              {LIMIT_OPTIONS.map((n) => (
                <Button
                  key={n}
                  variant={limit === n ? "default" : "outline"}
                  size="sm"
                  onClick={() => setLimit(n)}
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>

          {/* Refresh button */}
          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            disabled={recordsLoading}
            aria-label="Refresh"
          >
            <RefreshCw
              className={cn("size-4", recordsLoading && "animate-spin")}
            />
          </Button>

          {/* Auto-refresh toggle */}
          <div className="flex items-center gap-2 ml-auto">
            <Label htmlFor="auto-refresh" className="text-xs text-muted-foreground">
              Auto-refresh
            </Label>
            <Switch
              id="auto-refresh"
              size="sm"
              checked={autoRefresh}
              onCheckedChange={(checked) => setAutoRefresh(checked)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {recordsError && (
        <Card className="mb-4 border-destructive/50">
          <CardContent className="flex items-center justify-between py-3">
            <span className="text-sm text-destructive">{recordsError}</span>
            <Button variant="ghost" size="sm" onClick={handleRefresh}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {recordsLoading && records.length === 0 && (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state */}
      {!recordsLoading && !recordsError && records.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No log records found.
        </div>
      )}

      {/* Logs table */}
      {records.length > 0 && (
        <Card className="px-6">
          <ScrollArea className="max-h-[600px]">
            <TooltipProvider>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Prompt</TableHead>
                    <TableHead className="text-right">Completion</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Latency</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((r) => {
                    const isSuccess =
                      r.success === true ||
                      (r.status != null &&
                        String(r.status).toLowerCase() === "success");

                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger className="cursor-default">
                              {formatRelativeTime(r.timestamp)}
                            </TooltipTrigger>
                            <TooltipContent>
                              {new Date(r.timestamp).toLocaleString()}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{r.model}</Badge>
                        </TableCell>
                        <TableCell>
                          {String(r.accountLabel ?? r.accountId ?? "-")}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatTokens(r.promptTokens)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatTokens(r.completionTokens)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatTokens(r.totalTokens)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatCost(r.creditCost)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {r.latencyMs != null
                            ? `${Number(r.latencyMs).toLocaleString()}ms`
                            : "-"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={isSuccess ? "default" : "destructive"}
                            className={cn(
                              isSuccess &&
                                "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            )}
                          >
                            {isSuccess ? "success" : "fail"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TooltipProvider>
          </ScrollArea>
        </Card>
      )}
    </div>
  );
}
