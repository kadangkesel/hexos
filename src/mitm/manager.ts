import { exec, spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import net from "net";
import https from "https";
import crypto from "crypto";
import { addDNSEntry, removeDNSEntry, removeAllDNSEntries, checkAllDNSStatus, isSudoAvailable, execWithPassword } from "./dns/dnsConfig.ts";
import { generateRootCA, isCertExpired, ROOT_CA_CERT_PATH, ROOT_CA_KEY_PATH } from "./cert/rootCA.ts";
import { installCert, uninstallCert, checkCertInstalled } from "./cert/install.ts";
import type { ChildProcess } from "child_process";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const DATA_DIR = path.join(os.homedir(), ".hexos");
const MITM_DIR = path.join(DATA_DIR, "mitm");
const MITM_PORT = 443;
const PID_FILE = path.join(MITM_DIR, ".mitm.pid");
const DEFAULT_MITM_ROUTER_BASE = "http://localhost:7470";

const MITM_MAX_RESTARTS = 5;
const MITM_RESTART_DELAYS_MS = [5000, 10000, 20000, 30000, 60000];
const MITM_RESTART_RESET_MS = 60000;

let mitmRestartCount = 0;
let mitmLastStartTime = 0;
let mitmIsRestarting = false;
let serverProcess: ChildProcess | null = null;
let serverPid: number | null = null;

let cachedPassword: string | null = null;
export function getCachedPassword(): string | null { return cachedPassword; }
export function setCachedPassword(pwd: string | null): void { cachedPassword = pwd; }

const ENCRYPT_ALGO = "aes-256-gcm";
const ENCRYPT_SALT = "hexos-mitm-pwd";

function deriveKey(): Buffer {
  const seed = ENCRYPT_SALT;
  return crypto.createHash("sha256").update(seed).digest();
}

export function encryptPassword(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptPassword(stored: string): string | null {
  try {
    const [ivHex, tagHex, dataHex] = stored.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
  } catch {
    return null;
  }
}

function shellQuoteSingle(str: string): string {
  if (str == null || str === "") return "''";
  return `'${String(str).replace(/'/g, "'\\\\''")}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EACCES";
  }
}

function killProcess(pid: number, force: boolean = false, sudoPassword: string | null = null): void {
  if (IS_WIN) {
    const flag = force ? "/F " : "";
    exec(`taskkill ${flag}/PID ${pid}`, { windowsHide: true }, () => {});
  } else {
    const sig = force ? "SIGKILL" : "SIGTERM";
    const cmd = `pkill -${sig} -P ${pid} 2>/dev/null; kill -${sig} ${pid} 2>/dev/null`;
    if (sudoPassword) {
      execWithPassword(cmd, sudoPassword).catch(() => exec(cmd, { windowsHide: true }, () => {}));
    } else {
      exec(cmd, { windowsHide: true }, () => {});
    }
  }
}

function resolveServerPath(): string {
  if (process.env.MITM_SERVER_PATH) return process.env.MITM_SERVER_PATH;
  const fromCwd = path.join(process.cwd(), "src", "mitm", "server.ts");
  if (fs.existsSync(fromCwd)) return fromCwd;
  // Fallback: relative to this file (handle Windows file:// URLs)
  try {
    const fileUrl = new URL(import.meta.url);
    const dirPath = path.dirname(IS_WIN ? fileUrl.pathname.replace(/^\//, "") : fileUrl.pathname);
    const sibling = path.join(dirPath, "server.ts");
    if (fs.existsSync(sibling)) return sibling;
  } catch { /* ignore */ }
  return fromCwd;
}

async function killLeftoverMitm(sudoPassword: string | null): Promise<void> {
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill("SIGKILL"); } catch { /* ignore */ }
    serverProcess = null;
    serverPid = null;
  }
  try {
    if (fs.existsSync(PID_FILE)) {
      const savedPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (savedPid && isProcessAlive(savedPid)) {
        killProcess(savedPid, true, sudoPassword);
        await new Promise((r) => setTimeout(r, 500));
      }
      fs.unlinkSync(PID_FILE);
    }
  } catch { /* ignore */ }
}

function pollMitmHealth(timeoutMs: number): Promise<{ ok: boolean; pid: number | null } | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const req = https.request(
        { hostname: "127.0.0.1", port: MITM_PORT, path: "/_mitm_health", method: "GET", rejectUnauthorized: false },
        (res) => {
          let body = "";
          res.on("data", (d: Buffer) => { body += d; });
          res.on("end", () => {
            try {
              const json = JSON.parse(body);
              resolve(json.ok === true ? { ok: true, pid: json.pid || null } : null);
            } catch { resolve(null); }
          });
        },
      );
      req.on("error", () => {
        if (Date.now() < deadline) setTimeout(check, 500);
        else resolve(null);
      });
      req.end();
    };
    check();
  });
}

export async function getMitmStatus(): Promise<{
  running: boolean;
  pid: number | null;
  certExists: boolean;
  certTrusted: boolean;
  dnsStatus: Record<string, boolean>;
}> {
  let running = serverProcess !== null && !serverProcess.killed;
  let pid = serverPid;

  if (!running) {
    try {
      if (fs.existsSync(PID_FILE)) {
        const savedPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (savedPid && isProcessAlive(savedPid)) {
          running = true;
          pid = savedPid;
        } else {
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch { /* ignore */ }
  }

  const dnsStatus = checkAllDNSStatus();
  const certExists = fs.existsSync(ROOT_CA_CERT_PATH);
  const certTrusted = certExists ? await checkCertInstalled(ROOT_CA_CERT_PATH) : false;

  return { running, pid, certExists, certTrusted, dnsStatus };
}

export async function startServer(
  apiKey: string,
  sudoPassword: string | null,
): Promise<{ running: boolean; pid: number | null }> {
  if (!serverProcess || serverProcess.killed) {
    try {
      if (fs.existsSync(PID_FILE)) {
        const savedPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (savedPid && isProcessAlive(savedPid)) {
          serverPid = savedPid;
          console.log(`♻️ Reusing existing MITM process (PID: ${savedPid})`);
          if (sudoPassword) setCachedPassword(sudoPassword);
          return { running: true, pid: savedPid };
        } else {
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch { /* ignore */ }
  }

  if (serverProcess && !serverProcess.killed) {
    throw new Error("MITM server is already running");
  }

  await killLeftoverMitm(sudoPassword);

  // Step 1: Generate Root CA if missing or expired
  const certExists = fs.existsSync(ROOT_CA_CERT_PATH) && fs.existsSync(ROOT_CA_KEY_PATH);
  if (!certExists || isCertExpired(ROOT_CA_CERT_PATH)) {
    if (certExists) {
      console.log("🔐 Cert expired — uninstalling old cert...");
      try { await uninstallCert(sudoPassword, ROOT_CA_CERT_PATH); } catch { /* best effort */ }
    }
    console.log("🔐 Generating Root CA...");
    await generateRootCA();
  }

  // Step 2: Auto-install Root CA if not trusted yet
  const rootCATrusted = await checkCertInstalled(ROOT_CA_CERT_PATH);
  if (!rootCATrusted) {
    console.log("🔐 Cert: not trusted → installing...");
    if (!IS_WIN && !IS_MAC && !isSudoAvailable()) {
      console.log(`🔐 Cert: skipping system trust (no sudo). Install ${ROOT_CA_CERT_PATH} manually.`);
    } else {
      if (!sudoPassword && !IS_WIN) {
        throw new Error("Sudo password required to install Root CA certificate");
      }
      await installCert(sudoPassword, ROOT_CA_CERT_PATH);
      console.log("🔐 Cert: ✅ trusted");
    }
  } else {
    console.log("🔐 Cert: already trusted ✅");
  }

  // Step 3: Spawn MITM server as child process
  const SERVER_PATH = resolveServerPath();
  const mitmRouterBase = DEFAULT_MITM_ROUTER_BASE;
  console.log(`🚀 Starting MITM server... (router: ${mitmRouterBase})`);

  const bunPath = process.execPath || "bun";

  if (IS_WIN) {
    // Windows: port 443 needs admin — spawn elevated via a wrapper script
    const wrapperPath = path.join(MITM_DIR, "_mitm_start.ps1");
    const wrapperContent = [
      `$env:ROUTER_API_KEY = '${apiKey.replace(/'/g, "''")}'`,
      `$env:MITM_ROUTER_BASE = '${mitmRouterBase.replace(/'/g, "''")}'`,
      `$env:HOME = '${os.homedir().replace(/'/g, "''")}'`,
      `& '${bunPath.replace(/'/g, "''")}' run '${SERVER_PATH.replace(/'/g, "''")}'`,
    ].join("\r\n");
    fs.writeFileSync(wrapperPath, wrapperContent, "utf8");

    // Spawn elevated PowerShell that runs the wrapper — NOT hidden so it stays alive
    serverProcess = spawn(
      "powershell",
      ["-NoProfile", "-Command",
        `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','handle','-File','${wrapperPath.replace(/'/g, "''")}' -Verb RunAs -PassThru | ForEach-Object { $_.Id } | Set-Content '${PID_FILE.replace(/'/g, "''")}'`],
      { detached: true, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    serverProcess.unref();
  } else if (isSudoAvailable()) {
    const inlineCmd = [
      `HOME=${shellQuoteSingle(os.homedir())}`,
      `ROUTER_API_KEY=${shellQuoteSingle(apiKey)}`,
      `MITM_ROUTER_BASE=${shellQuoteSingle(mitmRouterBase)}`,
      shellQuoteSingle(bunPath),
      "run",
      shellQuoteSingle(SERVER_PATH),
    ].join(" ");

    serverProcess = spawn("sudo", ["-S", "-E", "sh", "-c", inlineCmd], {
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    serverProcess.stdin!.write(`${sudoPassword}\n`);
    serverProcess.stdin!.end();
  } else {
    serverProcess = spawn(bunPath, ["run", SERVER_PATH], {
      detached: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ROUTER_API_KEY: apiKey,
        MITM_ROUTER_BASE: mitmRouterBase,
      },
    });
  }

  if (IS_WIN) {
    // Windows: elevated process is detached, we track via PID file + health check
    if (!fs.existsSync(MITM_DIR)) fs.mkdirSync(MITM_DIR, { recursive: true });
    mitmLastStartTime = Date.now();
    // The launcher writes PID to PID_FILE, wait a moment for it
    await new Promise((r) => setTimeout(r, 2000));
    // Read PID from file (written by the launcher PowerShell)
    try {
      if (fs.existsSync(PID_FILE)) {
        serverPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10) || null;
      }
    } catch { /* ignore */ }
    // Detach — we don't track the launcher process
    serverProcess = null;
  } else if (serverProcess) {
    serverPid = serverProcess.pid || null;
    if (!fs.existsSync(MITM_DIR)) fs.mkdirSync(MITM_DIR, { recursive: true });
    if (serverPid) fs.writeFileSync(PID_FILE, String(serverPid));
    mitmLastStartTime = Date.now();

    serverProcess.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(data);
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && (!msg.includes("Password:") && !msg.includes("password for"))) {
        console.error(`[MITM] ${msg}`);
      }
      if (msg.includes("incorrect password") || msg.includes("no password was provided")) {
        setCachedPassword(null);
        mitmIsRestarting = true;
      }
    });

    serverProcess.on("exit", (code: number | null) => {
      console.log(`[MITM] Server exited (code: ${code})`);
      serverProcess = null;
      serverPid = null;
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      if (code !== 0 && !mitmIsRestarting) scheduleMitmRestart(apiKey);
    });
  }

  // Step 4: Health check — give Windows more time since UAC adds delay
  const healthTimeout = IS_WIN ? 15000 : 8000;
  const health = await pollMitmHealth(healthTimeout);
  if (!health) {
    if (serverProcess && !serverProcess.killed) {
      try { serverProcess.kill(); } catch { /* ignore */ }
      serverProcess = null;
    }
    throw new Error("MITM server failed to start. Check sudo password or port 443 access.");
  }

  console.log(`✅ MITM server healthy (PID: ${serverPid || health.pid})`);

  const dnsStatus = checkAllDNSStatus();
  for (const [tool, active] of Object.entries(dnsStatus)) {
    console.log(`🌐 DNS ${tool}: ${active ? "✅ active" : "❌ inactive"}`);
  }

  if (sudoPassword) setCachedPassword(sudoPassword);
  return { running: true, pid: serverPid };
}

