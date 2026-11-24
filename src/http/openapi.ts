import { VERSION } from "../version.js";

const ERROR_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["rule", "severity", "message"],
            properties: {
              rule: { type: "string" },
              severity: { type: "string", enum: ["error", "warning", "info"] },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "diagram-api",
      version: VERSION,
      description:
        "Renders Mermaid diagrams to PNG and serves them by public UUID URL. " +
        "Rendering is limited to 40 nodes, one concurrent job and a four-job queue.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        diagramToken: {
          type: "apiKey",
          in: "header",
          name: "x-lv24-diagram-token",
        },
      },
      schemas: {
        Error: ERROR_SCHEMA,
        RenderRequest: {
          type: "object",
          required: ["mermaid"],
          properties: {
            mermaid: { type: "string", minLength: 10, maxLength: 4000 },
            theme: {
              type: "string",
              enum: ["default", "base", "dark", "forest", "neutral"],
              default: "default",
            },
            title: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
        RenderResponse: {
          type: "object",
          required: ["id", "width", "height", "bytes", "mermaid"],
          properties: {
            id: { type: "string", format: "uuid" },
            width: { type: "integer" },
            height: { type: "integer" },
            bytes: { type: "integer" },
            mermaid: { type: "string" },
          },
        },
        Health: {
          type: "object",
          required: ["status", "chromium", "storage", "queue"],
          properties: {
            status: { type: "string", enum: ["ok"] },
            chromium: { type: "string", enum: ["ready", "missing"] },
            storage: { type: "string", enum: ["redis", "down"] },
            queue: {
              type: "object",
              required: ["size", "inflight"],
              properties: {
                size: { type: "integer" },
                inflight: { type: "integer" },
              },
            },
          },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          summary: "Liveness, Chromium and Redis state",
          security: [],
          responses: {
            "200": {
              description: "Service state",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
            },
          },
        },
      },
      "/v1/render": {
        post: {
          summary: "Render Mermaid to PNG and store it",
          security: [{ diagramToken: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RenderRequest" } },
            },
          },
          responses: {
            "200": {
              description: "Rendered diagram",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/RenderResponse" } },
              },
            },
            "400": {
              description: "Invalid or unreadable diagram",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "401": {
              description: "Missing or invalid token",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "429": {
              description: "Render queue is full",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "503": {
              description: "Chromium unavailable or Redis unavailable",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/v1/diagrams/{id}.png": {
        get: {
          summary: "Fetch a rendered PNG (public, cached for one hour)",
          security: [],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "PNG image",
              content: { "image/png": {} },
            },
            "404": { description: "Unknown or expired id" },
            "503": {
              description: "Redis unavailable",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/docs-json": {
        get: {
          summary: "OpenAPI document",
          security: [],
          responses: { "200": { description: "OpenAPI 3 document" } },
        },
      },
      "/docs": {
        get: {
          summary: "Swagger UI",
          security: [],
          responses: { "200": { description: "HTML page" } },
        },
      },
    },
  };
}
