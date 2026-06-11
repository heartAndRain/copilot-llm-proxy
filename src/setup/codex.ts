import path from "node:path";
import os from "node:os";
import { parse, stringify } from "smol-toml";
import { readFileOrNull, writeWithBackup } from "./common.js";

export interface CodexSetupOptions {
  /** Listening address of the proxy, e.g. `http://127.0.0.1:4141`. */
  proxyUrl: string;
  /** Codex provider name (the table key under `[model_providers.X]`). */
  providerName?: string;
  /** Default model id to set at the top level. Pass `null` to leave the existing model untouched. */
  model?: string | null;
  /** Override the path to config.toml. Defaults to `~/.codex/config.toml`. */
  configPath?: string;
  /** If true, also set top-level `model_provider = providerName`. Default true. */
  setDefaultProvider?: boolean;
}

export interface CodexSetupResult {
  configPath: string;
  providerName: string;
  changedKeys: string[];
  backupPath?: string;
}

const DEFAULT_PROVIDER = "copilot";

export async function setupCodex(opts: CodexSetupOptions): Promise<CodexSetupResult> {
  const configPath =
    opts.configPath ?? path.join(os.homedir(), ".codex", "config.toml");
  const providerName = opts.providerName ?? DEFAULT_PROVIDER;
  const setDefaultProvider = opts.setDefaultProvider ?? true;
  const desiredModel = opts.model === undefined ? "gpt-5" : opts.model;

  const raw = await readFileOrNull(configPath);
  const parsed: Record<string, unknown> = raw
    ? (parse(raw) as Record<string, unknown>)
    : {};

  const changed: string[] = [];

  // Ensure [model_providers] table exists
  const modelProviders =
    (parsed.model_providers as Record<string, unknown> | undefined) ?? {};
  parsed.model_providers = modelProviders;

  const provider = {
    name: "GitHub Copilot",
    base_url: `${opts.proxyUrl.replace(/\/+$/, "")}/v1`,
    wire_api: "responses",
    // Intentionally no `env_key`: the proxy doesn't validate Authorization,
    // and setting `env_key` would force users to set OPENAI_API_KEY in their
    // environment. Codex treats a missing `env_key` as "no auth required".
  };

  const prev = modelProviders[providerName] as Record<string, unknown> | undefined;
  if (!prev || !shallowEqual(prev, provider)) {
    modelProviders[providerName] = provider;
    changed.push(`model_providers.${providerName}`);
  }

  if (setDefaultProvider && parsed.model_provider !== providerName) {
    parsed.model_provider = providerName;
    changed.push("model_provider");
  }

  if (desiredModel != null && parsed.model !== desiredModel) {
    parsed.model = desiredModel;
    changed.push("model");
  }

  // smol-toml's stringify expects a record at the top level.
  const newContent = stringify(parsed as Parameters<typeof stringify>[0]) + "\n";
  const { backupPath } = await writeWithBackup(configPath, newContent);

  return { configPath, providerName, changedKeys: changed, backupPath };
}

function shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}
