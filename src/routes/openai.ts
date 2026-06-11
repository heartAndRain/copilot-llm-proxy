import { Router, type Request, type Response } from "express";
import type { CopilotClient } from "../copilot/client.js";
import type { ModelResolver } from "../copilot/modelResolver.js";
import { log } from "../util/logger.js";
import { logRequest } from "../util/accessLog.js";

export function createOpenAIRouter(copilot: CopilotClient, resolver: ModelResolver): Router {
  const router = Router();

  router.get("/models", async (req, res) => {
    let count: number | undefined;
    logRequest(req, res, () => ({ count }));
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const upstream = await copilot.listModels(ac.signal);
      res.status(upstream.status);
      forwardJsonHeaders(upstream.headers, res);
      // Tee the body so we can both forward and parse for the count.
      const chunks: Buffer[] = [];
      upstream.body.on("data", (c: Buffer) => chunks.push(c));
      upstream.body.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          count = parsed?.data?.length;
        } catch {
          /* ignore */
        }
      });
      upstream.body.pipe(res);
    } catch (err) {
      log.error("/v1/models failed:", err);
      sendError(res, err);
    }
  });

  router.post("/chat/completions", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const requestedModel = typeof body.model === "string" ? body.model : undefined;
    if (typeof body.model === "string") {
      body.model = await resolver.resolve(body.model);
    }
    const wantsStream = Boolean(body.stream);
    let upstreamStatus: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    logRequest(req, res, () => ({
      model: requestedModel && body.model && body.model !== requestedModel
        ? `${requestedModel}→${body.model}`
        : body.model,
      stream: wantsStream ? "y" : undefined,
      effort: body.reasoning_effort,
      think: body.thinking?.type,
      tools: Array.isArray(body.tools) ? body.tools.length : undefined,
      msgs: Array.isArray(body.messages) ? body.messages.length : undefined,
      in: inputTokens,
      out: outputTokens,
      upstream: upstreamStatus,
    }));

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const upstream = await copilot.chatCompletions({
        body,
        stream: wantsStream,
        signal: ac.signal,
      });
      upstreamStatus = upstream.status;
      res.status(upstream.status);
      if (wantsStream) {
        forwardSseHeaders(upstream.headers, res);
      } else {
        forwardJsonHeaders(upstream.headers, res);
      }
      // Tee the body so we can capture usage tokens for the access log.
      upstream.body.on("data", (c: Buffer) => {
        // Best-effort scan for usage tokens in last chunk(s); cheap and
        // good-enough for logging.
        const s = c.toString("utf8");
        const m = s.match(/"prompt_tokens"\s*:\s*(\d+)/);
        if (m) inputTokens = Number(m[1]);
        const m2 = s.match(/"completion_tokens"\s*:\s*(\d+)/);
        if (m2) outputTokens = Number(m2[1]);
      });
      upstream.body.pipe(res);
    } catch (err) {
      log.error("/v1/chat/completions failed:", err);
      sendError(res, err);
    }
  });

  return router;
}

function forwardJsonHeaders(src: Record<string, string | string[]>, res: Response) {
  const ct = src["content-type"];
  if (ct) res.setHeader("Content-Type", asString(ct));
  else res.setHeader("Content-Type", "application/json");
}

function forwardSseHeaders(src: Record<string, string | string[]>, res: Response) {
  res.setHeader("Content-Type", asString(src["content-type"]) || "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function asString(v: string | string[] | undefined): string {
  if (!v) return "";
  return Array.isArray(v) ? v[0] ?? "" : v;
}

function sendError(res: Response, err: unknown) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(502).json({
    error: { message, type: "upstream_error" },
  });
}
