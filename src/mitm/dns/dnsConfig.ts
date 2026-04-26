import { exec, spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { TOOL_HOSTS } from "../config.ts";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const HOSTS_FILE = IS_WIN
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

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
      const toAppend = entriesToAdd.map((h) => `127.0.0.1 ${h}`).join("\r\n") + "\r\n";
      fs.appendFileSync(HOSTS_FILE, toAppend, "utf8");
      execSync("ipconfig /flushdns", { windowsHide: true });
    } else {
      await execWithPassword(`echo "${entries}" >> ${HOSTS_FILE}`, sudoPassword);
      await flushDNS(sudoPassword);
    }
    console.log(`🌐 DNS ${tool}: ✅ added ${entriesToAdd.join(", ")}`);
  } catch (error: any) {
    const msg = error.message?.includes("incorrect password") ? "Wrong sudo password" : "Failed to add DNS entry";
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
      const content = fs.readFileSync(HOSTS_FILE, "utf8");
      const filtered = content.split(/\r?\n/).filter((l) => !entriesToRemove.some((h) => l.includes(h))).join("\r\n");
      fs.writeFileSync(HOSTS_FILE, filtered, "utf8");
      execSync("ipconfig /flushdns", { windowsHide: true });
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
    const msg = error.message?.includes("incorrect password") ? "Wrong sudo password" : "Failed to remove DNS entry";
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
