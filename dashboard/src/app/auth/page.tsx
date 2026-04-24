"use client";

import { useEffect, useState } from "react";
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
  Zap,
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
import { Separator } from "@/components/ui/separator";

export default function QoderPage() {
  const {
    connections,
    loading,
    error,
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
      <PageHeader
        title="IDE Auth"
        subtitle="Connect IDE accounts to Hexos. Import credentials from installed IDEs or enter tokens manually."
      />

      {/* Qoder Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Zap className="size-5" />
          Qoder
          <Badge variant="outline" className="text-xs font-normal">Alibaba Cloud</Badge>
        </h2>
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
              <div className="space-y-3">
                {connections.map((conn) => (
                  <div
                    key={conn.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-3">
                      {conn.status === "active" ? (
                        <CheckCircle2 className="size-4 text-green-500" />
                      ) : (
                        <XCircle className="size-4 text-destructive" />
                      )}
                      <div>
                        <p className="text-sm font-medium">{conn.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {conn.uid?.slice(0, 16)}...
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          conn.status === "active" ? "default" : "destructive"
                        }
                      >
                        {conn.status}
                      </Badge>
                      {conn.credit?.packageName && (
                        <Badge variant="outline">
                          {conn.credit.packageName}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Import Methods */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-4"
      >
        <h2 className="text-lg font-semibold mb-3">Add Account</h2>
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
        transition={{ delay: 0.3 }}
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
        transition={{ delay: 0.4 }}
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
