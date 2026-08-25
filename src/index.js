import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
const CLIENT_INFO = { name: "pi-mcp-bridge", version: "0.1.0" };
const TOOL_METADATA = {
  mcp__exa__web_search_exa: {
    promptSnippet: "Use Exa for current external web research.",
    promptGuidelines: [
      "Use this for current web facts, company research, and non-local external research.",
      "Prefer primary or official sources when possible.",
    ],
  },
  mcp__exa__crawling_exa: {
    promptSnippet: "Fetch and read one or more external URLs with Exa.",
    promptGuidelines: [
      "Use this after identifying relevant URLs that need to be read in detail.",
      "Batch multiple URLs into one call when practical.",
    ],
  },
  mcp__exa__get_code_context_exa: {
    promptSnippet: "Use Exa for external programming docs, SDK usage, and code examples.",
    promptGuidelines: [
      "Use this for libraries, APIs, SDKs, and official docs beyond the local repository.",
      "Prefer this over generic web search when the question is about programming usage or documentation.",
    ],
  },
  mcp__morph_mcp__codebase_search: {
    promptSnippet: "Use Morph semantic search for broad local codebase discovery.",
    promptGuidelines: [
      "Use this for broad local discovery like 'find the flow', 'where is this handled?', or 'where does this error come from?'.",
      "Prefer exact lookup tools for literal strings and symbol names once you know them.",
    ],
  },
  mcp__morph_mcp__github_codebase_search: {
    promptSnippet: "Use Morph semantic search for public GitHub repositories not cloned locally.",
    promptGuidelines: [
      "Use this when the target code lives in a public GitHub repository that is not cloned locally.",
    ],
  },
  mcp__morph_mcp__edit_file: {
    promptSnippet: "Use Morph for routine partial-file edits when the target change is already understood.",
    promptGuidelines: [
      "Prefer this for focused partial-file edits with minimal context.",
      "If this tool fails to apply a change cleanly, fall back to pi's local edit and write tools.",
    ],
  },
};

const serverStates = new Map();
const registeredTools = new Set();
const fileMutationQueues = new Map();

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

