/**
 * Qoder Authentication & Body Encryption
 *
 * Implements the full Qoder auth algorithm reverse-engineered from
 * QoderCLI v0.1.47 (Go) and Qoder IDE v0.14.1 (Electron).
 *
 * Two auth modes:
 *   1. Signature Auth (anonymous) — HMAC-SHA256 for heartbeat/status endpoints
 *   2. Bearer COSY Auth (logged in) — AES-128-CBC + RSA-1024 for inference
 *
 * Body encryption: AES-128-CBC with random key, key wrapped via RSA-1024.
 */

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Secret key — obfuscated in binary as reversed base64 "==Qez92Y" → "cosy" */
const SECRET = "cosy";

/** RSA-1024 public key — hardcoded in both CLI and IDE */
const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** Default product version (CLI) */
const COSY_VERSION = "0.1.47";

/** Default IDE version */
const IDE_VERSION = "0.14.1";

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function md5(data: string): string {
  return crypto.createHash("md5").update(data, "utf8").digest("hex");
}

function hmacSha256(key: string, data: string): string {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/** AES-128-CBC encrypt. IV = key[0:16]. Returns base64. */
function aesEncrypt(plaintext: string, key: string): string {
  const keyBuf = Buffer.from(key, "utf8");
  const iv = keyBuf.slice(0, 16);
  const cipher = crypto.createCipheriv("aes-128-cbc", keyBuf, iv);
  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return encrypted.toString("base64");
}

/** AES-128-CBC decrypt. IV = key[0:16]. Input is base64. */
export function aesDecrypt(ciphertext: string, key: string): string {
  const keyBuf = Buffer.from(key, "utf8");
  const iv = keyBuf.slice(0, 16);
  const decipher = crypto.createDecipheriv("aes-128-cbc", keyBuf, iv);
  let decrypted = decipher.update(ciphertext, "base64");
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

/** RSA-PKCS1 encrypt with the hardcoded public key. Returns base64. */
function rsaEncrypt(data: Buffer): string {
  const encrypted = crypto.publicEncrypt(
    { key: RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    data,
  );
  return encrypted.toString("base64");
}

/** Generate a random 16-char hex string (from UUID without dashes) */
function randomKey16(): string {
  return crypto.randomUUID().replace(/-/g, "").substring(0, 16);
}

// ---------------------------------------------------------------------------
// User info stored per-connection
// ---------------------------------------------------------------------------

export interface QoderUserInfo {
  uid: string;
  security_oauth_token: string;
  name: string;
  email: string;
  aid?: string;
}

// ---------------------------------------------------------------------------
// Mode 1: Signature Auth (anonymous endpoints)
// ---------------------------------------------------------------------------

export interface SignatureResult {
  signature: string;
  timestamp: string;
}

/**
 * Generate HMAC-SHA256 signature for anonymous endpoints.
 *
 * @param method - HTTP method (GET/POST)
 * @param path - URL path WITHOUT /algo prefix and WITHOUT query params
 * @param requestId - UUID v4
 * @param machineToken - from login (or random for anonymous)
 * @param body - request body string
 * @param version - product version (default: 0.1.47)
 */
export function generateSignature(
  method: string,
  path: string,
  requestId: string,
  machineToken: string,
  body: string,
  version = COSY_VERSION,
): SignatureResult {
  const secretKey = sha256(`${SECRET}:${version}:${machineToken}`);
  const bodyHash = sha256(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const signString = [method, path, requestId, machineToken, timestamp, bodyHash].join("\n");
  const signature = hmacSha256(secretKey, signString);

  return { signature, timestamp };
}

// ---------------------------------------------------------------------------
// Mode 2: Bearer COSY Auth (logged-in endpoints)
// ---------------------------------------------------------------------------

export interface BearerAuthResult {
  authToken: string;       // "Bearer COSY.{base64_payload}.{md5_signature}"
  cosyKey: string;         // RSA-encrypted AES key (base64) → Cosy-Key header
  cosyUser: string;        // User UID → Cosy-User header
  cosyDate: number;        // Unix timestamp → Cosy-Date header
  aesKey: string;          // Raw AES key (16 chars) — needed for body encryption
}

/**
 * Generate Bearer COSY token for authenticated endpoints.
 *
 * @param userInfo - User credentials (uid, oauth_token, name, email)
 * @param urlPath - Full URL path (e.g., /algo/api/v2/service/pro/sse/agent_chat_generation)
 * @param cosyVersion - CLI version (default: 0.1.47)
 * @param ideVersion - IDE version (default: 0.14.1)
 */
export function generateBearerToken(
  userInfo: QoderUserInfo,
  urlPath: string,
  bodyStr = "",
  cosyVersion = COSY_VERSION,
  ideVersion = IDE_VERSION,
): BearerAuthResult {
  // 1. Generate random AES key (16 chars)
  const aesKey = randomKey16();

  // 2. AES-128-CBC encrypt user info
  const userInfoJson = JSON.stringify({
    uid: userInfo.uid,
    security_oauth_token: userInfo.security_oauth_token,
    name: userInfo.name,
    aid: userInfo.aid || "",
    email: userInfo.email,
  });
  const encryptedInfo = aesEncrypt(userInfoJson, aesKey);

  // 3. RSA encrypt the AES key
  const encryptedKey = rsaEncrypt(Buffer.from(aesKey, "utf8"));

  // 4. Build auth payload
  const payload = JSON.stringify({
    version: "v1",
    requestId: crypto.randomUUID().replace(/-/g, ""),
    info: encryptedInfo,
    cosyVersion,
    ideVersion,
  });
  const base64Payload = Buffer.from(payload, "utf8").toString("base64");

  // 5. Calculate signature
  // From IDE source: calculateSignature(t, e, i, s, r)
  //   o = `${t}\n${e}\n${i}\n${s}\n${n}`
  //   where t=base64Payload, e=cosyKey, i=timestamp, s=body, n=cleanPath
  //   return md5Encode(o)  — md5Encode joins args with "&" but gets 1 arg so just md5(o)
  let cleanPath: string;
  try {
    cleanPath = new URL(urlPath).pathname;
  } catch {
    cleanPath = urlPath;
  }
  const qIdx = cleanPath.indexOf("?");
  if (qIdx > 0) cleanPath = cleanPath.substring(0, qIdx);
  if (cleanPath.startsWith("/algo")) cleanPath = cleanPath.slice(5);

  const timestamp = Math.floor(Date.now() / 1000);
  const signInput = `${base64Payload}\n${encryptedKey}\n${timestamp}\n${bodyStr}\n${cleanPath}`;
  const signature = md5(signInput);

  // 6. Build final token
  return {
    authToken: `Bearer COSY.${base64Payload}.${signature}`,
    cosyKey: encryptedKey,
    cosyUser: userInfo.uid,
    cosyDate: timestamp,
    aesKey,
  };
}

// ---------------------------------------------------------------------------
// Body encryption for inference endpoint
// ---------------------------------------------------------------------------

/**
 * Encrypt request body for Qoder inference endpoint.
 * Uses AES-128-CBC with a random key. The key is RSA-encrypted and sent
 * via the Cosy-Key header (already included in Bearer auth).
 *
 * The same AES key used for Bearer auth user info encryption is reused
 * for body encryption in the actual implementation. However, since we
 * generate a fresh Bearer token per request, we use the same key.
 *
 * @param body - JSON string to encrypt
 * @param aesKey - 16-char AES key (same as used in Bearer token generation)
 * @returns Encrypted body string (base64)
 */
export function encryptBody(body: string, aesKey: string): string {
  return aesEncrypt(body, aesKey);
}

/**
 * Generate complete auth headers + encrypted body for a Qoder inference request.
 * This is the main entry point used by the proxy handler.
 */
export function buildQoderRequest(
  userInfo: QoderUserInfo,
  bodyJson: string,
  urlPath: string,
  machineId?: string,
  machineToken?: string,
): {
  headers: Record<string, string>;
  encryptedBody: string;
} {
  // Generate random machine identity per-request (like CLI does)
  const mId = machineId || crypto.randomUUID();
  const mToken = machineToken || crypto.randomUUID().replace(/-/g, "").substring(0, 28);
  const mType = crypto.createHash("md5").update(mId).digest("hex").substring(0, 18);

  // Generate Bearer COSY token (signature includes plaintext body)
  const auth = generateBearerToken(userInfo, urlPath, bodyJson);

  // Build headers — Cosy-Key MUST match the key used in signature calculation
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "Accept-Encoding": "identity",
    "Cache-Control": "no-cache",
    "User-Agent": "Go-http-client/2.0",

    // Auth headers — Cosy-Key is the RSA-encrypted AES key from auth token generation
    "Authorization": auth.authToken,
    "Cosy-User": auth.cosyUser,
    "Cosy-Key": auth.cosyKey,
    "Cosy-Date": auth.cosyDate.toString(),

    // Machine headers
    "Cosy-Version": COSY_VERSION,
    "Cosy-MachineId": mId,
    "Cosy-MachineToken": mToken,
    "Cosy-MachineType": mType,
    "Cosy-ClientType": "5",  // 5 = CLI
    "Cosy-Data-Policy": "AGREE",

    // Request metadata
    "X-Request-Id": crypto.randomUUID(),
  };

  // Send plaintext body (no encryption) — Encode=1 is NOT used
  // Server accepts plaintext JSON when Encode param is absent
  return { headers, encryptedBody: bodyJson };
}

// ---------------------------------------------------------------------------
// Auth file decryption (for importing existing CLI credentials)
// ---------------------------------------------------------------------------

/**
 * Decrypt Qoder CLI auth file (~/.qoder/.auth/user).
 * Key = first 16 chars of machineId (from ~/.qoder/.auth/id).
 */
export function decryptAuthFile(encryptedContent: string, machineId: string): QoderUserInfo | null {
  try {
    const key = machineId.substring(0, 16);
    const decrypted = aesDecrypt(encryptedContent, key);
    const parsed = JSON.parse(decrypted);
    return {
      uid: parsed.uid || parsed.aid || "",
      security_oauth_token: parsed.security_oauth_token || parsed.access_token || "",
      name: parsed.name || "",
      email: parsed.email || "",
      aid: parsed.aid || "",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Qoder inference URL builder
// ---------------------------------------------------------------------------

const INFERENCE_BASE = "https://api2.qoder.sh";
const INFERENCE_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";

/**
 * Build the full inference URL with query parameters.
 */
export function buildInferenceUrl(): string {
  return `${INFERENCE_BASE}${INFERENCE_PATH}?FetchKeys=llm_model_result&AgentId=agent_common`;
}

/**
 * Build the inference URL path (for signature calculation).
 */
export function getInferencePath(): string {
  return INFERENCE_PATH;
}

// ---------------------------------------------------------------------------
// Qoder status/quota check
// ---------------------------------------------------------------------------

/**
 * Check Qoder user status and quota.
 */
export async function checkQoderStatus(
  userInfo: QoderUserInfo,
  machineToken?: string,
): Promise<{ valid: boolean; plan?: string; isQuotaExceeded?: boolean; email?: string; nextResetAt?: number }> {
  try {
    const mToken = machineToken || crypto.randomUUID().replace(/-/g, "").substring(0, 28);
    const requestId = crypto.randomUUID();
    const path = "/api/v3/user/status";
    const fullPath = `/algo${path}`;

    const { signature, timestamp } = generateSignature("POST", path, requestId, mToken, "", COSY_VERSION);

    const auth = generateBearerToken(userInfo, fullPath, "{}");

    const res = await fetch(`https://center.qoder.sh${fullPath}?Encode=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "Go-http-client/2.0",
        "Authorization": auth.authToken,
        "Cosy-User": auth.cosyUser,
        "Cosy-Key": auth.cosyKey,
        "Cosy-Date": auth.cosyDate.toString(),
        "Cosy-Version": COSY_VERSION,
        "Cosy-MachineToken": mToken,
        "Cosy-ClientType": "5",
        "Cosy-Data-Policy": "AGREE",
        "X-Request-Id": requestId,
      },
      body: "{}",
    });

    if (!res.ok) return { valid: false };

    const data = await res.json() as any;
    return {
      valid: true,
      plan: data.plan || data.userTag || "Free",
      isQuotaExceeded: data.isQuotaExceeded ?? false,
      email: data.email || userInfo.email,
      nextResetAt: data.nextResetAt,
    };
  } catch {
    return { valid: false };
  }
}
