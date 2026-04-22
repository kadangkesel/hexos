"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useIntegrationsStore, type Integration, type ModelSlot } from "@/stores/integrations";
import { useModelsStore } from "@/stores/models";
import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CodeTabs } from "@/components/animate-ui/components/animate/code-tabs";
import {
  Terminal,
  Code,
  Cpu,
  MousePointer,
  Compass,
  AppWindow,
  Plug,
  Copy,
  FileCode,
  Loader2,
  SquareTerminal,
  Cat,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Checkbox, CheckboxIndicator } from "@/components/animate-ui/primitives/base/checkbox";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Icon / color mapping                                               */
/* ------------------------------------------------------------------ */

const iconMap: Record<string, LucideIcon> = {
  terminal: Terminal, code: Code, cpu: Cpu,
  "mouse-pointer": MousePointer, compass: Compass,
  "app-window": AppWindow, "square-terminal": SquareTerminal,
  cat: Cat, zap: Zap,
};
function getIcon(name: string): LucideIcon { return iconMap[name] ?? Plug; }

const iconColors: Record<string, string> = {
  claude: "bg-orange-500/15 text-orange-500",
  opencode: "bg-blue-500/15 text-blue-500",
  openclaw: "bg-purple-500/15 text-purple-500",
  cline: "bg-emerald-500/15 text-emerald-500",
  hermes: "bg-cyan-500/15 text-cyan-500",
};

function copyToClipboard(text: string, label = "Copied") {
  navigator.clipboard.writeText(text).then(() => toast.success(label));
}

/* ------------------------------------------------------------------ */
/*  Helpers: model ID format                                           */
/* ------------------------------------------------------------------ */

// All tools use cb/ or cl/ prefix - no stripping needed
function getProviderTag(id: string): string {
  if (id.startsWith("cl/")) return "Cline";
  return "CodeBuddy";
}

/* ------------------------------------------------------------------ */
/*  Tabs                                                               */
/* ------------------------------------------------------------------ */

const TABS = [
  { value: "auto", label: "Auto Bind" },
  { value: "manual", label: "Manual Config" },
] as const;
type TabValue = (typeof TABS)[number]["value"];

/* ------------------------------------------------------------------ */
/*  Model Slot Selector                                                */
/* ------------------------------------------------------------------ */

function SlotSelector({
  slot,
  value,
  onChange,
  toolId,
}: {
  slot: ModelSlot;
  value: string;
  onChange: (v: string) => void;
  toolId: string;
}) {
  const { models } = useModelsStore();
  const options = models.map((m) => {
    const provider = getProviderTag(m.id);
    return { value: m.id, label: m.name, provider };
  });

  // Sort: CodeBuddy first, then Cline
  options.sort((a, b) => {
    if (a.provider === b.provider) return 0;
    return a.provider === "CodeBuddy" ? -1 : 1;
  });

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-medium text-muted-foreground w-32 shrink-0 truncate" title={slot.key}>
        {slot.label}
      </span>
      <Select value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger className="h-7 text-xs flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              <span className="flex items-center gap-1.5">
                {o.label}
                <span className={`text-[9px] px-1 py-0.5 rounded-sm leading-none ${o.provider === "Cline" ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}`}>
                  {o.provider}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Hook: per-tool model map state                                     */
/* ------------------------------------------------------------------ */

function useModelMap(slots?: ModelSlot[]) {
  const [map, setMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!slots) return;
    const initial: Record<string, string> = {};
    for (const s of slots) initial[s.key] = s.default;
    setMap(initial);
  }, [slots]);

  const setSlot = useCallback((key: string, value: string) => {
    setMap((prev) => ({ ...prev, [key]: value }));
  }, []);

  return { map, setSlot };
}

/* ------------------------------------------------------------------ */
/*  Integration Card (Auto Bind tab)                                   */
/* ------------------------------------------------------------------ */

