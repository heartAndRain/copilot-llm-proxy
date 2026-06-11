import { request, type Dispatcher } from "undici";
import { Readable } from "node:stream";
import type { CopilotTokenManager } from "../auth/copilotToken.js";
import type { Config } from "../config.js";
import { log } from "../util/logger.js";

export interface CopilotRequestOptions {
  body: unknown;
  signal?: AbortSignal;
  /**
   * If `true`, the response body is returned as a readable stream of
   * Server-Sent Events bytes. Callers are responsible for piping it back.
   */
  stream: boolean;
}

export interface CopilotResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Readable;
}

/**
 * Thin wrapper around GitHub Copilot's chat-completions endpoint that
 * injects the auth + identification headers it expects.
 */
export class CopilotClient {
  constructor(private readonly tokens: CopilotTokenManager, private readonly config: Config) {}

  private async commonHeaders(stream: boolean): Promise<Record<string, string>> {
    const { token } = await this.tokens.getToken();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": this.config.userAgent,
      "Editor-Version": this.config.editorVersion,
      "Editor-Plugin-Version": this.config.editorPluginVersion,
      "Copilot-Integration-Id": this.config.integrationId,
      "Openai-Intent": "conversation-panel",
    };
  }

  async chatCompletions(opts: CopilotRequestOptions): Promise<CopilotResponse> {
    const headers = await this.commonHeaders(opts.stream);
    const url = `${this.config.copilotBaseUrl}/chat/completions`;
    log.debug(`POST ${url} stream=${opts.stream}`);
    const res = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
    return toCopilotResponse(res);
  }

  async responses(opts: CopilotRequestOptions): Promise<CopilotResponse> {
    const headers = await this.commonHeaders(opts.stream);
    const url = `${this.config.copilotBaseUrl}/responses`;
    log.debug(`POST ${url} stream=${opts.stream}`);
    const res = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
    return toCopilotResponse(res);
  }

  async listModels(signal?: AbortSignal): Promise<CopilotResponse> {
    const headers = await this.commonHeaders(false);
    const url = `${this.config.copilotBaseUrl}/models`;
    const res = await request(url, { method: "GET", headers, signal });
    return toCopilotResponse(res);
  }
}

function toCopilotResponse(res: Dispatcher.ResponseData): CopilotResponse {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v == null) continue;
    headers[k] = v as string | string[];
  }
  // In undici v6, res.body is already a Node Readable (BodyReadable extends Readable).
  return {
    status: res.statusCode,
    headers,
    body: res.body as unknown as Readable,
  };
}
