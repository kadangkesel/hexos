"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useYepAPIStore } from "@/stores/yepapi";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  KeyRound,
  CheckCircle2,
  XCircle,
  User,
  Zap,
  ArrowLeft,
  Trash2,
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

export default function YepAPIPage() {
  const router = useRouter();
  const {
    connections,
    loading,
    error,
    fetchConnections,
    addApiKey,
    removeConnection,
  } = useYepAPIStore();

  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(9);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const handleAddApiKey = async () => {
    if (!apiKey.trim()) {
      toast.error("API key is required");
      return;
    }
    setSubmitting(true);
    const result = await addApiKey(apiKey.trim(), label.trim() || undefined);
    setSubmitting(false);
    if (result.ok) {
      toast.success("YepAPI key added successfully");
      setApiKey("");
      setLabel("");
    } else {
      toast.error(result.error || "Failed to add API key");
    }
  };

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    const result = await removeConnection(id);
    setRemovingId(null);
    if (result.ok) {
      toast.success("Connection removed");
    } else {
      toast.error(result.error || "Failed to remove connection");
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
            <KeyRound className="size-8" />
            YepAPI
            <Badge variant="outline" className="text-xs font-normal">Multi-model API</Badge>
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect YepAPI accounts — add your API key to access OpenAI, Anthropic, Google, and more models through a single provider.
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
              YepAPI keys — access 14 models including GPT, Claude, Gemini, DeepSeek, Grok, and more
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
                No YepAPI keys connected. Add your API key below to get started.
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
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={removingId === conn.id}
                        onClick={() => handleRemove(conn.id)}
                      >
                        {removingId === conn.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </Button>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge
                        variant={conn.status === "active" ? "default" : "destructive"}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {conn.status}
                      </Badge>
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

      {/* Add API Key */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-4"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" />
              Add API Key
            </CardTitle>
            <CardDescription>
              Enter your YepAPI secret key. Get one from{" "}
              <a
                href="https://yepapi.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-primary"
              >
                yepapi.com
              </a>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="yepapi-key">API Key</Label>
                <Input
                  id="yepapi-key"
                  placeholder="yep_sk_..."
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="yepapi-label">
                  Label{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="yepapi-label"
                  placeholder="my-yepapi-key"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            </div>
            <Button
              onClick={handleAddApiKey}
              disabled={submitting || !apiKey.trim()}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <KeyRound className="size-4 mr-2" />
              )}
              Add API Key
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Available Models */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mt-4"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="size-4" />
              Available YepAPI Models
            </CardTitle>
            <CardDescription>
              14 models accessible through YepAPI provider
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { id: "yp/gpt-4o-mini", name: "GPT-4o Mini", desc: "OpenAI" },
                { id: "yp/gpt-4o", name: "GPT-4o", desc: "OpenAI" },
                { id: "yp/gpt-5.4", name: "GPT-5.4", desc: "OpenAI" },
                { id: "yp/gpt-5.4-pro", name: "GPT-5.4 Pro", desc: "OpenAI" },
                { id: "yp/gpt-5.4-mini", name: "GPT-5.4 Mini", desc: "OpenAI" },
                { id: "yp/gpt-5.4-nano", name: "GPT-5.4 Nano", desc: "OpenAI" },
                { id: "yp/gpt-5.2", name: "GPT-5.2", desc: "OpenAI" },
                { id: "yp/gpt-5.2-pro", name: "GPT-5.2 Pro", desc: "OpenAI" },
                { id: "yp/gpt-5.3-chat", name: "GPT-5.3 Chat", desc: "OpenAI" },
                { id: "yp/gpt-5.3-codex", name: "GPT-5.3 Codex", desc: "OpenAI" },
                { id: "yp/gpt-5.2-codex", name: "GPT-5.2 Codex", desc: "OpenAI" },
                { id: "yp/gpt-audio", name: "GPT Audio", desc: "OpenAI" },
                { id: "yp/gpt-audio-mini", name: "GPT Audio Mini", desc: "OpenAI" },
                { id: "yp/gpt-oss-120b", name: "GPT OSS 120B", desc: "OpenAI" },
                { id: "yp/opus-4.7", name: "Opus 4.7", desc: "Anthropic" },
                { id: "yp/opus-4.6", name: "Opus 4.6", desc: "Anthropic" },
                { id: "yp/opus-4.6-fast", name: "Opus 4.6 Fast", desc: "Anthropic" },
                { id: "yp/sonnet-4", name: "Sonnet 4", desc: "Anthropic" },
                { id: "yp/sonnet-4.6", name: "Sonnet 4.6", desc: "Anthropic" },
                { id: "yp/sonnet-4.5", name: "Sonnet 4.5", desc: "Anthropic" },
                { id: "yp/haiku-4", name: "Haiku 4", desc: "Anthropic" },
                { id: "yp/gemini-3.1-pro", name: "Gemini 3.1 Pro", desc: "Google" },
                { id: "yp/gemini-3-flash", name: "Gemini 3 Flash", desc: "Google" },
                { id: "yp/gemini-2.5-pro", name: "Gemini 2.5 Pro", desc: "Google" },
                { id: "yp/gemini-2.5-flash", name: "Gemini 2.5 Flash", desc: "Google" },
                { id: "yp/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", desc: "Google" },
                { id: "yp/gemini-image", name: "Gemini Image", desc: "Google" },
                { id: "yp/grok-4.20", name: "Grok 4.20", desc: "xAI" },
                { id: "yp/grok-4.20-multi", name: "Grok 4.20 Multi", desc: "xAI" },
                { id: "yp/grok-4.1-fast", name: "Grok 4.1 Fast", desc: "xAI" },
                { id: "yp/deepseek-r1", name: "DeepSeek R1", desc: "DeepSeek" },
                { id: "yp/deepseek-v3", name: "DeepSeek V3", desc: "DeepSeek" },
                { id: "yp/deepseek-v3.2", name: "DeepSeek V3.2", desc: "DeepSeek" },
                { id: "yp/llama-4-maverick", name: "Llama 4 Maverick", desc: "Meta" },
                { id: "yp/llama-4-scout", name: "Llama 4 Scout", desc: "Meta" },
                { id: "yp/qwen-3-coder", name: "Qwen 3 Coder", desc: "Alibaba" },
                { id: "yp/qwen-3-max-thinking", name: "Qwen 3 Max Thinking", desc: "Alibaba" },
                { id: "yp/qwen-3.6-plus", name: "Qwen 3.6 Plus", desc: "Alibaba" },
                { id: "yp/qwen-3.5-plus", name: "Qwen 3.5 Plus", desc: "Alibaba" },
                { id: "yp/kimi-k2.5", name: "Kimi K2.5", desc: "Moonshot" },
                { id: "yp/minimax-m2.7", name: "MiniMax M2.7", desc: "MiniMax" },
                { id: "yp/mimo-v2-pro", name: "MiMo V2 Pro", desc: "Xiaomi" },
                { id: "yp/sonar", name: "Sonar", desc: "Perplexity" },
                { id: "yp/sonar-pro", name: "Sonar Pro", desc: "Perplexity" },
                { id: "yp/mistral-small-4", name: "Mistral Small 4", desc: "Mistral" },
                { id: "yp/devstral-2", name: "Devstral 2", desc: "Mistral" },
                { id: "yp/nemotron-3-super", name: "Nemotron 3 Super", desc: "Nvidia" },
                { id: "yp/step-3.5-flash", name: "Step 3.5 Flash", desc: "StepFun" },
                { id: "yp/gemma-4-31b", name: "Gemma 4 31B", desc: "Google" },
                { id: "yp/nano-banana-pro", name: "Nano Banana Pro", desc: "Google" },
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
