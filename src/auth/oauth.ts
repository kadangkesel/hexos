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

  // Step 3: Save connection (even if token is empty - auth succeeded in browser)
  const hasToken = !!finalResult.accessToken;
  const conn = await saveConnection({
    provider: "codebuddy",
    label: accountLabel,
    accessToken: finalResult.accessToken || "",
    refreshToken: finalResult.refreshToken || "",
    uid: finalResult.uid || "",
  });

  if (!hasToken) {
    log.warn(`[${accountLabel}] Saved without token (token poll failed). Account may need re-auth.`);
  }

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
): Promise<{ total: number; success: number; failed: number; errors: string[] }> {
  // Import proxy pool for random proxy selection
  let getRandomProxy: (() => string | null) | null = null;
  try {
    const pool = await import("../proxy/pool.ts");
    getRandomProxy = pool.getRandomProxy;
  } catch {}

  const results = { total: accounts.length, success: 0, failed: 0, errors: [] as string[] };

  log.info(`Batch connecting ${accounts.length} accounts (concurrency: ${concurrency})...`);

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
      return oauthCodebuddyAutomated(account.email, account.password, label, proxy, headless);
    });

    const batchResults = await Promise.allSettled(promises);

    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      const account = batch[j];
      if (r.status === "fulfilled" && r.value.success) {
        results.success++;
      } else {
        results.failed++;
        const errMsg = r.status === "fulfilled"
          ? r.value.error || "Unknown error"
          : r.reason?.message || "Unknown error";
        results.errors.push(`${account.email}: ${errMsg}`);
      }
    }

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
