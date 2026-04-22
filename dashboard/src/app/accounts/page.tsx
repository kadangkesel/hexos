"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useConnectionsStore, type Connection } from "@/stores/connections";
import { PageHeader } from "@/components/PageHeader";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  ShieldCheck,
  Trash2,
  RefreshCw,
  Play,
  Loader2,
  Download,
  Upload,
  Square,
  ListFilter,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getStatus(conn: Connection): "active" | "exhausted" {
  const credit = conn.credit as Record<string, unknown> | undefined;
  const remaining = Number(credit?.remainingCredits ?? -1);
  if (remaining === 0) return "exhausted";
  return "active";
}

function isActive(conn: Connection): boolean {
  return getStatus(conn) === "active";
}

const STATUS_BADGE_VARIANT: Record<string, "default" | "destructive"> = {
  active: "default",
  exhausted: "destructive",
};

function formatDate(d?: string | null): string {
  if (!d) return "\u2014";
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCredit(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n >= 100) return `${Math.round(n)}`;
  return n.toFixed(1);
}

function creditDisplay(conn: Connection): string {
  const credit = conn.credit as
    | { remainingCredits?: number; totalCredits?: number }
    | undefined;
  if (!credit) return "\u2014";
  const rem = credit.remainingCredits ?? 0;
  const tot = credit.totalCredits ?? 0;
  return `${formatCredit(rem)} / ${formatCredit(tot)}`;
}

/* ------------------------------------------------------------------ */
/*  Account Row                                                        */
/* ------------------------------------------------------------------ */

interface AccountRowProps {
  conn: Connection;
  onToggle: (id: string, enabled: boolean) => void;
  onCheck: (id: string) => void;
  onRemove: (id: string) => void;
  busy: string | null;
}

