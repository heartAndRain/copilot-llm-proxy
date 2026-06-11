// Translates OpenAI Chat Completions responses (both non-stream and
// streaming SSE) back into Anthropic Messages API responses / events.

import { formatSseEvent } from "../util/sse.js";

interface OpenAIChoiceMessage {
  role: "assistant";
  content?: string | null;
  /** Copilot-extension: visible reasoning text (the "thinking" output). */
  reasoning_text?: string | null;
  /** Copilot-extension: opaque/encrypted signed reasoning blob. */
  reasoning_opaque?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIChatCompletion {
  id: string;
  model?: string;
  choices: Array<{
    index: number;
    message: OpenAIChoiceMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature?: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function mapFinishReason(
  reason: string | null,
  hasToolCalls: boolean,
): AnthropicResponse["stop_reason"] {
  if (hasToolCalls || reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason === "content_filter") return "end_turn";
  return reason ? "end_turn" : null;
}

export function openAIToAnthropic(
  resp: OpenAIChatCompletion,
  requestedModel: string,
): AnthropicResponse {
  const choice = resp.choices[0];
  const msg = choice?.message;
  const content: AnthropicResponse["content"] = [];
  // Thinking must come BEFORE the text block per Anthropic's spec.
  if (msg?.reasoning_text) {
    const thinkingBlock: { type: "thinking"; thinking: string; signature?: string } = {
      type: "thinking",
      thinking: msg.reasoning_text,
    };
    if (msg.reasoning_opaque) thinkingBlock.signature = msg.reasoning_opaque;
    content.push(thinkingBlock);
  }
  if (msg?.content) content.push({ type: "text", text: msg.content });
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: unknown = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  return {
    id: `msg_${resp.id}`,
    type: "message",
    role: "assistant",
    model: resp.model ?? requestedModel,
    content,
    stop_reason: mapFinishReason(
      choice?.finish_reason ?? null,
      Boolean(msg?.tool_calls?.length),
    ),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------- streaming ----------

interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  /** Copilot-extension: incremental reasoning text chunks. */
  reasoning_text?: string | null;
  /** Copilot-extension: opaque signed reasoning blob (sent in last chunk). */
  reasoning_opaque?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIStreamChunk {
  id: string;
  model?: string;
  choices: Array<{
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ToolCallState {
  blockIndex: number;
  id: string;
  name: string;
  /** Last seen partial JSON arguments string (for diffing). */
  argsSoFar: string;
}

/**
 * Stateful translator that consumes OpenAI streaming chunks and emits the
 * Anthropic SSE event sequence:
 *   message_start
 *   content_block_start / content_block_delta / content_block_stop  (per block)
 *   message_delta
 *   message_stop
 *
 * When the upstream emits `delta.reasoning_text`, we emit a `thinking`
 * content block (Anthropic's spec requires it before the text block).
 */
export class OpenAIStreamToAnthropic {
  private started = false;
  private messageId = "";
  private model: string;
  private thinkingBlockIndex: number | null = null;
  private thinkingOpened = false;
  private thinkingClosed = false;
  private thinkingSignature = "";
  private textBlockIndex: number | null = null;
  private textOpened = false;
  private toolCalls = new Map<number, ToolCallState>(); // openai tool_call index -> state
  private nextBlockIndex = 0;
  private finishReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(requestedModel: string) {
    this.model = requestedModel;
  }

  /** Emit the initial `message_start` event. */
  start(): string {
    this.started = true;
    this.messageId = `msg_${randomId()}`;
    // Block indices are assigned in the order blocks first appear, so we
    // reserve the next index lazily inside handleChunk().
    this.nextBlockIndex = 0;
    return formatSseEvent("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  /** Process one OpenAI chunk and return any SSE events to forward. */
  handleChunk(chunk: OpenAIStreamChunk): string {
    if (!this.started) return "";
    let out = "";
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) {
      if (chunk.usage.prompt_tokens != null) this.inputTokens = chunk.usage.prompt_tokens;
      if (chunk.usage.completion_tokens != null) this.outputTokens = chunk.usage.completion_tokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};

    // 1) Reasoning chunks. Must precede the text block.
    if (typeof delta.reasoning_text === "string" && delta.reasoning_text.length > 0) {
      if (!this.thinkingOpened) {
        this.thinkingOpened = true;
        this.thinkingBlockIndex = this.nextBlockIndex++;
        out += formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: this.thinkingBlockIndex,
          content_block: { type: "thinking", thinking: "" },
        });
      }
      out += formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.thinkingBlockIndex!,
        delta: { type: "thinking_delta", thinking: delta.reasoning_text },
      });
    }
    if (typeof delta.reasoning_opaque === "string" && delta.reasoning_opaque.length > 0) {
      this.thinkingSignature += delta.reasoning_opaque;
    }

    // 2) Visible text. If a thinking block was opened, close it first.
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (this.thinkingOpened && !this.thinkingClosed) {
        this.thinkingClosed = true;
        if (this.thinkingSignature) {
          out += formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.thinkingBlockIndex!,
            delta: { type: "signature_delta", signature: this.thinkingSignature },
          });
        }
        out += formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: this.thinkingBlockIndex!,
        });
      }
      if (!this.textOpened) {
        this.textOpened = true;
        this.textBlockIndex = this.nextBlockIndex++;
        out += formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: this.textBlockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      out += formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.textBlockIndex!,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    if (delta.tool_calls) {
      // Tool-call blocks come after text. Close thinking if still open.
      if (this.thinkingOpened && !this.thinkingClosed) {
        this.thinkingClosed = true;
        if (this.thinkingSignature) {
          out += formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.thinkingBlockIndex!,
            delta: { type: "signature_delta", signature: this.thinkingSignature },
          });
        }
        out += formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: this.thinkingBlockIndex!,
        });
      }
      for (const tc of delta.tool_calls) {
        let state = this.toolCalls.get(tc.index);
        if (!state) {
          state = {
            blockIndex: this.nextBlockIndex++,
            id: tc.id ?? `toolu_${randomId()}`,
            name: tc.function?.name ?? "",
            argsSoFar: "",
          };
          this.toolCalls.set(tc.index, state);
        } else {
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;
        }

        // Emit content_block_start once we know the name + id.
        if (state.name && !(state as ToolCallState & { _started?: boolean })._started) {
          (state as ToolCallState & { _started?: boolean })._started = true;
          out += formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: {
              type: "tool_use",
              id: state.id,
              name: state.name,
              input: {},
            },
          });
        }

        const argsPart = tc.function?.arguments ?? "";
        if (argsPart.length > 0) {
          state.argsSoFar += argsPart;
          out += formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "input_json_delta", partial_json: argsPart },
          });
        }
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    return out;
  }

  /** Emit closing events. Call once after the OpenAI stream is fully drained. */
  end(): string {
    if (!this.started) return "";
    let out = "";

    // If the thinking block never got closed (no text or tool calls after),
    // close it now.
    if (this.thinkingOpened && !this.thinkingClosed) {
      this.thinkingClosed = true;
      if (this.thinkingSignature) {
        out += formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.thinkingBlockIndex!,
          delta: { type: "signature_delta", signature: this.thinkingSignature },
        });
      }
      out += formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.thinkingBlockIndex!,
      });
    }

    if (this.textOpened) {
      out += formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.textBlockIndex!,
      });
    }
    for (const state of this.toolCalls.values()) {
      const started = (state as ToolCallState & { _started?: boolean })._started;
      if (!started) {
        // Open then close so the client at least sees the block.
        out += formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: {
            type: "tool_use",
            id: state.id,
            name: state.name,
            input: {},
          },
        });
      }
      out += formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.blockIndex,
      });
    }

    const stopReason = mapFinishReason(
      this.finishReason,
      this.toolCalls.size > 0,
    );
    out += formatSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    out += formatSseEvent("message_stop", { type: "message_stop" });
    return out;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
