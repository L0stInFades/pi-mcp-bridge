import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

const CONFIG_PATH = process.env.PI_MCP_CONFIG_PATH || join(homedir(), ".codex", "config.toml");
const TARGET_SERVERS = [...new Set((process.env.PI_MCP_SERVERS || "exa,morph-mcp").split(",").map((name) => name.trim()).filter(Boolean))];
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;
const CLIENT_INFO = { name: "pi-mcp-bridge", version: "0.2.0" };

const serverStates = new Map();

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateHead(content, { maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES } = {}) {
  const totalBytes = Buffer.byteLength(content);
  const lines = content ? content.split("\n") : [];
  if (content.endsWith("\n")) lines.pop();
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes };
  }

  const output = [];
  let outputBytes = 0;
  for (const line of lines.slice(0, maxLines)) {
    const lineBytes = Buffer.byteLength(line) + (output.length ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) break;
    output.push(line);
    outputBytes += lineBytes;
  }

  return {
    content: output.join("\n"),
    truncated: true,
    totalLines,
    totalBytes,
    outputLines: output.length,
    outputBytes,
  };
}

function sanitizeSecrets(value) {
  return String(value)
    .replace(/([?&][^=\s&]+)=([^&\s]+)/g, "$1=***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
    .replace(/(exaApiKey=)[^&\s]+/gi, "$1***")
    .replace(/(--api-key\s+)[^\s]+/gi, "$1***")
    .replace(/(MORPH_API_KEY\s*[=:]\s*)[^\s]+/gi, "$1***")
    .replace(/(sk-[A-Za-z0-9_\-]+)/g, "***");
}

function shortServerName(serverName) {
  return serverName === "morph-mcp" ? "morph" : serverName;
}

function toPiToolName(serverName, mcpToolName) {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9]+/g, "_")}__${mcpToolName}`;
}

function stripAtPrefix(pathLike) {
  return typeof pathLike === "string" && pathLike.startsWith("@") ? pathLike.slice(1) : pathLike;
}

function stringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, String(val)]));
}

function timeoutMs(milliseconds, seconds, fallbackSeconds) {
  const value = Number(milliseconds ?? (seconds === undefined ? undefined : Number(seconds) * 1000));
  return Number.isFinite(value) && value > 0 ? value : fallbackSeconds * 1000;
}

function resolveHttpHeaders(raw) {
  const headers = new Headers(stringRecord(raw.http_headers));
  for (const [header, envName] of Object.entries(stringRecord(raw.env_http_headers))) {
    const value = process.env[envName];
    if (value !== undefined) headers.set(header, value);
  }

  const bearer = typeof raw.bearer_token_env_var === "string" ? process.env[raw.bearer_token_env_var] : undefined;
  if (bearer && !headers.has("authorization")) headers.set("authorization", `Bearer ${bearer}`);
  return Object.fromEntries(headers);
}

function resolveStdioEnv(raw) {
  const env = stringRecord(raw.env);
  for (const item of Array.isArray(raw.env_vars) ? raw.env_vars : []) {
    const name = typeof item === "string" ? item : item?.source !== "remote" ? item?.name : undefined;
    if (typeof name === "string" && process.env[name] !== undefined && env[name] === undefined) {
      env[name] = process.env[name];
    }
  }
  return Object.keys(env).length ? env : undefined;
}

async function loadConfiguredServers() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`MCP config not found at ${CONFIG_PATH}`);
  }

  const parsed = parseToml(await readFile(CONFIG_PATH, "utf8"));
  const configured = parsed?.mcp_servers ?? {};
  const servers = new Map();

  for (const serverName of TARGET_SERVERS) {
    const raw = configured?.[serverName];
    if (!raw || raw.enabled === false) continue;

    const common = {
      startupTimeoutMs: timeoutMs(raw.startup_timeout_ms, raw.startup_timeout_sec, 10),
      toolTimeoutMs: timeoutMs(undefined, raw.tool_timeout_sec, 60),
      enabledTools: Array.isArray(raw.enabled_tools) ? new Set(raw.enabled_tools.map(String)) : undefined,
      disabledTools: new Set(Array.isArray(raw.disabled_tools) ? raw.disabled_tools.map(String) : []),
    };

    if (typeof raw.url === "string" && raw.url) {
      servers.set(serverName, {
        ...common,
        type: "remote",
        url: raw.url,
        headers: resolveHttpHeaders(raw),
      });
      continue;
    }

    if (typeof raw.command === "string" && raw.command) {
      servers.set(serverName, {
        ...common,
        type: "stdio",
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.map((arg) => String(arg)) : [],
        env: resolveStdioEnv(raw),
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      });
    }
  }

  return servers;
}

function getOrCreateServerState(serverName) {
  let state = serverStates.get(serverName);
  if (!state) {
    state = {
      status: "disconnected",
      lastError: undefined,
      client: undefined,
      cwd: undefined,
      protocol: undefined,
      toolNames: [],
      config: undefined,
      connecting: undefined,
    };
    serverStates.set(serverName, state);
  }
  return state;
}

async function closeServer(serverName) {
  const state = getOrCreateServerState(serverName);
  const client = state.client;
  state.client = undefined;
  state.cwd = undefined;
  state.protocol = undefined;
  state.status = "disconnected";
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore shutdown errors.
    }
  }
}

async function closeAllServers() {
  await Promise.all(Array.from(serverStates.keys()).map((serverName) => closeServer(serverName)));
}

function createClient() {
  return new Client(CLIENT_INFO, { versionNegotiation: { mode: "auto" } });
}

async function connectRemoteServer(config) {
  const client = createClient();
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
  try {
    await client.connect(transport, { timeout: config.startupTimeoutMs });
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function ensureConnected(serverName, cwd, forceReconnect = false, configuredServers) {
  const servers = configuredServers || (await loadConfiguredServers());
  const config = servers.get(serverName);
  if (!config) {
    throw new Error(`Server ${serverName} is not configured in ${CONFIG_PATH}`);
  }

  const state = getOrCreateServerState(serverName);
  state.config = config;

  const needsReconnect =
    forceReconnect ||
    state.status !== "connected" ||
    !state.client ||
    (serverName === "morph-mcp" && state.cwd !== cwd);

  if (!needsReconnect) {
    return state;
  }

  if (state.connecting) {
    if (!forceReconnect) return state.connecting;
    await state.connecting.catch(() => {});
  }

  const connecting = (async () => {
    await closeServer(serverName);

    let client;
    if (config.type === "remote") {
      client = await connectRemoteServer(config);
    } else {
      client = createClient();
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: serverName === "morph-mcp" ? cwd : config.cwd || cwd,
        stderr: "pipe",
      });
      try {
        await client.connect(transport, { timeout: config.startupTimeoutMs });
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
    }

    client.onerror = (error) => {
      const currentState = getOrCreateServerState(serverName);
      if (currentState.client !== client) return;
      currentState.status = "error";
      currentState.lastError = sanitizeSecrets(error?.message || error);
    };
    client.onclose = () => {
      const currentState = getOrCreateServerState(serverName);
      if (currentState.client !== client) return;
      currentState.client = undefined;
      currentState.cwd = undefined;
      currentState.protocol = undefined;
      currentState.status = currentState.lastError ? "error" : "disconnected";
    };

    state.client = client;
    state.cwd = cwd;
    state.protocol = client.getNegotiatedProtocolVersion();
    state.status = "connected";
    state.lastError = undefined;
    return state;
  })();

  state.connecting = connecting;
  try {
    return await connecting;
  } finally {
    if (state.connecting === connecting) state.connecting = undefined;
  }
}

function adaptInputSchema(piToolName, inputSchema) {
  const schema = structuredClone(inputSchema || { type: "object", additionalProperties: true });

  if (piToolName === "mcp__morph_mcp__codebase_search") {
    if (Array.isArray(schema.required)) {
      schema.required = schema.required.filter((field) => field !== "repo_path");
    }
    if (schema.properties?.repo_path?.description) {
      schema.properties.repo_path.description += " Defaults to the current working directory when omitted.";
    }
  }

  return schema;
}

function finalizeCallArguments(piToolName, params, ctx) {
  const args = { ...(params || {}) };

  if (typeof args.path === "string") {
    args.path = stripAtPrefix(args.path);
  }

  if (piToolName === "mcp__morph_mcp__codebase_search") {
    if (typeof args.repo_path !== "string" || !args.repo_path.trim()) {
      args.repo_path = ctx.cwd;
    } else {
      args.repo_path = resolve(ctx.cwd, stripAtPrefix(args.repo_path));
    }
  }

  return args;
}

function resultToPiParts(result) {
  const texts = [];
  const images = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    } else if (item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      images.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else {
      texts.push(JSON.stringify(item, null, 2));
    }
  }
  if (!texts.length && result?.structuredContent !== undefined) {
    texts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  if (!texts.length && !images.length) texts.push("(no content returned)");
  return { text: texts.filter(Boolean).join("\n\n"), images };
}

async function truncateForPi(toolName, text) {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, tempFile: undefined, truncation };
  }

  const tempFile = join(tmpdir(), `${toolName.replace(/[^a-zA-Z0-9_]+/g, "_")}-${randomUUID()}.txt`);
  await mkdir(dirname(tempFile), { recursive: true });
  await writeFile(tempFile, text, { encoding: "utf8", mode: 0o600 });

  let truncatedText = truncation.content;
  truncatedText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
  truncatedText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  truncatedText += ` Full output saved to: ${tempFile}]`;

  return { text: truncatedText, tempFile, truncation };
}

function buildStatusLine() {
  const parts = TARGET_SERVERS.map((serverName) => {
    const state = serverStates.get(serverName);
    const name = shortServerName(serverName);
    if (!state) return `${name}:off`;
    if (state.status === "connected") return `${name}:${state.toolNames.length}`;
    if (state.status === "error") return `${name}:err`;
    return `${name}:off`;
  });
  return `mcp ${parts.join(" ")}`;
}

function buildStatusMessage() {
  const parts = TARGET_SERVERS.map((serverName) => {
    const state = serverStates.get(serverName);
    const label = shortServerName(serverName);
    if (!state) return `${label}: not configured`;
    if (state.status === "unconfigured") return `${label}: not configured`;
    if (state.status === "connected") {
      return `${label}: connected (${state.toolNames.length} tools, MCP ${state.protocol || "unknown"})`;
    }
    if (state.lastError) return `${label}: error (${state.lastError})`;
    return `${label}: disconnected`;
  });
  return `MCP bridge — ${parts.join("; ")}`;
}

function labelFor(serverName, mcpToolName) {
  return `${shortServerName(serverName)}/${mcpToolName}`;
}

function promptSnippetFor(serverName, tool) {
  const summary = tool.title || tool.description?.split(/\r?\n/).find((line) => line.trim()) || "MCP tool";
  return `${labelFor(serverName, tool.name)} — ${summary.replace(/\s+/g, " ").slice(0, 160)}`;
}

function descriptionFor(serverName, tool) {
  const base = tool.description || `${tool.name} via ${shortServerName(serverName)} MCP`;
  if (serverName === "morph-mcp" && tool.name === "codebase_search") {
    return `${base} Defaults repo_path to the current working directory when omitted.`;
  }
  return base;
}

function registerDiscoveredTool(pi, serverName, tool) {
  const piToolName = toPiToolName(serverName, tool.name);
  const schema = adaptInputSchema(piToolName, tool.inputSchema);

  pi.registerTool({
    name: piToolName,
    label: labelFor(serverName, tool.name),
    description: descriptionFor(serverName, tool),
    promptSnippet: promptSnippetFor(serverName, tool),
    parameters: schema,
    executionMode: tool.annotations?.destructiveHint === true ? "sequential" : undefined,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const state = await ensureConnected(serverName, ctx.cwd);
      const args = finalizeCallArguments(piToolName, params, ctx);

      onUpdate?.({
        content: [{ type: "text", text: `Calling ${labelFor(serverName, tool.name)}...` }],
        details: { server: serverName, tool: tool.name, stage: "calling" },
      });

      let result;
      try {
        result = await state.client.callTool(
          { name: tool.name, arguments: args },
          { signal, timeout: state.config.toolTimeoutMs },
        );
      } catch (error) {
        state.status = "error";
        state.lastError = sanitizeSecrets(error?.message || error);
        throw new Error(`${labelFor(serverName, tool.name)} failed: ${state.lastError}`);
      }

      const parts = resultToPiParts(result);
      const truncated = await truncateForPi(piToolName, parts.text);
      if (result.isError) {
        throw new Error(sanitizeSecrets(truncated.text || `${labelFor(serverName, tool.name)} failed`));
      }

      return {
        content: [...(truncated.text ? [{ type: "text", text: truncated.text }] : []), ...parts.images],
        details: {
          server: serverName,
          tool: tool.name,
          protocol: state.protocol,
          rawContent: result.content,
          structuredContent: result.structuredContent,
          tempFile: truncated.tempFile,
          truncation: truncated.truncation,
        },
      };
    },
  });

  return piToolName;
}

function filterConfiguredTools(config, tools) {
  return tools.filter(
    (tool) => (!config.enabledTools || config.enabledTools.has(tool.name)) && !config.disabledTools.has(tool.name),
  );
}

async function connectAndRegisterTools(pi, ctx, forceReconnect = false) {
  const errors = [];

  for (const serverName of TARGET_SERVERS) {
    const state = getOrCreateServerState(serverName);

    try {
      const configuredServers = await loadConfiguredServers();
      if (!configuredServers.has(serverName)) {
        await closeServer(serverName);
        state.status = "unconfigured";
        state.lastError = undefined;
        state.toolNames = [];
        continue;
      }
      const connectedState = await ensureConnected(serverName, ctx.cwd, forceReconnect, configuredServers);
      const listed = await connectedState.client.listTools();
      const tools = filterConfiguredTools(connectedState.config, listed.tools);
      connectedState.toolNames = tools.map((tool) => registerDiscoveredTool(pi, serverName, tool));
      connectedState.status = "connected";
      connectedState.lastError = undefined;
    } catch (error) {
      state.status = "error";
      state.lastError = sanitizeSecrets(error?.message || error);
      errors.push(`${shortServerName(serverName)}: ${state.lastError}`);
    }
  }

  if (ctx.hasUI) {
    ctx.ui.setStatus("mcp", buildStatusLine());
    if (errors.length > 0) {
      ctx.ui.notify(`MCP bridge issues — ${errors.join("; ")}`, "warning");
    }
  }
}

export default function mcpBridge(pi) {
  pi.registerCommand("mcp-status", {
    description: "Show MCP bridge status",
    handler: async (_args, ctx) => {
      await connectAndRegisterTools(pi, ctx);
      ctx.ui.notify(buildStatusMessage(), "info");
    },
  });

  pi.registerCommand("mcp-reconnect", {
    description: "Reconnect configured MCP servers",
    handler: async (_args, ctx) => {
      await closeAllServers();
      await connectAndRegisterTools(pi, ctx, true);
      ctx.ui.notify(buildStatusMessage(), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await connectAndRegisterTools(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("mcp", undefined);
    await closeAllServers();
  });
}
