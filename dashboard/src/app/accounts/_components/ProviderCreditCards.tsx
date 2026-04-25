"use client";

import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Coins } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export function ProviderCreditCards({
  creditByProvider,
}: {
  creditByProvider: Record<string, { total: number; used: number; remaining: number; count: number; active: number; exhausted: number }>;
}) {
  const items = [
    {
      key: "cb",
      label: "Code Buddy",
      data: creditByProvider["codebuddy"] ?? creditByProvider["Service"] ?? { total: 0, used: 0, remaining: 0, count: 0, active: 0, exhausted: 0 },
      iconBg: "bg-amber-500/10 text-amber-500",
      barColor: "bg-primary",
    },
    {
      key: "cl",
      label: "Cline",
      data: creditByProvider["cline"] ?? { total: 0, used: 0, remaining: 0, count: 0, active: 0, exhausted: 0 },
      iconBg: "bg-violet-500/10 text-violet-500",
      barColor: "bg-violet-500",
    },
    {
      key: "kr",
      label: "Kiro",
      data: creditByProvider["kiro"] ?? { total: 0, used: 0, remaining: 0, count: 0, active: 0, exhausted: 0 },
      iconBg: "bg-sky-500/10 text-sky-500",
      barColor: "bg-sky-500",
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 }}
      className="mb-6"
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {items.map((p) => {
          const percent = p.data.total > 0 ? (p.data.used / p.data.total) * 100 : 0;
          return (
            <Card key={p.key}>
              <CardContent className="pt-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", p.iconBg)}>
                    <Coins className="h-3.5 w-3.5" />
                  </div>
                  <p className="text-xs font-medium text-muted-foreground">{p.label} Credits</p>
                  <span className="ml-auto text-[10px] text-muted-foreground">{p.data.count} accs</span>
                </div>
                <p className="text-lg font-bold">
                  {p.data.remaining >= 1000 ? `${(p.data.remaining / 1000).toFixed(1)}K` : p.data.remaining.toFixed(1)}
                  <span className="text-muted-foreground font-normal text-sm"> / {p.data.total >= 1000 ? `${(p.data.total / 1000).toFixed(1)}K` : p.data.total.toFixed(1)}</span>
                </p>
                <div className="w-full h-1.5 bg-muted rounded-full mt-1.5 overflow-hidden">
                  <div className={cn("h-full rounded-full transition-all duration-500", percent > 80 ? "bg-high-impact" : p.barColor)} style={{ width: `${Math.min(percent, 100)}%` }} />
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[10px] text-muted-foreground">{p.data.remaining >= 1000 ? `${(p.data.remaining / 1000).toFixed(1)}K` : p.data.remaining.toFixed(1)} remaining</span>
                  {p.data.exhausted > 0 && (
                    <span className="text-[10px] text-high-impact">{p.data.exhausted} exhausted</span>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </motion.div>
  );
}
