# pi-mcp-bridge

Expose selected MCP servers from Codex's `~/.codex/config.toml` as native [Pi](https://github.com/badlogic/pi-mono) tools.

## Install

```sh
pi install git:github.com/L0stInFades/pi-mcp-bridge@v0.1.0
```

Start Pi and check the connection:

```text
/mcp-status
```

The bridge reads your existing Codex MCP configuration; it does not copy credentials anywhere.

## Supported configuration

The default servers are `exa` and `morph-mcp`. Both common Codex transport forms are supported:

```toml
[mcp_servers.example]
command = "npx"
args = ["-y", "your-mcp-package"]

[mcp_servers.example.env]
API_KEY = "your-key"
```

```toml
[mcp_servers.example]
url = "https://example.com/mcp"
```

Select other configured servers with `PI_MCP_SERVERS`:

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
- Supports stdio, Streamable HTTP, and SSE fallback.
- Reconnects a stopped server on the next tool call.
- Truncates oversized output and saves the full response in the system temp directory.
- Serializes concurrent Morph `edit_file` calls targeting the same path.
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
