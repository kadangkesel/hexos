"use client";

import { useEffect, useState } from "react";
import { useMitmStore } from "@/stores/mitm";
import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Shield,
  ShieldCheck,
  ShieldX,
  Play,
  Square,
  Loader2,
  Trash2,
  Plus,
  Github,
  Cloud,
  Cpu,
  MousePointer,
  Info,
  Lock,
  Network,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { motion } from "motion/react";

/* ------------------------------------------------------------------ */
/*  Tool metadata                                                      */
/* ------------------------------------------------------------------ */

interface ToolMeta {
  id: string;
  name: string;
  icon: LucideIcon;
  hosts: string[];
  comingSoon?: boolean;
}

const TOOLS: ToolMeta[] = [
  {
    id: "copilot",
    name: "GitHub Copilot",
    icon: Github,
    hosts: ["api.individual.githubcopilot.com"],
  },
  {
    id: "antigravity",
    name: "Google Cloud Code",
    icon: Cloud,
    hosts: ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"],
  },
  {
    id: "kiro",
    name: "Amazon Kiro",
    icon: Cpu,
    hosts: ["q.us-east-1.amazonaws.com", "codewhisperer.us-east-1.amazonaws.com"],
  },
  {
    id: "cursor",
    name: "Cursor IDE",
    icon: MousePointer,
    hosts: ["api2.cursor.sh"],
    comingSoon: true,
  },
];

