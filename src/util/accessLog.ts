import type { Request, Response } from "express";
import { log } from "./logger.js";

export type AccessExtras = Record<string, string | number | boolean | undefined>;

/**
 * Logs one concise line per request when the response finishes (or the
 * client disconnects). Extras are evaluated lazily on completion so they
 * can include data that's only known after upstream returns (e.g. resolved
 * model id, token counts from streaming chunks).
 */
export function logRequest(
  req: Request,
  res: Response,
  extras: () => AccessExtras,
) {
  const start = Date.now();
  let logged = false;
  const finalize = () => {
    if (logged) return;
    logged = true;
    const duration = Date.now() - start;
    const parts: string[] = [
      `${req.method} ${req.path}`,
      String(res.statusCode),
      formatDuration(duration),
    ];
    let extra: AccessExtras;
    try {
      extra = extras() ?? {};
    } catch {
      extra = {};
    }
    for (const [k, v] of Object.entries(extra)) {
      if (v == null || v === "" || v === false) continue;
      parts.push(`${k}=${v}`);
    }
    if (res.statusCode >= 500) log.warn(parts.join(" "));
    else log.info(parts.join(" "));
  };
  res.on("finish", finalize);
  res.on("close", finalize);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Summarises a `thinking`-like value for the access log:
 *   undefined        → undefined        (omitted)
 *   { type: 'X' }    → 'X'
 *   true/'enabled'   → 'enabled'
 *   other            → 'on'
 */
export function summariseThinking(thinking: unknown): string | undefined {
  if (thinking == null) return undefined;
  if (typeof thinking === "string") return thinking;
  if (typeof thinking === "object") {
    const t = (thinking as { type?: string }).type;
    if (t === "disabled") return undefined;
    if (typeof t === "string") return t;
    return "on";
  }
  return "on";
}

/**
 * Summarises a `reasoning`-like value (OpenAI Responses API style):
 *   { effort: 'high' } → 'high'
 *   { effort: 'low', summary: 'auto' } → 'low'
 */
export function summariseReasoning(reasoning: unknown): string | undefined {
  if (reasoning == null) return undefined;
  if (typeof reasoning === "object") {
    const e = (reasoning as { effort?: string }).effort;
    if (typeof e === "string") return e;
  }
  return undefined;
}
