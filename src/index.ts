#!/usr/bin/env bun
import { Command } from "commander";
import { createApp } from "./server.ts";
import { oauthCodebuddy } from "./auth/oauth.ts";
import { createApiKey, getApiKeys, listConnections, removeConnection } from "./auth/store.ts";
import { log } from "./utils/logger.ts";
import chalk from "chalk";

const program = new Command();

program
  .name("hexos")
  .description("Lightweight AI API proxy")
  .version("0.1.0");

// Start server
program
  .command("start")
  .description("Start the proxy server")
  .option("-p, --port <port>", "Port to listen on", "8080")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .action(async (opts) => {
    const app = createApp();
    const port = parseInt(opts.port);
    const keys = getApiKeys();

    log.ok(`Hexos proxy starting on ${chalk.cyan(`http://${opts.host}:${port}`)}`);
    if (keys.length === 0) {
      log.warn("No API keys configured — running in open mode. Run: hexos key create");
    } else {
      log.info(`API keys: ${keys.length} configured`);
    }
    log.info(`Connections: ${listConnections().length} active`);

    Bun.serve({ fetch: app.fetch, port, hostname: opts.host });
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
      return;
    }
    console.log(chalk.bold("\nConnections:"));
    for (const c of conns) {
      console.log(`  ${chalk.cyan(c.id.slice(0, 8))} ${chalk.white(c.provider)} — ${c.label}`);
    }
  });

auth
  .command("remove <id>")
  .description("Remove a connection by ID")
  .action(async (id) => {
    await removeConnection(id);
    log.ok(`Removed connection ${id}`);
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

program.parse();
