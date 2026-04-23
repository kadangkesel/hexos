#!/usr/bin/env bun
/**
 * Hexos Build Script
 *
 * Builds the complete Hexos distribution:
 * 1. Compiles the API server into a standalone Bun binary
 * 2. Exports the Next.js dashboard as static HTML
 * 3. Packages everything into a tarball per platform
 *
 * Usage:
 *   bun scripts/build.ts                    # Build for current platform
 *   bun scripts/build.ts --all              # Build for all platforms
 *   bun scripts/build.ts --target linux-x64 # Build for specific target
 *   bun scripts/build.ts --skip-dashboard   # Skip dashboard build
 *
 * Output: dist/hexos-<os>-<arch>.tar.gz (or .zip for Windows)
 */

import { $ } from "bun";
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const DASHBOARD_DIR = join(ROOT, "dashboard");
const DASHBOARD_OUT = join(DASHBOARD_DIR, "out");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;

// Bun compile targets
type Target = "bun-linux-x64" | "bun-linux-arm64" | "bun-darwin-x64" | "bun-darwin-arm64" | "bun-windows-x64";

interface PlatformInfo {
  bunTarget: Target;
  os: string;
  arch: string;
  ext: string; // binary extension
  archiveExt: string; // .tar.gz or .zip
}

const PLATFORMS: Record<string, PlatformInfo> = {
  "linux-x64": { bunTarget: "bun-linux-x64", os: "linux", arch: "amd64", ext: "", archiveExt: ".tar.gz" },
  "linux-arm64": { bunTarget: "bun-linux-arm64", os: "linux", arch: "arm64", ext: "", archiveExt: ".tar.gz" },
  "darwin-x64": { bunTarget: "bun-darwin-x64", os: "darwin", arch: "amd64", ext: "", archiveExt: ".tar.gz" },
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", os: "darwin", arch: "arm64", ext: "", archiveExt: ".tar.gz" },
  "windows-x64": { bunTarget: "bun-windows-x64", os: "windows", arch: "amd64", ext: ".exe", archiveExt: ".zip" },
};

function getCurrentPlatform(): string {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

function log(msg: string) {
  console.log(`\x1b[36m==>\x1b[0m ${msg}`);
}

function logOk(msg: string) {
  console.log(`\x1b[32m==>\x1b[0m ${msg}`);
}

function logErr(msg: string) {
  console.error(`\x1b[31m==>\x1b[0m ${msg}`);
}

// Parse args
const args = process.argv.slice(2);
const buildAll = args.includes("--all");
const skipDashboard = args.includes("--skip-dashboard");
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1] ||
  args[args.indexOf("--target") + 1];

let targets: string[];
if (buildAll) {
  targets = Object.keys(PLATFORMS);
} else if (targetArg) {
  if (!PLATFORMS[targetArg]) {
    logErr(`Unknown target: ${targetArg}. Available: ${Object.keys(PLATFORMS).join(", ")}`);
    process.exit(1);
  }
  targets = [targetArg];
} else {
  targets = [getCurrentPlatform()];
}

log(`Hexos v${VERSION} — Building for: ${targets.join(", ")}`);

// Clean dist
if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

// Step 1: Build dashboard (static export)
if (!skipDashboard) {
  log("Building dashboard (Next.js static export)...");

  // Install dashboard deps if needed
  if (!existsSync(join(DASHBOARD_DIR, "node_modules"))) {
    log("Installing dashboard dependencies...");
    const installResult = Bun.spawnSync(["bun", "install"], { cwd: DASHBOARD_DIR, stdio: ["inherit", "inherit", "inherit"] });
    if (installResult.exitCode !== 0) {
      logErr("Failed to install dashboard dependencies");
      process.exit(1);
    }
  }

  // Build with static export
  const buildResult = Bun.spawnSync(["bun", "run", "next", "build"], {
    cwd: DASHBOARD_DIR,
    env: { ...process.env, NEXT_STATIC_EXPORT: "true" },
    stdio: ["inherit", "inherit", "inherit"],
  });

  if (buildResult.exitCode !== 0) {
    logErr("Dashboard build failed");
    process.exit(1);
  }

  if (!existsSync(DASHBOARD_OUT)) {
    logErr("Dashboard export directory not found (dashboard/out/)");
    process.exit(1);
  }

  logOk("Dashboard built successfully");
} else {
  log("Skipping dashboard build (--skip-dashboard)");
}

