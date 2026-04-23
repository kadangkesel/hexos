"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Copy,
  Rocket,
  Terminal,
  FileText,
  Globe,
  BookOpen,
  Zap,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CodeTabs } from "@/components/animate-ui/components/animate/code-tabs";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(() => toast.success("Copied"));
}

function CodeBlock({ code, label, lang }: { code: string; label?: string; lang?: string }) {
  return (
    <div className="my-3">
      <CodeTabs
        codes={{ [label || "shell"]: code }}
        lang={lang || "bash"}
      />
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-muted px-1.5 py-0.5 rounded-sm font-mono text-[13px]">
      {children}
    </code>
  );
}

function Endpoint({ method, path }: { method: string; path: string }) {
  return (
    <div className="flex items-center gap-2 my-2">
      <Badge variant={method === "POST" ? "default" : "secondary"} className="text-xs">
        {method}
      </Badge>
      <code className="font-mono text-sm font-medium">{path}</code>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Docs sections                                                      */
/* ------------------------------------------------------------------ */

interface DocSection {
  id: string;
  title: string;
  icon: React.ReactNode;
  headings?: { id: string; title: string }[];
}

const SECTIONS: DocSection[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    icon: <Rocket className="size-4" />,
    headings: [
      { id: "what-is-hexos", title: "What is Hexos?" },
      { id: "install", title: "Install" },
      { id: "quick-setup", title: "Quick Setup" },
    ],
  },
  {
    id: "cli-commands",
    title: "CLI Commands",
    icon: <Terminal className="size-4" />,
    headings: [
      { id: "server-commands", title: "Server" },
      { id: "auth-commands", title: "Authentication" },
      { id: "key-commands", title: "API Keys" },
      { id: "usage-commands", title: "Usage" },
      { id: "system-commands", title: "System" },
    ],
  },
  {
    id: "account-format",
    title: "Account File Format",
    icon: <FileText className="size-4" />,
  },
  {
    id: "api-reference",
    title: "API Reference",
    icon: <Globe className="size-4" />,
    headings: [
      { id: "chat-completions", title: "Chat Completions" },
      { id: "messages-api", title: "Messages API" },
      { id: "list-models", title: "List Models" },
      { id: "health-check", title: "Health Check" },
      { id: "usage-stats", title: "Usage Stats" },
      { id: "usage-records", title: "Usage Records" },
    ],
  },
  {
    id: "model-aliases",
    title: "Model Aliases",
    icon: <BookOpen className="size-4" />,
    headings: [
      { id: "alias-mapping", title: "Alias Mapping" },
      { id: "available-models", title: "Available Models" },
      { id: "claude-code-config", title: "Claude Code Config" },
      { id: "opencode-config", title: "OpenCode Config" },
    ],
  },
  {
    id: "load-balancing",
    title: "Load Balancing",
    icon: <Zap className="size-4" />,
    headings: [
      { id: "strategy", title: "Strategy" },
      { id: "failover", title: "Failover" },
      { id: "credit-detection", title: "Credit Detection" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Active section tracking                                            */
/* ------------------------------------------------------------------ */

function useActiveSection() {
  const [active, setActive] = useState("getting-started");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 }
    );

    const headings = document.querySelectorAll("[data-docs-heading]");
    headings.forEach((h) => observer.observe(h));

    return () => observer.disconnect();
  }, []);

  return active;
}



/* ------------------------------------------------------------------ */
/*  Right TOC                                                          */
/* ------------------------------------------------------------------ */

function DocsToC({ active }: { active: string }) {
  const allHeadings = SECTIONS.flatMap((s) => [
    { id: s.id, title: s.title, level: 0 },
    ...(s.headings?.map((h) => ({ id: h.id, title: h.title, level: 1 })) ?? []),
  ]);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav className="hidden xl:block w-48 shrink-0 fixed right-6 top-20 h-[calc(100vh-6rem)] overflow-y-auto">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        On this page
      </p>
      <ul className="flex flex-col gap-0.5">
        {allHeadings.map((h) => (
          <li key={h.id}>
            <button
              onClick={() => scrollTo(h.id)}
              className={cn(
                "w-full text-left text-xs py-1 transition-colors",
                h.level === 1 ? "pl-3" : "pl-0",
                active === h.id
                  ? "text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {h.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/*  Section heading                                                    */
/* ------------------------------------------------------------------ */

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      data-docs-heading
      className="text-xl font-bold tracking-tight scroll-mt-20 mt-12 mb-4 first:mt-0 flex items-center gap-2"
    >
      {children}
    </h2>
  );
}

function H3({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3
      id={id}
      data-docs-heading
      className="text-base font-semibold tracking-tight scroll-mt-20 mt-8 mb-3"
    >
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground leading-relaxed mb-3">{children}</p>;
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function DocsPage() {
  const active = useActiveSection();

  return (
    <div>
      {/* Main content */}
      <article className="max-w-3xl xl:mr-56">

        {/* ---- Getting Started ---- */}
        <H2 id="getting-started">
          <Rocket className="size-5 text-primary" />
          Getting Started
        </H2>

        <H3 id="what-is-hexos">What is Hexos?</H3>
        <P>
          Hexos is an AI API proxy with multi-account management and load balancing.
          It routes requests through multiple provider accounts using a least-used strategy,
          supports both OpenAI and Anthropic API formats, tracks token usage,
          and automatically fails over when accounts are rate-limited or exhausted.
        </P>

        <H3 id="install">Install</H3>
        <div className="flex flex-col gap-3 mb-4">
          <div>
            <span className="text-sm font-medium text-muted-foreground">Linux / macOS</span>
            <CodeBlock code="curl -fsSL https://hexos.kadangkesel.net/install | bash" label="terminal" lang="bash" />
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground">Windows (PowerShell)</span>
            <CodeBlock code="irm https://hexos.kadangkesel.net/install.ps1 | iex" label="powershell" lang="powershell" />
          </div>
        </div>

        <H3 id="quick-setup">Quick Setup</H3>
        <div className="flex flex-col gap-3 mb-6">
          {[
            { step: "1", title: "Start server", code: "hexos start" },
            { step: "2", title: "Create API key", code: "hexos key create" },
            { step: "3", title: "Add accounts", code: "hexos auth batch-connect --file accounts.txt" },
            { step: "4", title: "Open dashboard", desc: "Visit http://localhost:7470 — dashboard is built-in." },
            { step: "5", title: "Configure tool", desc: "Go to Integration page to auto-bind, or set proxy URL and API key manually." },
          ].map((s) => (
            <div key={s.step} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold mt-0.5">
                {s.step}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">{s.title}</span>
                {s.code && <CodeBlock code={s.code} label="terminal" lang="bash" />}
                {s.desc && <p className="text-sm text-muted-foreground mt-1">{s.desc}</p>}
              </div>
            </div>
          ))}
        </div>

        {/* ---- CLI Commands ---- */}
        <H2 id="cli-commands">
          <Terminal className="size-5 text-primary" />
          CLI Commands
        </H2>

        {[
          {
            id: "server-commands", title: "Server", cmds: [
              ["hexos start", "Start proxy (default 127.0.0.1:7470)"],
              ["hexos start -p 3001 --host 0.0.0.0", "Custom port and host"],
            ],
          },
          {
            id: "auth-commands", title: "Authentication", cmds: [
              ["hexos auth connect codebuddy", "Manual OAuth device-code flow"],
              ["hexos auth auto-connect --email <e> --password <p>", "Automated browser login"],
              ["hexos auth batch-connect --file accounts.txt", "Batch connect from file"],
              ["hexos auth batch-connect --file accounts.txt --concurrency 4", "Batch with concurrency"],
              ["hexos auth list", "List all accounts with status"],
              ["hexos auth status", "Check token validity + credits"],
              ["hexos auth remove <id>", "Remove account"],
              ["hexos auth setup-automation", "Setup Python automation deps"],
            ],
          },
          {
            id: "key-commands", title: "API Keys", cmds: [
              ["hexos key create", "Generate new API key"],
              ["hexos key list", "List all keys"],
            ],
          },
          {
            id: "usage-commands", title: "Usage", cmds: [
              ["hexos usage stats", "Aggregate statistics"],
              ["hexos usage stats --today", "Today only"],
              ["hexos usage log", "Recent records"],
              ["hexos usage log -n 100 --model claude-opus-4.6", "Filtered log"],
            ],
          },
          {
            id: "system-commands", title: "System", cmds: [
              ["hexos update", "Update to latest version"],
              ["hexos uninstall", "Uninstall hexos (preserves data)"],
              ["hexos --version", "Show current version"],
            ],
          },
        ].map((group) => (
          <div key={group.id}>
            <H3 id={group.id}>{group.title}</H3>
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm">
                <tbody>
                  {group.cmds.map(([cmd, desc]) => (
                    <tr key={cmd} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <InlineCode>{cmd}</InlineCode>
                      </td>
                      <td className="py-2 text-muted-foreground text-xs">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {/* ---- Account File Format ---- */}
        <H2 id="account-format">
          <FileText className="size-5 text-primary" />
          Account File Format
        </H2>
        <P>
          One account per line. Supported delimiters:{" "}
          {["|", ":", ";", "tab"].map((d) => (
            <Badge key={d} variant="outline" className="font-mono mx-0.5 text-xs">{d}</Badge>
          ))}
          . Optional third field for label.
        </P>
        <CodeBlock code={`# Comments start with #
user1@gmail.com|password123
user2@gmail.com:password456
user3@gmail.com|password789|My Custom Label`} label="accounts.txt" lang="text" />

        {/* ---- API Reference ---- */}
        <H2 id="api-reference">
          <Globe className="size-5 text-primary" />
          API Reference
        </H2>
        <P>
          Base URL: <InlineCode>http://127.0.0.1:7470</InlineCode> — All{" "}
          <InlineCode>/v1/*</InlineCode> endpoints require{" "}
          <InlineCode>Authorization: Bearer &lt;key&gt;</InlineCode>
        </P>

        {/* Chat Completions */}
        <H3 id="chat-completions">Chat Completions</H3>
        <Endpoint method="POST" path="/v1/chat/completions" />
        <P>OpenAI-compatible chat completions. Always streams. For OpenCode, Hermes, and OpenAI-format tools.</P>
        <CodeBlock code={`curl http://127.0.0.1:7470/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <your-api-key>" \\
  -d '{
    "model": "cb/claude-opus-4.6",
    "stream": true,
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'`} label="curl" lang="bash" />
        <p className="text-xs font-medium text-muted-foreground mb-1">Response (SSE)</p>
        <CodeBlock code={`data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":25,"completion_tokens":10}}
data: [DONE]`} label="response" lang="text" />

        {/* Messages API */}
        <H3 id="messages-api">Messages API</H3>
        <Endpoint method="POST" path="/v1/messages" />
        <P>Anthropic Messages format. Hexos translates to OpenAI upstream and converts back. For Claude Code and OpenClaw.</P>
        <CodeBlock code={`curl http://127.0.0.1:7470/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: <your-api-key>" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Explain recursion briefly."}
    ]
  }'`} label="curl" lang="bash" />
        <p className="text-xs font-medium text-muted-foreground mb-1">Response (SSE)</p>
        <CodeBlock code={`event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","role":"assistant"}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Recursion is..."}}

event: message_stop
data: {"type":"message_stop"}`} label="response" lang="text" />

        {/* List Models */}
        <H3 id="list-models">List Models</H3>
        <Endpoint method="GET" path="/v1/models" />
        <CodeBlock code={`curl http://127.0.0.1:7470/v1/models -H "Authorization: Bearer <key>"`} label="curl" lang="bash" />
        <CodeBlock code={`{
  "object": "list",
  "data": [
    {"id": "cb/claude-opus-4.6", "object": "model", "owned_by": "hexos"},
    {"id": "cb/claude-haiku-4.5", "object": "model", "owned_by": "hexos"},
    {"id": "cb/gpt-5.4", "object": "model", "owned_by": "hexos"}
  ]
}`} label="response" lang="json" />

        {/* Health */}
        <H3 id="health-check">Health Check</H3>
        <Endpoint method="GET" path="/health" />
        <P>No authentication required.</P>
        <CodeBlock code={`curl http://127.0.0.1:7470/health`} label="curl" lang="bash" />
        <CodeBlock code={`{"status":"ok","connections":9,"totalRequests":42,"totalTokens":1250000}`} label="response" lang="json" />

        {/* Usage Stats */}
        <H3 id="usage-stats">Usage Stats</H3>
        <Endpoint method="GET" path="/v1/usage/stats" />
        <P>Aggregate statistics. Optional <InlineCode>?since=</InlineCode> timestamp (ms).</P>
        <CodeBlock code={`curl "http://127.0.0.1:7470/v1/usage/stats" -H "Authorization: Bearer <key>"`} label="curl" lang="bash" />
        <CodeBlock code={`{
  "totalRequests": 42,
  "totalPromptTokens": 1200000,
  "totalCompletionTokens": 50000,
  "totalTokens": 1250000,
  "avgLatencyMs": 3500,
  "successRate": 95.2,
  "byModel": { "claude-opus-4.6": { "requests": 30, "totalTokens": 940000 } },
  "byAccount": { "uuid": { "accountLabel": "user@gmail.com", "requests": 15 } }
}`} label="response" lang="json" />

        {/* Usage Records */}
        <H3 id="usage-records">Usage Records</H3>
        <Endpoint method="GET" path="/v1/usage/records" />
        <P>
          Query params: <InlineCode>limit</InlineCode>, <InlineCode>model</InlineCode>,{" "}
          <InlineCode>accountId</InlineCode>, <InlineCode>since</InlineCode>
        </P>
        <CodeBlock code={`curl "http://127.0.0.1:7470/v1/usage/records?limit=5&model=claude-opus-4.6" \\
  -H "Authorization: Bearer <key>"`} label="curl" lang="bash" />
        <CodeBlock code={`[{
  "id": "rec_abc",
  "timestamp": 1713700000000,
  "model": "claude-opus-4.6",
  "accountLabel": "user@gmail.com",
  "endpoint": "/v1/chat/completions",
  "promptTokens": 24335,
  "completionTokens": 61,
  "totalTokens": 24396,
  "latencyMs": 3892,
  "success": true
}]`} label="response" lang="json" />

        {/* ---- Model Aliases ---- */}
        <H2 id="model-aliases">
          <BookOpen className="size-5 text-primary" />
          Model Aliases
        </H2>

        <H3 id="alias-mapping">Alias Mapping</H3>
        <P>Hexos maps Anthropic model names to upstream models. Use either the <InlineCode>cb/</InlineCode> prefixed ID or the standard name.</P>
        <div className="overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 pr-4 font-medium text-muted-foreground text-xs">Input</th>
                <th className="text-left py-2 font-medium text-muted-foreground text-xs">Routes To</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["claude-opus-4-6, claude-opus-4-5, claude-opus-4", "cb/claude-opus-4.6"],
                ["claude-sonnet-4-6, claude-sonnet-4-5, claude-sonnet-4", "cb/claude-opus-4.6"],
                ["claude-haiku-4-5, claude-haiku-4", "cb/claude-haiku-4.5"],
              ].map(([input, output]) => (
                <tr key={input} className="border-b last:border-0">
                  <td className="py-2 pr-4"><InlineCode>{input}</InlineCode></td>
                  <td className="py-2"><span className="bg-primary/10 text-primary rounded-sm px-1.5 py-0.5 font-mono text-xs">{output}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <H3 id="available-models">Available Models</H3>
        <div className="flex flex-wrap gap-1.5 mb-6">
          {["cb/claude-opus-4.6", "cb/claude-haiku-4.5", "cb/gpt-5.4", "cb/gpt-5.2", "cb/gpt-5.1", "cb/gemini-2.5-pro", "cb/gemini-2.5-flash", "cb/gemini-3.1-pro", "cb/gemini-3.0-flash", "cb/kimi-k2.5", "cb/glm-5.0"].map((m) => (
            <Badge key={m} variant="outline" className="font-mono text-xs">{m}</Badge>
          ))}
        </div>

        <H3 id="claude-code-config">Claude Code Config</H3>
        <P>Claude Code uses Anthropic format — model names <strong>without</strong> <InlineCode>cb/</InlineCode> prefix:</P>
        <CodeBlock code={`// ~/.claude/settings.json
{
  "model": "claude-opus-4.6",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:7470/v1",
    "ANTHROPIC_AUTH_TOKEN": "<your-api-key>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4.6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-haiku-4.5",
    "API_TIMEOUT_MS": "3000000"
  }
}`} label="settings.json" lang="json" />

        <H3 id="opencode-config">OpenCode Config</H3>
        <P>OpenCode uses OpenAI format — model names <strong>with</strong> <InlineCode>cb/</InlineCode> prefix:</P>
        <CodeBlock code={`// ~/.config/opencode/opencode.json
{
  "provider": {
    "hexos": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:7470/v1",
        "apiKey": "<your-api-key>"
      },
      "models": {
        "cb/claude-opus-4.6": { "name": "Claude Opus 4.6" },
        "cb/claude-haiku-4.5": { "name": "Claude Haiku 4.5" }
      }
    }
  },
  "model": "hexos/cb/claude-opus-4.6"
}`} label="opencode.json" lang="json" />

        {/* ---- Load Balancing ---- */}
        <H2 id="load-balancing">
          <Zap className="size-5 text-primary" />
          Load Balancing
        </H2>

        <H3 id="strategy">Strategy</H3>
        <P>
          Hexos uses a <strong>least-used</strong> strategy. Each request picks the active account
          with the lowest usage count. Ties are broken by last-used time (oldest first), then creation time.
        </P>

        <H3 id="failover">Failover</H3>
        <P>
          If a request fails, Hexos automatically tries the next account (up to 3 attempts).
          Failure handling by status code:
        </P>
        <div className="overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 pr-4 font-medium text-muted-foreground text-xs">Status</th>
                <th className="text-left py-2 font-medium text-muted-foreground text-xs">Action</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["401", "Attempt token refresh, retry once. If refresh fails, mark expired."],
                ["429 (rate limit)", "Try next account. No failure recorded."],
                ["429 (credit exhausted)", "Disable account permanently. Try next."],
                ["5xx", "Record failure. After 3 consecutive failures, disable account."],
              ].map(([status, action]) => (
                <tr key={status} className="border-b last:border-0">
                  <td className="py-2 pr-4"><InlineCode>{status}</InlineCode></td>
                  <td className="py-2 text-muted-foreground text-xs">{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <H3 id="credit-detection">Credit Detection</H3>
        <P>
          Hexos distinguishes rate limits from credit exhaustion by reading the 429 response body.
          If it contains keywords like "credit", "quota", or "insufficient", the account is
          automatically disabled. Otherwise it's treated as a temporary rate limit.
        </P>

        <div className="h-24" />
      </article>

      <DocsToC active={active} />
    </div>
  );
}
