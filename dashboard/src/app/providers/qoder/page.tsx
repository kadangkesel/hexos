"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQoderStore } from "@/stores/qoder";
import { PageHeader } from "@/components/PageHeader";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  Download,
  Monitor,
  Terminal,
  KeyRound,
  CheckCircle2,
  XCircle,
  User,
  Users,
  Zap,
  Globe,
  ArrowLeft,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Qoder } from "@lobehub/icons";

export default function QoderAuthPage() {
  const router = useRouter();
  const {
    connections,
    loading,
    error,
    loginLoading,
    fetchConnections,
    addManual,
    importFromCli,
    importFromIde,
  } = useQoderStore();

  const [manualUid, setManualUid] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [manualRefresh, setManualRefresh] = useState("");
  const [manualLabel, setManualLabel] = useState("");

  const [submitting, setSubmitting] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(9);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const handleAddManual = async () => {
    if (!manualUid.trim() || !manualToken.trim()) {
      toast.error("UID and Token are required");
      return;
    }
    setSubmitting("manual");
    const result = await addManual(
      manualUid.trim(),
      manualToken.trim(),
      manualRefresh.trim() || undefined,
      manualLabel.trim() || undefined
    );
    setSubmitting(null);
    if (result.ok) {
      toast.success("Qoder account added successfully");
      setManualUid("");
      setManualToken("");
      setManualRefresh("");
      setManualLabel("");
    } else {
      toast.error(result.error || "Failed to add account");
    }
  };

  const handleImportCli = async () => {
    setSubmitting("cli");
    const result = await importFromCli();
    setSubmitting(null);
    if (result.ok) {
      toast.success("Imported from Qoder CLI");
    } else {
      toast.error(result.error || "Failed to import from CLI");
    }
  };

  const handleImportIde = async () => {
    setSubmitting("ide");
    const result = await importFromIde();
    setSubmitting(null);
    if (result.ok) {
      toast.success(
        result.email
          ? `Imported from Qoder IDE (${result.email})`
          : "Imported from Qoder IDE"
      );
    } else {
      toast.error(result.error || "Failed to import from IDE");
    }
  };

  return (
    <>
      {/* Back button + header */}
      <div className="flex items-center gap-3 mb-6">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={() => router.push("/providers")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-4">
            <Qoder className="size-8" />
            Qoder
            <Badge variant="outline" className="text-xs font-normal">Alibaba Cloud</Badge>
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect Qoder accounts — Google OAuth, CLI import, IDE import, or manual token entry.
          </p>
        </div>
      </div>

      {/* Connected Accounts */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="size-5" />
              Connected Accounts
              {connections.length > 0 && (
                <Badge variant="secondary">{connections.length}</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Qoder accounts — access 9 models including Qwen, GLM, Kimi, MiniMax
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            {!loading && connections.length === 0 && (
              <p className="text-sm text-muted-foreground py-4">
                No Qoder accounts connected. Use one of the methods below to add an account.
              </p>
            )}
            {connections.length > 0 && (
              <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {connections.slice(0, visibleCount).map((conn) => (
                  <div
                    key={conn.id}
                    className="rounded-lg border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        {conn.status === "active" ? (
                          <CheckCircle2 className="size-4 shrink-0 text-green-500" />
                        ) : (
                          <XCircle className="size-4 shrink-0 text-destructive" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{conn.label}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {conn.uid?.slice(0, 16)}...
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge
                        variant={conn.status === "active" ? "default" : "destructive"}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {conn.status}
                      </Badge>
                      {conn.credit?.packageName && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {conn.credit.packageName}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {connections.length > visibleCount && (
                <div className="flex justify-center mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setVisibleCount((v) => v + 9)}
                  >
                    Load More ({connections.length - visibleCount} remaining)
                  </Button>
                </div>
              )}
              </>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Google Login — redirect to Accounts page */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-4"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="size-4" />
              Login with Google
            </CardTitle>
            <CardDescription>
              Use Batch Connect on the Accounts page to add Qoder accounts via Google OAuth browser automation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push("/accounts")}>
              <Users className="size-4 mr-2" />
              Go to Accounts
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Import Methods */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mt-4"
      >
        <h2 className="text-lg font-semibold mb-3">Import Account</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {/* Import from IDE */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Monitor className="size-4" />
                Import from Qoder IDE
              </CardTitle>
              <CardDescription>
                Auto-detect and import credentials from Qoder IDE installed on this machine (Windows only)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleImportIde}
                disabled={submitting !== null}
                className="w-full"
              >
                {submitting === "ide" ? (
                  <Loader2 className="size-4 animate-spin mr-2" />
                ) : (
                  <Download className="size-4 mr-2" />
                )}
                Import from IDE
              </Button>
            </CardContent>
          </Card>

          {/* Import from CLI */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="size-4" />
                Import from Qoder CLI
              </CardTitle>
              <CardDescription>
                Import credentials from <code className="text-xs">~/.qoder/.auth/</code> directory (login via <code className="text-xs">qodercli /login</code> first)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleImportCli}
                disabled={submitting !== null}
                variant="outline"
                className="w-full"
              >
                {submitting === "cli" ? (
                  <Loader2 className="size-4 animate-spin mr-2" />
                ) : (
                  <Download className="size-4 mr-2" />
                )}
                Import from CLI
              </Button>
            </CardContent>
          </Card>
        </div>
      </motion.div>

      {/* Manual Token Entry */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-4"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" />
              Manual Token Entry
            </CardTitle>
            <CardDescription>
              Paste your Qoder credentials directly. Get these from the Qoder CLI auth file or IDE storage.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="qoder-uid">User ID (uid)</Label>
                <Input
                  id="qoder-uid"
                  placeholder="019db9dc-31df-7a45-..."
                  value={manualUid}
                  onChange={(e) => setManualUid(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qoder-token">Access Token</Label>
                <Input
                  id="qoder-token"
                  placeholder="dt-..."
                  type="password"
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qoder-refresh">
                  Refresh Token{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="qoder-refresh"
                  placeholder="drt-..."
                  type="password"
                  value={manualRefresh}
                  onChange={(e) => setManualRefresh(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qoder-label">
                  Label{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="qoder-label"
                  placeholder="my-qoder-account"
                  value={manualLabel}
                  onChange={(e) => setManualLabel(e.target.value)}
                />
              </div>
            </div>
            <Button
              onClick={handleAddManual}
              disabled={submitting !== null || !manualUid.trim() || !manualToken.trim()}
            >
              {submitting === "manual" ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <KeyRound className="size-4 mr-2" />
              )}
              Add Account
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Available Models */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="mt-4"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="size-4" />
              Available Qoder Models
            </CardTitle>
            <CardDescription>
              9 distinct models accessible through Qoder provider
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { id: "qd/lite", name: "Lite", desc: "Free tier" },
                { id: "qd/auto", name: "Auto", desc: "Smart selection" },
                { id: "qd/efficient", name: "Efficient", desc: "Low cost" },
                { id: "qd/performance", name: "Performance", desc: "High quality" },
                { id: "qd/ultimate", name: "Ultimate", desc: "Deep reasoning" },
                { id: "qd/qwen3.6-plus", name: "Qwen 3.6 Plus", desc: "Alibaba" },
                { id: "qd/glm-5.1", name: "GLM 5.1", desc: "Zhipu AI" },
                { id: "qd/kimi-k2.6", name: "Kimi K2.6", desc: "Moonshot" },
                { id: "qd/minimax-m2.7", name: "MiniMax M2.7", desc: "MiniMax" },
              ].map((model) => (
                <div
                  key={model.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium">{model.name}</p>
                    <p className="text-xs text-muted-foreground">{model.desc}</p>
                  </div>
                  <code className="text-xs text-muted-foreground">
                    {model.id}
                  </code>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </>
  );
}
