#!/usr/bin/env bun
import { Command } from "commander";
import { createApp } from "./server.ts";
import {
  oauthCodebuddy,
  oauthCodebuddyAutomated,
  batchConnect,
  setupAutomation,
  isAutomationReady,
  checkToken,
} from "./auth/oauth.ts";
import { createApiKey, getApiKeys, listConnections, removeConnection, updateConnection } from "./auth/store.ts";
import { log } from "./utils/logger.ts";
import chalk from "chalk";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const program = new Command();

program
  .name("hexos")
  .description("Lightweight AI API proxy")
  .version("0.1.4");

// Start server
program
  .command("start")
  .description("Start the proxy server")
  .option("-p, --port <port>", "Port to listen on", "7470")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .action(async (opts) => {
    const app = createApp();
    const port = parseInt(opts.port);
    const keys = getApiKeys();

    const baseUrl = `http://${opts.host}:${port}`;
    log.ok(`Hexos proxy starting on ${chalk.cyan(baseUrl)}`);
    if (keys.length === 0) {
      log.warn("No API keys configured — running in open mode. Run: hexos key create");
    } else {
      log.info(`API keys: ${keys.length} configured`);
    }
    log.info(`Connections: ${listConnections().length} active`);

    const dashboardDir = join(homedir(), ".hexos", "dashboard");
    if (existsSync(dashboardDir)) {
      log.ok(`Dashboard: ${chalk.cyan(baseUrl)}`);
    } else {
      log.info(`Dashboard: not installed (run separately with 'cd dashboard && bun dev')`);
    }

    Bun.serve({
      fetch: app.fetch,
      port,
      hostname: opts.host,
      idleTimeout: 120, // seconds — prevent timeout on large responses
    });
  });

// Auth commands
const auth = program.command("auth").description("Manage provider connections");

auth
  .command("connect <provider>")
  .description("Connect a provider via OAuth")
  .option("--label <label>", "Account label", "Account 1")
  .action(async (provider, opts) => {
    if (provider === "codebuddy") {
      await oauthCodebuddy(opts.label);
    } else {
      log.error(`Unknown provider: ${provider}. Available: codebuddy`);
    }
  });

auth
  .command("list")
  .description("List all connections")
  .action(() => {
    const conns = listConnections();
    if (conns.length === 0) {
      log.warn("No connections. Run: hexos auth connect <provider>");
      log.info("  Manual:    hexos auth connect codebuddy");
      log.info("  Automated: hexos auth auto-connect --email <email> --password <pw>");
      log.info("  Batch:     hexos auth batch-connect --file accounts.txt");
      return;
    }
    console.log(chalk.bold(`\nConnections (${conns.length}):`));
    for (const c of conns) {
      const status = (c as any).status || "active";
      const usageCount = (c as any).usageCount || 0;
      const lastUsed = (c as any).lastUsedAt
        ? new Date((c as any).lastUsedAt).toLocaleString()
        : "never";
      const credit = (c as any).credit;
      const statusColor = status === "active" ? chalk.green : status === "expired" ? chalk.yellow : chalk.red;

      let creditStr = "";
      if (credit) {
        const remain = credit.remainingCredits ?? 0;
        const total = credit.totalCredits ?? 0;
        creditStr = `  credits: ${chalk.cyan(`${remain}/${total}`)}`;
      }

      console.log(
        `  ${chalk.cyan(c.id.slice(0, 8))} ${chalk.white(c.provider)} — ${c.label}` +
        `  ${statusColor(`[${status}]`)}` +
        `  used: ${chalk.yellow(String(usageCount))}` +
        creditStr +
        `  last: ${chalk.dim(lastUsed)}`
      );
    }
    console.log(chalk.dim(`\n  Run 'hexos auth status' to refresh credit info`));
  });

auth
  .command("remove <id>")
  .description("Remove a connection by ID")
  .action(async (id) => {
    await removeConnection(id);
    log.ok(`Removed connection ${id}`);
  });

