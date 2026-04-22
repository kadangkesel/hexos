import { saveConnection } from "./store.ts";
import { log } from "../utils/logger.ts";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const CODEBUDDY_HEADERS = {
  "Content-Type": "application/json",
  "X-Domain": "www.codebuddy.ai",
  "User-Agent": "codebuddy/2.91.0",
};

// Resolve automation directory relative to this file
const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_DIR = join(__dirname, "..", "automation");
const VENV_PYTHON = process.platform === "win32"
  ? join(AUTOMATION_DIR, ".venv", "Scripts", "python.exe")
  : join(AUTOMATION_DIR, ".venv", "bin", "python");
const LOGIN_SCRIPT = join(AUTOMATION_DIR, "login.py");
const CLINE_LOGIN_SCRIPT = join(AUTOMATION_DIR, "cline_login.py");
const KIRO_LOGIN_SCRIPT = join(AUTOMATION_DIR, "kiro_login.py");

// Track active automation subprocesses for cleanup on cancel
export const activeProcs = new Set<{ kill: () => void }>();

export function killAllActiveProcs() {
  for (const proc of activeProcs) {
    try { proc.kill(); } catch {}
  }
  activeProcs.clear();
}

// ---------------------------------------------------------------------------
// Shared: request auth state from CodeBuddy
// ---------------------------------------------------------------------------

async function requestAuthState(): Promise<{ state: string; authUrl: string }> {
  const stateRes = await fetch("https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI", {
    method: "POST",
    headers: CODEBUDDY_HEADERS,
    body: JSON.stringify({}),
  });

  const stateData = await stateRes.json() as any;
  if (stateData.code !== 0) throw new Error(`Failed to get auth state: ${JSON.stringify(stateData)}`);

  const { state, authUrl } = stateData.data;
  const loginUrl = (authUrl as string).replace("copilot.tencent.com", "www.codebuddy.ai");
  return { state, authUrl: loginUrl };
}

// ---------------------------------------------------------------------------
// Shared: fetch UID from CodeBuddy
// ---------------------------------------------------------------------------

async function fetchUid(accessToken: string): Promise<string> {
  try {
    const accountRes = await fetch("https://www.codebuddy.ai/v2/plugin/accounts", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Domain": "www.codebuddy.ai",
        "User-Agent": "codebuddy/2.91.0",
      },
    });
    const accountData = await accountRes.json() as any;
    return accountData?.data?.uid ?? accountData?.data?.userId ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Manual OAuth: device-code flow (original)
// ---------------------------------------------------------------------------

// CodeBuddy OAuth device-code flow
export async function oauthCodebuddy(label = "Account 1"): Promise<void> {
  const { state, authUrl } = await requestAuthState();

  log.info(`Open this URL in your browser to login:`);
  console.log(`\n  ${authUrl}\n`);

  // Try to open browser automatically
  try {
    const { default: open } = await import("open");
    await open(authUrl);
  } catch {}

  // Step 2: Poll for token
  log.info("Waiting for login...");
  const token = await pollCodebuddy(state);

  // Step 3: Get uid
  const uid = await fetchUid(token.accessToken);

  await saveConnection({
    provider: "codebuddy",
    label,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    uid,
  });

  log.ok(`CodeBuddy connected! (${label})`);
}

// ---------------------------------------------------------------------------
// Token verification & credit check
// ---------------------------------------------------------------------------

export interface CreditResult {
  totalCredits: number;
  remainingCredits: number;
  usedCredits: number;
  packageName: string;
  expiresAt: string;
}

export interface TokenStatus {
  valid: boolean;
  uid?: string;
  nickname?: string;
  credit?: CreditResult | null;
}

/**
 * Verify a token is still valid by calling /v2/plugin/accounts.
 * Note: billing/credit API requires cookie session (not Bearer token),
 * so credit info is only available from browser login or cached data.
 */
export async function checkToken(accessToken: string): Promise<TokenStatus> {
  try {
    const res = await fetch("https://www.codebuddy.ai/v2/plugin/accounts", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Domain": "www.codebuddy.ai",
        "User-Agent": "codebuddy/2.91.0",
      },
    });

    if (res.status === 401) return { valid: false };

    const data = await res.json() as any;
    if (data?.code !== 0) return { valid: false };

    const accounts = data?.data?.accounts ?? [];
    const first = accounts[0];

    return {
      valid: true,
      uid: first?.uid ?? "",
      nickname: first?.nickname ?? "",
    };
  } catch {
    return { valid: false };
  }
}