export async function stopServer(sudoPassword: string | null): Promise<{ running: boolean; pid: null }> {
  mitmIsRestarting = true;
  mitmRestartCount = 0;
  console.log("⏹ Stopping MITM server...");

  const pidToKill = serverProcess && !serverProcess.killed
    ? serverProcess.pid
    : (() => { try { return parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10); } catch { return null; } })();

  if (pidToKill && isProcessAlive(pidToKill)) {
    console.log(`Killing MITM server (PID: ${pidToKill})...`);
    killProcess(pidToKill, false, sudoPassword);
    await new Promise((r) => setTimeout(r, 1000));
    if (isProcessAlive(pidToKill)) killProcess(pidToKill, true, sudoPassword);
  }
  serverProcess = null;
  serverPid = null;

  const password = sudoPassword || getCachedPassword();
  await removeAllDNSEntries(password);

  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  mitmIsRestarting = false;

  return { running: false, pid: null };
}

export async function enableToolDNS(tool: string, sudoPassword: string | null): Promise<{ success: boolean }> {
  const status = await getMitmStatus();
  if (!status.running) throw new Error("MITM server is not running. Start the server first.");
  const password = sudoPassword || getCachedPassword();
  await addDNSEntry(tool, password);
  return { success: true };
}

export async function disableToolDNS(tool: string, sudoPassword: string | null): Promise<{ success: boolean }> {
  const password = sudoPassword || getCachedPassword();
  await removeDNSEntry(tool, password);
  return { success: true };
}