auth
  .command("auto-connect")
  .description("Connect a CodeBuddy account via browser automation (Camoufox)")
  .requiredOption("--email <email>", "Google email address")
  .requiredOption("--password <password>", "Google password")
  .option("--label <label>", "Account label (defaults to email)")
  .option("--no-headless", "Show browser window (visible mode)")
  .action(async (opts) => {
    if (!isAutomationReady()) {
      log.error("Automation not set up. Run: hexos auth setup-automation");
      process.exit(1);
    }
    if (!opts.headless) process.env.HEXOS_HEADLESS = "false";
    const result = await oauthCodebuddyAutomated(opts.email, opts.password, opts.label);
    if (!result.success) {
      process.exit(1);
    }
  });

auth
  .command("batch-connect")
  .description("Batch connect multiple CodeBuddy accounts from a file")
  .requiredOption("--file <path>", "Path to accounts file (email|password or email:password per line)")
  .option("--concurrency <n>", "Max concurrent logins", "2")
  .option("--no-headless", "Show browser window (visible mode)")
  .action(async (opts) => {
    if (!isAutomationReady()) {
      log.error("Automation not set up. Run: hexos auth setup-automation");
      process.exit(1);
    }
    if (!opts.headless) process.env.HEXOS_HEADLESS = "false";

    const filePath = opts.file;
    if (!existsSync(filePath)) {
      log.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("#"));

    if (lines.length === 0) {
      log.error("No accounts found in file");
      process.exit(1);
    }

    const accounts = lines.map((line: string, idx: number) => {
      // Support multiple delimiters: | : ; tab space
      // Try in order of specificity: | then ; then tab then :
      // Note: ":" is tried last because emails contain "@" but passwords may contain ":"
      let parts: string[] = [];
      const delimiters = ["|", ";", "\t"];
      for (const delim of delimiters) {
        if (line.includes(delim)) {
          parts = line.split(delim).map((p: string) => p.trim());
          if (parts.length >= 2 && parts[0] && parts[1]) break;
        }
      }
      // Fallback: try ":" but only split on first ":" after the email part
      // e.g. "user@gmail.com:p@ss:word" → email="user@gmail.com", password="p@ss:word"
      if (parts.length < 2 && line.includes(":")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const email = line.slice(0, colonIdx).trim();
          const rest = line.slice(colonIdx + 1).trim();
          if (email && rest) {
            // Check if there's a label after another delimiter in the rest
            // e.g. "user@gmail.com:password:label" or "user@gmail.com:password|label"
            let password = rest;
            let label: string | undefined;
            for (const delim of ["|", ";", "\t"]) {
              if (rest.includes(delim)) {
                const restParts = rest.split(delim).map((p: string) => p.trim());
                password = restParts[0];
                label = restParts[1] || undefined;
                break;
              }
            }
            parts = label ? [email, password, label] : [email, password];
          }
        }
      }
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        log.error(`Invalid format on line ${idx + 1}: "${line}"`);
        log.error(`  Supported formats: email|password  email:password  email;password  email<tab>password`);
        process.exit(1);
      }
      return {
        email: parts[0],
        password: parts[1],
        label: parts[2] || undefined,
      };
    });

    log.info(`Found ${accounts.length} accounts in ${filePath}`);
    const concurrency = parseInt(opts.concurrency) || 2;

    const results = await batchConnect(accounts, concurrency);

    console.log(chalk.bold("\n=== Batch Connect Results ==="));
    console.log(`  Total:   ${results.total}`);
    console.log(`  ${chalk.green("Success:")} ${results.success}`);
    console.log(`  ${chalk.red("Failed:")}  ${results.failed}`);

    if (results.errors.length > 0) {
      console.log(chalk.red("\nErrors:"));
      for (const err of results.errors) {
        console.log(`  ${chalk.red("×")} ${err}`);
      }
    }

    if (results.failed > 0) process.exit(1);
  });

