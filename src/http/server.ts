import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { chromium } from "playwright";

import { errorMessage, log } from "../log.js";
import { createHttpHandler, DEFAULT_RENDER_TIMEOUT_MS } from "./routes.js";
import { RenderQueue } from "./queue.js";
import { renderDiagramPng, type RenderRequest, type RenderedPng } from "./render.js";
import { RedisDiagramStorage, type DiagramStorage } from "./storage.js";

export interface ChromiumState {
  chromium: "ready" | "missing";
}

/** Checks that Playwright has a Chromium binary without launching it. */
export function chromiumState(): ChromiumState["chromium"] {
  try {
    return existsSync(chromium.executablePath()) ? "ready" : "missing";
  } catch {
    return "missing";
  }
}

export interface CreateDiagramServerOptions {
  token: string;
  storage: DiagramStorage;
  render?: (request: RenderRequest) => Promise<RenderedPng>;
  queue?: RenderQueue;
  renderTimeoutMs?: number;
  chromiumReady?: () => "ready" | "missing";
}

/** Builds the HTTP server without listening; tests call `listen(0)` on it. */
export function createDiagramHttpServer(options: CreateDiagramServerOptions): Server {
  if (!options.token || options.token.trim().length === 0) {
    throw new Error("diagram HTTP token must not be empty");
  }
  const handler = createHttpHandler({
    token: options.token,
    storage: options.storage,
    render: options.render ?? renderDiagramPng,
    queue: options.queue ?? new RenderQueue({ concurrency: 1, maxQueue: 4 }),
    renderTimeoutMs: options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
    chromiumReady: options.chromiumReady ?? chromiumState,
  });

  return createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      log.error("http_handler_failed", errorMessage(error));
      response.destroy();
    });
  });
}

export interface StartHttpServerOptions {
  host: string;
  port: number;
  token: string;
  redisUrl: string;
  renderTimeoutMs?: number;
}

export interface StartedHttpServer {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/** Production entry point: Redis-backed storage, one shared renderer, bounded queue. */
export async function startHttpServer(
  options: StartHttpServerOptions,
): Promise<StartedHttpServer> {
  if (!options.token || options.token.trim().length === 0) {
    throw new Error("diagram HTTP token must not be empty");
  }

  const storage = new RedisDiagramStorage({ url: options.redisUrl });
  const connected = await storage.connect();
  if (!connected) {
    log.warn("redis_not_ready", "starting with storage=down; renders will return 503");
  }

  const server = createDiagramHttpServer({
    token: options.token,
    storage,
    queue: new RenderQueue({ concurrency: 1, maxQueue: 4 }),
    renderTimeoutMs: options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
    chromiumReady: chromiumState,
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.port, options.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  server.on("error", (error: Error) => {
    log.error("http_server_error", error.name);
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  log.info(`listening on http://${options.host}:${port}`);

  let closed = false;
  return {
    host: options.host,
    port,
    url: `http://${options.host}:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await storage.close();
    },
  };
}
