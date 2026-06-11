export interface Config {
  host: string;
  port: number;
  logLevel: "silent" | "info" | "debug";
  copilotBaseUrl: string;
  editorVersion: string;
  editorPluginVersion: string;
  userAgent: string;
  integrationId: string;
  // Optional override: if set, use this OAuth token instead of reading from disk
  oauthTokenOverride?: string;
}

const envBool = (v: string | undefined) => v === "1" || v === "true";

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4141),
    logLevel: (process.env.LOG_LEVEL as Config["logLevel"]) ??
      (envBool(process.env.DEBUG) ? "debug" : "info"),
    copilotBaseUrl: process.env.COPILOT_BASE_URL ?? "https://api.githubcopilot.com",
    // These headers identify the request to GitHub Copilot's backend.
    // Values mirror what the official VS Code Copilot Chat extension sends so
    // the API accepts the request and routes to the chat-tier models.
    editorVersion: process.env.COPILOT_EDITOR_VERSION ?? "vscode/1.95.0",
    editorPluginVersion:
      process.env.COPILOT_EDITOR_PLUGIN_VERSION ?? "copilot-chat/0.22.4",
    userAgent: process.env.COPILOT_USER_AGENT ?? "GitHubCopilotChat/0.22.4",
    integrationId: process.env.COPILOT_INTEGRATION_ID ?? "vscode-chat",
    oauthTokenOverride: process.env.GH_COPILOT_TOKEN,
    ...overrides,
  };
}