auth
  .command("status")
  .description("Check token validity and show cached credits for all connections")
  .action(async () => {
    const conns = listConnections();
    if (conns.length === 0) {
      log.warn("No connections. Run: hexos auth connect <provider>");
      return;
    }

    console.log(chalk.bold(`\nChecking ${conns.length} connection(s)...\n`));

    let totalCredits = 0;
    let totalRemaining = 0;
    let validCount = 0;
    let invalidCount = 0;

    for (const c of conns) {
      const label = c.label || c.id.slice(0, 8);
      process.stdout.write(`  ${chalk.cyan(label)} `);

      const tokenStatus = await checkToken(c.accessToken);
      const credit = (c as any).credit;

      if (tokenStatus.valid) {
        validCount++;
        process.stdout.write(chalk.green("✓ valid"));

        // Update status to active if it was expired/disabled
        if ((c as any).status !== "active") {
          await updateConnection(c.id, { status: "active", failCount: 0 } as any);
        }

        if (credit) {
          const remain = credit.remainingCredits ?? 0;
          const total = credit.totalCredits ?? 0;
          const pct = total > 0 ? ((remain / total) * 100).toFixed(0) : "0";
          const bar = total > 0 ? progressBar(remain / total, 15) : "";

          totalCredits += total;
          totalRemaining += remain;

          const creditColor = remain > 50 ? chalk.green : remain > 10 ? chalk.yellow : chalk.red;
          console.log(
            `  ${creditColor(`${remain}/${total}`)} credits (${pct}%) ${bar}` +
            (credit.packageName ? `  ${chalk.dim(credit.packageName)}` : "") +
            (credit.expiresAt ? `  ${chalk.dim(`exp: ${credit.expiresAt}`)}` : "")
          );
        } else {
          console.log(chalk.dim("  (no credit data — re-login to fetch)"));
        }
      } else {
        invalidCount++;
        await updateConnection(c.id, { status: "expired" } as any);
        console.log(chalk.red("✗ token expired") + chalk.dim(" — re-login to fix"));
      }
    }

    console.log("");
    console.log(chalk.bold("  Summary:"));
    console.log(`    Accounts: ${chalk.green(`${validCount} valid`)}${invalidCount > 0 ? `, ${chalk.red(`${invalidCount} expired`)}` : ""}`);
    if (totalCredits > 0) {
      console.log(`    Credits:  ${totalRemaining}/${totalCredits} remaining`);
    }
    console.log(chalk.dim("\n  Note: Credit data is cached from login. Re-login to refresh."));
    console.log("");
  });

auth
  .command("setup-automation")
  .description("Set up Python environment for browser automation (Camoufox)")
  .action(async () => {
    try {
      await setupAutomation();
    } catch (e: any) {
      log.error(e.message);
      process.exit(1);
    }
  });

function progressBar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(empty));
}

// Usage tracking commands
const usage = program.command("usage").description("View token usage and stats");

