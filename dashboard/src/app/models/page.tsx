"use client";

import { useEffect, useState, useCallback } from "react";
import { useModelsStore, type Model } from "@/stores/models";
import { Search, Copy, Check, Loader2, Brain } from "lucide-react";
import { toast } from "sonner";
import { motion } from "motion/react";
// utilities
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
// Lobehub icons (Mono by default; Avatar variant exposed optionally)
import {
  Tencent,
  Codex,
  Qoder,
  Cline,
  Aws,
  Anthropic,
  OpenAI,
  Gemini,
  DeepSeek,
  Kimi,
  ChatGLM,
  Minimax,
  Grok,
  Qwen,
} from "@lobehub/icons";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatContextWindow(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  if (num >= 1_000_000)
    return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  if (num >= 1_000)
    return `${(num / 1_000).toFixed(num % 1_000 === 0 ? 0 : 1)}K`;
  return String(num);
}

/* ------------------------------------------------------------------ */
/*  Model Card                                                         */
/* ------------------------------------------------------------------ */

function mapModelNameToIcon(name: string): any {
  const s = String(name ?? "").toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return Anthropic;
  if (s.includes("gpt") || s.includes("codex") || s.includes("codebuddy default")) return OpenAI;
  if (s.includes("gemini") || s.includes("gemma")) return Gemini;
  if (s.includes("deepseek")) return DeepSeek;
  if (s.includes("kimi")) return Kimi;
  if (s.includes("glm")) return ChatGLM;
  if (s.includes("minimax")) return Minimax;
  if (s.includes("grok")) return Grok;
  if (s.includes("qwen") || s.includes("qoder")) return Qwen;
  // Fallback to Brain icon (lucide) for unknown models
  return Brain;
}

function ModelCard({ model, index }: { model: Model; index: number }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(model.id);
      setCopied(true);
      toast.success(`Copied ${model.id}`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  }, [model.id]);

  const contextWindow = formatContextWindow((model as any).contextWindow);

  // Icon for the model — use Mono (default) variant, no background
  const IconElement = mapModelNameToIcon(model.name);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.04 }}
    >
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 w-full">
            <div className="flex items-center gap-3">
              <IconElement className="size-6 shrink-0" />
              <div className="flex flex-col">
                <CardTitle className="font-semibold">{model.name}</CardTitle>
                <span className="text-xs text-muted-foreground">{model.id}</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleCopy}
              aria-label="Copy model ID"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            {contextWindow && (
              <Badge variant="secondary">
                {contextWindow} ctx
              </Badge>
            )}
            {model.provider && (
              <Badge variant="outline" className="text-[10px]">
                {model.provider}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function ModelsPage() {
  const { models, loading, error, fetch } = useModelsStore();
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Flat filtered list for search mode
  const filteredFlat = models.filter((m) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      (m.provider && m.provider.toLowerCase().includes(q))
    );
  });

  // Group models by provider for the non-search view
  const groups: Record<string, Model[]> = {};
  if (!loading && !error) {
    for (const m of models) {
      const p = (m as any).provider || "";
      if (!groups[p]) groups[p] = [];
      groups[p].push(m);
    }
  }

  // Provider metadata for header icons and display names
  const PROVIDER_META: Record<string, { label: string; Icon: any }> = {
    codebuddy: { label: "CodeBuddy", Icon: Tencent },
    cline: { label: "Cline", Icon: Cline },
    kiro: { label: "Kiro", Icon: Aws },
    qoder: { label: "Qoder", Icon: Qoder },
    codex: { label: "Codex", Icon: Codex },
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Models</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Available AI models
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-6 max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search models..."
          className="pl-8"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Error */}
      {error && (
        <Card className="mb-4 border-destructive/50">
          <CardContent className="flex items-center justify-between py-3">
            <span className="text-sm text-destructive">{error}</span>
            <Button variant="ghost" size="sm" onClick={fetch}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && (search ? filteredFlat.length === 0 : models.length === 0) && (
        <div className="text-center py-12 text-muted-foreground">
          {search ? "No models match your search." : "No models available."}
        </div>
      )}

      {/* Model cards grid */}
      {!loading && (
        <>
          {search ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredFlat.map((model, i) => (
                <ModelCard key={model.id} model={model} index={i} />
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              {(() => {
                let idx = 0;
                return Object.entries(groups).map(([providerKey, list]) => {
                  if (!list || list.length === 0) return null;
                  const meta = PROVIDER_META[providerKey] ?? { label: providerKey, Icon: Brain };
                  const ProviderIcon = meta.Icon;
                  return (
                    <section key={providerKey} aria-label={`${meta.label} models`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-lg font-semibold text-foreground/90">
                          <ProviderIcon className="size-5" />
                          <span>{meta.label} ({list.length} models)</span>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {list.map((m) => (
                          <ModelCard key={m.id} model={m} index={idx++} />
                        ))}
                      </div>
                    </section>
                  );
                });
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
