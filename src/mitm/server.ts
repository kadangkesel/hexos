// Standalone MITM HTTPS server — runs as child process via sudo.
// Entry point: `bun run src/mitm/server.ts`
//
// Environment variables:
//   ROUTER_API_KEY    — API key for Hexos proxy auth
//   MITM_ROUTER_BASE  — Hexos proxy URL (default: http://localhost:7470)
//
import https from "https";
import fs from "fs";
import path from "path";
import dns from "dns";
import tls from "tls";
import { promisify } from "util";
import { execSync } from "child_process";
import { homedir } from "os";
import { getCertForDomain } from "./cert/generate.ts";
import { getToolForHost, URL_PATTERNS, INTERNAL_REQUEST_HEADER } from "./config.ts";
import * as copilotHandler from "./handlers/copilot.ts";
import * as antigravityHandler from "./handlers/antigravity.ts";
import * as kiroHandler from "./handlers/kiro.ts";
import * as cursorHandler from "./handlers/cursor.ts";

import type { IncomingMessage, ServerResponse } from "http";

const DATA_DIR = path.join(homedir(), ".hexos");
const MITM_DIR = path.join(DATA_DIR, "mitm");
const DB_FILE = path.join(DATA_DIR, "db.json");
const LOCAL_PORT = 443;

function time(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}
const log = (msg: string) => console.log(`[${time()}] [MITM] ${msg}`);
const err = (msg: string) => console.error(`[${time()}] ❌ [MITM] ${msg}`);

const handlers: Record<string, { intercept: Function }> = {
  antigravity: antigravityHandler,
  copilot: copilotHandler,
  kiro: kiroHandler,
  cursor: cursorHandler,
};

// ── SSL / SNI ────────────────────────────────────────────────
const certCache = new Map<string, tls.SecureContext>();

function sniCallback(servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void): void {
  try {
    if (certCache.has(servername)) return cb(null, certCache.get(servername)!);
    const certData = getCertForDomain(servername);
    if (!certData) return cb(new Error(`Failed to generate cert for ${servername}`));
    const ctx = tls.createSecureContext({ key: certData.key, cert: certData.cert });
    certCache.set(servername, ctx);
    log(`🔐 Cert generated: ${servername}`);
    cb(null, ctx);
  } catch (e: any) {
    err(`SNI error for ${servername}: ${e.message}`);
    cb(e);
  }
}

let sslOptions: https.ServerOptions;
try {
  sslOptions = {
    key: fs.readFileSync(path.join(MITM_DIR, "rootCA.key")),
    cert: fs.readFileSync(path.join(MITM_DIR, "rootCA.crt")),
    SNICallback: sniCallback,
  };
} catch (e: any) {
  err(`Root CA not found: ${e.message}`);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────
const cachedTargetIPs: Record<string, { ip: string; ts: number }> = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveTargetIP(hostname: string): Promise<string> {
  const cached = cachedTargetIPs[hostname];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ip;
  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8"]);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  const addresses = await resolve4(hostname);
  cachedTargetIPs[hostname] = { ip: addresses[0], ts: Date.now() };
  return addresses[0];
}

function collectBodyRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractModel(url: string, body: Buffer): string | null {
  const urlMatch = url.match(/\/models\/([^/:]+)/);
  if (urlMatch) return urlMatch[1];
  try {
    const parsed = JSON.parse(body.toString());
    if (parsed.conversationState) {
      return parsed.conversationState.currentMessage?.userInputMessage?.modelId || null;
    }
    return parsed.model || null;
  } catch {
    return null;
  }
}

function getMappedModel(tool: string, model: string | null): string | null {
  if (!model) return null;
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const aliases = db.mitmAlias?.[tool];
    if (!aliases) return null;
    if (aliases[model]) return aliases[model];
    const prefixKey = Object.keys(aliases).find(
      (k) => k && aliases[k] && (model.startsWith(k) || k.startsWith(model)),
    );
    return prefixKey ? aliases[prefixKey] : null;
  } catch {
    return null;
  }
}

async function passthrough(req: IncomingMessage, res: ServerResponse, bodyBuffer: Buffer): Promise<void> {
  const targetHost = (req.headers.host || "").split(":")[0];
  const targetIP = await resolveTargetIP(targetHost);

  const forwardReq = https.request(
    {
      hostname: targetIP,
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: targetHost },
      servername: targetHost,
      rejectUnauthorized: false,
    },
    (forwardRes) => {
      res.writeHead(forwardRes.statusCode || 502, forwardRes.headers);
      forwardRes.pipe(res);
    },
  );

  forwardReq.on("error", (e) => {
    err(`Passthrough error: ${e.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end("Bad Gateway");
  });

  if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
  forwardReq.end();
}

// ── Request handler ──────────────────────────────────────────
const server = https.createServer(sslOptions, async (req: IncomingMessage, res: ServerResponse) => {
  try {
    if (req.url === "/_mitm_health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    const bodyBuffer = await collectBodyRaw(req);

    if (req.headers[INTERNAL_REQUEST_HEADER.name] === INTERNAL_REQUEST_HEADER.value) {
      return passthrough(req, res, bodyBuffer);
    }

    const tool = getToolForHost(req.headers.host);
    if (!tool) return passthrough(req, res, bodyBuffer);

    const patterns = URL_PATTERNS[tool] || [];
    const isChat = patterns.some((p) => (req.url || "").includes(p));
    if (!isChat) return passthrough(req, res, bodyBuffer);

    log(`🔍 [${tool}] url=${req.url} | bodyLen=${bodyBuffer.length}`);

    if (tool === "cursor") {
      log(`⚡ intercept | cursor | proto`);
      return handlers[tool].intercept(req, res, bodyBuffer, null, passthrough);
    }

    const model = extractModel(req.url || "", bodyBuffer);
    log(`🔍 [${tool}] model="${model}"`);

    const mappedModel = getMappedModel(tool, model);
    if (!mappedModel) {
      log(`⏩ passthrough | no mapping | ${tool} | ${model || "unknown"}`);
      return passthrough(req, res, bodyBuffer);
    }

    log(`⚡ intercept | ${tool} | ${model} → ${mappedModel}`);
    return handlers[tool].intercept(req, res, bodyBuffer, mappedModel, passthrough);
  } catch (e: any) {
    err(`Unhandled error: ${e.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message, type: "mitm_error" } }));
  }
});

function killPort(port: number): void {
  try {
    const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: "utf-8",
      windowsHide: true,
    }).trim();
    if (!pids) return;
    const pidList = pids.split("\n").filter((p) => p && Number(p) !== process.pid);
    if (pidList.length === 0) return;
    pidList.forEach((pid) => {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* ignore */ }
    });
    log(`Killed ${pidList.length} process(es) on port ${port}`);
  } catch (e: any) {
    if (e.status !== 1) throw e;
  }
}

try {
  killPort(LOCAL_PORT);
} catch (e: any) {
  err(`Cannot kill process on port ${LOCAL_PORT}: ${e.message}`);
  process.exit(1);
}

server.listen(LOCAL_PORT, () => log(`🚀 Server ready on :${LOCAL_PORT}`));

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") err(`Port ${LOCAL_PORT} already in use`);
  else if (e.code === "EACCES") err(`Permission denied for port ${LOCAL_PORT}`);
  else err(e.message);
  process.exit(1);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (process.platform === "win32") process.on("SIGBREAK", shutdown);