usage
  .command("stats")
  .description("Show aggregate usage statistics")
  .option("--today", "Show only today's stats")
  .option("--hours <n>", "Show stats for last N hours")
  .action(async (opts) => {
    const { getStats } = await import("./tracking/tracker.ts");
    let since: number | undefined;
    if (opts.today) {
      const now = new Date();
      since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    } else if (opts.hours) {
      since = Date.now() - parseInt(opts.hours) * 60 * 60 * 1000;
    }

    const stats = getStats(since);

    if (stats.totalRequests === 0) {
      log.warn("No usage data yet. Start the proxy and make some requests.");
      return;
    }

    console.log(chalk.bold("\n=== Usage Statistics ===\n"));
    console.log(`  Requests:     ${chalk.cyan(String(stats.totalRequests))} (${stats.successRate}% success)`);
    console.log(`  Prompt:       ${chalk.yellow(stats.totalPromptTokens.toLocaleString())} tokens`);
    console.log(`  Completion:   ${chalk.yellow(stats.totalCompletionTokens.toLocaleString())} tokens`);
    console.log(`  Total:        ${chalk.bold(stats.totalTokens.toLocaleString())} tokens`);
    console.log(`  Avg Latency:  ${stats.avgLatencyMs}ms`);

    const models = Object.values(stats.byModel);
    if (models.length > 0) {
      console.log(chalk.bold("\n  By Model:"));
      for (const m of models.sort((a, b) => b.totalTokens - a.totalTokens)) {
        console.log(
          `    ${chalk.cyan(m.model.padEnd(25))} ` +
          `${String(m.requests).padStart(4)} req  ` +
          `${m.totalTokens.toLocaleString().padStart(10)} tok`
        );
      }
    }

    const accounts = Object.values(stats.byAccount);
    if (accounts.length > 0) {
      console.log(chalk.bold("\n  By Account:"));
      for (const a of accounts.sort((a, b) => b.totalTokens - a.totalTokens)) {
        console.log(
          `    ${chalk.cyan(a.accountLabel.padEnd(30))} ` +
          `${String(a.requests).padStart(4)} req  ` +
          `${a.totalTokens.toLocaleString().padStart(10)} tok`
        );
      }
    }
    console.log("");
  });

usage
  .command("log")
  .description("Show recent usage records")
  .option("-n, --limit <n>", "Number of records to show", "20")
  .option("--model <model>", "Filter by model")
  .option("--account <id>", "Filter by account ID")
  .action(async (opts) => {
    const { getRecords } = await import("./tracking/tracker.ts");
    const records = getRecords({
      limit: parseInt(opts.limit) || 20,
      model: opts.model,
      accountId: opts.account,
    });

    if (records.length === 0) {
      log.warn("No usage records yet.");
      return;
    }

    console.log(chalk.bold("\n  Recent Usage:\n"));
    console.log(
      chalk.dim("  Time                 Model                     Account                  Prompt     Compl     Total    Credit  Status")
    );
    console.log(chalk.dim("  " + "─".repeat(130)));

    for (const r of records) {
      const time = new Date(r.timestamp).toLocaleTimeString();
      const statusIcon = r.success ? chalk.green("✓") : chalk.red("✗");
      console.log(
        `  ${chalk.dim(time.padEnd(20))} ` +
        `${chalk.cyan(r.model.padEnd(25))} ` +
        `${r.accountLabel.padEnd(24)} ` +
        `${String(r.promptTokens.toLocaleString()).padStart(9)} ` +
        `${String(r.completionTokens.toLocaleString()).padStart(9)} ` +
        `${chalk.bold(String(r.totalTokens.toLocaleString()).padStart(9))} ` +
        `${statusIcon} ${r.latencyMs}ms`
      );
    }
    console.log("");
  });

// API key commands
const key = program.command("key").description("Manage API keys");

key
  .command("create")
  .description("Generate a new API key")
  .action(async () => {
    const k = await createApiKey();
    log.ok(`New API key: ${chalk.cyan(k)}`);
  });

key
  .command("list")
  .description("List all API keys")
  .action(() => {
    const keys = getApiKeys();
    if (keys.length === 0) {
      log.warn("No API keys. Run: hexos key create");
      return;
    }
    console.log(chalk.bold("\nAPI Keys:"));
    for (const k of keys) console.log(`  ${chalk.cyan(k)}`);
  });

// Service management commands
const service = program.command("service").description("Manage hexos background service");

