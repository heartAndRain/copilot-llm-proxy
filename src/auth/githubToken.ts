import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../util/logger.js";
import { readStoredAuth, authFilePath } from "./deviceLogin.js";

const execFileAsync = promisify(execFile);

export interface GitHubOAuthToken {
  token: string;
  source: string;
}

function candidateConfigDirs(): string[] {
  const dirs: string[] = [];
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "github-copilot"));
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "github-copilot"));
  }
  if (process.env.XDG_CONFIG_HOME) dirs.push(path.join(process.env.XDG_CONFIG_HOME, "github-copilot"));
  dirs.push(path.join(os.homedir(), ".config", "github-copilot"));
  return Array.from(new Set(dirs));
}

async function readJsonIfExists(file: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    log.debug(`Failed to read ${file}:`, err);
    return null;
  }
}

function extractToken(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const token = entry.oauth_token ?? entry.token;
    if (typeof token === "string" && token.length > 0) {
      // Prefer github.com hosts/apps
      if (key.startsWith("github.com")) return token;
    }
  }
  // Fall back to any token found, regardless of host
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const token = entry.oauth_token ?? entry.token;
    if (typeof token === "string" && token.length > 0) return token;
  }
  return null;
}

async function readFromCopilotConfig(): Promise<GitHubOAuthToken | null> {
  for (const dir of candidateConfigDirs()) {
    for (const file of ["apps.json", "hosts.json"]) {
      const full = path.join(dir, file);
      const parsed = await readJsonIfExists(full);
      const token = extractToken(parsed);
      if (token) {
        return { token, source: full };
      }
    }
  }
  return null;
}

async function readFromGhCli(): Promise<GitHubOAuthToken | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      windowsHide: true,
      timeout: 5000,
    });
    const token = stdout.trim();
    if (token.length > 0) return { token, source: "gh auth token" };
  } catch (err) {
    log.debug("gh auth token failed:", err);
  }
  return null;
}

/**
 * Locate a GitHub Copilot OAuth token from local sources.
 *
 * Search order:
 *   1. GH_COPILOT_TOKEN env var (if `overrideEnv` is provided)
 *   2. Token persisted by `copilot-llm-proxy login` (~/.copilot-llm-proxy/auth.json)
 *   3. The Copilot CLI/editor config dirs (apps.json / hosts.json)
 *   4. `gh auth token` (only works if the gh CLI is signed in with a token
 *      that has Copilot scope; usually it isn't — prefer `login`).
 */
export async function findGitHubOAuthToken(overrideEnv?: string): Promise<GitHubOAuthToken> {
  if (overrideEnv && overrideEnv.length > 0) {
    return { token: overrideEnv, source: "GH_COPILOT_TOKEN env" };
  }
  const stored = await readStoredAuth();
  if (stored) {
    return { token: stored.oauth_token, source: authFilePath() };
  }
  const fromConfig = await readFromCopilotConfig();
  if (fromConfig) return fromConfig;
  const fromGh = await readFromGhCli();
  if (fromGh) return fromGh;
  throw new Error(
    "Could not find a GitHub Copilot OAuth token. " +
      "Run `copilot-llm-proxy login` to sign in, " +
      "or set the GH_COPILOT_TOKEN env var.",
  );
}
