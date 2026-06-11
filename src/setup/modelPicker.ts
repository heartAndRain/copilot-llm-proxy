import readline from "node:readline";
import type { CopilotClient } from "../copilot/client.js";

interface CopilotModel {
  id: string;
  name?: string;
  vendor?: string;
  capabilities?: { type?: string; family?: string };
  model_picker_enabled?: boolean;
}

export interface PickModelOptions {
  copilot: CopilotClient;
  /** Restrict to models from this vendor (case-insensitive). e.g. "Anthropic", "OpenAI". */
  vendor?: string;
  /** Pre-selected default model id. */
  defaultId?: string;
  /** Title shown above the list. */
  title?: string;
  /**
   * Optional extra entry shown at the top of the list. Useful for
   * "let the client pick its own default" semantics. The returned `value`
   * is what `pickModelInteractive` resolves to when the user picks it.
   */
  topEntry?: { label: string; description: string; value: string };
}

/**
 * Fetches the model list from Copilot and lets the user pick one
 * interactively (numbered list + Enter). If stdin is not a TTY, returns
 * `defaultId` immediately without prompting.
 *
 * Throws if no models match the filter and no `defaultId` was provided.
 */
export async function pickModelInteractive(opts: PickModelOptions): Promise<string> {
  const models = await fetchModels(opts.copilot, opts.vendor);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (opts.topEntry) return opts.topEntry.value;
    if (opts.defaultId) return opts.defaultId;
    if (models.length > 0) return models[0]!.id;
    throw new Error("No models available and no default provided.");
  }

  if (models.length === 0) {
    if (opts.defaultId) {
      console.log(
        `(No ${opts.vendor ?? ""} models returned by Copilot — using default "${opts.defaultId}")`,
      );
      return opts.defaultId;
    }
    throw new Error("No models available to choose from.");
  }

  // Put the default at the end so Enter == last printed line == default.
  const defaultIndex = opts.defaultId
    ? models.findIndex((m) => m.id === opts.defaultId)
    : -1;

  // Build the displayed list. If a topEntry was provided (e.g. "Default"
  // for Claude), it appears as item #1 and shifts everything else down.
  const totalEntries = models.length + (opts.topEntry ? 1 : 0);

  console.log("");
  if (opts.title) console.log(opts.title);
  console.log("");
  let row = 0;
  if (opts.topEntry) {
    row++;
    const idx = String(row).padStart(2, " ");
    const label = opts.topEntry.label.padEnd(36);
    console.log(`  ${idx}) ${label} ${opts.topEntry.description}`);
  }
  for (let i = 0; i < models.length; i++) {
    row++;
    const m = models[i]!;
    const idx = String(row).padStart(2, " ");
    const name = (m.name ?? m.id).padEnd(36);
    const marker = i === defaultIndex ? "  ← default" : "";
    console.log(`  ${idx}) ${name} ${m.id}${marker}`);
  }
  console.log("");

  // Default selection number = the model default's row, or row 1 if a
  // topEntry is shown.
  const defaultRow = opts.topEntry
    ? 1
    : defaultIndex >= 0
      ? defaultIndex + 1
      : 0;
  const defaultPrompt = defaultRow > 0 ? ` (default: ${defaultRow})` : "";
  const answer = await ask(`Choose [1-${totalEntries}]${defaultPrompt}: `);
  const trimmed = answer.trim();

  const pickRow = (rowNum: number): string => {
    if (opts.topEntry && rowNum === 1) return opts.topEntry.value;
    const modelIdx = opts.topEntry ? rowNum - 2 : rowNum - 1;
    return models[modelIdx]!.id;
  };

  if (trimmed === "") {
    if (defaultRow > 0) return pickRow(defaultRow);
    return pickRow(1);
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > totalEntries) {
    throw new Error(`Invalid selection: ${trimmed}`);
  }
  return pickRow(n);
}

async function fetchModels(
  copilot: CopilotClient,
  vendor: string | undefined,
): Promise<CopilotModel[]> {
  const res = await copilot.listModels();
  if (res.status < 200 || res.status >= 300) {
    const body = await readAll(res.body);
    throw new Error(
      `Failed to list models from Copilot: ${res.status} ${body.slice(0, 300)}`,
    );
  }
  const text = await readAll(res.body);
  const parsed = JSON.parse(text) as { data?: CopilotModel[] };
  let models = parsed.data ?? [];
  // Only chat-capable models.
  models = models.filter(
    (m) => !m.capabilities || m.capabilities.type === "chat" || m.capabilities.type == null,
  );
  if (vendor) {
    const want = vendor.toLowerCase();
    models = models.filter((m) => (m.vendor ?? "").toLowerCase() === want);
  }
  // Prefer picker-enabled ones first, then alphabetical by display name.
  models.sort((a, b) => {
    const ap = a.model_picker_enabled === false ? 1 : 0;
    const bp = b.model_picker_enabled === false ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });
  return models;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