// Step 2: Build server binary for each target
for (const target of targets) {
  const platform = PLATFORMS[target];
  log(`Building server binary for ${target}...`);

  const binaryName = `hexos${platform.ext}`;
  const binaryPath = join(DIST, `${target}`, binaryName);

  // Create target directory
  mkdirSync(join(DIST, target), { recursive: true });

  // Bun compile
  const compileResult = Bun.spawnSync([
    "bun", "build",
    join(ROOT, "src", "index.ts"),
    "--compile",
    "--target", platform.bunTarget,
    "--outfile", binaryPath,
  ], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });

  if (compileResult.exitCode !== 0) {
    logErr(`Failed to compile for ${target}`);
    continue;
  }

  // Copy dashboard static files alongside binary
  const dashboardDest = join(DIST, target, "dashboard");
  if (existsSync(DASHBOARD_OUT)) {
    log(`Copying dashboard files for ${target}...`);
    cpSync(DASHBOARD_OUT, dashboardDest, { recursive: true });
  }

  // Copy Python automation files
  const automationDest = join(DIST, target, "automation");
  mkdirSync(automationDest, { recursive: true });
  const automationSrc = join(ROOT, "src", "automation");
  for (const file of ["login.py", "cline_login.py", "kiro_login.py", "setup.py", "requirements.txt"]) {
    const src = join(automationSrc, file);
    if (existsSync(src)) {
      cpSync(src, join(automationDest, file));
    }
  }

  // Create archive
  const archiveName = `hexos-${VERSION}-${platform.os}-${platform.arch}${platform.archiveExt}`;
  const archivePath = join(DIST, archiveName);

  log(`Creating archive: ${archiveName}...`);

  if (platform.archiveExt === ".tar.gz") {
    const tarResult = Bun.spawnSync([
      "tar", "czf", archivePath,
      "-C", join(DIST, target),
      ".",
    ], { stdio: ["inherit", "inherit", "inherit"] });

    if (tarResult.exitCode !== 0) {
      logErr(`Failed to create archive for ${target}`);
      continue;
    }
  } else {
    // Windows: use PowerShell Compress-Archive
    const zipResult = Bun.spawnSync([
      "powershell", "-Command",
      `Compress-Archive -Path '${join(DIST, target, "*")}' -DestinationPath '${archivePath}' -Force`,
    ], { stdio: ["inherit", "inherit", "inherit"] });

    if (zipResult.exitCode !== 0) {
      logErr(`Failed to create archive for ${target}`);
      continue;
    }
  }

  logOk(`Built: ${archiveName}`);
}

// Step 3: Generate checksums
log("Generating checksums...");
const checksumLines: string[] = [];
const { readdirSync } = await import("fs");
for (const file of readdirSync(DIST)) {
  if (file.endsWith(".tar.gz") || file.endsWith(".zip")) {
    const filePath = join(DIST, file);
    const hasher = new Bun.CryptoHasher("sha256");
    const fileData = readFileSync(filePath);
    hasher.update(fileData);
    const hash = hasher.digest("hex");
    checksumLines.push(`${hash}  ${file}`);
  }
}

if (checksumLines.length > 0) {
  const checksumFile = join(DIST, `hexos-${VERSION}-checksums.txt`);
  writeFileSync(checksumFile, checksumLines.join("\n") + "\n");
  logOk(`Checksums: ${checksumLines.length} files`);
  for (const line of checksumLines) {
    console.log(`  ${line}`);
  }
}

logOk(`Build complete! Artifacts in dist/`);
