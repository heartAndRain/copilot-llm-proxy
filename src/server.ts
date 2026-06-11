import express from "express";
import type { Config } from "./config.js";
import { CopilotTokenManager } from "./auth/copilotToken.js";
import { CopilotClient } from "./copilot/client.js";
import { ModelResolver } from "./copilot/modelResolver.js";
import { createOpenAIRouter } from "./routes/openai.js";
import { createAnthropicRouter } from "./routes/anthropic.js";
import { createResponsesRouter } from "./routes/responses.js";
import { findGitHubOAuthToken } from "./auth/githubToken.js";
import { VERSION } from "./util/version.js";
import { log } from "./util/logger.js";

export async function startServer(config: Config) {
  const tokens = new CopilotTokenManager({
    userAgent: config.userAgent,
    editorVersion: config.editorVersion,
    editorPluginVersion: config.editorPluginVersion,
    oauthOverride: config.oauthTokenOverride,
  });
  const copilot = new CopilotClient(tokens, config);
  const resolver = new ModelResolver(copilot);

  // Eagerly fetch a token so misconfiguration fails fast on startup.
  let tokenExpiresAt: number | undefined;
  let oauthSource: string | undefined;
  try {
    const oauth = await findGitHubOAuthToken(config.oauthTokenOverride);
    oauthSource = oauth.source;
    const t = await tokens.getToken();
    tokenExpiresAt = t.expiresAt;
  } catch (err) {
    log.error("Failed to acquire Copilot API token:", err);
    throw err;
  }

  // Best-effort: fetch model count so the banner shows it.
  let modelCount: number | undefined;
  try {
    const res = await copilot.listModels();
    const text = await readStream(res.body);
    modelCount = (JSON.parse(text)?.data ?? []).length;
  } catch (err) {
    log.debug("listModels at startup failed:", err);
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.use("/v1", createOpenAIRouter(copilot, resolver));
  app.use("/v1", createAnthropicRouter(copilot, resolver));
  app.use("/v1", createResponsesRouter(copilot, resolver));

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      printStartupBanner({
        host: config.host,
        port: config.port,
        oauthSource,
        tokenExpiresAt,
        modelCount,
        logLevel: config.logLevel,
      });
      const shutdown = (signal: string) => () => {
        log.info(`Received ${signal}, shutting down…`);
        server.close(() => process.exit(0));
        // Hard exit if close hangs (e.g., long-lived streaming clients).
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on("SIGINT", shutdown("SIGINT"));
      process.on("SIGTERM", shutdown("SIGTERM"));
      resolve();
    });
    server.on("error", reject);
  });
}

function printStartupBanner(opts: {
  host: string;
  port: number;
  oauthSource?: string;
  tokenExpiresAt?: number;
  modelCount?: number;
  logLevel: string;
}) {
  const base = `http://${opts.host}:${opts.port}`;
  log.info(`copilot-llm-proxy v${VERSION}  pid=${process.pid}  node=${process.version}`);
  log.info(`  Auth:     ${opts.oauthSource ?? "(unknown)"}`);
  if (opts.tokenExpiresAt) {
    const mins = Math.max(0, Math.round((opts.tokenExpiresAt * 1000 - Date.now()) / 60000));
    log.info(`  Token:    expires in ~${mins} min (auto-refreshed)`);
  }
  if (opts.modelCount != null) {
    log.info(`  Models:   ${opts.modelCount} available on your Copilot subscription`);
  }
  log.info(`  Log level: ${opts.logLevel}`);
  log.info(`Listening on ${base}`);
  log.info(`  OpenAI (chat):      POST ${base}/v1/chat/completions`);
  log.info(`  OpenAI (responses): POST ${base}/v1/responses`);
  log.info(`  Anthropic:          POST ${base}/v1/messages`);
  log.info(`  Models:             GET  ${base}/v1/models`);
  log.info(`  Health:             GET  ${base}/healthz`);
  log.info(`Press Ctrl+C to stop.`);
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks).toString("utf8");
}
