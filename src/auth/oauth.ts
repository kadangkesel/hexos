import { saveConnection } from "./store.ts";
import { log } from "../utils/logger.ts";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { existsSync } from "fs";
import crypto from "crypto";

const CODEBUDDY_HEADERS = {
  "Content-Type": "application/json",
  "X-Domain": "www.codebuddy.ai",
  "User-Agent": "codebuddy/2.91.0",
};

// Resolve automation directory: check ~/.hexos/automation/ first (installed mode),
// then fall back to source tree (dev mode)
const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALLED_AUTOMATION_DIR = join(homedir(), ".hexos", "automation");
const SOURCE_AUTOMATION_DIR = join(__dirname, "..", "automation");
const AUTOMATION_DIR = existsSync(join(INSTALLED_AUTOMATION_DIR, "login.py"))
  ? INSTALLED_AUTOMATION_DIR
  : SOURCE_AUTOMATION_DIR;
const VENV_PYTHON = process.platform === "win32"
  ? join(AUTOMATION_DIR, ".venv", "Scripts", "python.exe")
  : join(AUTOMATION_DIR, ".venv", "bin", "python");
const LOGIN_SCRIPT = join(AUTOMATION_DIR, "login.py");
const CLINE_LOGIN_SCRIPT = join(AUTOMATION_DIR, "cline_login.py");
const KIRO_LOGIN_SCRIPT = join(AUTOMATION_DIR, "kiro_login.py");
const QODER_LOGIN_SCRIPT = join(AUTOMATION_DIR, "qoder_login.py");

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

// Dosage notify codes that mean credit is exhausted
const EXHAUSTED_CODES = new Set([14001, 14018]);

/**
 * Fetch Service credit status.
 *
 * Uses /v2/billing/meter/get-dosage-notify (Bearer token — works for all accounts).
 * - dosageNotifyCode 0 = has credit
 * - dosageNotifyCode 14001/14018 = exhausted
 *
 * If cookie is available, also tries /billing/meter/get-user-resource for exact amounts.
 * (get-user-resource returns 401 with Bearer — cookie-only)
 */
export async function checkServiceCredit(
  accessToken: string,
  uid?: string,
  webCookie?: string,
): Promise<CreditResult | null> {
  const baseUrl = "https://www.codebuddy.ai";

  // Step 1: get-dosage-notify (always works with Bearer)
  let exhausted = false;
  let notifyChecked = false;
  try {
    const res = await fetch(`${baseUrl}/v2/billing/meter/get-dosage-notify`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-User-Id": uid || "",
        "X-Product": "SaaS",
        "X-IDE-Type": "CLI",
        "User-Agent": "codebuddy/2.91.0",
      },
      body: "{}",
    });

    if (res.status === 200) {
      const data = await res.json() as any;
      if (data?.code === 0) {
        notifyChecked = true;
        const notifyCode = data?.data?.dosageNotifyCode ?? 0;
        exhausted = EXHAUSTED_CODES.has(notifyCode);
        log.info(`[CreditCheck] dosage-notify code=${notifyCode} exhausted=${exhausted}`);
      }
    }
  } catch (e: any) {
    log.warn(`[CreditCheck] dosage-notify error: ${e.message}`);
  }

  // Step 2: try get-user-resource for exact amounts (cookie-only, Bearer returns 401)
  let detailCredit: CreditResult | null = null;
  if (webCookie?.trim()) {
    detailCredit = await _fetchUserResource(webCookie);
  }

  // Step 3: merge results
  if (detailCredit) {
    // If dosage-notify says exhausted but detail shows remaining > 0, trust dosage-notify
    if (notifyChecked && exhausted && detailCredit.remainingCredits > 0) {
      detailCredit.remainingCredits = 0;
    }
    return detailCredit;
  }

  // No detail available — return default 250 credit with status from dosage-notify
  const DEFAULT_CREDIT = 250;
  if (notifyChecked) {
    return {
      totalCredits: DEFAULT_CREDIT,
      remainingCredits: exhausted ? 0 : DEFAULT_CREDIT,
      usedCredits: exhausted ? DEFAULT_CREDIT : 0,
      packageName: "Free",
      expiresAt: "",
    };
  }

  // Could not reach dosage-notify — return default as fallback
  return {
    totalCredits: DEFAULT_CREDIT,
    remainingCredits: DEFAULT_CREDIT,
    usedCredits: 0,
    packageName: "Free",
    expiresAt: "",
  };
}

