import { request } from "undici";
import { findGitHubOAuthToken } from "./githubToken.js";
import { log } from "../util/logger.js";

interface CopilotTokenResponse {
  token: string;
  expires_at: number; // unix seconds
  refresh_in?: number;
  endpoints?: { api?: string };
}

interface CachedToken {
  token: string;
  expiresAt: number; // unix seconds
  endpoint?: string;
}

/**
 * Exchanges the GitHub OAuth token for a short-lived Copilot API token and
 * caches it. The API token is what the chat-completions endpoint accepts.
 */
export class CopilotTokenManager {
  private cached?: CachedToken;
  private inFlight?: Promise<CachedToken>;
  private readonly userAgent: string;
  private readonly editorVersion: string;
  private readonly editorPluginVersion: string;
  private readonly oauthOverride?: string;

  constructor(opts: {
    userAgent: string;
    editorVersion: string;
    editorPluginVersion: string;
    oauthOverride?: string;
  }) {
    this.userAgent = opts.userAgent;
    this.editorVersion = opts.editorVersion;
    this.editorPluginVersion = opts.editorPluginVersion;
    this.oauthOverride = opts.oauthOverride;
  }

  async getToken(): Promise<CachedToken> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expiresAt - 60 > now) {
      return this.cached;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<CachedToken> {
    const oauth = await findGitHubOAuthToken(this.oauthOverride);
    log.debug(`Using GitHub OAuth token from: ${oauth.source}`);

    const res = await request("https://api.github.com/copilot_internal/v2/token", {
      method: "GET",
      headers: {
        Authorization: `token ${oauth.token}`,
        Accept: "application/json",
        "User-Agent": this.userAgent,
        "Editor-Version": this.editorVersion,
        "Editor-Plugin-Version": this.editorPluginVersion,
      },
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(
        `Failed to exchange GitHub OAuth token for Copilot API token: ` +
          `${res.statusCode} ${body.slice(0, 500)}`,
      );
    }

    const data = (await res.body.json()) as CopilotTokenResponse;
    const isRefresh = !!this.cached;
    this.cached = {
      token: data.token,
      expiresAt: data.expires_at,
      endpoint: data.endpoints?.api,
    };
    const expiresIn = Math.max(0, Math.round((data.expires_at * 1000 - Date.now()) / 60000));
    const verb = isRefresh ? "Refreshed" : "Acquired";
    log.info(`${verb} Copilot API token (expires in ~${expiresIn} min)`);
    return this.cached;
  }
}
