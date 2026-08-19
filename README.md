# codex-proxy

A small local proxy that speaks Codex’s **Responses API** and translates it to the LLM you actually want — OpenRouter, Anthropic, xAI, Ollama, DeepSeek, or any OpenAI-compatible `/v1/chat/completions` endpoint.

Built for **Codex Desktop on Windows**. It also works with the Codex CLI on Windows, macOS, and Linux. Same `config.toml`, same catalog.

This is not a fork of Codex and not a kitchen-sink dashboard. On start it:

1. Listens on `127.0.0.1:18789`
2. Writes a model catalog Codex’s picker can read
3. Points Codex at the proxy with a reversible `openai_base_url` block

`codex-proxy stop` removes that block. Native Codex comes back.

## Why a proxy

Codex Desktop always talks the OpenAI **Responses** wire (`POST /v1/responses`, SSE). Most other providers speak Chat Completions or Anthropic Messages. The proxy sits in the middle, including streaming, function tools, and Codex’s `apply_patch` custom tool.

```text
Codex Desktop  --Responses SSE-->  codex-proxy  --Chat Completions / Anthropic / Responses-->  the LLM
     ^                                  |
     |                                  +-- catalog.json  (models in the picker)
     +-- %USERPROFILE%\.codex\config.toml
```

On loopback it hijacks the built-in `openai` provider (`openai_base_url`). That is what Codex Desktop uses when you are logged in with ChatGPT. Incoming ChatGPT bearer tokens are ignored; upstream calls use the API keys in `config.json`.

## Requirements

- [Bun](https://bun.sh/) 1.1+
- Codex Desktop and/or the Codex CLI
- An API key for each provider you add (Ollama needs none)

Windows (PowerShell):

```powershell
irm bun.sh/install.ps1 | iex
```

## Quick start (Codex Desktop on Windows)

```powershell
cd path\to\codex-proxy
bun install
bun run src/cli.ts init
```

Edit `%USERPROFILE%\.codex-proxy\config.json`. Keep the models you want, delete the rest. Set keys as user environment variables so they survive a new terminal:

```powershell
setx OPENROUTER_API_KEY "sk-or-..."
setx ANTHROPIC_API_KEY  "sk-ant-..."
setx XAI_API_KEY        "xai-..."
```

Close and reopen PowerShell, then:

```powershell
bun run src/cli.ts start
```

Leave that window open. Then **fully quit Codex Desktop** (system tray included) and open it again. The model picker should list your slugs, for example `openrouter/anthropic/claude-sonnet-4.6`.

Stop and restore native Codex:

```powershell
# from another terminal
bun run src/cli.ts stop
```

Or Ctrl+C in the proxy window — that also unwires Codex.

Compile a standalone `.exe` if you prefer not to keep a Bun project around:

```powershell
bun run build
.\dist\codex-proxy.exe init
.\dist\codex-proxy.exe start
```

## Config

Default path: `~/.codex-proxy/config.json` on Unix, `%USERPROFILE%\.codex-proxy\config.json` on Windows. Override with `CODEX_PROXY_HOME` or `--config`.

```json
{
  "listen": "127.0.0.1:18789",
  "defaultProvider": "openrouter",
  "defaultModel": "openrouter/anthropic/claude-sonnet-4.6",
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "models": [
        {
          "id": "anthropic/claude-sonnet-4.6",
          "displayName": "Claude Sonnet 4.6",
          "contextWindow": 200000,
          "reasoning": true
        }
      ]
    }
  }
}
```

Adapters:

| `adapter`           | Speaks                         | Typical `baseUrl`                    |
| ------------------- | ------------------------------ | ------------------------------------ |
| `openai-chat`       | `/v1/chat/completions`         | OpenRouter, xAI, Groq, Ollama, DeepSeek, Gemini’s OpenAI-compat URL |
| `anthropic`         | `/v1/messages`                 | `https://api.anthropic.com`          |
| `openai-responses`  | `/v1/responses` (passthrough)  | OpenAI API, Azure Responses          |

Routing:

- Codex sends `model` as `provider/model` (inner slashes stay on the model id: `openrouter/anthropic/claude-sonnet-4.6`)
- A unique bare id such as `grok-4` also matches
- `defaultModel` is what gets written into Codex as `model = "..."` on `start` / `wire`

Keys: `apiKey` may be a literal, `${ENV}`, or `$ENV`. `apiKeyEnv` names the environment variable directly.

## Codex integration

`start` and `wire` edit `$CODEX_HOME/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`) with a marked block that always sits **before** the first `[table]`:

```toml
# --- codex-proxy:begin ---
model = "openrouter/anthropic/claude-sonnet-4.6"
model_catalog_json = "C:/Users/you/.codex-proxy/catalog.json"
openai_base_url = "http://127.0.0.1:18789/v1"
# --- codex-proxy:end ---
```

The catalog entries set `visibility: "list"`, `supported_in_api: true`, `prefer_websockets: false`, `use_responses_lite: false`, and `tool_mode: "code_mode_only"` so Desktop can show them and still run local `exec` / `apply_patch` tools. Hosted OpenAI tools (`web_search`, `image_gen`) are dropped for routed models.

`unwire` / `stop` delete that block and put back any previous `model` you had.

Codex Desktop caches the catalog in the running `app-server`. A full quit/relaunch is required after every wire.

## Commands

```text
codex-proxy init                 Write config.json if missing
codex-proxy start [--port N]     Wire Codex and serve (foreground)
codex-proxy serve                Serve without touching Codex
codex-proxy stop                 Unwire + stop a recorded pid
codex-proxy wire / unwire        Inject or restore config.toml only
codex-proxy status / doctor
codex-proxy models               Print routed slugs
```

`--codex-home` and `CODEX_HOME` point at a non-default Codex directory. `CODEX_PROXY_HOME` relocates proxy state.

## Windows notes

- Run the proxy **on Windows**, not inside WSL. Desktop lives on the Windows loopback; WSL `localhost` is a different namespace.
- Store API keys with `setx` or System Properties → Environment Variables. A `$env:FOO=...` in one PowerShell dies with that window.
- Microsoft Store Codex and the installer both read `%USERPROFILE%\.codex\config.toml`.
- If Windows Firewall prompts, allow the proxy on private networks. It binds `127.0.0.1` only.
- Optional logon task (keeps the proxy up without a console):

  ```powershell
  schtasks /create /tn CodexProxy /sc onlogon /rl limited /tr "C:\path\to\codex-proxy.exe start"
  ```

  Uninstall later with `schtasks /delete /tn CodexProxy /f`. Prefer `start` in a terminal until the setup is proven.

## CLI without Desktop

After `codex-proxy start`:

```text
codex -m "openrouter/anthropic/claude-sonnet-4.6" "Explain src/cli.ts"
```

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

## Scope

In: Codex Desktop + CLI, Responses translation, reversible config injection, OpenAI-compat / Anthropic / Responses passthrough.

Out: ChatGPT account pooling, Claude Code / Grok Build shims, a web dashboard, OAuth device flows, vision/web-search sidecars. Use [opencodex](https://github.com/lidge-jun/opencodex) if you need that surface.

Independent of OpenAI, Anthropic, and other providers. Some providers restrict proxying — read their terms before you point a key at this process.

## License

MIT
