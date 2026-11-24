import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { errorMessage, log } from "../log.js";
import { isValidToken, TOKEN_HEADER } from "./auth.js";
import { buildOpenApiDocument } from "./openapi.js";
import { QueueFullError, RenderQueue } from "./queue.js";
import { validateRenderRequest, type RenderRequest, type RenderedPng } from "./render.js";
import { StorageUnavailableError, type DiagramStorage } from "./storage.js";
import { readSwaggerAsset, SWAGGER_UI_HTML } from "./swagger.js";

export const DEFAULT_RENDER_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 64 * 1024;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_PATH = /^\/v1\/diagrams\/([^/]+)\.png$/;

export interface DiagramHttpDeps {
  token: string;
  storage: DiagramStorage;
  render: (request: RenderRequest) => Promise<RenderedPng>;
  queue: RenderQueue;
  renderTimeoutMs?: number;
  chromiumReady?: () => "ready" | "missing";
}

export type HttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

class BodyTooLargeError extends Error {}
class RenderTimeoutError extends Error {}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RenderTimeoutError()), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message?: string,
  findings?: unknown[],
): void {
  const error: Record<string, unknown> = { code, ...(message ? { message } : {}) };
  if (findings) error.findings = findings;
  sendJson(response, status, { error });
}

function sendPng(response: ServerResponse, png: Buffer): void {
  response.writeHead(200, {
    "content-type": "image/png",
    "content-length": String(png.length),
    "cache-control": "public, max-age=3600, immutable",
    "x-content-type-options": "nosniff",
  });
  response.end(png);
}

export function createHttpHandler(deps: DiagramHttpDeps): HttpHandler {
  const timeoutMs = deps.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const chromiumReady = deps.chromiumReady ?? (() => "ready");

  async function handleRender(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isValidToken(request.headers[TOKEN_HEADER], deps.token)) {
      log.warn("render_unauthorized");
      sendError(response, 401, "DIAGRAM_UNAUTHORIZED", "missing or invalid token");
      return;
    }

    if (deps.storage.health() === "down") {
      log.error("render_storage_unavailable");
      sendError(response, 503, "STORAGE_UNAVAILABLE", "diagram storage is unavailable");
      return;
    }

    if (chromiumReady() !== "ready") {
      log.error("render_chromium_missing");
      sendError(response, 503, "DIAGRAM_UNAVAILABLE", "Chromium is not installed");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendError(response, 413, "DIAGRAM_INVALID", "request body exceeds 64 KB");
        return;
      }
      sendError(response, 400, "DIAGRAM_INVALID", "request body must be valid JSON");
      return;
    }

    const validation = validateRenderRequest(body);
    if (!validation.ok) {
      sendError(response, 400, "DIAGRAM_INVALID", "diagram rejected", validation.findings);
      return;
    }

    let rendered: RenderedPng;
    try {
      rendered = await withTimeout(
        deps.queue.run(() => deps.render(validation.value)),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof QueueFullError) {
        sendError(response, 429, "DIAGRAM_BUSY", "render queue is full");
        return;
      }
      if (error instanceof RenderTimeoutError) {
        log.error("render_timeout");
      } else {
        // Render errors may quote diagram text; log only the error class.
        log.error("render_failed", error instanceof Error ? error.name : "unknown");
      }
      sendError(response, 503, "DIAGRAM_UNAVAILABLE", "diagram could not be rendered");
      return;
    }

    const id = randomUUID();
    try {
      await deps.storage.put(id, rendered.png);
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) {
        log.error("storage_put_failed", error instanceof Error ? error.name : "unknown");
      } else {
        log.error("storage_unavailable");
      }
      sendError(response, 503, "STORAGE_UNAVAILABLE", "diagram storage is unavailable");
      return;
    }

    sendJson(response, 200, {
      id,
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.png.length,
      mermaid: validation.value.mermaid,
    });
  }

  async function handlePng(response: ServerResponse, id: string): Promise<void> {
    if (!UUID_V4.test(id)) {
      sendError(response, 404, "NOT_FOUND", "diagram not found");
      return;
    }
    try {
      const png = await deps.storage.get(id);
      if (!png) {
        sendError(response, 404, "NOT_FOUND", "diagram not found");
        return;
      }
      sendPng(response, png);
    } catch {
      log.error("storage_unavailable");
      sendError(response, 503, "STORAGE_UNAVAILABLE", "diagram storage is unavailable");
    }
  }

  return async function handler(request, response) {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    try {
      if (method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          chromium: chromiumReady(),
          storage: deps.storage.health(),
          queue: deps.queue.stats,
        });
        return;
      }

      if (method === "POST" && path === "/v1/render") {
        await handleRender(request, response);
        return;
      }

      if (method === "GET") {
        const pngMatch = PNG_PATH.exec(path);
        if (pngMatch?.[1]) {
          await handlePng(response, pngMatch[1]);
          return;
        }

        if (path === "/docs-json") {
          sendJson(response, 200, buildOpenApiDocument());
          return;
        }

        if (path === "/docs" || path === "/docs/") {
          const body = Buffer.from(SWAGGER_UI_HTML);
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(body.length),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(body);
          return;
        }

        const asset = await readSwaggerAsset(path);
        if (asset) {
          response.writeHead(200, {
            "content-type": asset.contentType,
            "content-length": String(asset.body.length),
            "cache-control": "public, max-age=86400",
            "x-content-type-options": "nosniff",
          });
          response.end(asset.body);
          return;
        }
      }

      sendError(response, 404, "NOT_FOUND", "route not found");
    } catch (error) {
      log.error("request_failed", errorMessage(error));
      if (!response.headersSent) {
        sendError(response, 500, "INTERNAL", "unexpected error");
      } else {
        response.end();
      }
    }
  };
}