const toolIconColors: Record<string, string> = {
  copilot: "bg-gray-500/15 text-gray-500",
  antigravity: "bg-blue-500/15 text-blue-500",
  kiro: "bg-orange-500/15 text-orange-500",
  cursor: "bg-purple-500/15 text-purple-500",
};

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function MitmPage() {
  const {
    status,
    loading,
    error,
    sudoPassword,
    fetch: fetchStatus,
    start,
    stop,
    enableTool,
    disableTool,
    setAlias,
    removeAlias,
    setSudoPassword,
  } = useMitmStore();

  /* ---- local state for add-alias form ---- */
  const [aliasTool, setAliasTool] = useState("copilot");
  const [aliasSource, setAliasSource] = useState("");
  const [aliasTarget, setAliasTarget] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  /* ---- initial fetch + polling ---- */
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  /* ---- handlers ---- */
  const handleStart = async () => {
    setActionLoading("start");
    try {
      await start();
      toast.success("MITM proxy started");
    } catch {
      toast.error(useMitmStore.getState().error ?? "Failed to start MITM proxy");
    }
    setActionLoading(null);
  };

  const handleStop = async () => {
    setActionLoading("stop");
    try {
      await stop();
      toast.success("MITM proxy stopped");
    } catch {
      toast.error(useMitmStore.getState().error ?? "Failed to stop MITM proxy");
    }
    setActionLoading(null);
  };

  const handleToggleTool = async (toolId: string, enabled: boolean) => {
    setActionLoading(toolId);
    try {
      if (enabled) {
        await enableTool(toolId);
        toast.success(`${TOOLS.find((t) => t.id === toolId)?.name ?? toolId} enabled`);
      } else {
        await disableTool(toolId);
        toast.success(`${TOOLS.find((t) => t.id === toolId)?.name ?? toolId} disabled`);
      }
    } catch {
      toast.error(useMitmStore.getState().error ?? `Failed to toggle ${toolId}`);
    }
    setActionLoading(null);
  };

  const handleAddAlias = async () => {
    const src = aliasSource.trim();
    const tgt = aliasTarget.trim();
    if (!src || !tgt) return;
    setActionLoading("add-alias");
    try {
      await setAlias(aliasTool, src, tgt);
      toast.success("Model alias added");
      setAliasSource("");
      setAliasTarget("");
    } catch {
      toast.error(useMitmStore.getState().error ?? "Failed to add alias");
    }
    setActionLoading(null);
  };

  const handleRemoveAlias = async (tool: string, sourceModel: string) => {
    setActionLoading(`rm-${tool}-${sourceModel}`);
    try {
      await removeAlias(tool, sourceModel);
      toast.success("Alias removed");
    } catch {
      toast.error(useMitmStore.getState().error ?? "Failed to remove alias");
    }
    setActionLoading(null);
  };

  /* ---- derived ---- */
  const isRunning = status?.running ?? false;
  const showPasswordField = !isRunning;

  /* ---- collect all aliases into flat rows ---- */
  const aliasRows: { tool: string; source: string; target: string }[] = [];
  if (status?.aliases) {
    for (const [tool, models] of Object.entries(status.aliases)) {
      for (const [source, target] of Object.entries(models)) {
        aliasRows.push({ tool, source, target });
      }
    }
  }

  /* ---- render ---- */
  return (
    <div>
      <PageHeader
        title="MITM Proxy"
        subtitle="Intercept IDE requests and route through Hexos"
      />

      {/* Error banner */}
      {error && (
        <Card className="mb-4 border-destructive/50 bg-destructive/10">
          <CardContent className="flex items-center justify-between pt-4">
            <span className="text-sm text-destructive">{error}</span>
            <Button variant="ghost" size="sm" onClick={fetchStatus}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && !status && (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {(status || !loading) && (
        <div className="flex flex-col gap-6">
          {/* ---- 1. Server Status Card ---- */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Shield className="size-5 text-primary" />
                  <CardTitle>Server Status</CardTitle>
                </div>
                <CardDescription>
                  MITM HTTPS proxy server running on port 443
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {/* Status indicators */}
                <div className="flex flex-wrap items-center gap-3">
                  <Badge
                    className={
                      isRunning
                        ? "bg-emerald-500/15 text-emerald-500"
                        : "bg-red-500/15 text-red-500"
                    }
                  >
                    {isRunning ? "Running" : "Stopped"}
                  </Badge>

                  {isRunning && status?.pid && (
                    <Badge variant="secondary">PID {status.pid}</Badge>
                  )}

                  {status?.certExists ? (
                    <Badge
                      className={
                        status.certTrusted
                          ? "bg-emerald-500/15 text-emerald-500"
                          : "bg-yellow-500/15 text-yellow-500"
                      }
                    >
                      <ShieldCheck className="mr-1 size-3" />
                      {status.certTrusted ? "Cert Trusted" : "Cert Generated"}
                    </Badge>
                  ) : (
                    <Badge className="bg-red-500/15 text-red-500">
                      <ShieldX className="mr-1 size-3" />
                      No Certificate
                    </Badge>
                  )}
                </div>

                {/* Sudo password + actions */}
                <div className="flex flex-wrap items-end gap-3">
                  {showPasswordField && (
                    <div className="flex min-w-0 flex-col gap-1.5 sm:w-64">
                      <Label htmlFor="sudo-password">
                        <Lock className="mr-1 inline size-3" />
                        Sudo Password
                      </Label>
                      <Input
                        id="sudo-password"
                        type="password"
                        placeholder="Required to bind port 443"
                        value={sudoPassword}
                        onChange={(e) => setSudoPassword(e.target.value)}
                      />
                    </div>
                  )}

                  {!isRunning ? (
                    <Button
                      onClick={handleStart}
                      disabled={actionLoading === "start"}
                    >
                      {actionLoading === "start" ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Play />
                      )}
                      Start Proxy
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      onClick={handleStop}
                      disabled={actionLoading === "stop"}
                    >
                      {actionLoading === "stop" ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Square />
                      )}
                      Stop Proxy
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* ---- 2. DNS Interception Card ---- */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Network className="size-5 text-primary" />
                  <CardTitle>DNS Interception</CardTitle>
                </div>
                <CardDescription>
                  Route IDE traffic through the MITM proxy via /etc/hosts
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {TOOLS.map((tool) => {
                    const Icon = tool.icon;
                    const isEnabled = status?.dnsStatus?.[tool.id] ?? false;

                    return (
                      <Card key={tool.id} className="relative">
                        {tool.comingSoon && (
                          <div className="absolute right-3 top-3">
                            <Badge variant="secondary" className="text-[10px]">
                              Coming Soon
                            </Badge>
                          </div>
                        )}
                        <CardContent className="flex items-start gap-3 pt-4">
                          <div
                            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                              toolIconColors[tool.id] ?? "bg-muted text-muted-foreground"
                            }`}
                          >
                            <Icon className="size-4.5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <div>
                                <p className="text-sm font-medium">{tool.name}</p>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {tool.hosts.map((host) => (
                                    <span
                                      key={host}
                                      className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                                    >
                                      {host}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <Switch
                                checked={isEnabled}
                                onCheckedChange={(checked) =>
                                  handleToggleTool(tool.id, checked)
                                }
                                disabled={
                                  !isRunning ||
                                  !!tool.comingSoon ||
                                  actionLoading === tool.id
                                }
                              />
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* ---- 3. Model Aliases Card ---- */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.2 }}
          >
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Shield className="size-5 text-primary" />
                  <CardTitle>Model Aliases</CardTitle>
                </div>
                <CardDescription>
                  Remap model names in intercepted requests to route to different
                  Hexos models
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {/* Add alias form */}
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1.5 sm:w-40">
                    <Label htmlFor="alias-tool">Tool</Label>
                    <Select value={aliasTool} onValueChange={setAliasTool}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TOOLS.filter((t) => !t.comingSoon).map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Label htmlFor="alias-source">Source Model</Label>
                    <Input
                      id="alias-source"
                      className="font-mono text-sm"
                      placeholder="e.g. gpt-4o"
                      value={aliasSource}
                      onChange={(e) => setAliasSource(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddAlias();
                      }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Label htmlFor="alias-target">Target Model</Label>
                    <Input
                      id="alias-target"
                      className="font-mono text-sm"
                      placeholder="e.g. cb/opus-4.6"
                      value={aliasTarget}
                      onChange={(e) => setAliasTarget(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddAlias();
                      }}
                    />
                  </div>
                  <Button
                    onClick={handleAddAlias}
                    disabled={
                      actionLoading === "add-alias" ||
                      !aliasSource.trim() ||
                      !aliasTarget.trim()
                    }
                  >
                    {actionLoading === "add-alias" ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Plus />
                    )}
                    Add
                  </Button>
                </div>

                {/* Aliases table */}
                {aliasRows.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No model aliases configured. Add one above to remap model
                    names in intercepted requests.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tool</TableHead>
                          <TableHead>Source Model</TableHead>
                          <TableHead>Target Model</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {aliasRows.map((row) => {
                          const toolMeta = TOOLS.find((t) => t.id === row.tool);
                          const rmKey = `rm-${row.tool}-${row.source}`;
                          return (
                            <TableRow key={`${row.tool}-${row.source}`}>
                              <TableCell>
                                <Badge variant="secondary">
                                  {toolMeta?.name ?? row.tool}
                                </Badge>
                              </TableCell>
                              <TableCell className="font-mono text-sm">
                                {row.source}
                              </TableCell>
                              <TableCell className="font-mono text-sm">
                                {row.target}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 text-destructive hover:text-destructive"
                                  onClick={() =>
                                    handleRemoveAlias(row.tool, row.source)
                                  }
                                  disabled={actionLoading === rmKey}
                                >
                                  {actionLoading === rmKey ? (
                                    <Loader2 className="animate-spin" />
                                  ) : (
                                    <Trash2 />
                                  )}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* ---- 4. How It Works Card ---- */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.3 }}
          >
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Info className="size-5 text-primary" />
                  <CardTitle>How It Works</CardTitle>
                </div>
                <CardDescription>
                  Understanding the MITM proxy interception flow
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="rounded-lg bg-muted/50 p-4 font-mono text-xs leading-relaxed text-muted-foreground">
                  <pre className="overflow-x-auto whitespace-pre">
{`  IDE (Copilot/Kiro/etc.)
        │
        │  HTTPS request to e.g. api.individual.githubcopilot.com
        ▼
  /etc/hosts  ──►  127.0.0.1  (redirected locally)
        │
        ▼
  MITM Proxy (:443)
        │
        ├─  Decrypt with generated leaf cert (signed by Root CA)
        ├─  Rewrite model names (aliases)
        ├─  Route request to Hexos proxy server
        │
        ▼
  Hexos Server (:7470)
        │
        ├─  Select best connection from pool
        ├─  Forward to upstream provider
        │
        ▼
  Response streamed back to IDE`}
                  </pre>
                </div>

                <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                  <p>
                    <strong className="text-foreground">1. DNS Redirect:</strong>{" "}
                    When you enable a tool, its API hostnames are added to{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">/etc/hosts</code>{" "}
                    pointing to <code className="rounded bg-muted px-1 py-0.5 text-xs">127.0.0.1</code>.
                  </p>
                  <p>
                    <strong className="text-foreground">2. TLS Interception:</strong>{" "}
                    The MITM proxy presents a leaf certificate signed by a local Root CA.
                    The Root CA must be trusted by your system for HTTPS to work seamlessly.
                  </p>
                  <p>
                    <strong className="text-foreground">3. Request Routing:</strong>{" "}
                    Intercepted requests are forwarded to the Hexos server, which
                    selects the best available connection and routes to the upstream provider.
                  </p>
                  <p>
                    <strong className="text-foreground">4. Model Aliases:</strong>{" "}
                    Optionally remap model names so the IDE&apos;s default model
                    is transparently replaced with your preferred Hexos model.
                  </p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      )}
    </div>
  );
}
