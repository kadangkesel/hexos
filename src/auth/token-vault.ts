import { existsSync, mkdirSync, renameSync, copyFileSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export interface TokenBundle {
  provider: string;
  connectionId: string;
  accessToken: string;
  refreshToken: string;
  previousRefreshToken?: string;
  generation: number;
  updatedAt: number;
  source?: string;
  refreshInProgress?: boolean;
  refreshStartedAt?: number;
  refreshLockExpiresAt?: number;
}

interface TokenVaultData {
  bundles: TokenBundle[];
}

const DEFAULT_VAULT_FILE = join(homedir(), ".hexos", "token-vault.json");
const DEFAULT_BACKUP_DIR = join(homedir(), ".hexos", "token-backups");

function vaultFile(): string {
  return process.env.HEXOS_TOKEN_VAULT_FILE || DEFAULT_VAULT_FILE;
}

function backupDir(): string {
  return process.env.HEXOS_TOKEN_VAULT_BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

function ensureDirs() {
  mkdirSync(dirname(vaultFile()), { recursive: true });
  mkdirSync(backupDir(), { recursive: true });
}

function readVault(): TokenVaultData {
  ensureDirs();
  if (!existsSync(vaultFile())) return { bundles: [] };
  try {
    const parsed = JSON.parse(readFileSync(vaultFile(), "utf8"));
    return { bundles: Array.isArray(parsed?.bundles) ? parsed.bundles : [] };
  } catch {
    return { bundles: [] };
  }
}

async function writeVault(data: TokenVaultData) {
  ensureDirs();
  const file = vaultFile();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function backupVault(reason: string) {
  const file = vaultFile();
  if (!existsSync(file)) return;
  const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dest = join(backupDir(), `token-vault-${Date.now()}-${safeReason}.json`);
  try { copyFileSync(file, dest); } catch {}
}

function findBundle(data: TokenVaultData, provider: string, connectionId: string): TokenBundle | undefined {
  return data.bundles.find((b) => b.provider === provider && b.connectionId === connectionId);
}

export async function getLatestTokenBundle(provider: string, connectionId: string): Promise<TokenBundle | null> {
  const data = readVault();
  return findBundle(data, provider, connectionId) ?? null;
}

export async function saveTokenBundle(
  provider: string,
  connectionId: string,
  tokens: { accessToken: string; refreshToken: string; source?: string },
): Promise<TokenBundle> {
  const data = readVault();
  const existing = findBundle(data, provider, connectionId);
  const next: TokenBundle = {
    provider,
    connectionId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    previousRefreshToken: existing?.refreshToken,
    generation: (existing?.generation ?? 0) + 1,
    updatedAt: Date.now(),
    source: tokens.source,
    refreshInProgress: false,
  };

  backupVault("save");
  if (existing) Object.assign(existing, next);
  else data.bundles.push(next);
  await writeVault(data);
  return next;
}

/**
 * Reserve a rotating refresh token before calling the upstream token endpoint.
 * This cross-process lock prevents two server instances from spending the same
 * refresh token concurrently. A crashed server leaves an expiring reservation.
 */
export async function reserveRefreshToken(
  provider: string,
  connectionId: string,
  lockTtlMs = 5 * 60_000,
): Promise<{ refreshToken: string; generation: number }> {
  const data = readVault();
  const bundle = findBundle(data, provider, connectionId);
  if (!bundle?.refreshToken) throw new Error("No refresh token in token vault");

  const now = Date.now();
  if (bundle.refreshInProgress && (bundle.refreshLockExpiresAt ?? 0) > now) {
    throw new Error("Refresh token already reserved by another process");
  }

  backupVault("reserve");
  bundle.refreshInProgress = true;
  bundle.refreshStartedAt = now;
  bundle.refreshLockExpiresAt = now + lockTtlMs;
  bundle.updatedAt = now;
  await writeVault(data);

  return { refreshToken: bundle.refreshToken, generation: bundle.generation };
}

/**
 * Commit the newly rotated token only if the vault is still at the generation
 * we reserved. This stops stale booted processes from overwriting newer tokens.
 */
export async function commitRefreshToken(
  provider: string,
  connectionId: string,
  reservedGeneration: number,
  tokens: { accessToken: string; refreshToken: string; source?: string },
): Promise<TokenBundle> {
  const data = readVault();
  const bundle = findBundle(data, provider, connectionId);
  if (!bundle) throw new Error("No token bundle in token vault");
  if (bundle.generation !== reservedGeneration) {
    throw new Error("Token generation changed while refresh was in progress");
  }

  backupVault("commit");
  const previous = bundle.refreshToken;
  bundle.accessToken = tokens.accessToken;
  bundle.refreshToken = tokens.refreshToken;
  bundle.previousRefreshToken = previous;
  bundle.generation += 1;
  bundle.updatedAt = Date.now();
  bundle.source = tokens.source;
  bundle.refreshInProgress = false;
  delete bundle.refreshStartedAt;
  delete bundle.refreshLockExpiresAt;
  await writeVault(data);
  return bundle;
}

export async function releaseRefreshToken(
  provider: string,
  connectionId: string,
  reservedGeneration: number,
  onlyIfExpired = false,
): Promise<void> {
  const data = readVault();
  const bundle = findBundle(data, provider, connectionId);
  if (!bundle || bundle.generation !== reservedGeneration) return;
  if (onlyIfExpired && (bundle.refreshLockExpiresAt ?? 0) > Date.now()) return;

  backupVault("release");
  bundle.refreshInProgress = false;
  delete bundle.refreshStartedAt;
  delete bundle.refreshLockExpiresAt;
  bundle.updatedAt = Date.now();
  await writeVault(data);
}