function IntegrationCard({ integration, index }: { integration: Integration; index: number }) {
  const { bind, bindingId } = useIntegrationsStore();
  const { models } = useModelsStore();
  const Icon = getIcon(integration.icon);
  const isBusy = bindingId === integration.id;
  const { map, setSlot } = useModelMap(integration.modelSlots);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(() => new Set(models.map((m) => m.id)));

  // Sync selectedModels when models load
  useEffect(() => {
    if (models.length > 0 && selectedModels.size === 0) {
      setSelectedModels(new Set(models.map((m) => m.id)));
    }
  }, [models, selectedModels.size]);

  const toggleModel = (id: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBind = async () => {
    const bindMap = { ...map };
    if (integration.showModelCheckboxes) {
      bindMap["_selectedModels"] = Array.from(selectedModels).join(",");
    }
    const ok = await bind(integration.id, Object.keys(bindMap).length > 0 ? bindMap : undefined);
    toast[ok ? "success" : "error"](ok ? `${integration.name} bound` : `Failed to bind ${integration.name}`);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.08 }}
    >
      <Card className="flex flex-col h-full">
        <CardHeader className="flex flex-row items-start gap-3">
          <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", iconColors[integration.id] ?? "bg-muted text-muted-foreground")}>
            <Icon className="size-4.5" />
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle>{integration.name}</CardTitle>
            <CardDescription>{integration.description}</CardDescription>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-3 flex-1">
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={integration.installed ? "default" : "secondary"} className={integration.installed ? "bg-green-500/15 text-green-600 dark:text-green-400" : ""}>
              {integration.installed ? "Installed" : "Not Found"}
            </Badge>
            <Badge variant={integration.bound ? "default" : "secondary"} className={integration.bound ? "bg-green-500/15 text-green-600 dark:text-green-400" : ""}>
              {integration.bound ? "Connected" : "Not Connected"}
            </Badge>
          </div>

          {integration.configPath && (
            <div className="flex items-center gap-2">
              <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-mono text-xs text-muted-foreground truncate">{integration.configPath}</span>
            </div>
          )}

          {integration.modelSlots && integration.modelSlots.length > 0 && (
            <div className="flex flex-col gap-2 mt-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Model Mapping</span>
              {integration.modelSlots.map((slot) => (
                <SlotSelector
                  key={slot.key}
                  slot={slot}
                  toolId={integration.id}
                  value={map[slot.key] ?? slot.default}
                  onChange={(v) => setSlot(slot.key, v)}
                />
              ))}
            </div>
          )}

          {integration.showModelCheckboxes && models.length > 0 && (
            <div className="flex flex-col gap-2 mt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Models to Include</span>
                <div className="flex gap-2">
                  <button className="text-[10px] text-primary hover:underline" onClick={() => setSelectedModels(new Set(models.map((m) => m.id)))}>All</button>
                  <button className="text-[10px] text-primary hover:underline" onClick={() => setSelectedModels(new Set())}>None</button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-[200px] overflow-y-auto">
                {models.map((m) => {
                  const provider = getProviderTag(m.id);
                  return (
                    <div key={m.id} className="flex items-center gap-1.5 text-xs py-0.5">
                      <Checkbox
                        checked={selectedModels.has(m.id)}
                        onCheckedChange={(checked) => {
                          if (checked) setSelectedModels((p) => new Set([...p, m.id]));
                          else setSelectedModels((p) => { const n = new Set(p); n.delete(m.id); return n; });
                        }}
                        className="size-4 shrink-0"
                      >
                        {selectedModels.has(m.id) && <CheckboxIndicator className="size-3" />}
                      </Checkbox>
                      <span className="truncate cursor-pointer" onClick={() => toggleModel(m.id)}>{m.name}</span>
                      <span className={`text-[8px] px-0.5 rounded-sm leading-none shrink-0 ${provider === "Cline" ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}`}>
                        {provider === "Cline" ? "CL" : "CB"}
                      </span>
                    </div>
                  );
                })}
              </div>
              <span className="text-[10px] text-muted-foreground">{selectedModels.size} of {models.length} selected</span>
            </div>
          )}

          {integration.configType === "guide" && integration.guideSteps && (
            <div className="flex flex-col gap-2 mt-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Setup Steps</span>
              <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                {integration.guideSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </CardContent>

        {integration.configType !== "guide" && (
          <CardFooter>
            <Button size="sm" disabled={isBusy || !!bindingId} onClick={handleBind}>
              {isBusy && <Loader2 className="animate-spin" />}
              {integration.bound ? "Re-bind" : "Bind"}
            </Button>
          </CardFooter>
        )}
      </Card>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Manual Config Panel                                                */
/* ------------------------------------------------------------------ */

function ManualConfigPanel() {
  const { integrations, generateConfig } = useIntegrationsStore();
  const configurableTools = useMemo(() => integrations.filter((i) => i.configType !== "guide"), [integrations]);

  const [selectedTool, setSelectedTool] = useState("");
  const [configCodes, setConfigCodes] = useState<Record<string, string> | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(false);

  const currentTool = configurableTools.find((t) => t.id === selectedTool);
  const { map, setSlot } = useModelMap(currentTool?.modelSlots);

  useEffect(() => {
    if (!selectedTool && configurableTools.length > 0) {
      setSelectedTool(configurableTools[0].id);
    }
  }, [configurableTools, selectedTool]);

  useEffect(() => {
    if (!selectedTool) return;
    let cancelled = false;
    setLoading(true);

    const mm = Object.keys(map).length > 0 ? map : undefined;
    generateConfig(selectedTool, mm).then((result) => {
      if (cancelled) return;
      if (result?.config) {
        const filename = currentTool?.configPath.split(/[/\\]/).pop() ?? "config.json";
        setConfigCodes({ [filename]: JSON.stringify(result.config, null, 2) });
        setConfigPath(result.configPath);
      } else {
        setConfigCodes(null);
        setConfigPath("");
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [selectedTool, map, generateConfig, currentTool?.configPath]);

  if (configurableTools.length === 0) {
    return <div className="text-center py-12 text-muted-foreground">No configurable tools available.</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">Tool:</span>
        <Select value={selectedTool} onValueChange={(v) => v && setSelectedTool(v)}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Select tool" />
          </SelectTrigger>
          <SelectContent>
            {configurableTools.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {currentTool?.modelSlots && currentTool.modelSlots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Model Mapping</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {currentTool.modelSlots.map((slot) => (
              <SlotSelector
                key={slot.key}
                slot={slot}
                toolId={currentTool.id}
                value={map[slot.key] ?? slot.default}
                onChange={(v) => setSlot(slot.key, v)}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : configCodes ? (
        <div className="flex flex-col gap-3">
          <CodeTabs codes={configCodes} lang="json" />
          {configPath && (
            <div className="flex items-center gap-2">
              <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-mono text-xs text-muted-foreground truncate">{configPath}</span>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={() => copyToClipboard(configPath, "Path copied")}>
                <Copy className="size-3" />
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-12 text-muted-foreground">No config available.</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function IntegrationPage() {
  const { integrations, loading, error, fetch: fetchIntegrations } = useIntegrationsStore();
  const { fetch: fetchModels } = useModelsStore();
  const [activeTab, setActiveTab] = useState<TabValue>("auto");

  useEffect(() => {
    fetchIntegrations();
    fetchModels();
  }, [fetchIntegrations, fetchModels]);

  return (
    <>
      <PageHeader title="Integration" subtitle="Auto-bind Hexos to your AI coding tools" />

      <div className="mb-6">
        <div className="flex items-center gap-1 rounded-sm bg-muted p-1 w-fit">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className="relative rounded-sm px-3 py-1 text-sm font-medium transition-colors"
            >
              {activeTab === tab.value && (
                <motion.div
                  layoutId="integration-tab-pill"
                  className="absolute inset-0 rounded-sm bg-background shadow-sm ring-1 ring-border"
                  transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
                />
              )}
              <span className={cn("relative z-10", activeTab === tab.value ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {tab.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="pt-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {!loading && !error && (
        <AnimatePresence mode="wait">
          {activeTab === "auto" ? (
            <motion.div key="auto" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
              {integrations.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">No integrations available.</div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {integrations.map((integration, i) => (
                    <IntegrationCard key={integration.id} integration={integration} index={i} />
                  ))}
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div key="manual" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
              <ManualConfigPanel />
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </>
  );
}
