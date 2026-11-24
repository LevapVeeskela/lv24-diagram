import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { errorMessage, log } from "../log.js";
import { VERSION } from "../version.js";

export interface DrawioHealth {
  ok: boolean;
  tools: string[];
  error?: string;
}

interface TextContent {
  type: string;
  text?: string;
}

function firstText(result: unknown): string {
  const content = (result as { content?: TextContent[] } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("\n");
}

function parsePayload(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Thin MCP client for the shared draw.io HTTP server (127.0.0.1:3214 by default).
 * The server owns the editor and its WebSocket bridge; we only forward tool calls.
 */
export class DrawioClient {
  #client?: Client;

  constructor(private readonly url: string) {}

  async #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    const client = new Client({ name: "lv24-diagram", version: VERSION }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(this.url));
    await client.connect(transport);
    this.#client = client;
    return client;
  }

  async health(): Promise<DrawioHealth> {
    try {
      const client = await this.#connect();
      const tools = await client.listTools();
      return { ok: true, tools: tools.tools.map((tool) => tool.name) };
    } catch (error) {
      this.#client = undefined;
      return { ok: false, tools: [], error: errorMessage(error) };
    }
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      const client = await this.#connect();
      const result = await client.callTool({ name, arguments: args });
      return parsePayload(firstText(result));
    } catch (error) {
      log.warn("draw.io call failed, reconnecting once:", errorMessage(error));
      this.#client = undefined;
      const client = await this.#connect();
      const result = await client.callTool({ name, arguments: args });
      return parsePayload(firstText(result));
    }
  }

  async listDocuments(): Promise<unknown> {
    return this.call("list-documents");
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}
