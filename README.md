# copilot-llm-proxy

Local HTTP proxy that exposes the **GitHub Copilot LLM backend** (Claude,
GPT, Gemini, etc. — whatever your Copilot subscription gives you) via APIs
compatible with:

- **OpenAI Chat Completions** — `POST /v1/chat/completions` (passthrough)
- **OpenAI Responses** — `POST /v1/responses` (passthrough, supports
  GPT-5.x and reasoning models that aren't on chat-completions)
- **Anthropic Messages** — `POST /v1/messages` (translated → chat-completions)

This lets you point local tools such as **Claude Code CLI**, **Codex CLI**,
and **Codex Desktop** at your Copilot subscription instead of paying for the
Anthropic or OpenAI APIs directly.

> ⚠️ This uses the same backend the official Copilot Chat extension uses.
> Make sure your usage complies with the
> [GitHub Copilot Acceptable Use Policy](https://docs.github.com/en/site-policy/acceptable-use-policies/github-copilot-coding-agent).

## Requirements

- Node.js ≥ 18.17
- A working **GitHub Copilot** subscription. You sign in via this proxy's
  built-in `login` command (uses GitHub's device-code OAuth flow against
  the standard Copilot Chat client ID). VS Code / `gh` sessions are also
  picked up automatically if present.

## Install & build

```powershell
cd path/to/copilot-llm-proxy
npm install
npm run build
npm link        # makes `cllmp` available globally
```

## Sign in

```powershell
cllmp login
```

You'll see something like:

```
Open the following URL in your browser and enter the code:
  URL:  https://github.com/login/device
  Code: ABCD-1234

Waiting for authorization…
✓ Logged in. Token saved to: C:\Users\<you>\.copilot-llm-proxy\auth.json
✓ Verified: Copilot API token exchange succeeded.
```

To check status or sign out:

```powershell
cllmp status
cllmp logout
```

## Run

```powershell
cllmp start                          # default: 127.0.0.1:4141
cllmp start --port 4242 --host 0.0.0.0
cllmp start --debug                  # verbose logging

# `cllmp serve` is identical to `cllmp start`.
```

You should see:

```
[...] [info] Copilot API token acquired.
[...] [info] Listening on http://127.0.0.1:4141
[...] [info]   OpenAI:    POST http://127.0.0.1:4141/v1/chat/completions
[...] [info]   Anthropic: POST http://127.0.0.1:4141/v1/messages
```

Health check:

```powershell
curl http://127.0.0.1:4141/healthz
```

List the models Copilot exposes to you:

```powershell
curl http://127.0.0.1:4141/v1/models
```

## Auto-configure clients

Instead of editing config files by hand, use `cllmp setup`:

```powershell
cllmp setup codex     # updates ~/.codex/config.toml
cllmp setup claude    # updates ~/.claude/settings.json
```

If `--model` is omitted **and** you're running in an interactive terminal,
`cllmp` will fetch the models your Copilot subscription exposes (filtered
to OpenAI for Codex / Anthropic for Claude) and let you pick one:

```
Available OpenAI models on your Copilot subscription:

   1) GPT-5.3-Codex                        gpt-5.3-codex
   2) GPT-5.4                              gpt-5.4
   3) GPT-5.4 mini                         gpt-5.4-mini
   4) GPT-5.5                              gpt-5.5  ← default

Choose [1-4] (default: 4):
```

Pressing Enter selects the default. When stdin isn't a TTY (e.g. piped
from a script) the picker is skipped and the default is used.

Both commands are **idempotent** and **non-destructive**:

- They preserve every unrelated key in your existing config.
- They write a timestamped `.bak-…` backup before changing anything.
- Re-running reports "no changes" once your config is up to date.

Useful flags:

```powershell
cllmp setup codex  --url http://127.0.0.1:4141 --model gpt-5.5 --provider-name copilot
cllmp setup codex  --no-model            # don't change Codex's default model
cllmp setup codex  --no-default-provider # don't change Codex's top-level model_provider
cllmp setup claude --url http://127.0.0.1:4141 --model claude-sonnet-4.6
cllmp setup claude --no-model            # don't change Claude Code's default model
cllmp setup codex  --config path/to/config.toml      # override config path
cllmp setup claude --config path/to/settings.json
```

Passing `--model <id>` explicitly skips the interactive picker.

## Client setup (manual)

### Claude Code CLI (manual)

Set these env vars (`$env:` on PowerShell, `export` on bash):

```powershell
$env:ANTHROPIC_BASE_URL  = "http://127.0.0.1:4141"
$env:ANTHROPIC_AUTH_TOKEN = "copilot-proxy"            # required but ignored
$env:ANTHROPIC_MODEL     = "claude-sonnet-4.6"         # or any model from /v1/models
claude
```

Or just run `cllmp setup claude`, which writes the equivalent `env` block
into `~/.claude/settings.json`.

### Codex CLI (manual)

Codex CLI ≥ 0.118 requires `wire_api = "responses"`. Add a Copilot
provider to `~/.codex/config.toml` (Windows:
`C:\Users\<you>\.codex\config.toml`):

```toml
model = "gpt-5.5"
model_provider = "copilot"

[model_providers.copilot]
name = "GitHub Copilot"
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"      # required for Codex ≥ 0.118; uses /v1/responses
# No `env_key` — the proxy ignores Authorization, so Codex doesn't need to
# read an API key from your environment.
```

Then just run:

```powershell
codex
```

### Codex Desktop (manual)

In **Settings → Providers**, add a custom OpenAI-compatible provider:

- Base URL: `http://127.0.0.1:4141/v1`
- API key: any non-empty value (e.g. `dummy`) — the proxy ignores it
- Wire format / API: `Chat completions` (or `Responses` if your Codex Desktop build supports it)

Select a model that appears in `GET /v1/models` (e.g. `gpt-5.5`, `gpt-4o`,
`claude-sonnet-4.6`).

## Configuration

All settings can be tuned via env vars:

| Env var                          | Default                              | Description                                              |
|----------------------------------|--------------------------------------|----------------------------------------------------------|
| `HOST`                           | `127.0.0.1`                          | Bind interface                                           |
| `PORT`                           | `4141`                               | Listen port                                              |
| `LOG_LEVEL`                      | `info`                               | `silent`, `info`, or `debug`                             |
| `DEBUG`                          | unset                                | Shortcut for `LOG_LEVEL=debug`                           |
| `COPILOT_BASE_URL`               | `https://api.githubcopilot.com`      | Upstream API                                             |
| `COPILOT_EDITOR_VERSION`         | `vscode/1.95.0`                      | Sent as `Editor-Version`                                 |
| `COPILOT_EDITOR_PLUGIN_VERSION`  | `copilot-chat/0.22.4`                | Sent as `Editor-Plugin-Version`                          |
| `COPILOT_USER_AGENT`             | `GitHubCopilotChat/0.22.4`           | Sent as `User-Agent`                                     |
| `COPILOT_INTEGRATION_ID`         | `vscode-chat`                        | Sent as `Copilot-Integration-Id`                         |
| `GH_COPILOT_TOKEN`               | (auto-detect)                        | Override OAuth token instead of reading from disk        |

## How the OAuth token is found

In order:

1. `GH_COPILOT_TOKEN` env var (if set).
2. `~/.copilot-llm-proxy/auth.json` (written by `copilot-llm-proxy login`).
3. The Copilot config directory:
   - Windows: `%LOCALAPPDATA%\github-copilot\{apps.json,hosts.json}` then
     `%APPDATA%\github-copilot\…`.
   - Linux/macOS: `$XDG_CONFIG_HOME/github-copilot/…` then
     `~/.config/github-copilot/…`.
4. `gh auth token` (usually rejected by the Copilot token endpoint unless
   `gh` happens to be signed in with a Copilot-scoped token — prefer
   `login`).

The OAuth token is then exchanged at
`https://api.github.com/copilot_internal/v2/token` for a short-lived API
token, which is cached in memory and refreshed automatically before it
expires.

## Endpoints

| Method | Path                          | Wire format                                |
|--------|-------------------------------|--------------------------------------------|
| GET    | `/healthz`                    | `{ "ok": true }`                           |
| GET    | `/v1/models`                  | OpenAI models list (passthrough)           |
| POST   | `/v1/chat/completions`        | OpenAI chat completions (passthrough)      |
| POST   | `/v1/responses`               | OpenAI Responses API (passthrough)         |
| POST   | `/v1/messages`                | Anthropic Messages (translated → chat-completions) |
| POST   | `/v1/messages/count_tokens`   | Coarse char-based estimate                 |

Streaming and non-streaming are supported on all three POST endpoints.
Tool / function calling is translated bidirectionally on the Anthropic
route, and round-trips natively on the Responses route.

## Limitations / known gaps

- **Token counts.** `/v1/messages/count_tokens` returns a `chars / 4`
  estimate — Claude Code will accept it but it is not exact.
- **Vision.** Image blocks in Anthropic requests are forwarded as OpenAI
  `image_url` parts; Copilot's support varies by model.
- **No `/v1/responses`.** Codex CLI/Desktop must be configured with
  `wire_api = "chat"`.
- **No request retries.** If Copilot returns 429/5xx the error is
  forwarded to the client as-is.
- **No persistent token cache.** A fresh API token is fetched per process
  start, then cached in memory until it expires.

## Project layout

```
src/
  index.ts                       # CLI: start | serve | login | logout | status | setup
  server.ts                      # Express bootstrap
  config.ts
  auth/
    deviceLogin.ts               # GitHub device-code flow + persisted auth.json
    githubToken.ts               # Token search (env, persisted, VS Code, gh)
    copilotToken.ts              # Exchange + cache short-lived API token
  copilot/
    client.ts                    # Upstream fetch wrapper (headers, streaming)
  routes/
    openai.ts                    # /v1/chat/completions, /v1/models
    anthropic.ts                 # /v1/messages, /v1/messages/count_tokens
    responses.ts                 # /v1/responses (passthrough to Copilot)
  setup/
    codex.ts                     # `cllmp setup codex`  → ~/.codex/config.toml
    claude.ts                    # `cllmp setup claude` → ~/.claude/settings.json
    common.ts
  translators/
    anthropicToOpenAI.ts         # request: Anthropic → OpenAI
    openAIToAnthropic.ts         # response: OpenAI → Anthropic (sync + SSE)
  util/
    logger.ts
    sse.ts
```

## License

MIT
