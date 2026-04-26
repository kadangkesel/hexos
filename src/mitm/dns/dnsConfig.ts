import { exec, spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { TOOL_HOSTS } from "../config.ts";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const HOSTS_FILE = IS_WIN
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

/**
 * Run a command with admin elevation on Windows.
 * Writes a temp .ps1 script, launches it via Start-Process -Verb RunAs,
 * and polls a flag file to know when it's done.
 */
function runElevatedWindows(command: string, timeoutMs: number = 30000): void {
  const ts = Date.now();
  const tmpDir = os.tmpdir();
  const scriptPath = path.join(tmpDir, `hexos_dns_${ts}.ps1`);
  const flagPath = path.join(tmpDir, `hexos_dns_${ts}.flag`);
  const errPath = path.join(tmpDir, `hexos_dns_${ts}.err`);

  const script = [
    `try {`,
    `  ${command}`,
    `  Set-Content -Path '${flagPath.replace(/'/g, "''")}' -Value 'ok'`,
    `} catch {`,
    `  Set-Content -Path '${errPath.replace(/'/g, "''")}' -Value $_.Exception.Message`,
    `}`,
  ].join("\r\n");
  fs.writeFileSync(scriptPath, script, "utf8");

  try {
    execSync(
      `powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','handle','-File','${scriptPath.replace(/'/g, "''")}' -Verb RunAs -Wait"`,
      { timeout: timeoutMs, windowsHide: false },
    );
  } catch (e: any) {
    // Log the actual error for debugging
    console.error(`[MITM] Elevated command failed: ${e.message}`);
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(flagPath)) {
      try { fs.unlinkSync(flagPath); } catch {}
      try { fs.unlinkSync(scriptPath); } catch {}
      return;
    }
    if (fs.existsSync(errPath)) {
      const errMsg = fs.readFileSync(errPath, "utf8").trim();
      console.error(`[MITM] Elevated script error: ${errMsg}`);
      try { fs.unlinkSync(errPath); } catch {}
      try { fs.unlinkSync(scriptPath); } catch {}
      throw new Error(errMsg || "Elevated command failed");
    }
    const start = Date.now();
    while (Date.now() - start < 100) { /* spin */ }
  }
  // Don't delete script on timeout — leave for debugging
  console.error(`[MITM] Elevated command timed out. Script at: ${scriptPath}`);
  throw new Error("Admin elevation timed out or was cancelled");
}

export function isSudoAvailable(): boolean {
  if (IS_WIN) return false;
  try {
    execSync("command -v sudo", { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function execWithPassword(command: string, password: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const useSudo = isSudoAvailable();
    const child = useSudo
      ? spawn("sudo", ["-S", "sh", "-c", command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d; });
    child.stderr.on("data", (d: Buffer) => { stderr += d; });

    child.on("close", (code: number) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });

    if (useSudo && password) {
      child.stdin!.write(`${password}\n`);
      child.stdin!.end();
    }
  });
}

async function flushDNS(sudoPassword: string | null): Promise<void> {
  if (IS_WIN) return;
  if (IS_MAC) {
    await execWithPassword("dscacheutil -flushcache && killall -HUP mDNSResponder", sudoPassword);
  } else {
    await execWithPassword("resolvectl flush-caches 2>/dev/null || true", sudoPassword);
  }
}

function checkDNSEntry(host: string): boolean {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    return hostsContent.includes(host);
  } catch {
    return false;
  }
}

export function checkAllDNSStatus(): Record<string, boolean> {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    const result: Record<string, boolean> = {};
    for (const [tool, hosts] of Object.entries(TOOL_HOSTS)) {
      result[tool] = hosts.every((h) => hostsContent.includes(h));
    }
    return result;
  } catch {
    return Object.fromEntries(Object.keys(TOOL_HOSTS).map((t) => [t, false]));
  }
}

export async function addDNSEntry(tool: string, sudoPassword: string | null): Promise<void> {
  const hosts = TOOL_HOSTS[tool];
  if (!hosts) throw new Error(`Unknown tool: ${tool}`);
  const entriesToAdd = hosts.filter((h) => !checkDNSEntry(h));
  if (entriesToAdd.length === 0) {
    console.log(`🌐 DNS ${tool}: already active`);
    return;
  }
  const entries = entriesToAdd.map((h) => `127.0.0.1 ${h}`).join("\n");
  try {
    if (IS_WIN) {
      // Windows: use elevated PowerShell to append each entry to hosts file
      const hostsEsc = HOSTS_FILE.replace(/'/g, "''");
      const cmds = entriesToAdd.map((h) => `Add-Content -Path '${hostsEsc}' -Value '127.0.0.1 ${h}' -Encoding UTF8`);
      cmds.push("ipconfig /flushdns | Out-Null");
      runElevatedWindows(cmds.join("; "));
    } else {
      await execWithPassword(`echo "${entries}" >> ${HOSTS_FILE}`, sudoPassword);
      await flushDNS(sudoPassword);
    }
    console.log(`🌐 DNS ${tool}: ✅ added ${entriesToAdd.join(", ")}`);
  } catch (error: any) {
    const msg = error.message?.includes("incorrect password") ? "Wrong sudo password"
      : IS_WIN && error.message?.includes("canceled") ? "Admin elevation was cancelled"
      : "Failed to add DNS entry";
    throw new Error(msg);
  }
}

export async function removeDNSEntry(tool: string, sudoPassword: string | null): Promise<void> {
  const hosts = TOOL_HOSTS[tool];
  if (!hosts) throw new Error(`Unknown tool: ${tool}`);
  const entriesToRemove = hosts.filter((h) => checkDNSEntry(h));
  if (entriesToRemove.length === 0) {
    console.log(`🌐 DNS ${tool}: already inactive`);
    return;
  }
  try {
    if (IS_WIN) {
      // Windows: use elevated PowerShell to remove entries from hosts file
      const hostsEsc = HOSTS_FILE.replace(/'/g, "''");
      // Build a simple filter: read file, exclude lines containing any of the hosts, write back
      const conditions = entriesToRemove.map((h) => `$_ -notmatch '${h}'`).join(" -and ");
      const cmd = `(Get-Content '${hostsEsc}') | Where-Object { ${conditions} } | Set-Content '${hostsEsc}' -Encoding UTF8; ipconfig /flushdns | Out-Null`;
      runElevatedWindows(cmd);
    } else {
      for (const host of entriesToRemove) {
        const sedCmd = IS_MAC
          ? `sed -i '' '/${host}/d' ${HOSTS_FILE}`
          : `sed -i '/${host}/d' ${HOSTS_FILE}`;
        await execWithPassword(sedCmd, sudoPassword);
      }
      await flushDNS(sudoPassword);
    }
    console.log(`🌐 DNS ${tool}: ✅ removed ${entriesToRemove.join(", ")}`);
  } catch (error: any) {
    const msg = error.message?.includes("incorrect password") ? "Wrong sudo password"
      : IS_WIN && error.message?.includes("canceled") ? "Admin elevation was cancelled"
      : "Failed to remove DNS entry";
    throw new Error(msg);
  }
}

export async function removeAllDNSEntries(sudoPassword: string | null): Promise<void> {
  for (const tool of Object.keys(TOOL_HOSTS)) {
    try {
      await removeDNSEntry(tool, sudoPassword);
    } catch (e: any) {
      console.error(`DNS ${tool}: failed to remove — ${e.message}`);
    }
  }
}
