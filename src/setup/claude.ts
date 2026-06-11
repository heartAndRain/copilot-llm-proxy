import path from "node:path";
import os from "node:os";
import { readFileOrNull, writeWithBackup } from "./common.js";

export interface ClaudeSetupOptions {
  /** Listening address of the proxy, e.g. `http://127.0.0.1:4141`. */
  proxyUrl: string;
  /**
   * Default Anthropic model id to set. Special values:
   *   - `undefined` (omitted): keep current setting
   *   - `null` (--no-model): don't change the existing setting
   *   - `""` or `"default"`: REMOVE the pinned model, so the Claude Code
   *     client picks its own default (option 1 in `/model`)
   *   - any other string: write it as the pinned model
   */
  model?: string | null;
  /** Override the path to settings.json. Defaults to `~/.claude/settings.json`. */
  configPath?: string;
  /** Placeholder API key (Claude Code requires one even when ignored). */
  apiKey?: string;
}

export interface ClaudeSetupResult {
  configPath: string;
  changedKeys: string[];
  backupPath?: string;
}

/** Sentinel that `pickModelInteractive` returns when the user picks "let the client decide". */
export const CLAUDE_USE_CLIENT_DEFAULT = "__default__";

/**
 * Updates Claude Code's user settings (~/.claude/settings.json) to point at
 * the proxy. Claude Code respects an `env` object that is exported into the
 * session before launching, which is the supported way to override
 * ANTHROPIC_BASE_URL etc.
 *
 * Existing keys are preserved; only the proxy-related ones inside `env`
 * (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`) and the
 * top-level `model` field are touched. Any stale `ANTHROPIC_SMALL_FAST_MODEL`
 * pointing at a model id the new proxy doesn't expose is removed so it
 * doesn't break background haiku-class calls.
 *
 * If `model` is `""`, `"default"`, or `CLAUDE_USE_CLIENT_DEFAULT`, the
 * top-level `model` and `env.ANTHROPIC_MODEL` are REMOVED so the Claude
 * Code client picks its built-in default (option 1 in `/model`).
 */
export async function setupClaude(opts: ClaudeSetupOptions): Promise<ClaudeSetupResult> {
  const configPath =
    opts.configPath ?? path.join(os.homedir(), ".claude", "settings.json");
  const apiKey = opts.apiKey ?? "copilot-proxy";
  const baseUrl = opts.proxyUrl.replace(/\/+$/, "");

  const useClientDefault =
    opts.model === "" ||
    opts.model === "default" ||
    opts.model === CLAUDE_USE_CLIENT_DEFAULT;
  const desiredModel = useClientDefault
    ? null
    : opts.model === undefined
      ? "claude-sonnet-4.6"
      : opts.model;

  const raw = await readFileOrNull(configPath);
  const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};

  const changed: string[] = [];
  const env = (parsed.env as Record<string, string> | undefined) ?? {};
  parsed.env = env;

  const desiredEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
  if (desiredModel != null) desiredEnv.ANTHROPIC_MODEL = desiredModel;

  for (const [k, v] of Object.entries(desiredEnv)) {
    if (env[k] !== v) {
      env[k] = v;
      changed.push(`env.${k}`);
    }
  }

  // When letting the client pick its default, strip any pinned ANTHROPIC_MODEL.
  if (useClientDefault && typeof env.ANTHROPIC_MODEL === "string") {
    delete env.ANTHROPIC_MODEL;
    changed.push("env.ANTHROPIC_MODEL (removed)");
  }

  // If there's a small-fast model env override leftover from a previous
  // proxy that we can't verify, drop it — leaving a stale value will cause
  // background classification calls to fail.
  if (typeof env.ANTHROPIC_SMALL_FAST_MODEL === "string") {
    delete env.ANTHROPIC_SMALL_FAST_MODEL;
    changed.push("env.ANTHROPIC_SMALL_FAST_MODEL (removed)");
  }

  if (useClientDefault) {
    if (parsed.model !== undefined) {
      delete parsed.model;
      changed.push("model (removed)");
    }
  } else if (desiredModel != null && parsed.model !== desiredModel) {
    parsed.model = desiredModel;
    changed.push("model");
  }

  const newContent = JSON.stringify(parsed, null, 2) + "\n";
  const { backupPath } = await writeWithBackup(configPath, newContent);

  return { configPath, changedKeys: changed, backupPath };
}