export async function trustCert(sudoPassword: string | null): Promise<void> {
  if (!fs.existsSync(ROOT_CA_CERT_PATH)) throw new Error("Root CA not found. Start server first to generate it.");
  if (!IS_WIN && !IS_MAC && !isSudoAvailable()) {
    console.log(`🔐 Cert: system trust unavailable (no sudo). Use file: ${ROOT_CA_CERT_PATH}`);
    return;
  }
  const password = sudoPassword || getCachedPassword();
  if (!password && !IS_WIN) throw new Error("Sudo password required to trust certificate");
  await installCert(password, ROOT_CA_CERT_PATH);
  if (password) setCachedPassword(password);
}

async function scheduleMitmRestart(apiKey: string): Promise<void> {
  if (mitmIsRestarting) return;

  const aliveMs = Date.now() - mitmLastStartTime;
  if (aliveMs >= MITM_RESTART_RESET_MS) mitmRestartCount = 0;

  if (mitmRestartCount >= MITM_MAX_RESTARTS) {
    console.error("[MITM] Max restart attempts reached. Giving up.");
    return;
  }

  const delay = MITM_RESTART_DELAYS_MS[Math.min(mitmRestartCount, MITM_RESTART_DELAYS_MS.length - 1)];
  mitmRestartCount++;
  mitmIsRestarting = true;

  console.log(`[MITM] Restarting in ${delay / 1000}s... (${mitmRestartCount}/${MITM_MAX_RESTARTS})`);
  await new Promise((r) => setTimeout(r, delay));

  try {
    const password = getCachedPassword();
    if (!password && !IS_WIN) {
      console.error("[MITM] No cached password, cannot auto-restart");
      mitmIsRestarting = false;
      return;
    }
    await startServer(apiKey, password);
    console.log("[MITM] 🔄 Restarted successfully");
    mitmRestartCount = 0;
    mitmIsRestarting = false;
  } catch (e: any) {
    console.error(`[MITM] Restart attempt ${mitmRestartCount}/${MITM_MAX_RESTARTS} failed: ${e.message}`);
    mitmIsRestarting = false;
    scheduleMitmRestart(apiKey);
  }
}
