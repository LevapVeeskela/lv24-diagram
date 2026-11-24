// Drives the built MCP server over stdio: lists tools and calls a few, printing compact results.
//   node scripts/smoke-mcp.mjs <cwd> [tool ...]
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(process.argv[2] ?? process.cwd());
const requested = process.argv.slice(3);
const child = spawn(process.execPath, [resolve(here, "../dist/src/cli.js"), "mcp"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let buffer = "";
let nextId = 1;
const pending = new Map();

child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 120_000);
    pending.set(id, { resolvePromise, reject, timer });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else entry.resolvePromise(message.result);
  }
});

function summarize(result) {
  if (!result?.content) return JSON.stringify(result).slice(0, 300);
  const parts = result.content.map((item) =>
    item.type === "text"
      ? item.text.slice(0, 900)
      : `<${item.type} ${item.mimeType ?? ""} ${item.data ? Math.round((item.data.length * 3) / 4) + " bytes" : ""}>`,
  );
  return parts.join("\n");
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lv24-diagram-smoke", version: "1" },
  });
  notify("notifications/initialized", {});

  const list = await request("tools/list", {});
  console.log(`tools (${list.tools.length}): ${list.tools.map((tool) => tool.name).join(", ")}`);

  const calls = {
    diagram_render: {
      mermaid: "flowchart LR\n  A[Client] -->|HTTPS| B[API]",
      png: true,
    },
    diagram_lint: { mermaid: "flowchart LR\n A --> B\n B --> C" },
    schema_tables: { pattern: "%" },
    schema_er: { max_entities: 5 },
    arch_scan: { path: process.env.SMOKE_ARCH_PATH ?? cwd },
    brain_context: {},
    drawio_status: {},
  };

  const selected = requested.length > 0 ? requested : Object.keys(calls);
  for (const name of selected) {
    const args = calls[name] ?? {};
    try {
      const result = await request("tools/call", { name, arguments: args });
      const payload = summarize(result);
      console.log(`\n=== ${name} ===\n${payload}`);
    } catch (error) {
      console.log(`\n=== ${name} === ERROR: ${error.message}`);
    }
  }
} finally {
  child.kill();
}
