"use client";

import { useEffect, useState } from "react";
import { useKeysStore } from "@/stores/keys";
import { Eye, EyeOff, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { copyText } from "@/lib/utils";

function copyToClipboard(text: string, label = "Copied to clipboard") {
  copyText(text).then(() => toast.success(label)).catch(() => toast.error("Failed to copy"));
}

export default function ApiKeyPage() {
  const { keys, loading, error, fetch } = useKeysStore();
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch();
  }, [fetch]);

  const toggleReveal = (key: string) =>
    setRevealed((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">API Key</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          View and copy your Hexos proxy API keys
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {loading && (
          <div className="flex justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="rounded-sm border border-destructive/50 px-4 py-3">
            <span className="text-sm text-destructive">{error}</span>
          </div>
        )}

        {!loading && !error && keys.length === 0 && (
          <div className="rounded-sm border border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No API keys found.
          </div>
        )}

        {keys.map((k, i) => {
          const isRevealed = revealed[k.key] ?? false;
          const displayValue = isRevealed ? k.key : k.masked;

          return (
            <motion.div
              key={k.key}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              className="rounded-sm border border-border bg-card p-4"
            >
              {k.name && (
                <p className="text-sm font-semibold text-muted-foreground mb-2">
                  {k.name}
                </p>
              )}
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-sm border border-border bg-muted/50 px-3 py-2 font-mono text-sm select-all truncate">
                  {displayValue}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => toggleReveal(k.key)}
                  aria-label={isRevealed ? "Hide key" : "Reveal key"}
                >
                  {isRevealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
                <Button
                  variant="default"
                  size="icon"
                  onClick={() => copyToClipboard(k.key, "API key copied")}
                  aria-label="Copy key"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="my-8 h-px bg-border" />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.15 }}
        className="rounded-sm border border-border bg-card p-4"
      >
        <p className="text-sm font-medium mb-3">Usage</p>
        <p className="text-sm text-muted-foreground mb-4">
          Use this key to authenticate requests to the Hexos proxy. Include
          it in the{" "}
          <Badge variant="outline" className="text-xs font-mono">
            Authorization
          </Badge>{" "}
          header of every request.
        </p>

        <div className="flex flex-col gap-4">
          <div>
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              Example Header
            </span>
            <div className="flex items-center gap-2 mt-1">
              <span className="flex-1 rounded-sm border border-border bg-muted/50 px-3 py-2 font-mono text-sm select-all truncate">
                Authorization: Bearer &lt;your-key&gt;
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard("Authorization: Bearer <your-key>", "Header example copied")}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>

          <div>
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              Proxy Base URL
            </span>
            <div className="flex items-center gap-2 mt-1">
              <span className="flex-1 rounded-sm border border-border bg-muted/50 px-3 py-2 font-mono text-sm select-all truncate">
                http://127.0.0.1:7470/v1
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard("http://127.0.0.1:7470/v1", "Base URL copied")}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
