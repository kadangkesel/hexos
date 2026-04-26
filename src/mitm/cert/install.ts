import fs from "fs";
import crypto from "crypto";
import { exec, execSync } from "child_process";
import { execWithPassword, isSudoAvailable } from "../dns/dnsConfig.ts";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const LINUX_CERT_DIR = "/usr/local/share/ca-certificates";
const CA_COMMON_NAME = "Hexos MITM Root CA";

function getCertFingerprint(certPath: string): string {
  const pem = fs.readFileSync(certPath, "utf-8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  return crypto.createHash("sha1").update(der).digest("hex").toUpperCase().match(/.{2}/g)!.join(":");
}

export async function checkCertInstalled(certPath: string): Promise<boolean> {
  if (IS_WIN) return checkCertInstalledWindows();
  if (IS_MAC) return checkCertInstalledMac(certPath);
  return checkCertInstalledLinux();
}

function checkCertInstalledMac(certPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      exec(
        `security verify-cert -c "${certPath}" -p ssl -k /Library/Keychains/System.keychain 2>/dev/null`,
        { windowsHide: true },
        (error) => {
          if (!error) return resolve(true);
          const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
          exec(
            `security dump-trust-settings -d 2>/dev/null | grep -i "${fingerprint}"`,
            { windowsHide: true },
            (err2, stdout2) => resolve(!err2 && !!stdout2?.trim()),
          );
        },
      );
    } catch {
      resolve(false);
    }
  });
}

function checkCertInstalledWindows(): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`certutil -store Root "${CA_COMMON_NAME}"`, { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

function checkCertInstalledLinux(): Promise<boolean> {
  const certFile = `${LINUX_CERT_DIR}/hexos-root-ca.crt`;
  return Promise.resolve(fs.existsSync(certFile));
}

export async function installCert(sudoPassword: string | null, certPath: string): Promise<void> {
  if (!fs.existsSync(certPath)) {
    throw new Error(`Certificate file not found: ${certPath}`);
  }
  const isInstalled = await checkCertInstalled(certPath);
  if (isInstalled) {
    console.log("🔐 Cert: already trusted ✅");
    return;
  }
  if (IS_WIN) await installCertWindows(certPath);
  else if (IS_MAC) await installCertMac(sudoPassword, certPath);
  else await installCertLinux(sudoPassword, certPath);
}

async function installCertMac(sudoPassword: string | null, certPath: string): Promise<void> {
  const deleteOld = `security delete-certificate -c "${CA_COMMON_NAME}" /Library/Keychains/System.keychain 2>/dev/null || true`;
  const install = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`;
  try {
    await execWithPassword(`${deleteOld} && ${install}`, sudoPassword);
    console.log("🔐 Cert: ✅ installed to system keychain");
  } catch (error: any) {
    const msg = error.message?.includes("canceled") ? "User canceled authorization" : "Certificate install failed";
    throw new Error(msg);
  }
}

/**
 * Run a command with admin elevation on Windows.
 * If already admin, runs directly. Otherwise uses UAC elevation.
 */
function runElevatedWindows(command: string, timeoutMs: number = 30000): void {
  const os = require("os");
  const path = require("path");

  // If already running as admin, just execute directly
  try {
    execSync("net session >nul 2>&1", { windowsHide: true });
    // We're admin — run directly
    execSync(`powershell -NoProfile -Command "${command}"`, { windowsHide: true, timeout: timeoutMs });
    return;
  } catch (e: any) {
    // net session failed = not admin, OR powershell command failed
    if (e.message?.includes("net session")) {
      // Not admin — fall through to UAC elevation
    } else if (!e.status || e.status === 1) {
      // net session check itself failed — try direct anyway
    } else {
      throw new Error(e.message || "Command failed");
    }
  }

  // Not admin — use UAC elevation via temp script
  const ts = Date.now();
  const tmpDir = os.tmpdir();
  const scriptPath = path.join(tmpDir, `hexos_mitm_${ts}.ps1`);
  const flagPath = path.join(tmpDir, `hexos_mitm_${ts}.flag`);
  const errPath = path.join(tmpDir, `hexos_mitm_${ts}.err`);

  // Script: run command, write flag on success, write error on failure
  const script = [
    `try {`,
    `  ${command}`,
    `  Set-Content -Path '${flagPath.replace(/'/g, "''")}' -Value 'ok'`,
    `} catch {`,
    `  Set-Content -Path '${errPath.replace(/'/g, "''")}' -Value $_.Exception.Message`,
    `}`,
  ].join("\r\n");
  fs.writeFileSync(scriptPath, script, "utf8");

  // Launch elevated — this WILL show UAC prompt
  try {
    execSync(
      `powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptPath.replace(/'/g, "''")}' -Verb RunAs -Wait"`,
      { timeout: timeoutMs, windowsHide: false },
    );
  } catch {
    // Start-Process itself may throw if user cancels UAC
  }

  // Poll for result
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(flagPath)) {
      try { fs.unlinkSync(flagPath); } catch {}
      try { fs.unlinkSync(scriptPath); } catch {}
      return; // success
    }
    if (fs.existsSync(errPath)) {
      const errMsg = fs.readFileSync(errPath, "utf8").trim();
      try { fs.unlinkSync(errPath); } catch {}
      try { fs.unlinkSync(scriptPath); } catch {}
      throw new Error(errMsg || "Elevated command failed");
    }
    // busy-wait 100ms
    const start = Date.now();
    while (Date.now() - start < 100) { /* spin */ }
  }

  try { fs.unlinkSync(scriptPath); } catch {}
  throw new Error("Admin elevation timed out or was cancelled");
}

