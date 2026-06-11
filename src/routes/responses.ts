import { Router, type Request, type Response } from "express";
import type { CopilotClient } from "../copilot/client.js";
import type { ModelResolver } from "../copilot/modelResolver.js";
import { log } from "../util/logger.js";
import { logRequest, summariseReasoning } from "../util/accessLog.js";

/**
 * `/v1/responses` is a near-passthrough to Copilot's native `/responses`
 * endpoint, which speaks the OpenAI Responses API and supports the newer
 * GPT-5.x models (which Copilot does *not* expose through chat-completions).
 *
 * This is what Codex CLI ≥ 0.118 requires (`wire_api = "responses"`).
 */
export function createResponsesRouter(copilot: CopilotClient, resolver: ModelResolver): Router {
  const router = Router();

  router.post("/responses", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (!body.input && !body.messages) {
      return res.status(400).json({
        error: { message: "`input` is required", type: "invalid_request_error" },
      });
    }
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
      effort: summariseReasoning(body.reasoning),
      tools: Array.isArray(body.tools) ? body.tools.length : undefined,
      in: inputTokens,
      out: outputTokens,
      upstream: upstreamStatus,
    }));

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });

    try {
      const upstream = await copilot.responses({
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
      upstream.body.on("data", (c: Buffer) => {
        const s = c.toString("utf8");
        const m = s.match(/"input_tokens"\s*:\s*(\d+)/);
        if (m) inputTokens = Number(m[1]);
        const m2 = s.match(/"output_tokens"\s*:\s*(\d+)/);
        if (m2) outputTokens = Number(m2[1]);
      });
      upstream.body.pipe(res);
    } catch (err) {
      log.error("/v1/responses failed:", err);
      sendError(res, err);
    }
  });

  return router;
}

function forwardJsonHeaders(src: Record<string, string | string[]>, res: Response) {
  const ct = src["content-type"];
  res.setHeader("Content-Type", asString(ct) || "application/json");
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
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(502).json({ error: { message, type: "upstream_error" } });
}
