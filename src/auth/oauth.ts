import { saveConnection } from "./store.ts";
import { log } from "../utils/logger.ts";

// CodeBuddy OAuth device-code flow
export async function oauthCodebuddy(label = "Account 1"): Promise<void> {
  // Step 1: Request device code
  const stateRes = await fetch("https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Domain": "www.codebuddy.ai",
      "User-Agent": "codebuddy/2.91.0",
    },
    body: JSON.stringify({}),
  });

  const stateData = await stateRes.json() as any;
  if (stateData.code !== 0) throw new Error(`Failed to get auth state: ${JSON.stringify(stateData)}`);

  const { state, authUrl } = stateData.data;
  // Ensure URL uses codebuddy.ai domain
  const loginUrl = (authUrl as string).replace("copilot.tencent.com", "www.codebuddy.ai");

  log.info(`Open this URL in your browser to login:`);
  console.log(`\n  ${loginUrl}\n`);

  // Try to open browser automatically
  try {
    const { default: open } = await import("open");
    await open(loginUrl);
  } catch {}

  // Step 2: Poll for token
  log.info("Waiting for login...");
  const token = await pollCodebuddy(state);

  // Step 3: Get uid
  let uid = "";
  try {
    const accountRes = await fetch("https://www.codebuddy.ai/v2/plugin/accounts", {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "X-Domain": "www.codebuddy.ai",
        "User-Agent": "codebuddy/2.91.0",
      },
    });
    const accountData = await accountRes.json() as any;
    uid = accountData?.data?.uid ?? accountData?.data?.userId ?? "";
  } catch {}

  await saveConnection({
    provider: "codebuddy",
    label,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    uid,
  });

  log.ok(`CodeBuddy connected! (${label})`);
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
