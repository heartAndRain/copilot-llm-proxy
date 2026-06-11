import { Router, type Request, type Response } from "express";
import type { CopilotClient } from "../copilot/client.js";
import type { ModelResolver } from "../copilot/modelResolver.js";
import {
  anthropicToOpenAI,
  type AnthropicRequest,
} from "../translators/anthropicToOpenAI.js";
import {
  openAIToAnthropic,
  OpenAIStreamToAnthropic,
} from "../translators/openAIToAnthropic.js";
import { iterateSse } from "../util/sse.js";
import { log } from "../util/logger.js";
import { logRequest, summariseThinking } from "../util/accessLog.js";

export function createAnthropicRouter(copilot: CopilotClient, resolver: ModelResolver): Router {
  const router = Router();

  // Claude Code calls `POST /v1/messages/count_tokens` before some requests.
  // We don't have a real tokenizer here; return a coarse character-based
  // estimate so the client doesn't hard-fail.
  router.post("/messages/count_tokens", (req: Request, res: Response) => {
    const body = req.body as AnthropicRequest | undefined;
    if (!body) return res.json({ input_tokens: 0 });
    let chars = 0;
    if (typeof body.system === "string") chars += body.system.length;
    else if (Array.isArray(body.system)) {
      for (const b of body.system) if (b.type === "text") chars += b.text.length;
    }
    for (const m of body.messages ?? []) {
      if (typeof m.content === "string") chars += m.content.length;
      else
        for (const b of m.content) {
          if (b.type === "text") chars += b.text.length;
          else if (b.type === "tool_use") chars += JSON.stringify(b.input).length;
          else if (b.type === "tool_result") {
            chars +=
              typeof b.content === "string"
                ? b.content.length
                : JSON.stringify(b.content).length;
          }
        }
    }
    res.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) });
  });

  router.post("/messages", async (req: Request, res: Response) => {
    const anthropicReq = req.body as AnthropicRequest;
    if (!anthropicReq || !Array.isArray(anthropicReq.messages)) {
      return res
        .status(400)
        .json({ type: "error", error: { type: "invalid_request_error", message: "messages required" } });
    }
    const openAIReq = anthropicToOpenAI(anthropicReq);
    const wantsStream = Boolean(anthropicReq.stream);
    openAIReq.stream = wantsStream;
    const requestedModel = openAIReq.model;
    openAIReq.model = await resolver.resolve(openAIReq.model);

    // Access log: filled in lazily as we discover token counts.
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let upstreamStatus: number | undefined;
    logRequest(req, res, () => ({
      model: openAIReq.model === requestedModel
        ? openAIReq.model
        : `${requestedModel}→${openAIReq.model}`,
      stream: wantsStream ? "y" : undefined,
      think: summariseThinking(anthropicReq.thinking),
      tools: anthropicReq.tools?.length,
      msgs: anthropicReq.messages.length,
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
        body: openAIReq,
        stream: wantsStream,
        signal: ac.signal,
      });
      upstreamStatus = upstream.status;

      if (upstream.status < 200 || upstream.status >= 300) {
        await forwardError(upstream, res);
        return;
      }

      if (!wantsStream) {
        const text = await readAll(upstream.body);
        const parsed = JSON.parse(text) as {
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        inputTokens = parsed.usage?.prompt_tokens;
        outputTokens = parsed.usage?.completion_tokens;
        const translated = openAIToAnthropic(parsed as never, anthropicReq.model);
        res.setHeader("Content-Type", "application/json");
        res.status(200).send(JSON.stringify(translated));
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const translator = new OpenAIStreamToAnthropic(anthropicReq.model);
      res.write(translator.start());

      try {
        for await (const data of iterateSse(upstream.body)) {
          if (data === "[DONE]") break;
          try {
            const chunk = JSON.parse(data) as {
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            if (chunk.usage) {
              if (chunk.usage.prompt_tokens != null) inputTokens = chunk.usage.prompt_tokens;
              if (chunk.usage.completion_tokens != null) outputTokens = chunk.usage.completion_tokens;
            }
            const out = translator.handleChunk(chunk as never);
            if (out) res.write(out);
          } catch (err) {
            log.debug("Skipping unparseable SSE chunk:", data.slice(0, 200));
          }
        }
        res.write(translator.end());
      } catch (err) {
        log.error("Stream error:", err);
        const msg = err instanceof Error ? err.message : String(err);
        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: "api_error", message: msg },
          })}\n\n`,
        );
      } finally {
        res.end();
      }
    } catch (err) {
      log.error("/v1/messages failed:", err);
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        res
          .status(502)
          .json({ type: "error", error: { type: "api_error", message } });
      }
    }
  });

  return router;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function forwardError(
  upstream: { status: number; body: NodeJS.ReadableStream },
  res: Response,
) {
  const text = await readAll(upstream.body);
  res.status(upstream.status);
  res.setHeader("Content-Type", "application/json");
  // Try to wrap as Anthropic error if it parses as JSON.
  try {
    const parsed = JSON.parse(text);
    res.send(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message:
            parsed?.error?.message ??
            parsed?.message ??
            `Upstream error ${upstream.status}`,
          upstream: parsed,
        },
      }),
    );
  } catch {
    res.send(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: `Upstream error ${upstream.status}: ${text.slice(0, 500)}`,
        },
      }),
    );
  }
}
