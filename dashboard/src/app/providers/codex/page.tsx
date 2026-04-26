"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCodexStore } from "@/stores/codex";
import { Codex } from '@lobehub/icons';
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  Download,
  Terminal,
  KeyRound,
  CheckCircle2,
  XCircle,
  User,
  Brain,
  Globe,
  ArrowLeft,
  ExternalLink,
  Trash2,
  RefreshCw,
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

export default function CodexProviderPage() {
  const router = useRouter();
  const {
    connections,
    loading,
    error,
    fetchConnections,
    importTokens,
    importFromCli,
    startOAuth,
    exchangeCode,
    removeConnection,
    checkUsage,
  } = useCodexStore();

  const [manualAccessToken, setManualAccessToken] = useState("");
  const [manualRefreshToken, setManualRefreshToken] = useState("");
  const [callbackInput, setCallbackInput] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [oauthStarted, setOauthStarted] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(9);
  const nowRef = useRef(Date.now() / 1000);
  nowRef.current = Date.now() / 1000;

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const handleStartOAuth = async () => {
    setSubmitting("oauth");
    const result = await startOAuth();
    setSubmitting(null);
    if (result.ok && result.authUrl) {
      setOauthStarted(true);
      window.open(result.authUrl, "_blank");
      toast.info("ChatGPT login opened in new window. Paste the callback URL below after authorizing.");
    } else {
      toast.error(result.error || "Failed to start OAuth");
    }
  };

  const handleExchangeCode = async () => {
    const input = callbackInput.trim();
    if (!input) {
      toast.error("Please paste the callback URL or authorization code");
      return;
    }
    // Extract code from callback URL or use raw input
    let code = input;
    try {
      const url = new URL(input);
      const codeParam = url.searchParams.get("code");
      if (codeParam) code = codeParam;
    } catch {
      // Not a URL, use as-is (raw code)
    }
    setSubmitting("exchange");
    const result = await exchangeCode(code);
    setSubmitting(null);
    if (result.ok) {
      toast.success(
        result.email
          ? `Connected Codex account (${result.email})`
          : "Codex account connected successfully"
      );
      setCallbackInput("");
      setOauthStarted(false);
    } else {
      toast.error(result.error || "Failed to exchange code");
    }
  };

  const handleImportCli = async () => {
    setSubmitting("cli");
    const result = await importFromCli();
    setSubmitting(null);
    if (result.ok) {
      toast.success(
        result.email
          ? `Imported from Codex CLI (${result.email})`
          : "Imported from Codex CLI"
      );
    } else {
      toast.error(result.error || "Failed to import from CLI");
    }
  };

  const handleImportTokens = async () => {
    if (!manualAccessToken.trim() || !manualRefreshToken.trim()) {
      toast.error("Both access token and refresh token are required");
      return;
    }
    setSubmitting("manual");
    const result = await importTokens(
      manualAccessToken.trim(),
      manualRefreshToken.trim()
    );
    setSubmitting(null);
    if (result.ok) {
      toast.success(
        result.email
          ? `Codex account added (${result.email})`
          : "Codex account added successfully"
      );
      setManualAccessToken("");
      setManualRefreshToken("");
    } else {
      toast.error(result.error || "Failed to import tokens");
    }
  };

  const handleRemove = async (id: string) => {
    setSubmitting(`remove-${id}`);
    const result = await removeConnection(id);
    setSubmitting(null);
    if (result.ok) {
      toast.success("Connection removed");
    } else {
      toast.error(result.error || "Failed to remove connection");
    }
  };

  const handleCheckUsage = async (id: string, label: string) => {
    setCheckingId(id);
    const result = await checkUsage(id);
    setCheckingId(null);
    if (result.ok) {
      toast.success(`${label} — valid, usage updated`);
    } else {
      toast.error(`${label} — ${result.error || "check failed"}`);
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
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Codex size={32} />
            Codex
            <Badge variant="outline" className="text-xs font-normal">OpenAI</Badge>
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect Codex accounts — ChatGPT OAuth, CLI import, or manual token entry.
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
              Codex accounts — access GPT-5.5, GPT-5.4, GPT-5.3 Codex and more via ChatGPT
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
                No Codex accounts connected. Use one of the methods below to add an account.
              </p>
            )}
            {connections.length > 0 && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {connections.slice(0, visibleCount).map((conn) => {
                    const primaryResetAt = conn.credit?.primaryResetAt;
                    const secondaryResetAt = conn.credit?.secondaryResetAt;

                    // If reset time has passed, quota has reset — force percentage to 0
                    const primaryExpired = primaryResetAt != null && primaryResetAt <= nowRef.current;
                    const secondaryExpired = secondaryResetAt != null && secondaryResetAt <= nowRef.current;

                    const primary = primaryExpired ? 0 : (conn.credit?.primaryUsedPercent ?? 0);
                    const secondary = secondaryExpired ? 0 : (conn.credit?.secondaryUsedPercent ?? 0);
                    const primaryColor = primary > 80 ? "bg-red-500" : primary > 50 ? "bg-amber-500" : "bg-emerald-500";
                    const secondaryColor = secondary > 80 ? "bg-red-500" : secondary > 50 ? "bg-amber-500" : "bg-emerald-500";

                    // 5h limit: show hours + minutes
                    const primaryTotalMin = primaryResetAt ? Math.max(0, Math.round((primaryResetAt - nowRef.current) / 60)) : null;
                    const primaryH = primaryTotalMin !== null ? Math.floor(primaryTotalMin / 60) : null;
                    const primaryM = primaryTotalMin !== null ? primaryTotalMin % 60 : null;
                    const primaryResetStr = primaryTotalMin !== null
                      ? primaryH! > 0 ? `${primaryH}h ${primaryM}m` : `${primaryM}m`
                      : null;

                    // Weekly limit: show days + reset day name & date
                    const secondaryTotalH = secondaryResetAt ? Math.max(0, Math.round((secondaryResetAt - nowRef.current) / 3600)) : null;
                    const secondaryDays = secondaryTotalH !== null ? Math.floor(secondaryTotalH / 24) : null;
                    const secondaryResetDate = secondaryResetAt ? new Date(secondaryResetAt * 1000) : null;
                    const secondaryDayName = secondaryResetDate
                      ? secondaryResetDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
                      : null;
                    const secondaryResetStr = secondaryDays !== null
                      ? `${secondaryDays}d${secondaryDayName ? ` (${secondaryDayName})` : ""}`
                      : null;

                    return (
                      <div
                        key={conn.id}
                        className="rounded-lg border p-3 space-y-2.5"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <Codex size={24} />
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{conn.label}</p>
                              <p className="text-xs text-muted-foreground">
                                {conn.usageCount ?? 0} req
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">

                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={checkingId !== null || submitting !== null}
                              onClick={() => handleCheckUsage(conn.id, conn.label)}
                              title="Check valid & refresh usage"
                            >
                              {checkingId === conn.id ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <RefreshCw className="size-3" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={submitting !== null}
                              onClick={() => handleRemove(conn.id)}
                            >
                              {submitting === `remove-${conn.id}` ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <Trash2 className="size-3" />
                              )}
                            </Button>
                            {conn.status === "active" ? (
                              <CheckCircle2 className="size-4 shrink-0 text-green-500" />
                            ) : (
                              <XCircle className="size-4 shrink-0 text-destructive" />
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {conn.planType && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                              {conn.planType}
                            </Badge>
                          )}
                          <Badge
                            variant={conn.status === "active" ? "default" : "destructive"}
                            className="text-[10px] px-1.5 py-0"
                          >
                            {conn.status}
                          </Badge>
                        </div>
                        {/* 5-hour limit */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>5 Hours Limit</span>
                            <span>{primary}%{primaryResetStr ? ` · ${primaryResetStr}` : ""}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${primaryColor}`}
                              style={{ width: `${Math.min(primary, 100)}%` }}
                            />
                          </div>
                        </div>
                        {/* Weekly limit */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>Weekly Limit</span>
                            <span>{secondary}%{secondaryResetStr ? ` · ${secondaryResetStr}` : ""}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${secondaryColor}`}
                              style={{ width: `${Math.min(secondary, 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
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

      {/* Login with ChatGPT */}
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
              Login with ChatGPT
            </CardTitle>
            <CardDescription>
              Authenticate via OpenAI OAuth. Opens ChatGPT login in a new window — paste the callback URL after authorizing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!oauthStarted ? (
              <Button
                onClick={handleStartOAuth}
                disabled={submitting !== null}
              >
                {submitting === "oauth" ? (
                  <Loader2 className="size-4 animate-spin mr-2" />
                ) : (
                  <ExternalLink className="size-4 mr-2" />
                )}
                Login with ChatGPT
              </Button>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  After authorizing in the browser, paste the callback URL below (e.g. <code className="text-xs">http://localhost:1455/auth/callback?code=...</code>)
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Paste callback URL or authorization code..."
                    value={callbackInput}
                    onChange={(e) => setCallbackInput(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    onClick={handleExchangeCode}
                    disabled={submitting !== null || !callbackInput.trim()}
                  >
                    {submitting === "exchange" ? (
                      <Loader2 className="size-4 animate-spin mr-2" />
                    ) : (
                      <CheckCircle2 className="size-4 mr-2" />
                    )}
                    Connect
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOauthStarted(false);
                    setCallbackInput("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
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
          {/* Import from Codex CLI */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="size-4" />
                Import from Codex CLI
              </CardTitle>
              <CardDescription>
                Auto-detect and import credentials from <code className="text-xs">~/.codex/auth.json</code> (login via <code className="text-xs">codex</code> CLI first)
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

          {/* Manual Token Entry */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="size-4" />
                Manual Token Entry
              </CardTitle>
              <CardDescription>
                Paste your ChatGPT access token and refresh token directly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="codex-access-token">Access Token</Label>
                <Input
                  id="codex-access-token"
                  placeholder="eyJhbGciOi..."
                  type="password"
                  value={manualAccessToken}
                  onChange={(e) => setManualAccessToken(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="codex-refresh-token">Refresh Token</Label>
                <Input
                  id="codex-refresh-token"
                  placeholder="v1.xxx..."
                  type="password"
                  value={manualRefreshToken}
                  onChange={(e) => setManualRefreshToken(e.target.value)}
                />
              </div>
              <Button
                onClick={handleImportTokens}
                disabled={submitting !== null || !manualAccessToken.trim() || !manualRefreshToken.trim()}
                className="w-full"
              >
                {submitting === "manual" ? (
                  <Loader2 className="size-4 animate-spin mr-2" />
                ) : (
                  <KeyRound className="size-4 mr-2" />
                )}
                Import Tokens
              </Button>
            </CardContent>
          </Card>
        </div>
      </motion.div>

      {/* Available Models */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-4"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Brain className="size-4" />
              Available Codex Models
            </CardTitle>
            <CardDescription>
              6 models accessible through Codex provider
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { id: "cx/gpt-5.5", name: "GPT-5.5", desc: "Latest flagship" },
                { id: "cx/gpt-5.4", name: "GPT-5.4", desc: "Previous flagship" },
                { id: "cx/gpt-5.4-mini", name: "GPT-5.4 Mini", desc: "Fast & efficient" },
                { id: "cx/gpt-5.3-codex", name: "GPT-5.3 Codex", desc: "Coding optimized" },
                { id: "cx/gpt-5.2", name: "GPT-5.2", desc: "Stable" },
                { id: "cx/codex-auto-review", name: "Auto Review", desc: "Hidden model" },
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