function AccountRow({ conn, onToggle, onCheck, onRemove, busy }: AccountRowProps) {
  const isBusy = busy === conn.id;
  const status = getStatus(conn);
  const active = isActive(conn);
  const usageCount = (conn as Record<string, unknown>).usageCount as number | undefined;
  const failCount = (conn as Record<string, unknown>).failCount as number | undefined;
  const lastUsedAt = (conn as Record<string, unknown>).lastUsedAt as string | undefined;

  return (
    <TableRow>
      <TableCell className="max-w-[200px] truncate font-medium">
        <div className="flex items-center gap-1.5">
          {conn.label ?? conn.email}
          <Badge variant="outline" className="text-[9px] font-mono shrink-0">
            {String((conn as any).provider || "codebuddy")}
          </Badge>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_BADGE_VARIANT[status]}>{status}</Badge>
      </TableCell>
      <TableCell className="text-right">{usageCount ?? 0}</TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">
        {formatDate(lastUsedAt)}
      </TableCell>
      <TableCell className="text-right text-xs">{creditDisplay(conn)}</TableCell>
      <TableCell className="text-right">
        {(failCount ?? 0) > 0 ? (
          <span className="text-destructive font-medium">{failCount}</span>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-2">
          {/* Enable / Disable toggle */}
          <Switch
            size="sm"
            checked={active}
            disabled={isBusy}
            onCheckedChange={() => onToggle(conn.id, active)}
          />

          {/* Check Token */}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={isBusy}
            onClick={() => onCheck(conn.id)}
            title="Check Token"
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
          </Button>

          {/* Remove with confirm Dialog */}
          <Dialog>
            <DialogTrigger
              render={
                <Button
                  variant="destructive"
                  size="icon-xs"
                  disabled={isBusy}
                  title="Remove"
                />
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Remove Account</DialogTitle>
                <DialogDescription>
                  Are you sure you want to remove{" "}
                  <strong>{conn.label ?? conn.email}</strong>? This action cannot
                  be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button
                  variant="destructive"
                  onClick={() => onRemove(conn.id)}
                >
                  Remove
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------ */
/*  Batch Add Section                                                  */
/* ------------------------------------------------------------------ */

function BatchAddSection() {
  const { batchConnect, cancelBatch, fetchBatchStatus, batchTaskId, batchTask, batchLoading, fetch } =
    useConnectionsStore();

  const [text, setText] = useState("");
  const [concurrency, setConcurrency] = useState(2);
  const [headless, setHeadless] = useState(true);
  const [providers, setProviders] = useState<string[]>(["codebuddy"]);
  const taskId = batchTaskId;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* stop polling on unmount */
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /* poll batch status */
  useEffect(() => {
    if (!taskId) return;

    fetchBatchStatus(taskId);
    pollRef.current = setInterval(() => fetchBatchStatus(taskId), 2000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [taskId, fetchBatchStatus]);

  /* detect completion */
  useEffect(() => {
    if (
      batchTask &&
      (batchTask.status === "completed" || batchTask.status === "done" || batchTask.status === "cancelled" || batchTask.status === "failed")
    ) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (batchTask.status === "cancelled") {
        toast("Batch cancelled");
      } else if (batchTask.status === "failed") {
        toast.error("Batch failed");
      } else {
        toast.success(`Batch complete: ${batchTask.completed ?? batchTask.success ?? 0} added, ${batchTask.failed} failed`);
      }
      useConnectionsStore.setState({ batchTaskId: null });
      fetch();
    }
  }, [batchTask, fetch]);

  async function handleStart() {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      toast.error("Paste at least one account");
      return;
    }

    const accounts = lines.map((line) => {
      const sep = line.includes("|") ? "|" : ":";
      const [email, password] = line.split(sep, 2);
      return { email: email.trim(), password: (password ?? "").trim() };
    });

    try {
      await batchConnect({ accounts, concurrency, headless, providers });
      toast.success("Batch started");
    } catch {
      toast.error("Failed to start batch");
    }
  }

  const isRunning = !!taskId;
  const progress =
    batchTask && batchTask.total > 0
      ? Math.round(((batchTask.completed ?? 0) / batchTask.total) * 100)
      : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Batch Add Accounts</CardTitle>
          <CardDescription>
            Paste accounts, one per line. Format:{" "}
            <code className="text-xs font-mono">email|password</code> or{" "}
            <code className="text-xs font-mono">email:password</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            className="font-mono text-xs max-h-[160px] overflow-y-auto resize-none"
            rows={5}
            placeholder={"user1@example.com|password123\nuser2@example.com:secret"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isRunning}
          />

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={providers.includes("codebuddy")}
                onChange={(e) => {
                  if (e.target.checked) setProviders(p => [...p, "codebuddy"]);
                  else setProviders(p => p.filter(x => x !== "codebuddy"));
                }}
                disabled={isRunning}
                className="rounded"
              />
              <span>CodeBuddy</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={providers.includes("cline")}
                onChange={(e) => {
                  if (e.target.checked) setProviders(p => [...p, "cline"]);
                  else setProviders(p => p.filter(x => x !== "cline"));
                }}
                disabled={isRunning}
                className="rounded"
              />
              <span>Cline</span>
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="concurrency">Concurrency</Label>
              <Input
                id="concurrency"
                type="number"
                min={1}
                max={20}
                className="w-24"
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
                disabled={isRunning}
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="headless"
                checked={headless}
                onCheckedChange={setHeadless}
                disabled={isRunning}
              />
              <Label htmlFor="headless" className="text-sm">
                Headless
              </Label>
            </div>

            {isRunning ? (
              <Button
                variant="destructive"
                onClick={async () => {
                  if (taskId) {
                    await cancelBatch(taskId);
                    fetchBatchStatus(taskId);
                  }
                }}
              >
                <Square className="h-4 w-4" />
                Cancel
              </Button>
            ) : (
              <Button
                onClick={handleStart}
                disabled={batchLoading}
              >
                {batchLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Start Batch Connect
              </Button>
            )}
          </div>

          {/* Progress + Logs */}
          {batchTask && (isRunning || batchTask.status === "completed" || batchTask.status === "failed" || batchTask.status === "cancelled") && (
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Task: <code className="text-xs">{taskId ?? batchTask.taskId}</code>
                </span>
                <div className="flex items-center gap-3">
                  {batchTask.failed > 0 && (
                    <span className="text-xs text-destructive">{batchTask.failed} failed</span>
                  )}
                  <span>
                    {batchTask.completed ?? 0}/{batchTask.total} ({progress}%)
                  </span>
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>

              {/* Live logs */}
              {batchTask.logs && batchTask.logs.length > 0 && (
                <div className="rounded-sm border border-border bg-muted/30 overflow-hidden min-w-0">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/50">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Logs</span>
                    <span className="text-[10px] text-muted-foreground">{batchTask.logs.length} entries</span>
                  </div>
                  <div className="overflow-y-auto overflow-x-hidden max-h-[250px] p-2" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
                    <div className="flex flex-col gap-0.5 font-mono text-[11px] min-w-0">
                      {batchTask.logs.map((log, i) => (
                        <div key={i} className="flex gap-2 leading-relaxed min-w-0">
                          <span className="text-muted-foreground shrink-0">[{log.time}]</span>
                          <span className={`shrink-0 ${
                            log.level === "error" ? "text-destructive" :
                            log.level === "success" ? "text-emerald-500" :
                            "text-foreground"
                          }`}>
                            {log.level === "error" ? "✗" : log.level === "success" ? "✓" : "ℹ"}
                          </span>
                          <span className={`break-all min-w-0 ${
                            log.level === "error" ? "text-destructive" :
                            log.level === "success" ? "text-emerald-500" :
                            "text-muted-foreground"
                          }`}>
                            {log.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Filter Unconnected                                                 */
/* ------------------------------------------------------------------ */

function FilterUnconnectedSection() {
  const { connections, batchConnect, cancelBatch, fetchBatchStatus, batchTaskId, batchTask, batchLoading, fetch } =
    useConnectionsStore();

  const [text, setText] = useState("");
  const [provider, setProvider] = useState<"codebuddy" | "cline">("cline");
  const [concurrency, setConcurrency] = useState(2);
  const [headless, setHeadless] = useState(true);

  const taskId = batchTaskId;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    if (!taskId) return;
    fetchBatchStatus(taskId);
    pollRef.current = setInterval(() => fetchBatchStatus(taskId), 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [taskId, fetchBatchStatus]);

  useEffect(() => {
    if (
      batchTask &&
      (batchTask.status === "completed" || batchTask.status === "done" || batchTask.status === "cancelled" || batchTask.status === "failed")
    ) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (batchTask.status === "cancelled") toast("Batch cancelled");
      else if (batchTask.status === "failed") toast.error("Batch failed");
      else toast.success(`Batch complete: ${batchTask.completed ?? batchTask.success ?? 0} added, ${batchTask.failed} failed`);
      useConnectionsStore.setState({ batchTaskId: null });
      fetch();
    }
  }, [batchTask, fetch]);

  // Build set of connected emails per provider
  const connectedEmails = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const conn of connections) {
      const p = String((conn as any).provider || "codebuddy");
      if (!map.has(p)) map.set(p, new Set());
      map.get(p)!.add((conn.label ?? conn.email ?? "").toLowerCase());
    }
    return map;
  }, [connections]);

  // Parse input and filter out already-connected accounts
  const parsed = useMemo(() => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const connected = connectedEmails.get(provider) ?? new Set();
    const all: { email: string; password: string }[] = [];
    const missing: { email: string; password: string }[] = [];
    const alreadyConnected: string[] = [];

    for (const line of lines) {
      const sep = line.includes("|") ? "|" : line.includes(";") ? ";" : ":";
      const [email, password] = line.split(sep, 2);
      const e = (email ?? "").trim().toLowerCase();
      const p = (password ?? "").trim();
      if (!e) continue;
      all.push({ email: e, password: p });
      if (connected.has(e)) {
        alreadyConnected.push(e);
      } else {
        missing.push({ email: e, password: p });
      }
    }
    return { all, missing, alreadyConnected };
  }, [text, provider, connectedEmails]);

  const isRunning = !!taskId;
  const progress =
    batchTask && batchTask.total > 0
      ? Math.round(((batchTask.completed ?? 0) / batchTask.total) * 100)
      : 0;

  async function handleStart() {
    if (parsed.missing.length === 0) {
      toast.error("No unconnected accounts to process");
      return;
    }
    try {
      await batchConnect({
        accounts: parsed.missing,
        concurrency,
        headless,
        providers: [provider],
      });
      toast.success(`Batch started: ${parsed.missing.length} accounts`);
    } catch {
      toast.error("Failed to start batch");
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
    >
      <Card className="mt-3">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ListFilter className="h-4 w-4 text-muted-foreground" />
            <div>
              <CardTitle>Filter Unconnected</CardTitle>
              <CardDescription>
                Paste your account list — only accounts <strong>not yet connected</strong> to the selected provider will be shown and batch-connected.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Provider selector */}
          <div className="flex items-center gap-3">
            <Label className="text-xs text-muted-foreground shrink-0">Provider:</Label>
            <div className="flex gap-1.5">
              {(["codebuddy", "cline"] as const).map((p) => (
                <Button
                  key={p}
                  variant={provider === p ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs px-3"
                  onClick={() => setProvider(p)}
                >
                  {p === "codebuddy" ? "CodeBuddy" : "Cline"}
                  <Badge variant="secondary" className="ml-1.5 text-[9px] px-1 py-0">
                    {connectedEmails.get(p)?.size ?? 0}
                  </Badge>
                </Button>
              ))}
            </div>
          </div>

          {/* Account list input */}
          <Textarea
            className="font-mono text-xs max-h-[160px] overflow-y-auto resize-none"
            rows={5}
            placeholder={"email|password\nemail:password\nemail;password"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isRunning}
          />

          {/* Stats */}
          {parsed.all.length > 0 && (
            <div className="flex flex-wrap gap-3 text-xs">
              <span className="text-muted-foreground">
                Total: <strong className="text-foreground">{parsed.all.length}</strong>
              </span>
              <span className="text-muted-foreground">
                Already connected: <strong className="text-green-400">{parsed.alreadyConnected.length}</strong>
              </span>
              <span className="text-muted-foreground">
                Missing: <strong className="text-amber-400">{parsed.missing.length}</strong>
              </span>
            </div>
          )}

          {/* Missing accounts list */}
          {parsed.missing.length > 0 && !isRunning && (
            <div className="rounded-md border border-border overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Unconnected to {provider === "codebuddy" ? "CodeBuddy" : "Cline"} ({parsed.missing.length})
                </span>
              </div>
              <div className="max-h-[200px] overflow-y-auto">
                {parsed.missing.map((acc, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1 text-xs font-mono border-b border-border/50 last:border-0"
                  >
                    <span className="text-amber-400 shrink-0 w-5 text-right text-[10px] text-muted-foreground">{i + 1}</span>
                    <span className="truncate">{acc.email}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Concurrency:</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value) || 2)}
                className="w-16 h-8 text-xs"
                disabled={isRunning}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                size="sm"
                checked={headless}
                onCheckedChange={setHeadless}
                disabled={isRunning}
              />
              <Label className="text-xs text-muted-foreground">Headless</Label>
            </div>
            <div className="ml-auto flex gap-2">
              {isRunning ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => { if (taskId) cancelBatch(taskId); }}
                >
                  <Square className="h-3.5 w-3.5" />
                  Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleStart}
                  disabled={batchLoading || parsed.missing.length === 0}
                >
                  {batchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Connect {parsed.missing.length} accounts
                </Button>
              )}
            </div>
          </div>

          {/* Progress */}
          {isRunning && batchTask && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  Task: <code className="text-xs">{taskId ?? batchTask.taskId}</code>
                </span>
                <div className="flex items-center gap-3">
                  {batchTask.failed > 0 && (
                    <span className="text-xs text-destructive">{batchTask.failed} failed</span>
                  )}
                  <span>
                    {batchTask.completed ?? 0}/{batchTask.total} ({progress}%)
                  </span>
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>

              {/* Live logs */}
              {batchTask.logs && batchTask.logs.length > 0 && (
                <div className="rounded-sm border border-border bg-muted/30 overflow-hidden min-w-0">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/50">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Logs</span>
                    <span className="text-[10px] text-muted-foreground">{batchTask.logs.length} entries</span>
                  </div>
                  <div className="max-h-[200px] overflow-y-auto p-0 min-w-0">
                    <div className="min-w-0">
                      {batchTask.logs.map((log: any, i: number) => (
                        <div
                          key={i}
                          className={`flex gap-2 px-3 py-0.5 text-[11px] font-mono border-b border-border/30 last:border-0 min-w-0 ${
                            log.level === "error" ? "text-destructive" : log.level === "warn" ? "text-amber-400" : "text-muted-foreground"
                          }`}
                        >
                          <span className="shrink-0 text-muted-foreground/60 w-[60px]">{log.time}</span>
                          <span className="shrink-0 w-3">
                            {log.level === "error" ? "\u2717" : log.level === "warn" ? "\u26A0" : "\u2139"}
                          </span>
                          <span className="break-all min-w-0">{log.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function AccountsPage() {
  const { connections, loading, error, fetch, enable, disable, checkToken, checkAllCredits, removeExhausted, exportData, importData, remove } =
    useConnectionsStore();
  const importRef = useRef<HTMLInputElement>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkingCredits, setCheckingCredits] = useState(false);
  const creditPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch + start background credit polling
  useEffect(() => {
    fetch();
    // Check credits on mount
    checkAllCredits();
    // Poll every 60s
    creditPollRef.current = setInterval(() => checkAllCredits(), 60_000);
    return () => { if (creditPollRef.current) clearInterval(creditPollRef.current); };
  }, [fetch, checkAllCredits]);

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
        // Refresh to get updated credit info
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

  return (
    <>
      <PageHeader title="Accounts" subtitle="Manage connected accounts" />

      {/* ---- Account List ---- */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mb-6"
      >
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Connections</CardTitle>
              <Badge variant="secondary">{connections.length}</Badge>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setCheckingCredits(true);
                    await checkAllCredits();
                    setCheckingCredits(false);
                    toast.success("Credits updated");
                  }}
                  disabled={checkingCredits}
                >
                  {checkingCredits ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Check Credits
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10"
                  onClick={async () => {
                    const removed = await removeExhausted();
                    if (removed > 0) toast.success(`Removed ${removed} exhausted accounts`);
                    else toast("No exhausted accounts");
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove Exhausted
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
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
                  }}
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
                      const result = await importData(data);
                      if (result) {
                        toast.success(`Imported ${result.imported} accounts (${result.skipped} skipped)`);
                      } else {
                        toast.error("Import failed");
                      }
                    } catch {
                      toast.error("Invalid JSON file");
                    }
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fetch()}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Refresh
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Usage</TableHead>
                  <TableHead className="text-right">Last Used</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Fails</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && connections.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    </TableCell>
                  </TableRow>
                ) : connections.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No accounts connected
                    </TableCell>
                  </TableRow>
                ) : (
                  connections.map((conn) => (
                    <AccountRow
                      key={conn.id}
                      conn={conn}
                      onToggle={handleToggle}
                      onCheck={handleCheck}
                      onRemove={handleRemove}
                      busy={busyId}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </motion.div>

      {/* ---- Batch Add ---- */}
      <BatchAddSection />

      {/* ---- Filter Unconnected ---- */}
      <FilterUnconnectedSection />
    </>
  );
}