// Keep old name as alias for backward compat
export async function checkCredit(accessToken: string): Promise<CreditResult | null> {
  // Credit API requires cookie session, not Bearer token.
  // Return null — credit info comes from browser login (cached in db).
  return null;
}

// ---------------------------------------------------------------------------
// Automated OAuth: browser automation via Camoufox (Python subprocess)
// ---------------------------------------------------------------------------

interface AutoLoginProgress {
  type: "progress" | "result" | "error" | "debug";
  step?: string;
  message?: string;
  success?: boolean;
  accessToken?: string;
  refreshToken?: string;
  uid?: string;
  error?: string;
  credit?: {
    totalCredits: number;
    remainingCredits: number;
    usedCredits: number;
    packageName: string;
    expiresAt: string;
  };
}

/**
 * Check if the automation Python venv is set up.
 */
export function isAutomationReady(): boolean {
  try {
    const fs = require("fs");
    return fs.existsSync(VENV_PYTHON) && fs.existsSync(LOGIN_SCRIPT);
  } catch {
    return false;
  }
}

/**
 * Run the automation setup (create venv + install deps).
 */
export async function setupAutomation(): Promise<void> {
  const setupScript = join(AUTOMATION_DIR, "setup.py");
  log.info("Setting up automation environment...");

  const proc = Bun.spawn(["python", setupScript], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Automation setup failed with exit code ${exitCode}`);
  }

  log.ok("Automation environment ready!");
}

/**
 * Login a single account via browser automation (Camoufox).
 * Spawns a Python subprocess that controls the browser.
 */
export async function oauthCodebuddyAutomated(
  email: string,
  password: string,
  label?: string,
  proxy?: string,
  headless = true,
): Promise<{ success: boolean; error?: string }> {
  const accountLabel = label || email;

  if (!isAutomationReady()) {
    log.error("Automation not set up. Run: hexos auth setup-automation");
    return { success: false, error: "Automation not set up" };
  }

  // Step 1: Request auth state
  log.info(`[${accountLabel}] Requesting auth state...`);
  let state: string, authUrl: string;
  try {
    ({ state, authUrl } = await requestAuthState());
  } catch (e: any) {
    log.error(`[${accountLabel}] Failed to get auth state: ${e.message}`);
    return { success: false, error: e.message };
  }

  // Step 2: Spawn Python login script
  log.info(`[${accountLabel}] Launching browser automation...`);

  const proc = Bun.spawn(
    [
      VENV_PYTHON,
      LOGIN_SCRIPT,
      "--email", email,
      "--password", password,
      "--state", state,
      "--auth-url", authUrl,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HEXOS_DEBUG: process.env.HEXOS_DEBUG || "false",
        ...(proxy ? { HEXOS_PROXY: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}),
        HEXOS_HEADLESS: headless ? "true" : "false",
      },
    },
  );
  activeProcs.add(proc);

  // Read stdout line by line for progress updates
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: AutoLoginProgress | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: AutoLoginProgress = JSON.parse(line);
          if (msg.type === "progress") {
            log.info(`[${accountLabel}] ${msg.message}`);
          } else if (msg.type === "result") {
            finalResult = msg;
            // Log token presence for debugging missing refresh tokens
            const hasAccess = !!msg.accessToken;
            const hasRefresh = !!msg.refreshToken;
            log.info(`[${accountLabel}] Result: success=${msg.success} accessToken=${hasAccess ? 'present' : 'EMPTY'} refreshToken=${hasRefresh ? 'present' : 'EMPTY'}`);
          } else if (msg.type === "error") {
            log.error(`[${accountLabel}] ${msg.error}`);
          } else if (msg.type === "debug") {
            log.info(`[${accountLabel}] [debug] ${msg.message}`);
          }
        } catch {
          // Non-JSON output, ignore
        }
      }
    }
  } catch {}

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const msg: AutoLoginProgress = JSON.parse(buffer);
      if (msg.type === "result") finalResult = msg;
    } catch {}
  }

  const exitCode = await proc.exited;
  activeProcs.delete(proc);

  // Read stderr for error info
  let stderrText = "";
  try {
    const stderrReader = proc.stderr.getReader();
    const { value } = await stderrReader.read();
    if (value) stderrText = decoder.decode(value);
  } catch {}

  if (exitCode !== 0 && !finalResult) {
    const errMsg = stderrText.trim() || `Process exited with code ${exitCode}`;
    log.error(`[${accountLabel}] Automation failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  if (!finalResult || !finalResult.success) {
    const errMsg = finalResult?.error || "Unknown automation error";
    log.error(`[${accountLabel}] Login failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  // Reject results with empty tokens — these create broken connections
  if (!finalResult.accessToken) {
    log.error(`[${accountLabel}] Login succeeded in browser but no token obtained (token poll failed). Skipping save.`);
    return { success: false, error: "Token poll failed — no accessToken obtained" };
  }

  // Warn if refresh token is missing (accessToken present but no refreshToken)
  if (!finalResult.refreshToken) {
    log.warn(`[${accountLabel}] WARNING: accessToken present but refreshToken is EMPTY. Token refresh will not work.`);
  }

  // Step 3: Save connection
  const conn = await saveConnection({
    provider: "codebuddy",
    label: accountLabel,
    accessToken: finalResult.accessToken,
    refreshToken: finalResult.refreshToken || "",
    uid: finalResult.uid || "",
  });

  // Step 4: Save credit info if available
  if (finalResult.credit) {
    const { updateConnection } = await import("./store.ts");
    await updateConnection(conn.id, {
      credit: {
        ...finalResult.credit,
        fetchedAt: Date.now(),
      },
    } as any);
  }

  log.ok(`[${accountLabel}] CodeBuddy connected!`);
  return { success: true };
}

/**
 * Batch login multiple accounts from a list.
 * Format: [{ email, password, label? }]
 */
export async function batchConnect(
  accounts: Array<{ email: string; password: string; label?: string }>,
  concurrency = 2,
  headless = true,
  isCancelled?: () => boolean,
  providers: string[] = ["codebuddy"],
  onProgress?: (completed: number, success: number, failed: number) => void,
): Promise<{ total: number; success: number; failed: number; errors: string[] }> {
  // Import proxy pool for random proxy selection
  let getRandomProxy: (() => string | null) | null = null;
  try {
    const pool = await import("../proxy/pool.ts");
    getRandomProxy = pool.getRandomProxy;
  } catch {}

  const results = { total: accounts.length, success: 0, failed: 0, errors: [] as string[] };

  log.info(`Batch connecting ${accounts.length} accounts (concurrency: ${concurrency}, providers: ${providers.join(", ")})...`);

  // Process in batches of `concurrency`
  for (let i = 0; i < accounts.length; i += concurrency) {
    // Check cancel
    if (isCancelled?.()) {
      log.warn("Batch connect cancelled by user");
      break;
    }

    const batch = accounts.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(accounts.length / concurrency);

    log.info(`Batch ${batchNum}/${totalBatches} (${batch.length} accounts):`);

    const promises = batch.map(async (account, idx) => {
      const label = account.label || account.email;
      // Pick a random proxy from the pool
      const proxy = getRandomProxy?.() ?? undefined;
      if (proxy) log.info(`[${label}] Using proxy: ${proxy}`);
      // Stagger starts slightly to avoid hitting rate limits
      if (idx > 0) await Bun.sleep(2000 * idx);

      const providerResults: { provider: string; success: boolean; error?: string }[] = [];

      for (const provider of providers) {
        if (isCancelled?.()) break;
        if (provider === "codebuddy") {
          const r = await oauthCodebuddyAutomated(account.email, account.password, label, proxy, headless);
          providerResults.push({ provider: "codebuddy", ...r });
        } else if (provider === "kiro") {
          const r = await oauthKiroAutomated(account.email, account.password, label, proxy, headless);
          providerResults.push({ provider: "kiro", ...r });
        } else if (provider === "cline") {
          const r = await oauthClineAutomated(account.email, account.password, label, proxy, headless);
          providerResults.push({ provider: "cline", ...r });
        }
      }

      return providerResults;
    });

    const batchResults = await Promise.allSettled(promises);

    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      const account = batch[j];
      if (r.status === "fulfilled") {
        const providerResults = r.value;
        const allSucceeded = providerResults.length > 0 && providerResults.every((pr) => pr.success);
        const anySucceeded = providerResults.some((pr) => pr.success);
        if (allSucceeded) {
          results.success++;
        } else if (anySucceeded) {
          // Partial success — count as success but log errors for failed providers
          results.success++;
          for (const pr of providerResults) {
            if (!pr.success) {
              results.errors.push(`${account.email} [${pr.provider}]: ${pr.error || "Unknown error"}`);
            }
          }
        } else {
          results.failed++;
          for (const pr of providerResults) {
            results.errors.push(`${account.email} [${pr.provider}]: ${pr.error || "Unknown error"}`);
          }
        }
      } else {
        results.failed++;
        results.errors.push(`${account.email}: ${r.reason?.message || "Unknown error"}`);
      }
    }

    // Report incremental progress
    onProgress?.(results.success + results.failed, results.success, results.failed);

    // Wait between batches to avoid rate limiting
    if (i + concurrency < accounts.length) {
      log.info("Waiting 5s before next batch...");
      await Bun.sleep(5000);
    }
  }

  return results;
}

async function pollCodebuddy(state: string, maxWait = 120000): Promise<{ accessToken: string; refreshToken: string }> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await Bun.sleep(3000);
    const res = await fetch(`https://www.codebuddy.ai/v2/plugin/auth/token?state=${state}&platform=CLI`, {
      headers: {
        "X-Domain": "www.codebuddy.ai",
        "User-Agent": "codebuddy/2.91.0",
      },
    });
    const data = await res.json() as any;
    if (data.code === 0 && data.data?.accessToken) {
      return { accessToken: data.data.accessToken, refreshToken: data.data.refreshToken ?? "" };
    }
    if (data.code !== 11217) throw new Error(`Auth error: ${JSON.stringify(data)}`);
  }
  throw new Error("Login timeout");
}

