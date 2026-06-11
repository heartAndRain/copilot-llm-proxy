import type { CopilotClient } from "./client.js";
import { log } from "../util/logger.js";

interface CopilotModel {
  id: string;
}

/**
 * Maps incoming model ids (from clients like Claude Code, which use
 * Anthropic-canonical ids like `claude-opus-4-5-20251015` or
 * `claude-opus-4-1[1m]`) to ids Copilot actually accepts (like
 * `claude-opus-4.5` or `claude-opus-4.6-1m`).
 *
 * Strategy (first match wins):
 *   1. Exact match against Copilot's model list
 *   2. Strip trailing date suffix `-YYYYMMDD`, retry
 *   3. Strip `[1m]` / `-1m` suffix to capture context-window hint
 *   4. Replace `-N-M` (digit-dash-digit) with `-N.M` to normalize Anthropic
 *      hyphenated versions (`claude-opus-4-1` → `claude-opus-4.1`)
 *   5. If a 1M variant was requested but doesn't exist on Copilot, fall
 *      back to the base model (with a warning).
 *   6. Otherwise pass through unchanged.
 *
 * The model list is fetched once, then cached for 5 minutes.
 */
export class ModelResolver {
  private cache: { ids: Set<string>; at: number } | null = null;
  private inFlight: Promise<Set<string>> | null = null;
  private readonly ttlMs = 5 * 60 * 1000;

  constructor(private readonly copilot: CopilotClient) {}

  private async availableIds(): Promise<Set<string>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.ids;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const res = await this.copilot.listModels();
      const text = await readAll(res.body);
      const parsed = JSON.parse(text) as { data?: CopilotModel[] };
      const ids = new Set((parsed.data ?? []).map((m) => m.id));
      this.cache = { ids, at: Date.now() };
      return ids;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Resolves `requested` to an id Copilot accepts. Logs at debug level
   * when a mapping happens.
   */
  async resolve(requested: string): Promise<string> {
    if (!requested) return requested;
    let ids: Set<string>;
    try {
      ids = await this.availableIds();
    } catch (err) {
      log.warn(
        "ModelResolver could not fetch Copilot model list; passing model id through:",
        err instanceof Error ? err.message : err,
      );
      return requested;
    }

    if (ids.has(requested)) return requested;

    // Compute candidates in priority order.
    const candidates = candidateIds(requested);
    const requestedOneMillion = isOneMillion(requested);
    for (const c of candidates) {
      if (ids.has(c)) {
        if (c !== requested) {
          // If user wanted 1M but we're returning a non-1M variant, warn —
          // this is a silent quality downgrade.
          if (requestedOneMillion && !isOneMillion(c)) {
            log.warn(
              `Model "${requested}" requested a 1M-context variant, but Copilot ` +
                `doesn't expose one. Falling back to "${c}".`,
            );
          } else {
            log.debug(`Model mapped: "${requested}" → "${c}"`);
          }
        }
        return c;
      }
    }

    log.warn(
      `Model "${requested}" is not exposed by Copilot. Passing through unchanged ` +
        `(Copilot will likely reject it). Tried candidates: ${candidates.join(", ")}.`,
    );
    return requested;
  }
}

/**
 * Generates candidate Copilot ids for a requested id, in priority order.
 * Pure function — no I/O — so it's easy to unit-test.
 */
export function candidateIds(requested: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  add(requested);

  // Detect 1M-context hint, then strip it so we can try variants both with
  // and without the 1M suffix.
  let base = requested;
  let hasOneMillion = false;
  if (/\[1m\]$/i.test(base)) {
    hasOneMillion = true;
    base = base.replace(/\[1m\]$/i, "");
  } else if (/-1m(-internal)?$/i.test(base)) {
    hasOneMillion = true;
    base = base.replace(/-1m(-internal)?$/i, "");
  }

  // Strip trailing -YYYYMMDD date suffix (Anthropic canonical ids).
  const dateMatch = base.match(/^(.*)-\d{8}$/);
  if (dateMatch) base = dateMatch[1]!;

  // Normalize hyphenated version numbers (claude-opus-4-1 → claude-opus-4.1).
  const dotted = dotifyVersion(base);

  if (hasOneMillion) {
    // Prefer 1M variants first (-internal, then bare -1m, dotted then hyphenated).
    for (const b of [dotted, base]) {
      add(`${b}-1m-internal`);
      add(`${b}-1m`);
    }
    // Then fall back to the non-1M base — Copilot may not expose a 1M
    // variant for every model.
    add(dotted);
    add(base);
  } else {
    add(dotted);
    add(base);
    // Don't auto-upgrade to 1M when the user didn't ask for it.
  }

  return out;
}

function isOneMillion(id: string): boolean {
  return /\[1m\]$/i.test(id) || /-1m(-internal)?$/i.test(id);
}

function dotifyVersion(id: string): string {
  // Replace one or more `-<digit>` segments with `.<digit>` after the first
  // `-<digit>`. E.g. `claude-opus-4-1` → `claude-opus-4.1`,
  // `claude-sonnet-4-6` → `claude-sonnet-4.6`. Leave the rest alone.
  return id.replace(/(\w-\d+)((?:-\d+)+)/, (_, head, tail: string) => {
    return head + tail.replace(/-(\d+)/g, ".$1");
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks).toString("utf8");
}