service
  .command("status")
  .description("Check if hexos service is running")
  .action(async () => {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    if (isWindows) {
      const proc = Bun.spawnSync(["powershell", "-Command", "Get-ScheduledTask -TaskName Hexos -ErrorAction SilentlyContinue | Format-Table TaskName,State -AutoSize"], { stdio: ["inherit", "inherit", "inherit"] });
      if (proc.exitCode !== 0) log.warn("Hexos task not found. Run installer to set up.");
    } else if (isMac) {
      const proc = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe" });
      const output = new TextDecoder().decode(proc.stdout);
      const hexosLine = output.split("\n").find(l => l.includes("hexos"));
      if (hexosLine) {
        console.log(chalk.green("  Hexos service is loaded"));
        console.log(`  ${hexosLine}`);
      } else {
        log.warn("Hexos service not found. Run installer to set up.");
      }
    } else {
      const proc = Bun.spawnSync(["systemctl", "--user", "status", "hexos"], { stdio: ["inherit", "inherit", "inherit"] });
      if (proc.exitCode !== 0 && proc.exitCode !== 3) {
        log.warn("Hexos service not found. Run installer to set up.");
      }
    }
  });

service
  .command("start")
  .description("Start hexos background service")
  .action(async () => {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    if (isWindows) {
      Bun.spawnSync(["powershell", "-Command", "Start-ScheduledTask -TaskName Hexos"], { stdio: ["inherit", "inherit", "inherit"] });
    } else if (isMac) {
      const plist = join(homedir(), "Library", "LaunchAgents", "net.kadangkesel.hexos.plist");
      Bun.spawnSync(["launchctl", "load", "-w", plist], { stdio: ["inherit", "inherit", "inherit"] });
    } else {
      Bun.spawnSync(["systemctl", "--user", "start", "hexos"], { stdio: ["inherit", "inherit", "inherit"] });
    }
    log.ok("Service started");
  });

service
  .command("stop")
  .description("Stop hexos background service")
  .action(async () => {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    if (isWindows) {
      Bun.spawnSync(["powershell", "-Command", "Stop-ScheduledTask -TaskName Hexos"], { stdio: ["inherit", "inherit", "inherit"] });
    } else if (isMac) {
      const plist = join(homedir(), "Library", "LaunchAgents", "net.kadangkesel.hexos.plist");
      Bun.spawnSync(["launchctl", "unload", plist], { stdio: ["inherit", "inherit", "inherit"] });
    } else {
      Bun.spawnSync(["systemctl", "--user", "stop", "hexos"], { stdio: ["inherit", "inherit", "inherit"] });
    }
    log.ok("Service stopped");
  });

service
  .command("restart")
  .description("Restart hexos background service")
  .action(async () => {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    if (isWindows) {
      Bun.spawnSync(["powershell", "-Command", "Stop-ScheduledTask -TaskName Hexos; Start-ScheduledTask -TaskName Hexos"], { stdio: ["inherit", "inherit", "inherit"] });
    } else if (isMac) {
      const plist = join(homedir(), "Library", "LaunchAgents", "net.kadangkesel.hexos.plist");
      Bun.spawnSync(["launchctl", "unload", plist], { stdio: ["inherit", "inherit", "inherit"] });
      Bun.spawnSync(["launchctl", "load", "-w", plist], { stdio: ["inherit", "inherit", "inherit"] });
    } else {
      Bun.spawnSync(["systemctl", "--user", "restart", "hexos"], { stdio: ["inherit", "inherit", "inherit"] });
    }
    log.ok("Service restarted");
  });

service
  .command("logs")
  .description("View hexos service logs")
  .action(async () => {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    if (isWindows) {
      log.info("Windows Task Scheduler doesn't capture logs by default.");
      log.info("Use 'hexos start' in a terminal to see output.");
    } else if (isMac) {
      const logFile = join(homedir(), ".hexos", "hexos.log");
      if (existsSync(logFile)) {
        Bun.spawnSync(["tail", "-f", logFile], { stdio: ["inherit", "inherit", "inherit"] });
      } else {
        log.warn(`Log file not found: ${logFile}`);
      }
    } else {
      Bun.spawnSync(["journalctl", "--user", "-u", "hexos", "-f", "--no-pager"], { stdio: ["inherit", "inherit", "inherit"] });
    }
  });

