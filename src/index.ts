#!/usr/bin/env node
import { Command, Option } from "commander";
import { promises as fs } from "node:fs";
import { loadConfig } from "./config.js";
import { setLogLevel } from "./util/logger.js";
import { startServer } from "./server.js";
import { loginInteractive, authFilePath, readStoredAuth } from "./auth/deviceLogin.js";
import { findGitHubOAuthToken } from "./auth/githubToken.js";
import { CopilotTokenManager } from "./auth/copilotToken.js";
import { setupCodex } from "./setup/codex.js";
import { setupClaude, CLAUDE_USE_CLIENT_DEFAULT } from "./setup/claude.js";
import { pickModelInteractive } from "./setup/modelPicker.js";
import { CopilotClient } from "./copilot/client.js";
import { VERSION } from "./util/version.js";

const program = new Command();
program
  .name("cllmp")
  .version(VERSION, "-V, --version", "print version and exit")
  .description(
    "copilot-llm-proxy — local proxy that exposes GitHub Copilot's LLM backend via OpenAI- and Anthropic-compatible HTTP APIs.",
  );

const serveCommand = (name: string, description: string) =>
  program
    .command(name)
    .description(description)
    .option("-p, --port <port>", "port to listen on", (v) => Number(v))
    .option("-H, --host <host>", "host/interface to bind to")
    .option("--debug", "enable debug logging", false)
    .action(async (opts) => {
      const config = loadConfig({
        ...(opts.port ? { port: opts.port } : {}),
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.debug ? { logLevel: "debug" as const } : {}),
      });
      setLogLevel(config.logLevel);
      try {
        await startServer(config);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

serveCommand("start", "Start the proxy server.");
serveCommand("serve", "Alias for `start`. Run the proxy server.");

program
  .command("login")
  .alias("signin")
  .description("Sign in to GitHub Copilot via device-code flow and persist the OAuth token.")
  .action(async () => {
    const config = loadConfig();
    try {
      await loginInteractive(config.userAgent);
      const tokens = new CopilotTokenManager({
        userAgent: config.userAgent,
        editorVersion: config.editorVersion,
        editorPluginVersion: config.editorPluginVersion,
      });
      await tokens.getToken();
      console.log("✓ Verified: Copilot API token exchange succeeded.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("logout")
  .alias("signout")
  .description("Remove the persisted OAuth token.")
  .action(async () => {
    const file = authFilePath();
    try {
      await fs.unlink(file);
      console.log(`Removed ${file}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log("Nothing to remove (not logged in).");
      } else {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    }
  });

program
  .command("status")
  .description("Show which OAuth token source would be used and whether it works.")
  .action(async () => {
    const config = loadConfig();
    setLogLevel(config.logLevel);
    try {
      const found = await findGitHubOAuthToken(config.oauthTokenOverride);
      console.log(`OAuth token source: ${found.source}`);
      const stored = await readStoredAuth();
      if (stored) console.log(`Persisted login saved at: ${stored.saved_at}`);
      const tokens = new CopilotTokenManager({
        userAgent: config.userAgent,
        editorVersion: config.editorVersion,
        editorPluginVersion: config.editorPluginVersion,
        oauthOverride: config.oauthTokenOverride,
      });
      const t = await tokens.getToken();
      console.log(
        `✓ Copilot API token OK (expires ${new Date(t.expiresAt * 1000).toISOString()})`,
      );
    } catch (err) {
      console.error("✗", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

const setup = program
  .command("setup")
  .description("Configure a client tool (Codex or Claude Code) to use this proxy.");

setup
  .command("codex")
  .description("Update ~/.codex/config.toml to add a Copilot provider pointing at the proxy.")
  .addOption(
    new Option("--url <url>", "Proxy base URL").default("http://127.0.0.1:4141"),
  )
  .option("--provider-name <name>", "Codex provider name to register under [model_providers.X]", "copilot")
  .option(
    "--model <id>",
    "Default model id to set at the top level. Prompts interactively if omitted. Use --no-model to leave it unchanged.",
  )
  .option("--no-model", "Don't change the top-level `model` setting")
  .option("--no-default-provider", "Don't set the top-level `model_provider`")
  .option(
    "--compact-limit <tokens>",
    "Token count at which Codex auto-compacts the conversation. Prevents long sessions from growing past Copilot's request-size limit (413). Default 160000.",
    (v) => Number(v),
  )
  .option("--no-compact-limit", "Don't set Codex's `model_auto_compact_token_limit`")
  .option("--config <path>", "Override path to config.toml")
  .action(async (opts) => {
    try {
      const model = await resolveModel({
        explicit: opts.model,
        vendor: "OpenAI",
        defaultId: "gpt-5.5",
        title: "Available OpenAI models on your Copilot subscription:",
      });
      const autoCompactTokenLimit =
        opts.compactLimit === false ? null : (opts.compactLimit ?? 160000);
      const result = await setupCodex({
        proxyUrl: opts.url,
        providerName: opts.providerName,
        model,
        setDefaultProvider: opts.defaultProvider !== false,
        autoCompactTokenLimit,
        configPath: opts.config,
      });
      printSetupSummary("Codex", result.configPath, result.changedKeys, result.backupPath, [
        `Make sure \`cllmp start\` is running on ${opts.url}.`,
        `No API key needed — the proxy ignores Authorization.`,
        ...(autoCompactTokenLimit != null
          ? [`Codex will auto-compact at ~${autoCompactTokenLimit} tokens to avoid Copilot's request-size limit.`]
          : []),
      ]);
    } catch (err) {
      console.error("✗", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

setup
  .command("claude")
  .description("Update ~/.claude/settings.json to point Claude Code at the proxy.")
  .addOption(
    new Option("--url <url>", "Proxy base URL").default("http://127.0.0.1:4141"),
  )
  .option(
    "--model <id>",
    "Default Anthropic model id to set. Prompts interactively if omitted. " +
      "Use `default` to let Claude Code pick (recommended). Use --no-model to leave the existing setting unchanged.",
  )
  .option("--no-model", "Don't change the top-level `model` setting")
  .option("--config <path>", "Override path to settings.json")
  .action(async (opts) => {
    try {
      const model = await resolveModel({
        explicit: opts.model,
        vendor: "Anthropic",
        defaultId: "claude-sonnet-4.6",
        title: "Available Anthropic models on your Copilot subscription:",
        topEntry: {
          label: "Default (recommended)",
          description: "let Claude Code's /model picker decide (currently Opus 4.8 1M)",
          value: CLAUDE_USE_CLIENT_DEFAULT,
        },
      });
      const result = await setupClaude({
        proxyUrl: opts.url,
        model,
        configPath: opts.config,
      });
      printSetupSummary("Claude Code", result.configPath, result.changedKeys, result.backupPath, [
        `Restart your Claude Code session so the new \`env\` block is picked up.`,
        `Make sure \`cllmp start\` is running on ${opts.url}.`,
      ]);
    } catch (err) {
      console.error("✗", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

/**
 * Resolves the model id from the command-line flag, interactive picker, or
 * default — depending on what the user passed:
 *   - `--no-model`          → returns `null` (caller should not modify model)
 *   - `--model <id>`        → returns `<id>` as-is
 *   - (omitted, TTY)        → prompts interactively with models from Copilot
 *   - (omitted, non-TTY)    → returns `defaultId` (or `topEntry.value` if set)
 */
async function resolveModel(opts: {
  explicit: string | false | undefined;
  vendor: string;
  defaultId: string;
  title: string;
  topEntry?: { label: string; description: string; value: string };
}): Promise<string | null> {
  if (opts.explicit === false) return null;
  if (typeof opts.explicit === "string") return opts.explicit;

  // Need a CopilotClient to fetch models. Build one with cached token.
  const config = loadConfig();
  setLogLevel("silent"); // keep the picker UI clean
  const tokens = new CopilotTokenManager({
    userAgent: config.userAgent,
    editorVersion: config.editorVersion,
    editorPluginVersion: config.editorPluginVersion,
    oauthOverride: config.oauthTokenOverride,
  });
  const copilot = new CopilotClient(tokens, config);
  return pickModelInteractive({
    copilot,
    vendor: opts.vendor,
    defaultId: opts.defaultId,
    title: opts.title,
    topEntry: opts.topEntry,
  });
}

function printSetupSummary(
  tool: string,
  configPath: string,
  changed: string[],
  backupPath: string | undefined,
  nextSteps: string[],
) {
  console.log(`\n✓ ${tool} configured.`);
  console.log(`  Config file:   ${configPath}`);
  if (changed.length === 0) {
    console.log(`  Changes:       (none — already up to date)`);
  } else {
    console.log(`  Updated keys:  ${changed.join(", ")}`);
  }
  if (backupPath) {
    console.log(`  Backup:        ${backupPath}`);
  }
  if (nextSteps.length > 0) {
    console.log("\nNext steps:");
    for (const step of nextSteps) console.log(`  • ${step}`);
  }
}

program
  .showHelpAfterError("(run `cllmp --help` to see all commands)")
  .showSuggestionAfterError(true);

program.parseAsync(process.argv);

