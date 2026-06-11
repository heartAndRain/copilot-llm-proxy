// Translates an Anthropic Messages API request into an OpenAI Chat
// Completions request body. Supports text, tool_use / tool_result content
// blocks, tool definitions, and tool_choice.

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
}
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?:
    | { type: "auto" | "any" }
    | { type: "tool"; name: string }
    | { type: "none" };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
  // Reasoning controls — Anthropic clients (e.g. Claude Code) send this.
  thinking?:
    | { type: "enabled"; budget_tokens?: number }
    | { type: "adaptive" }
    | { type: "disabled" }
    | Record<string, unknown>;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  user?: string;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };
  // Reasoning controls — Copilot's chat-completions accepts both:
  //   `reasoning_effort` (OpenAI extension) and `thinking` (Anthropic-style).
  reasoning_effort?: "low" | "medium" | "high" | "minimal";
  thinking?:
    | { type: "enabled"; budget_tokens?: number }
    | { type: "adaptive" }
    | { type: "disabled" }
    | Record<string, unknown>;
}

function systemToString(system: AnthropicRequest["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

function anthropicContentToOpenAIUser(
  content: string | AnthropicContentBlock[],
): { messages: OpenAIMessage[] } {
  // A single Anthropic "user" message can contain tool_result blocks, which
  // in OpenAI's schema must be emitted as separate role:"tool" messages.
  if (typeof content === "string") {
    return { messages: [{ role: "user", content }] };
  }
  const toolMessages: OpenAIMessage[] = [];
  const userParts: Array<Record<string, unknown>> = [];
  let textOnly = "";
  let hasNonText = false;

  for (const block of content) {
    if (block.type === "text") {
      textOnly += (textOnly ? "\n" : "") + block.text;
      userParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      hasNonText = true;
      const url =
        block.source.type === "url"
          ? block.source.url!
          : `data:${block.source.media_type ?? "image/png"};base64,${block.source.data}`;
      userParts.push({ type: "image_url", image_url: { url } });
    } else if (block.type === "tool_result") {
      const toolContent =
        typeof block.content === "string"
          ? block.content
          : block.content
              .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
              .join("\n");
      toolMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: block.is_error ? `ERROR: ${toolContent}` : toolContent,
      });
    }
  }

  const messages: OpenAIMessage[] = [...toolMessages];
  if (userParts.length > 0) {
    messages.push({
      role: "user",
      content: hasNonText ? userParts : textOnly,
    });
  }
  return { messages };
}

function anthropicContentToOpenAIAssistant(
  content: string | AnthropicContentBlock[],
): OpenAIMessage {
  if (typeof content === "string") {
    return { role: "assistant", content };
  }
  let text = "";
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
  for (const block of content) {
    if (block.type === "text") {
      text += (text ? "\n" : "") + block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const msg: OpenAIMessage = { role: "assistant", content: text || null };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return msg;
}

function contentToPlainText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_result") {
        return typeof b.content === "string"
          ? b.content
          : b.content.map((c) => (c.type === "text" ? c.text : "")).filter(Boolean).join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // Hoist in-array `role: "system"` messages into the system prompt prefix.
  // The Anthropic Messages API spec only allows `user`/`assistant` in
  // `messages[]`, but clients like Claude Code (≥ v2) sometimes inject
  // system-reminder messages with `role: "system"` mid-conversation. If we
  // forwarded those as trailing assistant messages, Copilot would reject
  // the request for some models (e.g., Opus 4.8) with
  // "This model does not support assistant message prefill".
  const extraSystem: string[] = [];
  const conversationMessages = req.messages.filter((m) => {
    if (m.role === "system") {
      const text = contentToPlainText(m.content);
      if (text) extraSystem.push(text);
      return false;
    }
    return true;
  });

  const systemText = systemToString(req.system);
  const combinedSystem = [systemText, ...extraSystem].filter(Boolean).join("\n\n");
  if (combinedSystem) {
    messages.push({ role: "system", content: combinedSystem });
  }

  for (const m of conversationMessages) {
    if (m.role === "user") {
      const { messages: out } = anthropicContentToOpenAIUser(m.content);
      messages.push(...out);
    } else {
      messages.push(anthropicContentToOpenAIAssistant(m.content));
    }
  }

  const out: OpenAIRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream,
  };
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (req.stop_sequences && req.stop_sequences.length > 0) out.stop = req.stop_sequences;
  if (req.metadata?.user_id) out.user = req.metadata.user_id;

  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") out.tool_choice = "auto";
    else if (req.tool_choice.type === "any") out.tool_choice = "required";
    else if (req.tool_choice.type === "none") out.tool_choice = "none";
    else if (req.tool_choice.type === "tool")
      out.tool_choice = {
        type: "function",
        function: { name: req.tool_choice.name },
      };
  }

  // Forward reasoning controls. Copilot's chat-completions endpoint accepts
  // the Anthropic-style `thinking` object directly, so a passthrough is
  // sufficient. We don't downgrade it to `reasoning_effort` here because
  // `thinking.budget_tokens` carries more information than effort levels.
  if (req.thinking) {
    out.thinking = req.thinking;
  }

  return out;
}
