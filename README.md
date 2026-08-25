# pi-mcp-bridge

Expose [Exa](https://github.com/exa-labs/exa-mcp-server) and [Morph](https://docs.morphllm.com/mcpquickstart) servers from Codex's [MCP configuration](https://developers.openai.com/codex/mcp/) as native [Pi](https://github.com/badlogic/pi-mono) tools. The bridge uses the official [MCP TypeScript client](https://github.com/modelcontextprotocol/typescript-sdk) v2.

## Install

```sh
pi install git:github.com/L0stInFades/pi-mcp-bridge@v0.2.0
```

Start Pi and check the connection:

```text
/mcp-status
```

The bridge reads the same Codex MCP configuration on macOS, Linux, and Windows; Pi needs no second copy of either API key.

## Configure Exa and Morph

The shortest cross-platform setup is to add this to `~/.codex/config.toml` (`$HOME\.codex\config.toml` in PowerShell):

```toml
[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
http_headers = { "x-api-key" = "YOUR_EXA_API_KEY" }

[mcp_servers.morph-mcp]
command = "npx"
args = ["-y", "@morphllm/morphmcp"]
env = { MORPH_API_KEY = "YOUR_MORPH_API_KEY" }
startup_timeout_sec = 120
```

Exa also works anonymously with lower limits. To keep keys out of the file, set `EXA_API_KEY` and `MORPH_API_KEY` in the environment and use:

```toml
[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
env_http_headers = { "x-api-key" = "EXA_API_KEY" }

[mcp_servers.morph-mcp]
command = "npx"
args = ["-y", "@morphllm/morphmcp"]
env_vars = ["MORPH_API_KEY"]
```

PowerShell can persist those variables with `setx EXA_API_KEY "..."` and `setx MORPH_API_KEY "..."`; open a new terminal afterward.

The bridge supports Codex's stdio fields (`command`, `args`, `env`, `env_vars`, `cwd`), HTTP credential fields (`http_headers`, `env_http_headers`, `bearer_token_env_var`), tool filters, and startup/tool timeouts. Codex-managed OAuth sessions are not copied into Pi.

The default servers are `exa` and `morph-mcp`. Select other configured servers with `PI_MCP_SERVERS`:

```sh
PI_MCP_SERVERS=example,another pi
```

PowerShell:

```powershell
$env:PI_MCP_SERVERS="example,another"; pi
```

Set `PI_MCP_CONFIG_PATH` to use a config file other than `~/.codex/config.toml`.

## Behavior

- Discovers and registers every tool exposed by the selected servers.
- Speaks MCP `2026-07-28` and automatically falls back to current `2025` servers.
- Supports stdio and standard Streamable HTTP transports.
- Honors Codex tool allow/deny lists and timeout settings.
- Reconnects a stopped server on the next tool call.
- Truncates oversized output and saves the full response in the system temp directory.
- Passes MCP images through as native Pi image content.
- Uses MCP destructive annotations to make Pi execute write tools sequentially.
- Redacts API keys, bearer tokens, and URL query values from surfaced errors.

Morph's local server receives Pi's current working directory, and `codebase_search.repo_path` defaults to it.

## Commands

- `/mcp-status` — show connection state and discovered tool counts.
- `/mcp-reconnect` — reload the config and reconnect all selected servers.

After changing the extension itself, run `/reload` in Pi.

## Development

```sh
npm ci
npm test
```

MIT licensed.