/**
 * Internal: call /billing/meter/get-user-resource with cookie auth.
 * Bearer token returns 401 on this endpoint — cookie is required.
 */
async function _fetchUserResource(webCookie: string): Promise<CreditResult | null> {
  const baseUrl = "https://www.codebuddy.ai";
  const now = new Date();
  const begin = now.toISOString().replace("T", " ").slice(0, 19);
  const end = new Date(now.getTime() + 365 * 100 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

  try {
    const res = await fetch(`${baseUrl}/billing/meter/get-user-resource`, {
      method: "POST",
      headers: {
        "Cookie": webCookie,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Referer": `${baseUrl}/profile/usage`,
        "Origin": baseUrl,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 300,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        PackageEndTimeRangeBegin: begin,
        PackageEndTimeRangeEnd: end,
      }),
    });

    if (res.status !== 200) return null;

    const payload = await res.json() as any;
    if (payload?.code !== 0) return null;

    const responseData = payload?.data?.Response?.Data ?? {};
    const totalDosage = Number(responseData.TotalDosage ?? 0);
    const accounts: any[] = responseData.Accounts ?? [];

    let totalRemain = 0;
    let totalUsed = 0;
    let totalSize = 0;
    let packageName = "";
    let expiresAt = "";

    for (const acct of accounts) {
      totalRemain += Number(acct.CapacityRemain ?? 0);
      totalUsed += Number(acct.CapacityUsed ?? 0);
      totalSize += Number(acct.CapacitySize ?? 0);
      if (!packageName) packageName = acct.PackageName ?? "";
      if (!expiresAt) expiresAt = acct.CycleEndTime ?? "";
    }

    return {
      totalCredits: Math.max(totalDosage, totalSize),
      remainingCredits: Math.max(totalDosage, totalRemain),
      usedCredits: totalUsed,
      packageName,
      expiresAt,
    };
  } catch {
    return null;
  }
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
  webCookie?: string;
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

  // Step 4: Save credit info + web cookie if available
  {
    const { updateConnection } = await import("./store.ts");
    const patch: Record<string, unknown> = {};
    if (finalResult.credit) {
      patch.credit = { ...finalResult.credit, fetchedAt: Date.now() };
    }
    if (finalResult.webCookie) {
      patch.webCookie = finalResult.webCookie;
    }
    if (Object.keys(patch).length > 0) {
      await updateConnection(conn.id, patch as any);
    }
  }

  log.ok(`[${accountLabel}] Service connected!`);
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

  // Worker pool pattern: each worker grabs the next account as soon as it finishes.
  // No more waiting for the slowest account in a batch.
  let nextIndex = 0;

  async function worker(workerId: number) {
    while (true) {
      if (isCancelled?.()) break;

      // Grab next account atomically
      const idx = nextIndex++;
      if (idx >= accounts.length) break;

      const account = accounts[idx];
      const label = account.label || account.email;
      const proxy = getRandomProxy?.() ?? undefined;
      if (proxy) log.info(`[${label}] Using proxy: ${proxy}`);

      // Stagger first wave slightly
      if (idx > 0 && idx < concurrency) {
        await Bun.sleep(2000 * (idx % concurrency));
      }

      log.info(`[${idx + 1}/${accounts.length}] ${label} (worker ${workerId + 1})`);

      try {
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
          } else if (provider === "qoder") {
            const r = await oauthQoderAutomated(account.email, account.password, label, proxy, headless);
            providerResults.push({ provider: "qoder", ...r });
          }
        }

        const allSucceeded = providerResults.length > 0 && providerResults.every((pr) => pr.success);
        const anySucceeded = providerResults.some((pr) => pr.success);
        if (allSucceeded) {
          results.success++;
        } else if (anySucceeded) {
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
      } catch (e: any) {
        results.failed++;
        results.errors.push(`${account.email}: ${e.message || "Unknown error"}`);
      }

      // Report progress after each account
      onProgress?.(results.success + results.failed, results.success, results.failed);

      // Small delay between accounts per worker to avoid rate limiting
      await Bun.sleep(2000);
    }
  }

  // Spawn workers
  const workers = Array.from({ length: Math.min(concurrency, accounts.length) }, (_, i) => worker(i));
  await Promise.all(workers);

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