async function installCertWindows(certPath: string): Promise<void> {
  const escaped = certPath.replace(/'/g, "''");
  runElevatedWindows(`certutil -addstore Root '${escaped}' | Out-Null`);
  console.log("🔐 Cert: ✅ installed to Windows Root store");
}

async function installCertLinux(sudoPassword: string | null, certPath: string): Promise<void> {
  if (!isSudoAvailable()) {
    console.log(`🔐 Cert: cannot install to system store without sudo — trust this file on clients: ${certPath}`);
    return;
  }
  const destFile = `${LINUX_CERT_DIR}/hexos-root-ca.crt`;
  const cmd = `cp "${certPath}" "${destFile}" && (update-ca-certificates 2>/dev/null || update-ca-trust 2>/dev/null || true)`;
  try {
    await execWithPassword(cmd, sudoPassword);
    console.log("🔐 Cert: ✅ installed to Linux trust store");
  } catch {
    throw new Error("Certificate install failed");
  }
}

export async function uninstallCert(sudoPassword: string | null, certPath: string): Promise<void> {
  const isInstalled = await checkCertInstalled(certPath);
  if (!isInstalled) {
    console.log("🔐 Cert: not found in system store");
    return;
  }
  if (IS_WIN) await uninstallCertWindows();
  else if (IS_MAC) await uninstallCertMac(sudoPassword, certPath);
  else await uninstallCertLinux(sudoPassword);
}

async function uninstallCertMac(sudoPassword: string | null, certPath: string): Promise<void> {
  const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
  const command = `security delete-certificate -Z "${fingerprint}" /Library/Keychains/System.keychain`;
  try {
    await execWithPassword(command, sudoPassword);
    console.log("🔐 Cert: ✅ uninstalled from system keychain");
  } catch {
    throw new Error("Failed to uninstall certificate");
  }
}

async function uninstallCertWindows(): Promise<void> {
  runElevatedWindows(`certutil -delstore Root '${CA_COMMON_NAME}' | Out-Null`);
  console.log("🔐 Cert: ✅ uninstalled from Windows Root store");
}

async function uninstallCertLinux(sudoPassword: string | null): Promise<void> {
  if (!isSudoAvailable()) return;
  const destFile = `${LINUX_CERT_DIR}/hexos-root-ca.crt`;
  const cmd = `rm -f "${destFile}" && (update-ca-certificates 2>/dev/null || update-ca-trust 2>/dev/null || true)`;
  try {
    await execWithPassword(cmd, sudoPassword);
    console.log("🔐 Cert: ✅ uninstalled from Linux trust store");
  } catch {
    throw new Error("Failed to uninstall certificate");
  }
}
