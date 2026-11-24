import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { encodeRgbaPng } from "../src/http/png.js";
import { RenderQueue } from "../src/http/queue.js";
import type { RenderRequest, RenderedPng } from "../src/http/render.js";
import { createDiagramHttpServer } from "../src/http/server.js";
import {
  DIAGRAM_PNG_TTL_SECONDS,
  diagramPngKey,
  StorageUnavailableError,
  type DiagramStorage,
  type StorageHealth,
} from "../src/http/storage.js";

const TOKEN = "test-token";
const TOKEN_HEADER = "x-lv24-diagram-token";
const DIAGRAM = "flowchart LR\n  U[User] --> A[API]";
const PNG = encodeRgbaPng({ width: 2, height: 2, data: Buffer.alloc(16, 0x80) });

class FakeStorage implements DiagramStorage {
  readonly objects = new Map<string, Buffer>();
  down = false;
  failPut = false;
  lastTtl: number | undefined;

  async put(id: string, png: Buffer): Promise<void> {
    if (this.down || this.failPut) throw new StorageUnavailableError();
    this.objects.set(id, png);
    this.lastTtl = DIAGRAM_PNG_TTL_SECONDS;
  }

  async get(id: string): Promise<Buffer | null> {
    if (this.down) throw new StorageUnavailableError();
    return this.objects.get(id) ?? null;
  }

  health(): StorageHealth {
    return this.down ? "down" : "redis";
  }

  async close(): Promise<void> {}
}

interface Harness {
  url: string;
  storage: FakeStorage;
  queue: RenderQueue;
  server: Server;
  renderCalls: RenderRequest[];
  close: () => Promise<void>;
}

