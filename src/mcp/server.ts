import { basename, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { buildArchDiagram, summarizeScan, type ArchView } from "../arch/diagram.js";
import { scanArchitecture } from "../arch/scan.js";
import { BrainClient, redactSecrets } from "../brain/client.js";
import {
  type DiagramConfig,
  resolveDocsDir,
} from "../config.js";
import { DrawioClient } from "../drawio/client.js";
import {
  readManifest,
  saveDiagram,
  summarizeManifest,
  writeManifest,
} from "../docs/repository.js";
import { errorMessage, log } from "../log.js";
import { buildErDiagram } from "../schema/er.js";
import { PostgresIntrospector } from "../schema/postgres.js";
import { isMermaidTheme, renderMermaid, type MermaidTheme } from "../mermaid/render.js";
import { DEFAULT_BUDGET, lintMermaid } from "../mermaid/lint.js";
import { SERVER_NAME, VERSION } from "../version.js";

export interface Runtime {
  config: DiagramConfig;
  cwd: string;
  docsDir: string;
  drawio: DrawioClient;
  brain: BrainClient;
  introspector?: PostgresIntrospector;
}

export function createRuntime(config: DiagramConfig, cwd = process.cwd()): Runtime {
  const docsDir = resolveDocsDir(config, cwd);
  return {
    config,
    cwd,
    docsDir,
    drawio: new DrawioClient(config.drawio.url),
    brain: new BrainClient({
      ...(config.brain.project ? { project: config.brain.project } : {}),
      ...(config.brain.binary ? { binary: config.brain.binary } : {}),
      cwd,
    }),
    ...(config.database
      ? { introspector: new PostgresIntrospector(config.database) }
      : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function ok(value: unknown, extra: ContentBlock[] = []) {
  return {
    content: [{ type: "text" as const, text: text(value) }, ...extra],
  };
}

function fail(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: errorMessage(error) }],
  };
}

function requireDatabase(runtime: Runtime): PostgresIntrospector {
  if (!runtime.introspector) {
    throw new Error(
      "No database is configured. Add a `database` section to diagram.config.json (password: \"${ENV_VAR}\" or passwordFile: \"<path>\").",
    );
  }
  return runtime.introspector;
}

function themeOf(value: string | undefined): MermaidTheme | undefined {
  if (!value) return undefined;
  if (!isMermaidTheme(value)) {
    throw new Error(`Unknown theme "${value}". Use default, base, dark, forest or neutral.`);
  }
  return value;
}

async function manifestHash(runtime: Runtime): Promise<{ hash: string; manifest: Awaited<ReturnType<typeof readManifest>> }> {
  const manifest = await readManifest(runtime.docsDir);
  const hash = Object.values(manifest.diagrams)
    .sort((a, b) => a.index.localeCompare(b.index))
    .map((entry) => entry.hash)
    .join("-");
  return { hash, manifest };
}

async function publishToBrain(runtime: Runtime, dryRun = false): Promise<unknown> {
  if (!runtime.config.brain.enabled) return { published: false, reason: "brain.enabled is false" };
  const { hash, manifest } = await manifestHash(runtime);
  if (Object.keys(manifest.diagrams).length === 0) {
    return { published: false, reason: "no diagrams recorded in the manifest" };
  }
  if (manifest.brain?.publishedHash === hash) {
    return { published: false, reason: "already published for this content", noteId: manifest.brain.noteId };
  }
  const summary = summarizeManifest(manifest);
  const body = [
    `Diagrams directory: \`${runtime.docsDir}\``,
    "",
    `- ${Object.keys(manifest.diagrams).length} diagram(s): ${summary}`,
    `- Content hash: \`${hash}\``,
    `- Published by ${SERVER_NAME} ${VERSION} on ${new Date().toISOString()}`,
    "",
    "The .mmd files are the source of truth; PNG/SVG are generated.",
  ].join("\n");
  const safeBody = redactSecrets(body);
  if (dryRun) {
    return { published: false, dryRun: true, hash, title: `Architecture diagrams: ${basename(runtime.docsDir)}`, body: safeBody };
  }
  const note = await runtime.brain.note(`Architecture diagrams: ${basename(runtime.docsDir)}`, safeBody);
  if (!note.ok) {
    return { published: false, reason: note.error ?? "brain write failed" };
  }
  manifest.brain = {
    publishedHash: hash,
    ...(note.id ? { noteId: note.id } : {}),
    publishedAt: new Date().toISOString(),
    ...(runtime.brain.project ? { project: runtime.brain.project } : {}),
  };
  await writeManifest(runtime.docsDir, manifest);
  return { published: true, noteId: note.id, hash };
}

export function buildServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

  server.registerTool(
    "diagram_render",
    {
      title: "Render Mermaid",
      description:
        "Render a Mermaid diagram to SVG and/or PNG. Returns a text summary plus a PNG image when requested.",
      inputSchema: {
        mermaid: z.string().min(1).describe("Mermaid source"),
        theme: z.string().optional().describe("default | base | dark | forest | neutral"),
        background: z.string().optional().describe("CSS background colour, default #ffffff"),
        png: z.boolean().optional().describe("Render a PNG screenshot (default true)"),
      },
    },
    async ({ mermaid, theme, background, png }) => {
      try {
        const rendered = await renderMermaid(mermaid, {
          png: png !== false,
          ...(themeOf(theme) ? { theme: themeOf(theme) } : {}),
          ...(background ? { backgroundColor: background } : {}),
        });
        const extra = rendered.png
          ? [{ type: "image" as const, data: rendered.png.toString("base64"), mimeType: "image/png" }]
          : [];
        return ok(
          {
            width: rendered.width,
            height: rendered.height,
            layoutWidth: rendered.layoutWidth,
            layoutHeight: rendered.layoutHeight,
            pngWidth: rendered.pngWidth ?? null,
            pngHeight: rendered.pngHeight ?? null,
            pngBytes: rendered.png?.byteLength ?? 0,
            svgBytes: Buffer.byteLength(rendered.svg, "utf8"),
            svg: rendered.svg.length <= 20_000 ? rendered.svg : undefined,
          },
          extra,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "diagram_lint",
    {
      title: "Lint Mermaid",
      description:
        "Check a Mermaid diagram against readability budgets (node count, depth, cycles, edge labels, label length).",
      inputSchema: {
        mermaid: z.string().min(1),
        max_nodes: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ mermaid, max_nodes }) => {
      try {
        const budget = max_nodes
          ? { ...DEFAULT_BUDGET, maxNodes: max_nodes, maxNodesHard: Math.max(max_nodes * 2, max_nodes) }
          : undefined;
        return ok(lintMermaid(mermaid, budget));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "diagram_save",
    {
      title: "Save diagram",
      description:
        "Render and store a diagram as NN-slug.mmd/.svg/.png under docs.dir, update the README index, and optionally publish a digest to lv24-brain.",
      inputSchema: {
        title: z.string().min(1),
        mermaid: z.string().min(1),
        theme: z.string().optional(),
        background: z.string().optional(),
        png: z.boolean().optional(),
        publish_to_brain: z.boolean().optional().describe("Best-effort brain note (default true)"),
      },
    },
    async ({ title, mermaid, theme, background, png, publish_to_brain }) => {
      try {
        const rendered = await renderMermaid(mermaid, {
          png: png !== false,
          ...(themeOf(theme) ? { theme: themeOf(theme) } : {}),
          ...(background ? { backgroundColor: background } : {}),
        });
        const saved = await saveDiagram({
          dir: runtime.docsDir,
          title,
          mermaid,
          svg: rendered.svg,
          ...(rendered.png ? { png: rendered.png } : {}),
        });
        const brain =
          publish_to_brain === false ? { published: false, reason: "disabled by request" } : await publishToBrain(runtime);
        return ok({ ...saved, brain });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "schema_tables",
    {
      title: "List tables",
      description: "List tables and views with row estimates from the configured PostgreSQL database.",
      inputSchema: {
        pattern: z.string().optional().describe("SQL LIKE pattern, e.g. travel_%"),
        include_views: z.boolean().optional().describe("Include views and materialized views"),
      },
    },
    async ({ pattern, include_views }) => {
      try {
        const db = requireDatabase(runtime);
        const tables = await db.tables({
          ...(pattern ? { pattern } : {}),
          ...(include_views === undefined ? {} : { includeViews: include_views }),
        });
        return ok({ count: tables.length, tables });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "schema_columns",
    {
      title: "Describe columns",
      description: "Return columns, types, nullability and PK/UK flags for the given tables.",
      inputSchema: {
        tables: z.array(z.string().min(1)).min(1).max(50),
      },
    },
    async ({ tables }) => {
      try {
        const db = requireDatabase(runtime);
        const columns = await db.columns(tables);
        return ok({ count: columns.length, columns });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "schema_query",
    {
      title: "Read-only query",
      description:
        "Run one read-only SELECT/WITH statement with a row limit. The DB user must still be read-only; the guard is not a permission boundary.",
      inputSchema: {
        sql: z.string().min(1),
      },
    },
    async ({ sql }) => {
      try {
        const db = requireDatabase(runtime);
        const result = await db.query(sql);
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "schema_er",
    {
      title: "ER diagram from schema",
      description:
        "Build a Mermaid erDiagram from the live database schema (tables ranked by size), optionally render and save it.",
      inputSchema: {
        tables: z.array(z.string().min(1)).max(50).optional(),
        max_entities: z.number().int().min(1).max(40).optional(),
        include_columns: z.boolean().optional(),
        save: z.boolean().optional(),
        title: z.string().optional(),
      },
    },
    async ({ tables, max_entities, include_columns, save, title }) => {
      try {
        const db = requireDatabase(runtime);
        const available = await db.tables();
        const selected = tables && tables.length > 0 ? tables : available.map((table) => table.name);
        if (selected.length === 0) throw new Error("No tables found in the configured schemas.");
        const snapshot = await db.snapshot(selected);
        const er = buildErDiagram(snapshot, {
          ...(max_entities ? { maxEntities: max_entities } : {}),
          ...(include_columns === false ? { includeColumns: false } : {}),
        });
        if (!save) return ok(er);
        const rendered = await renderMermaid(er.mermaid, { png: true });
        const saved = await saveDiagram({
          dir: runtime.docsDir,
          title: title ?? "ER diagram",
          mermaid: er.mermaid,
          svg: rendered.svg,
          ...(rendered.png ? { png: rendered.png } : {}),
        });
        const brain = await publishToBrain(runtime);
        return ok({ ...er, saved, brain });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "arch_scan",
    {
      title: "Scan repository architecture",
      description:
        "Detect services from docker-compose, nginx proxy targets and packages. Facts only; unknowns are reported explicitly.",
      inputSchema: {
        path: z.string().optional().describe("Repository root (default: current directory)"),
      },
    },
    async ({ path }) => {
      try {
        const root = path ? resolve(runtime.cwd, path) : runtime.cwd;
        const scan = await scanArchitecture(root, { maxFiles: runtime.config.arch.maxFiles });
        return ok({ summary: summarizeScan(scan), ...scan });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "arch_diagram",
    {
      title: "Architecture diagram",
      description:
        "Build a Mermaid architecture view (container | context | deploy) from the repository scan, optionally save it.",
      inputSchema: {
        view: z.enum(["container", "context", "deploy"]).optional(),
        path: z.string().optional(),
        save: z.boolean().optional(),
        title: z.string().optional(),
      },
    },
    async ({ view, path, save, title }) => {
      try {
        const root = path ? resolve(runtime.cwd, path) : runtime.cwd;
        const scan = await scanArchitecture(root, { maxFiles: runtime.config.arch.maxFiles });
        const diagram = buildArchDiagram(scan, (view ?? "container") as ArchView);
        if (!save) return ok({ ...diagram, summary: summarizeScan(scan) });
        const rendered = await renderMermaid(diagram.mermaid, { png: true });
        const saved = await saveDiagram({
          dir: runtime.docsDir,
          title: title ?? `Architecture ${view ?? "container"}`,
          mermaid: diagram.mermaid,
          svg: rendered.svg,
          ...(rendered.png ? { png: rendered.png } : {}),
        });
        const brain = await publishToBrain(runtime);
        return ok({ ...diagram, saved, brain });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "drawio_status",
    {
      title: "draw.io status",
      description: "Check the shared draw.io MCP server and list connected editor documents.",
      inputSchema: {},
    },
    async () => {
      try {
        const health = await runtime.drawio.health();
        if (!health.ok) {
          throw new Error(
            `${health.error ?? "draw.io is not reachable"}. Start it with: lv24-diagram drawio start (or open ${runtime.config.drawio.editorUrl}).`,
          );
        }
        const documents = await runtime.drawio.listDocuments();
        return ok({ editorUrl: runtime.config.drawio.editorUrl, toolCount: health.tools.length, documents });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "drawio_import_mermaid",
    {
      title: "Import Mermaid into draw.io",
      description: "Convert Mermaid into native draw.io cells on a page of the connected editor document.",
      inputSchema: {
        mermaid: z.string().min(1),
        insert_mode: z.enum(["replace", "add", "new-page"]).optional(),
        mode: z.enum(["native", "embed"]).optional(),
      },
    },
    async ({ mermaid, insert_mode, mode }) => {
      try {
        const result = await runtime.drawio.call("import-mermaid", {
          mermaid_source: mermaid,
          insert_mode: insert_mode ?? "replace",
          mode: mode ?? "native",
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "drawio_export",
    {
      title: "Export draw.io diagram",
      description: "Export a page of the connected draw.io document to PNG, SVG or XML.",
      inputSchema: {
        format: z.enum(["png", "svg", "xml"]),
        output_path: z.string().min(1),
        page: z.number().int().min(0).optional(),
        embed_xml: z.boolean().optional(),
      },
    },
    async ({ format, output_path, page, embed_xml }) => {
      try {
        const result = await runtime.drawio.call("export-diagram", {
          format,
          output_path,
          size: format === "xml" ? "diagram" : "diagram",
          target_page: { index: page ?? 0 },
          ...(embed_xml === undefined ? {} : { embed_xml }),
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "brain_context",
    {
      title: "Project context from lv24-brain",
      description:
        "Read the curated project state (goal, next action, active items) so diagrams match what the project is actually doing.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!runtime.config.brain.enabled) throw new Error("brain.enabled is false");
        const available = await runtime.brain.available();
        if (!available) {
          throw new Error("brain CLI is not available on PATH (or LV24_DIAGRAM_BRAIN_BIN is wrong).");
        }
        return ok(await runtime.brain.open());
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "brain_publish",
    {
      title: "Publish diagram digest to lv24-brain",
      description:
        "Write one note describing the saved diagram set. Idempotent: skipped when the content hash was already published. Use dry_run to preview the note without writing.",
      inputSchema: {
        dry_run: z.boolean().optional(),
      },
    },
    async ({ dry_run }) => {
      try {
        return ok(await publishToBrain(runtime, dry_run === true));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

export async function startStdioServer(config: DiagramConfig, cwd = process.cwd()): Promise<void> {
  const runtime = createRuntime(config, cwd);
  const server = buildServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`${SERVER_NAME} ${VERSION} listening on stdio (docs: ${runtime.docsDir})`);

  const shutdown = async (): Promise<void> => {
    await runtime.drawio.close();
    await runtime.introspector?.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