// Update command
program
  .command("update")
  .description("Update hexos to the latest version")
  .action(async () => {
    log.info("Checking for updates...");

    const isWindows = process.platform === "win32";
    if (isWindows) {
      log.info("Run the following command to update:");
      console.log(chalk.cyan("  irm https://hexos.kadangkesel.net/install.ps1 | iex"));
    } else {
      // Write a wrapper script that:
      // 1. Waits for this hexos process to exit
      // 2. Runs the installer
      const myPid = process.pid;
      const wrapper = `#!/bin/bash
# Wait for hexos update process to exit (max 10s)
for i in $(seq 1 20); do
  kill -0 ${myPid} 2>/dev/null || break
  sleep 0.5
done
# Run installer
curl -fsSL https://hexos.kadangkesel.net/install | bash
`;
      const tmpScript = "/tmp/hexos-update-wrapper.sh";
      const { writeFileSync } = await import("fs");
      writeFileSync(tmpScript, wrapper, { mode: 0o755 });

      // Spawn detached — runs after we exit
      log.info("Starting update (hexos will restart automatically)...");
      const child = Bun.spawn(["bash", tmpScript], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.unref();

      // Exit so binary is released
      process.exit(0);
    }
  });

// Uninstall command
program
  .command("uninstall")
  .description("Uninstall hexos")
  .action(async () => {
    const hexosDir = join(homedir(), ".hexos");
    const linkPath = process.platform === "win32"
      ? join(hexosDir, "bin", "hexos.exe")
      : join(homedir(), ".local", "bin", "hexos");

    console.log(chalk.bold("\nThis will remove:"));
    console.log(`  ${chalk.red(join(hexosDir, "bin"))}  (binary)`);
    console.log(`  ${chalk.red(join(hexosDir, "dashboard"))}  (dashboard files)`);
    console.log(`  ${chalk.red(join(hexosDir, "automation"))}  (automation scripts)`);
    if (!process.platform.startsWith("win")) {
      console.log(`  ${chalk.red(linkPath)}  (symlink)`);
    }
    console.log("");
    console.log(chalk.yellow("  Note: ~/.hexos/db.json and ~/.hexos/usage.json will NOT be removed."));
    console.log("");

    // Simple confirmation via stdin
    process.stdout.write("  Continue? [y/N] ");
    const reader = Bun.stdin.stream().getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const answer = new TextDecoder().decode(value).trim().toLowerCase();

    if (answer !== "y" && answer !== "yes") {
      log.info("Cancelled.");
      return;
    }

    const { rmSync } = await import("fs");

    // Remove binary
    const binDir = join(hexosDir, "bin");
    if (existsSync(binDir)) {
      rmSync(binDir, { recursive: true });
      log.ok("Removed binary");
    }

    // Remove dashboard
    const dashDir = join(hexosDir, "dashboard");
    if (existsSync(dashDir)) {
      rmSync(dashDir, { recursive: true });
      log.ok("Removed dashboard");
    }

    // Remove automation (but keep .venv if user wants)
    const autoDir = join(hexosDir, "automation");
    if (existsSync(autoDir)) {
      rmSync(autoDir, { recursive: true });
      log.ok("Removed automation scripts");
    }

    // Remove symlink
    if (!process.platform.startsWith("win") && existsSync(linkPath)) {
      rmSync(linkPath);
      log.ok("Removed symlink");
    }

    log.ok("Hexos uninstalled. Data files preserved at ~/.hexos/");
    log.info("To fully remove all data: rm -rf ~/.hexos");
  });

// ── MITM commands ────────────────────────────────────────────
const mitm = program.command("mitm").description("Manage MITM proxy for IDE interception");

mitm
  .command("start")
  .description("Start the MITM proxy server (requires sudo)")
  .option("--password <password>", "Sudo password (will prompt if not provided)")
  .action(async (opts) => {
    const { startServer } = await import("./mitm/manager.ts");
    const keys = getApiKeys();
    const apiKey = keys[0] || "";

    if (!apiKey) {
      log.warn("No API key configured. Run: hexos key create");
      log.warn("MITM will forward requests without authentication.");
    }

    let password = opts.password || null;
    if (!password && process.platform !== "win32") {
      process.stdout.write("Sudo password: ");
      try {
        const line = readFileSync("/dev/stdin", "utf-8").split("\n")[0];
        password = line.trim();
      } catch {
        log.error("Failed to read password. Use --password flag instead.");
        process.exit(1);
      }
    }

    try {
      const result = await startServer(apiKey, password);
      log.ok(`MITM server started (PID: ${result.pid})`);
    } catch (e: any) {
      log.error(e.message);
      process.exit(1);
    }
  });

mitm
  .command("stop")
  .description("Stop the MITM proxy server")
  .option("--password <password>", "Sudo password")
  .action(async (opts) => {
    const { stopServer } = await import("./mitm/manager.ts");
    try {
      await stopServer(opts.password || null);
      log.ok("MITM server stopped");
    } catch (e: any) {
      log.error(e.message);
      process.exit(1);
    }
  });

mitm
  .command("status")
  .description("Show MITM proxy status")
  .action(async () => {
    const { getMitmStatus } = await import("./mitm/manager.ts");
    const status = await getMitmStatus();

    console.log(chalk.bold("\n  MITM Proxy Status:\n"));
    console.log(`    Server:  ${status.running ? chalk.green(`running (PID: ${status.pid})`) : chalk.red("stopped")}`);
    console.log(`    Cert:    ${status.certExists ? (status.certTrusted ? chalk.green("trusted ✅") : chalk.yellow("exists but not trusted")) : chalk.red("not generated")}`);
    console.log(chalk.bold("\n    DNS Interception:"));
    for (const [tool, active] of Object.entries(status.dnsStatus)) {
      console.log(`      ${tool.padEnd(15)} ${active ? chalk.green("✅ active") : chalk.dim("inactive")}`);
    }
    console.log("");
  });

mitm
  .command("enable <tool>")
  .description("Enable DNS interception for a tool (antigravity|copilot|kiro|cursor)")
  .option("--password <password>", "Sudo password")
  .action(async (tool, opts) => {
    const { enableToolDNS } = await import("./mitm/manager.ts");
    try {
      await enableToolDNS(tool, opts.password || null);
      log.ok(`DNS interception enabled for ${tool}`);
    } catch (e: any) {
      log.error(e.message);
      process.exit(1);
    }
  });

mitm
  .command("disable <tool>")
  .description("Disable DNS interception for a tool")
  .option("--password <password>", "Sudo password")
  .action(async (tool, opts) => {
    const { disableToolDNS } = await import("./mitm/manager.ts");
    try {
      await disableToolDNS(tool, opts.password || null);
      log.ok(`DNS interception disabled for ${tool}`);
    } catch (e: any) {
      log.error(e.message);
      process.exit(1);
    }
  });

mitm
  .command("alias")
  .description("Manage model aliases for MITM interception")
  .action(async () => {
    const { getMitmAliases } = await import("./auth/store.ts");
    const aliases = getMitmAliases();
    if (Object.keys(aliases).length === 0) {
      log.warn("No MITM model aliases configured.");
      log.info("Set aliases via dashboard or API: POST /api/mitm/alias");
      return;
    }
    console.log(chalk.bold("\n  MITM Model Aliases:\n"));
    for (const [tool, mappings] of Object.entries(aliases)) {
      console.log(`    ${chalk.cyan(tool)}:`);
      for (const [from, to] of Object.entries(mappings)) {
        console.log(`      ${from} → ${chalk.green(to)}`);
      }
    }
    console.log("");
  });

program.parse();
