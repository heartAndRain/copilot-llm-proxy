import { request } from "undici";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../util/logger.js";

// Public OAuth client ID for GitHub Copilot Chat in VS Code.
// This is the standard, widely-documented client ID; it's not a secret.
// Tokens issued for it are accepted by /copilot_internal/v2/token.
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export interface StoredAuth {
  oauth_token: string;
  saved_at: string;
}

export function authFilePath(): string {
  return path.join(os.homedir(), ".copilot-llm-proxy", "auth.json");
}

export async function readStoredAuth(): Promise<StoredAuth | null> {
  try {
    const raw = await fs.readFile(authFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.oauth_token === "string") {
      return parsed as StoredAuth;
    }
    return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    log.debug("readStoredAuth failed:", err);
    return null;
  }
}

async function writeStoredAuth(auth: StoredAuth): Promise<string> {
  const file = authFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(auth, null, 2), { mode: 0o600 });
  return file;
}

async function requestDeviceCode(userAgent: string): Promise<DeviceCodeResponse> {
  const res = await request("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": userAgent,
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await res.body.text();
    throw new Error(`device/code failed: ${res.statusCode} ${body.slice(0, 300)}`);
  }
  return (await res.body.json()) as DeviceCodeResponse;
}

async function pollForToken(
  deviceCode: string,
  intervalSec: number,
  expiresInSec: number,
  userAgent: string,
): Promise<string> {
  const deadline = Date.now() + expiresInSec * 1000;
  let interval = intervalSec;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": userAgent,
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = (await res.body.json()) as DeviceTokenResponse;
    if (data.access_token) return data.access_token;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      interval = (data.interval ?? interval) + 1;
      continue;
    }
    if (data.error === "expired_token" || data.error === "access_denied") {
      throw new Error(`OAuth flow ended: ${data.error}: ${data.error_description ?? ""}`);
    }
    throw new Error(
      `Unexpected device-token response: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }
  throw new Error("Device-code flow timed out before the user authorized.");
}

/**
 * Runs GitHub's device-code OAuth flow against the Copilot Chat client ID.
 * Prints the verification code, waits for the user to authorize in the
 * browser, then persists the resulting OAuth token.
 *
 * Returns the path the token was written to.
 */
export async function loginInteractive(userAgent: string): Promise<string> {
  const code = await requestDeviceCode(userAgent);
  console.log("");
  console.log("Open the following URL in your browser and enter the code:");
  console.log(`  URL:  ${code.verification_uri}`);
  console.log(`  Code: ${code.user_code}`);
  console.log("");
  console.log("Waiting for authorization…");
  const token = await pollForToken(
    code.device_code,
    code.interval,
    code.expires_in,
    userAgent,
  );
  const file = await writeStoredAuth({
    oauth_token: token,
    saved_at: new Date().toISOString(),
  });
  console.log(`\n✓ Logged in. Token saved to: ${file}`);
  return file;
}
