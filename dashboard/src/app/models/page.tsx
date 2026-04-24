"use client";

import { useEffect, useState, useCallback } from "react";
import { useModelsStore, type Model } from "@/stores/models";
import { Search, Copy, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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

  const contextWindow = formatContextWindow(model.contextWindow);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.04 }}
    >
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="font-semibold">{model.name}</CardTitle>
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
        <CardContent className="flex flex-col gap-3">
          <code className="rounded bg-muted px-2 py-1 text-sm font-mono text-muted-foreground w-fit">
            {model.id}
          </code>

          <div className="flex flex-col gap-1 text-sm text-muted-foreground">
            {model.provider && (
              <div>
                <span className="font-medium text-foreground/50">
                  Provider:
                </span>{" "}
                {model.provider}
              </div>
            )}
            {/* {model.upstreamModel != null && (
              <div>
                <span className="font-medium text-foreground/50">
                  Upstream:
                </span>{" "}
                <span>{String(model.upstreamModel)}</span>
              </div>
            )} */}
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

  const filtered = models.filter((m) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      (m.provider && m.provider.toLowerCase().includes(q))
    );
  });

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
      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          {search ? "No models match your search." : "No models available."}
        </div>
      )}

      {/* Model cards grid */}
      {!loading && filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((model, i) => (
            <ModelCard key={model.id} model={model} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
