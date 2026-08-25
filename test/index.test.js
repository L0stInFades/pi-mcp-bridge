import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

test("bridges a configured stdio MCP tool into Pi", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-mcp-bridge-"));
  const configPath = join(tempDir, "config.toml");
  const fixturePath = join(projectDir, "test", "fixture-server.mjs");
  await writeFile(
    configPath,
    `[mcp_servers.exa]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixturePath)}]\n`,
  );

  const previousConfig = process.env.PI_MCP_CONFIG_PATH;
  const previousServers = process.env.PI_MCP_SERVERS;
  process.env.PI_MCP_CONFIG_PATH = configPath;
  process.env.PI_MCP_SERVERS = "exa";

  let shutdown;
  t.after(async () => {
    await shutdown?.();
    if (previousConfig === undefined) delete process.env.PI_MCP_CONFIG_PATH;
    else process.env.PI_MCP_CONFIG_PATH = previousConfig;
    if (previousServers === undefined) delete process.env.PI_MCP_SERVERS;
    else process.env.PI_MCP_SERVERS = previousServers;
    await rm(tempDir, { recursive: true, force: true });
  });

  const { default: bridge } = await import(`${pathToFileURL(join(projectDir, "src", "index.js"))}?test=${Date.now()}`);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  bridge({
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  const ctx = {
    cwd: tempDir,
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
  };
  await handlers.get("session_start")({}, ctx);
  shutdown = async () => {
    await handlers.get("session_shutdown")({}, ctx);
    shutdown = undefined;
  };

  assert(commands.has("mcp-status"));
  assert(commands.has("mcp-reconnect"));
  const echo = tools.get("mcp__exa__echo");
  assert(echo);
  assert.equal(echo.parameters.type, "object");

  const result = await echo.execute("test-call", { text: "hello" }, new AbortController().signal, undefined, ctx);
  assert.equal(result.content[0].text, "hello");
});