async function startHarness(
  options: {
    render?: (request: RenderRequest) => Promise<RenderedPng>;
    queue?: RenderQueue;
    storage?: FakeStorage;
    renderTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const storage = options.storage ?? new FakeStorage();
  const queue = options.queue ?? new RenderQueue({ concurrency: 1, maxQueue: 4 });
  const renderCalls: RenderRequest[] = [];
  const render =
    options.render ??
    (async (): Promise<RenderedPng> => ({ png: PNG, width: 2, height: 2 }));

  const server = createDiagramHttpServer({
    token: TOKEN,
    storage,
    queue,
    render: async (request) => {
      renderCalls.push(request);
      return render(request);
    },
    renderTimeoutMs: options.renderTimeoutMs ?? 500,
    chromiumReady: () => "ready",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    storage,
    queue,
    server,
    renderCalls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function postRender(
  url: string,
  body: unknown,
  token: string | undefined = TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers[TOKEN_HEADER] = token;
  return fetch(`${url}/v1/render`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface ErrorBody {
  error: { code: string; message?: string; findings?: Array<{ rule: string; severity: string }> };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("POST /v1/render requires the configured token", async () => {
  const harness = await startHarness();
  try {
    const missing = await postRender(harness.url, { mermaid: DIAGRAM }, "");
    assert.equal(missing.status, 401);
    assert.equal(((await missing.json()) as ErrorBody).error.code, "DIAGRAM_UNAUTHORIZED");

    const wrong = await postRender(harness.url, { mermaid: DIAGRAM }, "wrong-token");
    assert.equal(wrong.status, 401);

    const ok = await postRender(harness.url, { mermaid: DIAGRAM });
    assert.equal(ok.status, 200);
  } finally {
    await harness.close();
  }
});

test("POST /v1/render returns the stored PNG dimensions and echoes the source", async () => {
  const harness = await startHarness();
  try {
    const response = await postRender(harness.url, {
      mermaid: DIAGRAM,
      theme: "dark",
      title: "City flow",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      id: string;
      width: number;
      height: number;
      bytes: number;
      mermaid: string;
    };
    assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(body.width, 2);
    assert.equal(body.height, 2);
    assert.equal(body.bytes, PNG.length);
    assert.equal(body.mermaid, DIAGRAM);
    assert.equal(harness.renderCalls[0]?.theme, "dark");
    assert.equal(harness.storage.lastTtl, 3600);
    assert.deepEqual(harness.storage.objects.get(body.id), PNG);
  } finally {
    await harness.close();
  }
});

test("GET /v1/diagrams/{id}.png is public, cached and 404s for unknown ids", async () => {
  const harness = await startHarness();
  try {
    const render = await postRender(harness.url, { mermaid: DIAGRAM });
    const { id } = (await render.json()) as { id: string };

    const image = await fetch(`${harness.url}/v1/diagrams/${id}.png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("cache-control"), "public, max-age=3600, immutable");
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.deepEqual(bytes, PNG);

    const missing = await fetch(`${harness.url}/v1/diagrams/${crypto.randomUUID()}.png`);
    assert.equal(missing.status, 404);

    const malformed = await fetch(`${harness.url}/v1/diagrams/not-a-uuid.png`);
    assert.equal(malformed.status, 404);
  } finally {
    await harness.close();
  }
});

test("POST /v1/render rejects schema violations with findings", async () => {
  const harness = await startHarness();
  try {
    const short = await postRender(harness.url, { mermaid: "too short" });
    assert.equal(short.status, 400);
    const shortBody = (await short.json()) as ErrorBody;
    assert.equal(shortBody.error.code, "DIAGRAM_INVALID");
    assert.equal(shortBody.error.findings?.[0]?.rule, "request");

    const badTheme = await postRender(harness.url, { mermaid: DIAGRAM, theme: "rainbow" });
    assert.equal(badTheme.status, 400);

    const invalidJson = await fetch(`${harness.url}/v1/render`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: TOKEN },
      body: "{not json",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(harness.storage.objects.size, 0);
  } finally {
    await harness.close();
  }
});

test("lint rejects a diagram above the 40-node budget", async () => {
  const harness = await startHarness();
  try {
    const nodes = Array.from({ length: 41 }, (_, index) => `N${index}[Node ${index}]`).join("\n");
    const response = await postRender(harness.url, {
      mermaid: `flowchart LR\n${nodes}\nN0 --> N1`,
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as ErrorBody;
    assert.equal(body.error.code, "DIAGRAM_INVALID");
    assert.ok(body.error.findings?.some((finding) => finding.rule === "node-budget"));
    assert.equal(harness.storage.objects.size, 0);
  } finally {
    await harness.close();
  }
});

test("security rules reject click directives and init blocks", async () => {
  const harness = await startHarness();
  try {
    for (const mermaid of [
      "flowchart LR\n  A[Start] --> B[End]\n  click A \"https://example.com\"",
      "%%{init: {'securityLevel': 'loose'}}%%\nflowchart LR\n  A --> B",
    ]) {
      const response = await postRender(harness.url, { mermaid });
      assert.equal(response.status, 400, mermaid);
      const body = (await response.json()) as ErrorBody;
      assert.ok(body.error.findings?.some((finding) => finding.rule === "security"));
    }
    assert.equal(harness.renderCalls.length, 0);
  } finally {
    await harness.close();
  }
});

test("GET /health reports chromium, storage and queue without auth", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      chromium: string;
      storage: string;
      queue: { size: number; inflight: number };
    };
    assert.deepEqual(body, {
      status: "ok",
      chromium: "ready",
      storage: "redis",
      queue: { size: 0, inflight: 0 },
    });

    harness.storage.down = true;
    const down = (await (await fetch(`${harness.url}/health`)).json()) as { storage: string };
    assert.equal(down.storage, "down");
  } finally {
    await harness.close();
  }
});

test("render returns 503 STORAGE_UNAVAILABLE before rendering when Redis is down", async () => {
  const harness = await startHarness();
  try {
    harness.storage.down = true;
    const response = await postRender(harness.url, { mermaid: DIAGRAM });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as ErrorBody).error.code, "STORAGE_UNAVAILABLE");
    assert.equal(harness.renderCalls.length, 0);
  } finally {
    await harness.close();
  }
});

test("storage write failure returns 503 instead of a dangling id", async () => {
  const harness = await startHarness();
  try {
    harness.storage.failPut = true;
    const response = await postRender(harness.url, { mermaid: DIAGRAM });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as ErrorBody).error.code, "STORAGE_UNAVAILABLE");
    assert.equal(harness.storage.objects.size, 0);
  } finally {
    await harness.close();
  }
});

test("render failure and timeout return 503 without echoing the diagram", async () => {
  const failing = await startHarness({
    render: async () => {
      throw new Error(`bad syntax in ${DIAGRAM}`);
    },
  });
  try {
    const response = await postRender(failing.url, { mermaid: DIAGRAM });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, "DIAGRAM_UNAVAILABLE");
    assert.doesNotMatch(text, /bad syntax/);
  } finally {
    await failing.close();
  }

  const hanging = await startHarness({
    render: () => new Promise<RenderedPng>(() => {}),
    renderTimeoutMs: 30,
  });
  try {
    const response = await postRender(hanging.url, { mermaid: DIAGRAM });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as ErrorBody).error.code, "DIAGRAM_UNAVAILABLE");
  } finally {
    await hanging.close();
  }
});

test("queue accepts one render plus four waiting jobs and rejects the sixth with 429", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const queue = new RenderQueue({ concurrency: 1, maxQueue: 4 });
  const harness = await startHarness({
    queue,
    render: async () => {
      started += 1;
      await gate;
      return { png: PNG, width: 2, height: 2 };
    },
  });
  try {
    const accepted = Array.from({ length: 5 }, () =>
      postRender(harness.url, { mermaid: DIAGRAM }),
    );
    await waitFor(() => queue.stats.inflight === 1 && queue.stats.size === 4, "full queue");
    assert.equal(started, 1);

    const rejected = await postRender(harness.url, { mermaid: DIAGRAM });
    assert.equal(rejected.status, 429);
    assert.equal(((await rejected.json()) as ErrorBody).error.code, "DIAGRAM_BUSY");

    release();
    const statuses = await Promise.all(accepted.map(async (response) => (await response).status));
    assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
    assert.deepEqual(queue.stats, { size: 0, inflight: 0 });
  } finally {
    release();
    await harness.close();
  }
});

test("OpenAPI and Swagger UI are served without auth", async () => {
  const harness = await startHarness();
  try {
    const document = await fetch(`${harness.url}/docs-json`);
    assert.equal(document.status, 200);
    const openapi = (await document.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    assert.match(openapi.openapi, /^3\./);
    assert.ok(openapi.paths["/v1/render"]);
    assert.ok(openapi.paths["/v1/diagrams/{id}.png"]);

    const ui = await fetch(`${harness.url}/docs`);
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /SwaggerUIBundle/);

    const css = await fetch(`${harness.url}/docs/swagger-ui.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  } finally {
    await harness.close();
  }
});

test("server refuses to start with an empty token", () => {
  assert.throws(
    () =>
      createDiagramHttpServer({
        token: "",
        storage: new FakeStorage(),
        render: async () => ({ png: PNG, width: 2, height: 2 }),
      }),
    /token/,
  );
});

test("storage keys are namespaced and versioned", () => {
  const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  assert.equal(diagramPngKey(id), `diagram:v1:png:${id}`);
});

test("unknown routes return a JSON 404", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/nope`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as ErrorBody;
    assert.equal(body.error.code, "NOT_FOUND");
  } finally {
    await harness.close();
  }
});