async function withFileMutationQueue(filePath, fn) {
  // ponytail: resolved paths only; use realpath if symlink aliases become a real concurrency issue.
  const key = resolve(filePath);
  const previous = fileMutationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  fileMutationQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (fileMutationQueues.get(key) === current) fileMutationQueues.delete(key);
  }
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

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

    if (typeof raw.url === "string" && raw.url) {
      servers.set(serverName, {
        type: "remote",
        url: raw.url,
      });
      continue;
    }

    if (typeof raw.command === "string" && raw.command) {
      servers.set(serverName, {
        type: "stdio",
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.map((arg) => String(arg)) : [],
        env:
          raw.env && typeof raw.env === "object"
            ? Object.fromEntries(Object.entries(raw.env).map(([key, val]) => [key, String(val)]))
            : undefined,
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
      transport: undefined,
      cwd: undefined,
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
  const transport = state.transport;
  state.client = undefined;
  state.transport = undefined;
  state.cwd = undefined;
  state.status = "disconnected";
  if (transport?.close) {
    try {
      await transport.close();
    } catch {
      // Ignore shutdown errors.
    }
  }
}

async function closeAllServers() {
  await Promise.all(Array.from(serverStates.keys()).map((serverName) => closeServer(serverName)));
}

async function connectRemoteServer(url) {
  const httpClient = new Client(CLIENT_INFO);
  const baseUrl = new URL(url);
  const httpTransport = new StreamableHTTPClientTransport(baseUrl);

  try {
    await httpClient.connect(httpTransport);
    return { client: httpClient, transport: httpTransport };
  } catch (httpError) {
    await httpTransport.close().catch(() => {});
    const sseClient = new Client(CLIENT_INFO);
    const transport = new SSEClientTransport(baseUrl);
    try {
      await sseClient.connect(transport);
      return { client: sseClient, transport };
    } catch (sseError) {
      await transport.close().catch(() => {});
      throw new Error(
        `Streamable HTTP failed (${sanitizeSecrets(httpError?.message || httpError)}); SSE failed (${sanitizeSecrets(
          sseError?.message || sseError,
        )})`,
      );
    }
  }
}

function getMorphSpawnArgs(config, cwd) {
  const args = [...(config.args || [])];
  if (cwd && !args.includes(cwd)) {
    args.push(cwd);
  }
  return args;
}

async function ensureConnected(serverName, cwd, forceReconnect = false) {
  const servers = await loadConfiguredServers();
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
    !state.transport ||
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

    let connection;
    if (config.type === "remote") {
      connection = await connectRemoteServer(config.url);
    } else {
      const client = new Client(CLIENT_INFO);
      const transport = new StdioClientTransport({
        command: config.command,
        args: getMorphSpawnArgs(config, cwd),
        env: config.env,
        cwd,
        stderr: "pipe",
      });
      await client.connect(transport);
      connection = { client, transport };
    }

    connection.client.onerror = (error) => {
      const currentState = getOrCreateServerState(serverName);
      if (currentState.client !== connection.client) return;
      currentState.status = "error";
      currentState.lastError = sanitizeSecrets(error?.message || error);
    };
    connection.client.onclose = () => {
      const currentState = getOrCreateServerState(serverName);
      if (currentState.client !== connection.client) return;
      currentState.client = undefined;
      currentState.transport = undefined;
      currentState.cwd = undefined;
      currentState.status = currentState.lastError ? "error" : "disconnected";
    };

    state.client = connection.client;
    state.transport = connection.transport;
    state.cwd = cwd;
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

async function listAllTools(client) {
  const tools = [];
  let cursor;

  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
}

function adaptInputSchema(piToolName, inputSchema) {
  const schema = cloneJson(inputSchema) || { type: "object", additionalProperties: true };

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

function normalizePreparedArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }

  const prepared = { ...args };
  if (typeof prepared.path === "string") {
    prepared.path = stripAtPrefix(prepared.path);
  }
  if (typeof prepared.repo_path === "string") {
    prepared.repo_path = stripAtPrefix(prepared.repo_path);
  }
  return prepared;
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

function stringifyContentItem(item) {
  if (!item || typeof item !== "object") {
    return String(item ?? "");
  }
  if (item.type === "text" && typeof item.text === "string") {
    return item.text;
  }
  return JSON.stringify(item, null, 2);
}

function resultToText(result) {
  const parts = Array.isArray(result?.content) ? result.content.map((item) => stringifyContentItem(item)).filter(Boolean) : [];
  if (parts.length > 0) {
    return parts.join("\n\n");
  }
  if (result?.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return "(no text content returned)";
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
  await writeFile(tempFile, text, "utf8");

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
    if (state.status === "connected") return `${label}: connected (${state.toolNames.length} tools)`;
    if (state.lastError) return `${label}: error (${state.lastError})`;
    return `${label}: disconnected`;
  });
  return `MCP bridge — ${parts.join("; ")}`;
}

function metadataFor(piToolName) {
  return TOOL_METADATA[piToolName] || {};
}

function labelFor(serverName, mcpToolName) {
  return `${shortServerName(serverName)}/${mcpToolName}`;
}

function descriptionFor(serverName, tool) {
  const base = tool.description || `${tool.name} via ${shortServerName(serverName)} MCP`;
  if (tool.name === "codebase_search") {
    return `${base} Defaults repo_path to the current working directory when omitted.`;
  }
  return base;
}

function registerDiscoveredTool(pi, serverName, tool) {
  const piToolName = toPiToolName(serverName, tool.name);
  if (registeredTools.has(piToolName)) {
    return piToolName;
  }

  const schema = adaptInputSchema(piToolName, tool.inputSchema);
  const meta = metadataFor(piToolName);

  pi.registerTool({
    name: piToolName,
    label: labelFor(serverName, tool.name),
    description: descriptionFor(serverName, tool),
    promptSnippet: meta.promptSnippet,
    promptGuidelines: meta.promptGuidelines,
    parameters: schema,
    prepareArguments: normalizePreparedArguments,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const run = async () => {
        const state = await ensureConnected(serverName, ctx.cwd);
        const args = finalizeCallArguments(piToolName, params, ctx);

        onUpdate?.({
          content: [{ type: "text", text: `Calling ${labelFor(serverName, tool.name)}...` }],
          details: { server: serverName, tool: tool.name, stage: "calling" },
        });

        let result;
        try {
          result = await state.client.callTool(
            {
              name: tool.name,
              arguments: args,
            },
            undefined,
            {
              signal,
              timeout: 120000,
            },
          );
        } catch (error) {
          state.status = "error";
          state.lastError = sanitizeSecrets(error?.message || error);
          throw new Error(`${labelFor(serverName, tool.name)} failed: ${state.lastError}`);
        }

        const rawText = resultToText(result);
        const truncated = await truncateForPi(piToolName, rawText);
        if (result.isError) {
          throw new Error(sanitizeSecrets(truncated.text || `${labelFor(serverName, tool.name)} failed`));
        }

        return {
          content: [{ type: "text", text: truncated.text }],
          details: {
            server: serverName,
            tool: tool.name,
            rawContent: result.content,
            structuredContent: result.structuredContent,
            tempFile: truncated.tempFile,
            truncation: truncated.truncation,
          },
        };
      };

      if (
        piToolName === "mcp__morph_mcp__edit_file" &&
        typeof params?.path === "string" &&
        params.path &&
        !params.dryRun
      ) {
        const absolutePath = resolve(ctx.cwd, stripAtPrefix(params.path));
        return withFileMutationQueue(absolutePath, run);
      }

      return run();
    },
  });

  registeredTools.add(piToolName);
  return piToolName;
}

async function connectAndRegisterTools(pi, ctx, forceReconnect = false) {
  const errors = [];

  for (const serverName of TARGET_SERVERS) {
    const state = getOrCreateServerState(serverName);

    try {
      const connectedState = await ensureConnected(serverName, ctx.cwd, forceReconnect);
      const tools = await listAllTools(connectedState.client);
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
