"use client";

import { useEffect, useState, useCallback } from "react";
import { useDashboardStore } from "@/stores/dashboard";
import { useUsageStore, type ChartRange } from "@/stores/usage";
import { useConnectionsStore } from "@/stores/connections";
import { PageHeader } from "@/components/PageHeader";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  TrendingUp,
  Cpu,
  CheckCircle,
  Users,
  Clock,
  UserCheck,
  UserX,
  Coins,
  BarChart3,
  Layers,
  Contact,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
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
import { Area, AreaChart, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

function formatPercent(n: number): string {
  return n.toFixed(1) + "%";
}

function formatMs(n: number): string {
  return n.toFixed(0) + "ms";
}

/* ------------------------------------------------------------------ */
/*  Stat Card Data                                                     */
/* ------------------------------------------------------------------ */

interface StatDef {
  title: string;
  desc: string;
  getValue: (u: Record<string, number>, a: Record<string, number>, s: Record<string, unknown>) => string;
  icon: React.ReactNode;
  iconBg: string;
}

const STAT_DEFS: StatDef[] = [
  {
    title: "Total Requests",
    desc: "All time requests",
    getValue: (u, _a, s) => formatNumber(u.totalRequests ?? (s.totalRequests as number) ?? 0),
    icon: <TrendingUp className="h-4 w-4" />,
    iconBg: "bg-blue-500/10 text-blue-500",
  },
  {
    title: "Total Tokens",
    desc: "Tokens processed",
    getValue: (u, _a, s) => formatNumber(u.totalTokens ?? (s.totalTokens as number) ?? 0),
    icon: <Cpu className="h-4 w-4" />,
    iconBg: "bg-violet-500/10 text-violet-500",
  },
  {
    title: "Success Rate",
    desc: "Request success",
    getValue: (u) => formatPercent(u.successRate ?? 0),
    icon: <CheckCircle className="h-4 w-4" />,
    iconBg: "bg-emerald-500/10 text-emerald-500",
  },
  {
    title: "Active Accounts",
    desc: "Connected accounts",
    getValue: (_u, a, s) => String(a.active ?? (s.activeAccounts as number) ?? 0),
    icon: <Users className="h-4 w-4" />,
    iconBg: "bg-pink-500/10 text-pink-500",
  },
  {
    title: "Total Accounts",
    desc: "", // filled dynamically
    getValue: (_u, a) => String(a.total ?? 0),
    icon: <Users className="h-4 w-4" />,
    iconBg: "bg-cyan-500/10 text-cyan-500",
  },
];

/* ------------------------------------------------------------------ */
/*  Chart Range Options                                                */
/* ------------------------------------------------------------------ */

const ACCOUNT_PREVIEW_LIMIT = 10;

function UsageByAccountCard({ data, loading }: { data: Array<Record<string, unknown>>; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? data : data.slice(0, ACCOUNT_PREVIEW_LIMIT);
  const hasMore = data.length > ACCOUNT_PREVIEW_LIMIT;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.8 }}
    >
      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-500">
              <Contact className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <CardTitle>Usage by Account</CardTitle>
                <Badge variant="secondary" className="text-[10px]">{data.length}</Badge>
              </div>
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">Activity breakdown per account</p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className={cn("overflow-x-auto", expanded && "overflow-auto max-h-[500px]")}>
            <Table>
              <TableHeader className={cn(expanded && "sticky top-0 z-10 bg-card")}>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Last Used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                      No data
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((a, i) => (
                    <TableRow key={i}>
                      <TableCell className="max-w-[160px] truncate">
                        {String(a.accountLabel ?? a.label ?? a.account ?? a.email ?? "\u2014")}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber((a.requests as number) ?? 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber((a.totalTokens as number) ?? (a.tokens as number) ?? 0)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {(() => {
                          const ts = Number(a.lastUsed ?? a.lastUsedAt ?? 0);
                          if (!ts) return "\u2014";
                          const d = new Date(ts);
                          return isNaN(d.getTime()) ? "\u2014" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                        })()}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {hasMore && (
            <div className="flex justify-center pt-3 border-t border-border mt-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" />
                    Show top {ACCOUNT_PREVIEW_LIMIT}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3.5 w-3.5" />
                    Show all {data.length} accounts
                  </>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

const RANGES: { label: string; value: ChartRange }[] = [
  { label: "Day", value: "day" },
  { label: "Week", value: "week" },
  { label: "Month", value: "month" },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const { stats, loading: dashLoading, fetch: fetchDash } = useDashboardStore();
  const { chart, chartLoading, fetchChart } = useUsageStore();
  const { fetch: fetchConnections } = useConnectionsStore();

  const [activeRange, setActiveRange] = useState<ChartRange>("day");
  const [creditSummary, setCreditSummary] = useState<Record<string, any> | null>(null);

  /* ---- derived data from the rich API response ---- */
  const usage = ((stats as Record<string, unknown>)?.usage ?? {}) as Record<string, number>;
  const accounts = ((stats as Record<string, unknown>)?.accounts ?? {}) as Record<string, number>;
  const statsRecord = (stats ?? {}) as Record<string, unknown>;

  // Backend returns byModel/byAccount as Record<string, {...}> — convert to arrays
  const byModelRaw = (stats as Record<string, unknown>)?.byModel as
    | Record<string, Record<string, unknown>>
    | Array<Record<string, unknown>>
    | undefined;
  const byAccountRaw = (stats as Record<string, unknown>)?.byAccount as
    | Record<string, Record<string, unknown>>
    | Array<Record<string, unknown>>
    | undefined;

  const byModel: Array<Record<string, unknown>> = Array.isArray(byModelRaw)
    ? byModelRaw
    : byModelRaw
      ? Object.entries(byModelRaw).map(([key, val]) => ({ model: key, ...val }))
      : [];
  const byAccount: Array<Record<string, unknown>> = Array.isArray(byAccountRaw)
    ? byAccountRaw
    : byAccountRaw
      ? Object.entries(byAccountRaw).map(([key, val]) => ({ accountId: key, ...val }))
      : [];

  /* ---- credit stats from server-side summary (all connections, not paginated) ---- */
  const bp = creditSummary?.byProvider ?? {};
  const cb = bp.codebuddy ?? { total: 0, used: 0, remaining: 0, count: 0, active: 0, exhausted: 0 };
  const cl = bp.cline ?? { total: 0, used: 0, remaining: 0, count: 0, active: 0, exhausted: 0 };
  const kr = bp.kiro ?? { total: 0, used: 0, remaining: 0, count: 0, active: 0, exhausted: 0 };

  const cbTotal = cb.total;
  const cbUsed = cb.used;
  const cbRemaining = cb.remaining;
  const cbPercent = cbTotal > 0 ? (cbUsed / cbTotal) * 100 : 0;

  const clTotal = cl.total;
  const clUsed = cl.used;
  const clRemaining = cl.remaining;
  const clPercent = clTotal > 0 ? (clUsed / clTotal) * 100 : 0;

  const totalActive = creditSummary?.activeConnections ?? 0;
  const totalExhausted = cb.exhausted + cl.exhausted + kr.exhausted;

  /* ---- fetch on mount + auto-refresh every 30s ---- */
  const fetchCreditSummary = useCallback(async () => {
    try {
      const { apiFetch } = await import("@/lib/api");
      const data = await apiFetch<Record<string, any>>("/api/connections/credit-summary");
      setCreditSummary(data);
    } catch {}
  }, []);

  const refresh = useCallback(() => {
    fetchDash();
    fetchChart(activeRange);
    fetchConnections();
    fetchCreditSummary();
  }, [fetchDash, fetchChart, fetchConnections, fetchCreditSummary, activeRange]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  /* ---- range change ---- */
  function handleRangeChange(range: ChartRange) {
    setActiveRange(range);
    fetchChart(range);
  }

  /* ---- sorted tables ---- */
  const sortedByModel = [...byModel].sort(
    (a, b) => ((b.requests as number) ?? 0) - ((a.requests as number) ?? 0),
  );
  const sortedByAccount = [...byAccount].sort(
    (a, b) => ((b.requests as number) ?? 0) - ((a.requests as number) ?? 0),
  );

  /* ---- chart: aggregate totals ---- */
  const chartTotalTokens = chart.reduce((sum, b) => sum + (Number(b.tokens) || Number(b.promptTokens || 0) + Number(b.completionTokens || 0)), 0);
  const chartPromptTokens = chart.reduce((sum, b) => sum + (Number(b.promptTokens) || 0), 0);
  const chartCompletionTokens = chart.reduce((sum, b) => sum + (Number(b.completionTokens) || 0), 0);

  /* ---- chart: per-model stacked bar data ---- */
  const MODEL_COLORS = [
    "hsl(35, 92%, 60%)",   // amber
    "hsl(262, 83%, 68%)",  // violet
    "hsl(160, 60%, 50%)",  // emerald
    "hsl(200, 80%, 60%)",  // sky
    "hsl(340, 75%, 60%)",  // rose
    "hsl(45, 90%, 55%)",   // yellow
    "hsl(180, 60%, 50%)",  // teal
    "hsl(280, 60%, 60%)",  // purple
  ];

  // Collect unique models from byModel data or chart
  const knownModels = sortedByModel.map((m) => String(m.model ?? m.name ?? "")).filter(Boolean);

  // Build per-model chart data from raw records if available, otherwise use aggregate
  // For now, use the chart buckets and distribute by model proportions from byModel
  const modelKeys = knownModels.length > 0 ? knownModels.slice(0, 8) : ["tokens"];

  const chartConfig: Record<string, { label: string; color: string }> = {};
  modelKeys.forEach((model, i) => {
    const safeKey = model.replace(/[^a-zA-Z0-9]/g, "-");
    chartConfig[safeKey] = {
      label: model,
      color: MODEL_COLORS[i % MODEL_COLORS.length],
    };
  });

  // Build chart data with per-model breakdown
  const totalModelTokens = sortedByModel.reduce((sum, m) => sum + (Number(m.totalTokens ?? m.tokens ?? 0)), 0);
  const modelProportions = sortedByModel.map((m) => ({
    key: String(m.model ?? m.name ?? "").replace(/[^a-zA-Z0-9]/g, "-"),
    proportion: totalModelTokens > 0 ? (Number(m.totalTokens ?? m.tokens ?? 0)) / totalModelTokens : 0,
  }));

  const chartDataByModel = chart.map((bucket) => {
    const row: Record<string, unknown> = { label: bucket.label };
    const bucketTotal = Number(bucket.tokens) || (Number(bucket.promptTokens || 0) + Number(bucket.completionTokens || 0));

    if (modelProportions.length > 0) {
      modelProportions.forEach(({ key, proportion }) => {
        row[key] = Math.round(bucketTotal * proportion);
      });
    } else {
      row["tokens"] = bucketTotal;
    }
    return row;
  });

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Overview of your Hexos gateway" />

      {/* ---- Stat Cards ---- */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 mb-6">
        {STAT_DEFS.map((stat, index) => (
          <motion.div
            key={stat.title}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
          >
            <Card className="h-full">
              <CardHeader className="flex flex-row items-center justify-between pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {stat.title}
                </CardTitle>
                <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", stat.iconBg)}>
                  {stat.icon}
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">
                  {stat.getValue(usage, accounts, statsRecord)}
                </div>
                {stat.title === "Total Accounts" ? (
                  <p className="text-[10px] text-muted-foreground/70 mt-1">
                    <span className="text-emerald-500">{totalActive} active</span>
                    {" · "}
                    <span className="text-destructive">{totalExhausted} exhausted</span>
                  </p>
                ) : stat.desc ? (
                  <p className="text-[10px] text-muted-foreground/70 mt-1">{stat.desc}</p>
                ) : null}
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* ---- Accounts & Credits ---- */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.55 }}
        className="mb-6"
      >
        {/* Credits by provider — always show all 3 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { key: "cb", label: "CodeBuddy", data: cb, total: cbTotal, used: cbUsed, remaining: cbRemaining, percent: cbPercent, iconBg: "bg-amber-500/10 text-amber-500", barColor: "bg-primary" },
            { key: "cl", label: "Cline", data: cl, total: clTotal, used: clUsed, remaining: clRemaining, percent: clPercent, iconBg: "bg-violet-500/10 text-violet-500", barColor: "bg-violet-500" },
            { key: "kr", label: "Kiro", data: kr, total: kr.total, used: kr.used, remaining: kr.remaining, percent: kr.total > 0 ? (kr.used / kr.total) * 100 : 0, iconBg: "bg-sky-500/10 text-sky-500", barColor: "bg-sky-500" },
          ].map((p) => (
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
                  {p.remaining >= 1000 ? `${(p.remaining / 1000).toFixed(1)}K` : p.remaining.toFixed(1)}{" "}
                  <span className="text-muted-foreground font-normal text-sm">/ {p.total >= 1000 ? `${(p.total / 1000).toFixed(1)}K` : p.total.toFixed(1)}</span>
                </p>
                <div className="w-full h-1.5 bg-muted rounded-full mt-1.5 overflow-hidden">
                  <div className={cn("h-full rounded-full transition-all duration-500", p.percent > 80 ? "bg-destructive" : p.barColor)} style={{ width: `${Math.min(p.percent, 100)}%` }} />
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[10px] text-muted-foreground">{p.remaining >= 1000 ? `${(p.remaining / 1000).toFixed(1)}K` : p.remaining.toFixed(1)} remaining</span>
                  {p.data.exhausted > 0 && (
                    <span className="text-[10px] text-destructive">{p.data.exhausted} exhausted</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </motion.div>

      {/* ---- Token Usage Chart ---- */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
      >
        <Card className="mb-6">
          <div className="flex flex-col gap-4 px-4 pt-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-500">
                  <BarChart3 className="h-4 w-4" />
                </div>
                <div>
                  <CardTitle>
                    {activeRange === "day" ? "Hourly" : "Daily"} Usage
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">Token usage breakdown by model</p>
                </div>
              </div>
              <div className="flex items-center gap-1 rounded-sm bg-muted p-1">
                {RANGES.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => handleRangeChange(r.value)}
                    className="relative rounded-sm px-3 py-1 text-sm font-medium transition-colors"
                  >
                    {activeRange === r.value && (
                      <motion.div
                        layoutId="chart-range-pill"
                        className="absolute inset-0 rounded-sm bg-background shadow-sm ring-1 ring-border"
                        transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
                      />
                    )}
                    <span className={cn(
                      "relative z-10",
                      activeRange === r.value ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}>
                      {r.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Token breakdown */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground font-medium">Total</p>
                <p className="text-2xl font-bold tracking-tight mt-0.5">
                  {formatNumber(chartTotalTokens)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium">Prompt</p>
                <p className="text-2xl font-bold tracking-tight mt-0.5">
                  {formatNumber(chartPromptTokens)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium">Completion</p>
                <p className="text-2xl font-bold tracking-tight mt-0.5">
                  {formatNumber(chartCompletionTokens)}
                </p>
              </div>
            </div>
          </div>

          <CardContent>
            {chartLoading && chart.length === 0 ? (
              <div className="flex h-[300px] items-center justify-center text-muted-foreground">
                Loading chart...
              </div>
            ) : chart.length === 0 ? (
              <div className="flex h-[300px] items-center justify-center text-muted-foreground">
                No chart data available
              </div>
            ) : (
              <ChartContainer config={chartConfig} className="h-[300px] w-full">
                <AreaChart
                  data={chartDataByModel}
                  margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                >
                  <defs>
                    {modelKeys.map((model) => {
                      const safeKey = model.replace(/[^a-zA-Z0-9]/g, "-");
                      return (
                        <linearGradient key={safeKey} id={`fill-${safeKey}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={`var(--color-${safeKey})`} stopOpacity={0.4} />
                          <stop offset="95%" stopColor={`var(--color-${safeKey})`} stopOpacity={0.05} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: number) => formatNumber(v)}
                    width={50}
                  />
                  <ChartTooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const total = payload.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
                      return (
                        <div className="rounded-sm border border-border bg-card px-3 py-2 shadow-md">
                          <p className="text-xs font-medium text-foreground mb-1.5">{label}</p>
                          <div className="flex flex-col gap-1">
                            {payload.map((entry, i) => (
                              <div key={String(entry.dataKey ?? i)} className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                                    style={{ backgroundColor: entry.color }}
                                  />
                                  <span className="text-xs text-muted-foreground">
                                    {chartConfig[String(entry.dataKey)]?.label ?? entry.dataKey}
                                  </span>
                                </div>
                                <span className="text-xs font-mono font-medium text-foreground">
                                  {formatNumber(Number(entry.value) || 0)}
                                </span>
                              </div>
                            ))}
                          </div>
                          <div className="mt-1.5 pt-1.5 border-t border-border flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">Total</span>
                            <span className="text-xs font-mono font-bold text-foreground">
                              {formatNumber(total)}
                            </span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {modelKeys.map((model) => {
                    const safeKey = model.replace(/[^a-zA-Z0-9]/g, "-");
                    return (
                      <Area
                        key={safeKey}
                        type="monotone"
                        dataKey={safeKey}
                        stackId="a"
                        stroke={`var(--color-${safeKey})`}
                        fill={`url(#fill-${safeKey})`}
                        strokeWidth={2}
                      />
                    );
                  })}
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ---- Tables Row ---- */}
      <div className="grid gap-6 lg:grid-cols-2 min-w-0">
        {/* Usage by Model */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
        >
          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-500">
                  <Layers className="h-4 w-4" />
                </div>
                <div>
                  <CardTitle>Usage by Model</CardTitle>
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">Requests and token usage per model</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashLoading && sortedByModel.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                        Loading...
                      </TableCell>
                    </TableRow>
                  ) : sortedByModel.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                        No data
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedByModel.map((m, i) => {
                      const modelName = String(m.model ?? m.name ?? "");
                      const safeKey = modelName.replace(/[^a-zA-Z0-9]/g, "-");
                      const color = chartConfig[safeKey]?.color ?? MODEL_COLORS[i % MODEL_COLORS.length];
                      return (
                        <TableRow key={i}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span
                                className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: color }}
                              />
                              <span className="font-mono text-xs">{modelName || "\u2014"}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber((m.requests as number) ?? 0)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber((m.totalTokens as number) ?? (m.tokens as number) ?? 0)}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Usage by Account */}
        <UsageByAccountCard
          data={sortedByAccount}
          loading={dashLoading}
        />
      </div>
    </>
  );
}