export async function refreshCodebuddy(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch("https://www.codebuddy.ai/v2/plugin/auth/token/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Refresh-Token": refreshToken,
      "X-Auth-Refresh-Source": "plugin",
      "User-Agent": "codebuddy/2.91.0",
    },
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  return { accessToken: data.data.accessToken, refreshToken: data.data.refreshToken ?? refreshToken };
}

// ---------------------------------------------------------------------------
// Cline: automated OAuth via browser automation (Camoufox)
// ---------------------------------------------------------------------------

export async function oauthClineAutomated(
  email: string,
  password: string,
  label?: string,
  proxy?: string,
  headless = true,
): Promise<{ success: boolean; error?: string }> {
  const accountLabel = label || email;

  if (!isAutomationReady()) {
    log.error("Automation not set up. Run: hexos auth setup-automation");
    return { success: false, error: "Automation not set up" };
  }

  log.info(`[${accountLabel}] Launching Cline browser automation...`);

  const proc = Bun.spawn(
    [VENV_PYTHON, CLINE_LOGIN_SCRIPT, "--email", email, "--password", password],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HEXOS_DEBUG: process.env.HEXOS_DEBUG || "false",
        ...(proxy ? { HEXOS_PROXY: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}),
        HEXOS_HEADLESS: headless ? "true" : "false",
      },
    },
  );
  activeProcs.add(proc);

  // Read stdout (same pattern as oauthCodebuddyAutomated)
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: any = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "progress") {
            log.info(`[${accountLabel}] ${msg.message}`);
          } else if (msg.type === "result") {
            finalResult = msg;
          } else if (msg.type === "error") {
            log.error(`[${accountLabel}] ${msg.error}`);
          } else if (msg.type === "debug") {
            log.info(`[${accountLabel}] [debug] ${msg.message}`);
          }
        } catch {}
      }
    }
  } catch {}

  if (buffer.trim()) {
    try {
      const msg = JSON.parse(buffer);
      if (msg.type === "result") finalResult = msg;
    } catch {}
  }

  const exitCode = await proc.exited;
  activeProcs.delete(proc);

  let stderrText = "";
  try {
    const stderrReader = proc.stderr.getReader();
    const { value } = await stderrReader.read();
    if (value) stderrText = decoder.decode(value);
  } catch {}

  if (exitCode !== 0 && !finalResult) {
    const errMsg = stderrText.trim() || `Process exited with code ${exitCode}`;
    log.error(`[${accountLabel}] Cline automation failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  if (!finalResult || !finalResult.success) {
    const errMsg = finalResult?.error || "Unknown Cline automation error";
    log.error(`[${accountLabel}] Cline login failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  // Reject results with empty tokens — these create broken connections
  if (!finalResult.accessToken) {
    log.error(`[${accountLabel}] Cline login succeeded in browser but no token obtained. Skipping save.`);
    return { success: false, error: "No accessToken obtained from Cline login" };
  }

  // Save connection as "cline" provider
  const conn = await saveConnection({
    provider: "cline",
    label: accountLabel,
    accessToken: finalResult.accessToken,
    refreshToken: finalResult.refreshToken || "",
    uid: finalResult.uid || "",
  });

  // Save credit info
  if (finalResult.credit) {
    const { updateConnection } = await import("./store.ts");
    await updateConnection(conn.id, {
      credit: {
        ...finalResult.credit,
        fetchedAt: Date.now(),
      },
    });
  }

  log.ok(`[${accountLabel}] Cline connected!`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Cline: token refresh
// ---------------------------------------------------------------------------

export async function refreshCline(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch("https://api.cline.bot/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Cline token refresh failed: ${res.status}`);
  const data = await res.json() as any;
  return {
    accessToken: data.accessToken || data.access_token || "",
    refreshToken: data.refreshToken || data.refresh_token || refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Cline: token verification
// ---------------------------------------------------------------------------

export async function checkClineToken(accessToken: string): Promise<{ valid: boolean; uid?: string; email?: string }> {
  try {
    const res = await fetch("https://api.cline.bot/api/v1/users/me", {
      headers: {
        "Authorization": `Bearer workos:${accessToken}`,
        "User-Agent": "Cline/3.79.0",
      },
    });
    if (!res.ok) return { valid: false };
    const data = await res.json() as any;
    return { valid: true, uid: data.id, email: data.email };
  } catch {
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// Kiro: automated OAuth via browser automation (Camoufox)
// ---------------------------------------------------------------------------

interface KiroLoginResult {
  type: "progress" | "result" | "error" | "debug";
  step?: string;
  message?: string;
  success?: boolean;
  accessToken?: string;
  refreshToken?: string;
  profileArn?: string;
  error?: string;
  credit?: {
    totalCredits: number;
    remainingCredits: number;
    usedCredits: number;
    packageName: string;
    expiresAt: string;
  };
}

export async function oauthKiroAutomated(
  email: string,
  password: string,
  label?: string,
  proxy?: string,
  headless = true,
): Promise<{ success: boolean; error?: string }> {
  const accountLabel = label || email;

  if (!isAutomationReady()) {
    log.error("Automation not set up. Run: hexos auth setup-automation");
    return { success: false, error: "Automation not set up" };
  }

  log.info(`[${accountLabel}] Launching Kiro browser automation...`);

  const proc = Bun.spawn(
    [VENV_PYTHON, KIRO_LOGIN_SCRIPT, "--email", email, "--password", password],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HEXOS_DEBUG: process.env.HEXOS_DEBUG || "false",
        ...(proxy ? { HEXOS_PROXY: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}),
        HEXOS_HEADLESS: headless ? "true" : "false",
      },
    },
  );
  activeProcs.add(proc);

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: KiroLoginResult | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: KiroLoginResult = JSON.parse(line);
          if (msg.type === "progress") {
            log.info(`[${accountLabel}] ${msg.message}`);
          } else if (msg.type === "result") {
            finalResult = msg;
            const hasAccess = !!msg.accessToken;
            const hasRefresh = !!msg.refreshToken;
            log.info(`[${accountLabel}] Result: success=${msg.success} accessToken=${hasAccess ? 'present' : 'EMPTY'} refreshToken=${hasRefresh ? 'present' : 'EMPTY'} profileArn=${msg.profileArn ? 'present' : 'EMPTY'}`);
          } else if (msg.type === "error") {
            log.error(`[${accountLabel}] ${msg.error}`);
          } else if (msg.type === "debug") {
            log.info(`[${accountLabel}] [debug] ${msg.message}`);
          }
        } catch {}
      }
    }
  } catch {}

  if (buffer.trim()) {
    try {
      const msg: KiroLoginResult = JSON.parse(buffer);
      if (msg.type === "result") finalResult = msg;
    } catch {}
  }

  const exitCode = await proc.exited;
  activeProcs.delete(proc);

  let stderrText = "";
  try {
    const stderrReader = proc.stderr.getReader();
    const { value } = await stderrReader.read();
    if (value) stderrText = decoder.decode(value);
  } catch {}

  if (exitCode !== 0 && !finalResult) {
    const errMsg = stderrText.trim() || `Process exited with code ${exitCode}`;
    log.error(`[${accountLabel}] Kiro automation failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  if (!finalResult || !finalResult.success) {
    const errMsg = finalResult?.error || "Unknown Kiro automation error";
    log.error(`[${accountLabel}] Kiro login failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  // Reject results with empty tokens
  if (!finalResult.accessToken) {
    log.error(`[${accountLabel}] Kiro login succeeded in browser but no token obtained. Skipping save.`);
    return { success: false, error: "No accessToken obtained from Kiro login" };
  }

  if (!finalResult.refreshToken) {
    log.warn(`[${accountLabel}] WARNING: Kiro accessToken present but refreshToken is EMPTY.`);
  }

  // Save connection as "kiro" provider
  // Store profileArn in uid field (reuse existing field)
  const conn = await saveConnection({
    provider: "kiro",
    label: accountLabel,
    accessToken: finalResult.accessToken,
    refreshToken: finalResult.refreshToken || "",
    uid: finalResult.profileArn || "",
  });

  // Save credit info
  if (finalResult.credit) {
    const { updateConnection } = await import("./store.ts");
    await updateConnection(conn.id, {
      credit: {
        ...finalResult.credit,
        fetchedAt: Date.now(),
      },
    });
  }

  log.ok(`[${accountLabel}] Kiro connected!`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Kiro: token refresh
// ---------------------------------------------------------------------------

export async function refreshKiro(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) throw new Error(`Kiro token refresh failed: ${res.status}`);
  const data = await res.json() as any;
  return {
    accessToken: data.accessToken || "",
    refreshToken: data.refreshToken || refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Kiro: token verification (uses usage API as health check)
// ---------------------------------------------------------------------------

export async function checkKiroToken(accessToken: string, profileArn?: string): Promise<{ valid: boolean; usage?: any }> {
  try {
    // Use the usage/quota endpoint as a token validity check
    const params = new URLSearchParams({
      origin: "AI_EDITOR",
      resourceType: "AGENTIC_REQUEST",
    });
    if (profileArn) params.set("profileArn", profileArn);

    const res = await fetch(`https://q.us-east-1.amazonaws.com/getUsageLimits?${params}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "kiro-ide/1.0.0",
      },
    });

    if (res.status === 401 || res.status === 403) return { valid: false };
    if (!res.ok) return { valid: false };

    const data = await res.json() as any;
    const usageList = data?.usageBreakdownList ?? [];
    if (usageList.length === 0) return { valid: true };

    const usage = usageList[0] ?? {};
    const limit = Number(usage.usageLimitWithPrecision ?? usage.usageLimit ?? 0);
    const current = Number(usage.currentUsageWithPrecision ?? usage.currentUsage ?? 0);

    // Add free trial
    const freeTrial = usage.freeTrialInfo ?? {};
    let totalLimit = limit;
    let totalUsage = current;
    if (String(freeTrial.freeTrialStatus ?? "").toUpperCase() === "ACTIVE") {
      totalLimit += Number(freeTrial.usageLimitWithPrecision ?? freeTrial.usageLimit ?? 0);
      totalUsage += Number(freeTrial.currentUsageWithPrecision ?? freeTrial.currentUsage ?? 0);
    }

    // Add bonuses
    for (const bonus of usage.bonuses ?? []) {
      totalLimit += Number(bonus?.usageLimit ?? 0);
      totalUsage += Number(bonus?.currentUsage ?? 0);
    }

    const remaining = Math.max(totalLimit - totalUsage, 0);
    const subTitle = data?.subscriptionInfo?.subscriptionTitle ?? data?.subscriptionType ?? "Free";

    return {
      valid: true,
      usage: {
        totalCredits: totalLimit,
        remainingCredits: remaining,
        usedCredits: totalUsage,
        packageName: subTitle,
        expiresAt: data?.nextDateReset ?? "",
      },
    };
  } catch {
    return { valid: false };
  }
}