// ---------------------------------------------------------------------------
// Qoder: automated OAuth via browser automation (Camoufox)
// ---------------------------------------------------------------------------

interface QoderLoginResult {
  type: "progress" | "result" | "error" | "debug";
  step?: string;
  message?: string;
  success?: boolean;
  accessToken?: string;
  refreshToken?: string;
  uid?: string;
  email?: string;
  name?: string;
  error?: string;
}

/**
 * Login to Qoder via browser automation (Camoufox).
 * Automates Google OAuth login on qoder.com, then extracts device token.
 */
export async function oauthQoderAutomated(
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

  log.info(`[${accountLabel}] Launching Qoder browser automation...`);

  const proc = Bun.spawn(
    [VENV_PYTHON, QODER_LOGIN_SCRIPT, "--email", email, "--password", password],
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
  let finalResult: QoderLoginResult | null = null;

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
          const msg: QoderLoginResult = JSON.parse(line);
          if (msg.type === "progress") {
            log.info(`[${accountLabel}] ${msg.message}`);
          } else if (msg.type === "result") {
            finalResult = msg;
            const hasAccess = !!msg.accessToken;
            const hasRefresh = !!msg.refreshToken;
            log.info(`[${accountLabel}] Result: success=${msg.success} accessToken=${hasAccess ? "present" : "EMPTY"} refreshToken=${hasRefresh ? "present" : "EMPTY"} uid=${msg.uid ? "present" : "EMPTY"}`);
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
      const msg: QoderLoginResult = JSON.parse(buffer);
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
    log.error(`[${accountLabel}] Qoder automation failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  if (!finalResult || !finalResult.success) {
    const errMsg = finalResult?.error || "Unknown Qoder automation error";
    log.error(`[${accountLabel}] Qoder login failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  // Reject results with empty tokens
  if (!finalResult.accessToken) {
    log.error(`[${accountLabel}] Qoder login succeeded in browser but no token obtained. Skipping save.`);
    return { success: false, error: "No accessToken obtained from Qoder login" };
  }

  // Save connection as "qoder" provider
  const conn = await saveConnection({
    provider: "qoder",
    label: accountLabel,
    accessToken: finalResult.accessToken,
    refreshToken: finalResult.refreshToken || "",
    uid: finalResult.uid || "",
  });

  log.ok(`[${accountLabel}] Qoder connected! (${finalResult.email || finalResult.uid})`);
  return { success: true };
}

/**
 * Legacy: Login to Qoder via device polling flow (manual browser).
 */
export async function oauthQoderDeviceLogin(
  label = "Qoder Account",
): Promise<{ success: boolean; error?: string }> {
  try {
    const nonce = require("crypto").randomBytes(16).toString("hex");

    log.info(`[${label}] Starting Qoder device login...`);
    const loginUrl = `https://qoder.com/device/selectAccounts?nonce=${nonce}`;

    log.info(`Open this URL in your browser to login:`);
    console.log(`\n  ${loginUrl}\n`);

    try {
      const { default: open } = await import("open");
      await open(loginUrl);
    } catch {}

    log.info("Waiting for Qoder login...");
    const result = await _pollQoderDeviceToken(nonce);

    if (!result) {
      return { success: false, error: "Login timeout" };
    }

    await saveConnection({
      provider: "qoder",
      label,
      accessToken: result.security_oauth_token,
      refreshToken: result.refresh_token || "",
      uid: result.uid,
    });

    log.ok(`[${label}] Qoder connected! (${result.email || result.name || result.uid})`);
    return { success: true };
  } catch (e: any) {
    log.error(`[${label}] Qoder login failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Import Qoder credentials from existing CLI auth files.
 * Reads ~/.qoder/.auth/id and ~/.qoder/.auth/user, decrypts, and saves.
 */
export async function importQoderFromCli(
  authDir?: string,
  label = "Qoder (imported)",
): Promise<{ success: boolean; error?: string }> {
  try {
    const fs = require("fs");
    const path = require("path");
    const dir = authDir || path.join(homedir(), ".qoder", ".auth");

    const idFile = path.join(dir, "id");
    const userFile = path.join(dir, "user");

    if (!fs.existsSync(idFile) || !fs.existsSync(userFile)) {
      return { success: false, error: `Qoder auth files not found in ${dir}` };
    }

    const machineId = fs.readFileSync(idFile, "utf8").trim();
    const encryptedUser = fs.readFileSync(userFile, "utf8").trim();

    const { decryptAuthFile } = await import("../proxy/qoder-auth.ts");
    const userInfo = decryptAuthFile(encryptedUser, machineId);

    if (!userInfo) {
      return { success: false, error: "Failed to decrypt Qoder auth file" };
    }

    await saveConnection({
      provider: "qoder",
      label,
      accessToken: userInfo.security_oauth_token,
      refreshToken: "",  // CLI doesn't store refresh token separately
      uid: userInfo.uid,
    });

    log.ok(`[${label}] Qoder imported! (${userInfo.email || userInfo.uid})`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Poll Qoder device token endpoint.
 */
async function _pollQoderDeviceToken(
  nonce: string,
  maxWait = 120000,
): Promise<{ uid: string; security_oauth_token: string; refresh_token: string; name: string; email: string } | null> {
  const { generateSignature } = await import("../proxy/qoder-auth.ts");
  const crypto = require("crypto");
  const start = Date.now();
  const machineToken = crypto.randomUUID().replace(/-/g, "").substring(0, 28);

  while (Date.now() - start < maxWait) {
    await Bun.sleep(1500);

    try {
      const requestId = crypto.randomUUID();
      const bodyStr = JSON.stringify({ nonce });
      const path = "/api/v1/deviceToken/poll";
      const { signature, timestamp } = generateSignature("POST", path, requestId, machineToken, bodyStr);

      const res = await fetch(`https://center.qoder.sh/algo${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Go-http-client/2.0",
          "Authorization": `Signature ${signature}`,
          "X-Client-Timestamp": timestamp,
          "X-Request-Id": requestId,
          "Cosy-Version": "0.1.47",
          "Cosy-MachineToken": machineToken,
          "Cosy-ClientType": "5",
          "Appcode": "cosy",
          "Login-Version": "v2",
        },
        body: bodyStr,
      });

      if (!res.ok) continue;

      const data = await res.json() as any;

      // Check if login completed
      if (data.machineToken || data.uid || data.security_oauth_token) {
        return {
          uid: data.uid || "",
          security_oauth_token: data.security_oauth_token || data.machineToken || "",
          refresh_token: data.refresh_token || "",
          name: data.name || "",
          email: data.email || "",
        };
      }
    } catch {
      // Polling — ignore errors
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Qoder: token refresh
// ---------------------------------------------------------------------------

export async function refreshQoder(
  refreshToken: string,
  uid: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  // Qoder tokens don't expire (machineToken is permanent).
  // If we have a refresh_token from the login flow, try it.
  if (!refreshToken) {
    throw new Error("Qoder: no refresh token available (tokens are permanent, re-login if needed)");
  }

  try {
    const { generateBearerToken } = await import("../proxy/qoder-auth.ts");
    const crypto = require("crypto");

    const userInfo = {
      uid,
      security_oauth_token: refreshToken,
      name: "",
      email: "",
    };

    const path = "/api/v1/deviceToken/refresh";
    const auth = generateBearerToken(userInfo, `/algo${path}`);

    const res = await fetch(`https://center.qoder.sh/algo${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": auth.authToken,
        "Cosy-User": auth.cosyUser,
        "Cosy-Key": auth.cosyKey,
        "Cosy-Date": auth.cosyDate.toString(),
        "Cosy-Version": "0.1.47",
        "Cosy-ClientType": "5",
        "User-Agent": "Go-http-client/2.0",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) throw new Error(`Qoder token refresh failed: ${res.status}`);

    const data = await res.json() as any;
    return {
      accessToken: data.security_oauth_token || data.access_token || refreshToken,
      refreshToken: data.refresh_token || refreshToken,
    };
  } catch (e: any) {
    // Qoder tokens are permanent — if refresh fails, the original token is likely still valid
    log.warn(`Qoder token refresh failed (tokens are permanent): ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Qoder: token verification
// ---------------------------------------------------------------------------

export async function checkQoderToken(
  accessToken: string,
  uid: string,
): Promise<{ valid: boolean; plan?: string; isQuotaExceeded?: boolean; email?: string }> {
  try {
    const { checkQoderStatus } = await import("../proxy/qoder-auth.ts");
    const userInfo = {
      uid,
      security_oauth_token: accessToken,
      name: "",
      email: "",
    };
    return await checkQoderStatus(userInfo);
  } catch {
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// Codex: Token refresh (ROTATING refresh tokens!)
// ---------------------------------------------------------------------------

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL="https://auth.openai.com/oauth/token";

/**
 * Extract email and plan type from Codex access token JWT.
 */
export function parseCodexToken(accessToken: string): { email?: string; planType?: string; userId?: string } {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return {};
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const auth = payload["https://api.openai.com/auth"] || {};
    const profile = payload["https://api.openai.com/profile"] || {};
    return {
      email: profile.email,
      planType: auth.chatgpt_plan_type,
      userId: auth.chatgpt_user_id,
    };
  } catch {
    return {};
  }
}

// Mutex to prevent concurrent refresh of the same rotating token
const codexRefreshLocks = new Map<string, Promise<{ accessToken: string; refreshToken: string }>>();

export async function refreshCodex(
  refreshToken: string,
  connectionId: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const existing = codexRefreshLocks.get(connectionId);
  if (existing) {
    log.info(`[codex] Waiting for in-progress refresh for ${connectionId}`);
    return existing;
  }

  const refreshPromise = (async () => {
    try {
      const res = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CODEX_CLIENT_ID,
          refresh_token: refreshToken,
        }),
      });

      if (!res.ok) {
        const error = await res.text();
        throw new Error(`Codex token refresh failed (${res.status}): ${error}`);
      }

      const data = await res.json();
      log.info(`[codex] Token refreshed successfully (expires in ${data.expires_in}s)`);

      // CRITICAL: Save new rotating refresh token atomically
      await saveConnection(connectionId, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
      });

      return { accessToken: data.access_token, refreshToken: data.refresh_token };
    } finally {
      codexRefreshLocks.delete(connectionId);
    }
  })();

  codexRefreshLocks.set(connectionId, refreshPromise);
  return refreshPromise;
}

/**
 * Check if a Codex access token (JWT) is expired or near expiry.
 */
export function isCodexTokenExpired(accessToken: string, bufferSeconds = 86400): boolean {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return true;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return !payload.exp || (payload.exp - bufferSeconds) < (Date.now() / 1000);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Codex: OAuth PKCE login (browser-based, port 1455)
// ---------------------------------------------------------------------------

export async function oauthCodexLogin(): Promise<{
  accessToken: string;
  refreshToken: string;
  email: string;
  planType: string;
}> {
  // Generate PKCE
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");

  const CODEX_PORT = 1455;
  const redirectUri = `http://localhost:${CODEX_PORT}/auth/callback`;

  // Build auth URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
    state,
  });
  const authUrl = `https://auth.openai.com/oauth/authorize?${params.toString()}`;

  // Start local server on port 1455
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.stop();
      reject(new Error("Codex OAuth timeout (5 minutes)"));
    }, 300000);

    const server = Bun.serve({
      port: CODEX_PORT,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/auth/callback") {
          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");

          if (!code || returnedState !== state) {
            return new Response("Invalid callback", { status: 400 });
          }

          // Exchange code for tokens
          try {
            const tokenRes = await fetch(CODEX_TOKEN_URL, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: CODEX_CLIENT_ID,
                code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier,
              }),
            });

            if (!tokenRes.ok) {
              throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
            }

            const tokens = await tokenRes.json() as {
              access_token: string;
              refresh_token: string;
              id_token: string;
              expires_in: number;
            };

            const parsed = parseCodexToken(tokens.access_token);

            clearTimeout(timeout);
            server.stop();

            resolve({
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              email: parsed.email || "unknown",
              planType: parsed.planType || "unknown",
            });
          } catch (err) {
            clearTimeout(timeout);
            server.stop();
            reject(err);
          }

          return new Response(
            `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
              <div style="text-align:center"><h1>✓ Codex Connected</h1><p>You can close this tab.</p></div>
              <script>setTimeout(()=>window.close(),2000)</script>
            </body></html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });

    log.info(`[codex] OAuth server started on port ${CODEX_PORT}`);
    log.info(`[codex] Auth URL: ${authUrl}`);
  });
}

export async function checkKiroToken(accessToken: string, profileArn?: string): Promise<{ valid: boolean; suspended?: boolean; usage?: any }> {
  try {
    // Step 1: Check usage/quota API for token validity + credit info
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

    if (res.status === 401) return { valid: false };
    if (res.status === 403) {
      // Check if suspended
      try {
        const body = await res.text();
        if (body.toLowerCase().includes("suspended") || body.toLowerCase().includes("locked")) {
          return { valid: false, suspended: true };
        }
      } catch {}
      return { valid: false };
    }
    if (!res.ok) return { valid: false };

    const data = await res.json() as any;

    // Step 2: Probe chat API to detect suspended accounts
    // (usage API returns 200 even for suspended accounts)
    try {
      const probeRes = await fetch("https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/vnd.amazon.eventstream",
          "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
          "User-Agent": "AWS-SDK-JS/3.0 kiro-ide/1.0.0",
          "Authorization": `Bearer ${accessToken}`,
          "Amz-Sdk-Request": "attempt=1; max=3",
          "Amz-Sdk-Invocation-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationState: {
            chatTriggerType: "MANUAL",
            conversationId: crypto.randomUUID(),
            currentMessage: {
              userInputMessage: {
                content: "hi",
                modelId: "claude-haiku-4.5",
                origin: "AI_EDITOR",
              },
            },
            history: [],
          },
          profileArn: profileArn || "arn:aws:codewhisperer:us-east-1:63861613270:profile/AAACCXX",
          inferenceConfig: { maxTokens: 1 },
        }),
      });

      if (probeRes.status === 403) {
        try {
          const probeBody = await probeRes.text();
          const lower = probeBody.toLowerCase();
          if (lower.includes("suspended") || lower.includes("locked") || lower.includes("banned")) {
            log.warn(`[Kiro check] Account suspended: ${probeBody.slice(0, 150)}`);
            return { valid: false, suspended: true };
          }
        } catch {}
        return { valid: false, suspended: true };
      }
      // If probe succeeds (200) or returns other errors (400, 429), account is not suspended
      // Abort the response body to avoid consuming the stream
      try { probeRes.body?.cancel(); } catch {}
    } catch {
      // Network error on probe — don't fail the whole check, just skip
    }

    // Step 3: Parse usage data
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

