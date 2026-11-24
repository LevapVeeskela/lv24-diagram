#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { buildArchDiagram, summarizeScan, type ArchView } from "./arch/diagram.js";
import { scanArchitecture } from "./arch/scan.js";
import { CONFIG_TEMPLATE, loadConfig, resolveDocsDir, type DiagramConfig } from "./config.js";
import { DrawioClient } from "./drawio/client.js";
import { saveDiagram } from "./docs/repository.js";
import { BrainClient } from "./brain/client.js";
import { errorMessage, log } from "./log.js";
import { startStdioServer } from "./mcp/server.js";
import { startHttpServer } from "./http/server.js";
import { renderMermaid } from "./mermaid/render.js";
import { lintMermaid } from "./mermaid/lint.js";
import { PostgresIntrospector } from "./schema/postgres.js";
import { VERSION } from "./version.js";

interface CliArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command = "mcp";
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    positionals.push(token);
  }
  return { command, positionals, flags };
}

function flagString(args: CliArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBoolean(args: CliArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === "true";
}

function line(label: string, value: string, status?: "ok" | "warn" | "fail"): string {
  const marker = status === "ok" ? "✓" : status === "warn" ? "!" : status === "fail" ? "✗" : "·";
  return `${marker} ${label.padEnd(22)} ${value}`;
}

async function commandDoctor(args: CliArgs): Promise<number> {
  const config = await loadConfig({ cwd: process.cwd() });
  const docsDir = resolveDocsDir(config);
  const strict = flagBoolean(args, "strict");
  const rows: string[] = [];
  let failures = 0;

  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  rows.push(line("node", `v${process.versions.node}`, nodeMajor >= 22 ? "ok" : "fail"));
  if (nodeMajor < 22) failures += 1;

  rows.push(line("config", config.sourcePath ?? "defaults (no diagram.config.json)"));

  let chromiumOk = false;
  try {
    const { chromium } = await import("playwright");
    const executable = chromium.executablePath();
    chromiumOk = existsSync(executable);
    rows.push(line("chromium", chromiumOk ? executable : `missing: ${executable}`, chromiumOk ? "ok" : "fail"));
    if (!chromiumOk) failures += 1;
  } catch (error) {
    rows.push(line("chromium", `playwright unavailable: ${errorMessage(error)}`, "fail"));
    failures += 1;
  }

  const drawio = new DrawioClient(config.drawio.url);
  const health = await drawio.health();
  rows.push(
    line(
      "draw.io",
      health.ok ? `${config.drawio.url} (${health.tools.length} tools)` : `${config.drawio.url} unreachable`,
      health.ok ? "ok" : "warn",
    ),
  );
  await drawio.close();

  if (config.database) {
    const introspector = new PostgresIntrospector(config.database);
    try {
      const tables = await introspector.tables();
      rows.push(
        line(
          "database",
          `${config.database.host}:${config.database.port}/${config.database.database} (${tables.length} relations)`,
          "ok",
        ),
      );
    } catch (error) {
      rows.push(line("database", errorMessage(error), "fail"));
      failures += 1;
    } finally {
      await introspector.close();
    }
  } else {
    rows.push(line("database", "not configured (schema tools disabled)", "warn"));
  }

  const brain = new BrainClient({
    ...(config.brain.project ? { project: config.brain.project } : {}),
    ...(config.brain.binary ? { binary: config.brain.binary } : {}),
  });
  const brainAvailable = config.brain.enabled ? await brain.available() : false;
  rows.push(
    line(
      "brain",
      !config.brain.enabled ? "disabled in config" : brainAvailable ? "available" : "not available",
      !config.brain.enabled ? "warn" : brainAvailable ? "ok" : "warn",
    ),
  );

  rows.push(line("docs dir", docsDir));
  console.log(rows.join("\n"));
  if (strict && failures > 0) {
    console.error(`\n${failures} required check(s) failed`);
    return 1;
  }
  return 0;
}

async function commandRender(args: CliArgs): Promise<number> {
  const file = args.positionals[0];
  if (!file) {
    console.error("usage: lv24-diagram render <file.mmd> [--saved <title>]");
    return 2;
  }
  const config = await loadConfig({ cwd: process.cwd() });
  const source = await readFile(resolve(file), "utf8");
  const lint = lintMermaid(source);
  for (const finding of lint.findings) {
    console.error(`[${finding.severity}] ${finding.rule}: ${finding.message}`);
  }
  const rendered = await renderMermaid(source, {
    png: true,
    ...(config.docs.backgroundColor ? { backgroundColor: config.docs.backgroundColor } : {}),
  });
  const savedTitle = flagString(args, "saved");
  if (savedTitle) {
    const saved = await saveDiagram({
      dir: resolveDocsDir(config),
      title: savedTitle,
      mermaid: source,
      svg: rendered.svg,
      ...(rendered.png ? { png: rendered.png } : {}),
    });
    console.log(JSON.stringify({ ...saved, width: rendered.width, height: rendered.height, layoutWidth: rendered.layoutWidth, layoutHeight: rendered.layoutHeight }, null, 2));
    return 0;
  }
  const out = resolve(flagString(args, "out") ?? ".");
  await mkdir(out, { recursive: true });
  const base = file.replace(/\.mmd$/i, "");
  const svgPath = join(out, `${base}.svg`);
  await writeFile(svgPath, rendered.svg, "utf8");
  const result: Record<string, unknown> = { svg: svgPath, width: rendered.width, height: rendered.height, layoutWidth: rendered.layoutWidth, layoutHeight: rendered.layoutHeight };
  if (rendered.png) {
    const pngPath = join(out, `${base}.png`);
    await writeFile(pngPath, rendered.png);
    result.png = pngPath;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function commandScan(args: CliArgs): Promise<number> {
  const config = await loadConfig({ cwd: process.cwd() });
  const root = resolve(args.positionals[0] ?? ".");
  const scan = await scanArchitecture(root, { maxFiles: config.arch.maxFiles });
  const view = (flagString(args, "view") ?? "container") as ArchView;
  const diagram = buildArchDiagram(scan, view);
  const saved = flagBoolean(args, "save");
  if (!saved) {
    if (flagBoolean(args, "json")) {
      console.log(JSON.stringify({ summary: summarizeScan(scan), diagram, scan }, null, 2));
      return 0;
    }
    console.log(summarizeScan(scan));
    if (scan.unknowns.length > 0) {
      console.log(`\nUnknowns:\n${scan.unknowns.map((item) => `  - ${item}`).join("\n")}`);
    }
    console.log(`\n${diagram.mermaid}`);
    return 0;
  }
  const rendered = await renderMermaid(diagram.mermaid, { png: true });
  const result = await saveDiagram({
    dir: resolveDocsDir(config),
    title: `Architecture ${view}`,
    mermaid: diagram.mermaid,
    svg: rendered.svg,
    ...(rendered.png ? { png: rendered.png } : {}),
  });
  console.log(JSON.stringify({ summary: summarizeScan(scan), saved: result, notes: diagram.notes }, null, 2));
  return 0;
}

async function commandBrain(args: CliArgs): Promise<number> {
  const config = await loadConfig({ cwd: process.cwd() });
  const client = new BrainClient({
    ...(config.brain.project ? { project: config.brain.project } : {}),
    ...(config.brain.binary ? { binary: config.brain.binary } : {}),
  });
  if (!(await client.available())) {
    console.error("brain CLI is not available");
    return 1;
  }
  console.log(JSON.stringify(await client.open(), null, 2));
  return 0;
}

async function commandDrawio(args: CliArgs): Promise<number> {
  const config = await loadConfig({ cwd: process.cwd() });
  const action = args.positionals[0] ?? "status";
  const drawio = new DrawioClient(config.drawio.url);
  try {
    if (action === "status") {
      const health = await drawio.health();
      console.log(
        JSON.stringify(
          {
            url: config.drawio.url,
            editorUrl: config.drawio.editorUrl,
            ok: health.ok,
            tools: health.tools.length,
            ...(health.error ? { error: health.error } : {}),
          },
          null,
          2,
        ),
      );
      return health.ok ? 0 : 1;
    }
    if (action !== "start") {
      console.error("usage: lv24-diagram drawio [status|start]");
      return 2;
    }
    const health = await drawio.health();
    if (health.ok) {
      console.log(`draw.io is already running at ${config.drawio.url}`);
      return 0;
    }
    const { stdout } = await promisify(execFile)("npm", ["root", "-g"], { windowsHide: true });
    const entry = join(stdout.trim(), "drawio-mcp-server", "build", "index.js");
    if (!existsSync(entry)) {
      console.error("drawio-mcp-server is not installed globally: npm i -g drawio-mcp-server@2.4.0");
      return 1;
    }
    const url = new URL(config.drawio.url);
    const port = url.port || "3214";
    const child = spawn(
      process.execPath,
      [entry, "--editor", "--transport", "http", "--http-port", port, "--extension-port", "3337", "--host", "127.0.0.1"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
    console.log(`started draw.io on 127.0.0.1:${port}; open ${config.drawio.editorUrl} once`);
    return 0;
  } finally {
    await drawio.close();
  }
}

async function commandServe(args: CliArgs): Promise<number> {
  const portText = flagString(args, "http-port") ?? "3793";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--http-port must be an integer between 1 and 65535, got "${portText}"`);
    return 2;
  }
  const host = flagString(args, "host") ?? "127.0.0.1";
  const redisUrl = flagString(args, "redis-url") ?? "redis://127.0.0.1:6379";
  const tokenEnv = flagString(args, "token-env") ?? "DIAGRAM_API_TOKEN";
  const token = process.env[tokenEnv];
  if (!token || token.trim().length === 0) {
    console.error(`${tokenEnv} is empty or unset; refusing to start without an HTTP token`);
    return 1;
  }

  const server = await startHttpServer({ host, port, token, redisUrl });
  try {
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await server.close();
  }
  return 0;
}

async function commandInit(args: CliArgs): Promise<number> {
  const target = resolve(flagString(args, "path") ?? "diagram.config.json");
  if (existsSync(target) && !flagBoolean(args, "force")) {
    console.error(`${target} already exists (use --force to overwrite)`);
    return 1;
  }
  await writeFile(target, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, "utf8");
  console.log(`wrote ${target}`);
  return 0;
}

function usage(): string {
  return [
    "lv24-diagram — architecture and diagrams MCP",
    "",
    "usage:",
    "  lv24-diagram mcp                     start the MCP server on stdio (default)",
    "  lv24-diagram serve [--http-port 3793] [--host 127.0.0.1] [--redis-url URL] [--token-env NAME]",
    "                                       HTTP render service for diagram-api",
    "  lv24-diagram doctor [--strict]       check node, chromium, draw.io, database, brain",
    "  lv24-diagram render <file.mmd>       lint and render to SVG/PNG",
    "  lv24-diagram scan [path] [--view]    scan a repository and print an architecture diagram",
    "  lv24-diagram brain                   print the curated project context",
    "  lv24-diagram drawio [status|start]   check or start the shared draw.io HTTP server",
    "  lv24-diagram init [--force]          write diagram.config.json",
    "  lv24-diagram version",
  ].join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "mcp": {
      const config = await loadConfig({ cwd: process.cwd() });
      await startStdioServer(config);
      return 0;
    }
    case "doctor":
      return commandDoctor(args);
    case "render":
      return commandRender(args);
    case "scan":
      return commandScan(args);
    case "brain":
      return commandBrain(args);
    case "drawio":
      return commandDrawio(args);
    case "serve":
      return commandServe(args);
    case "init":
      return commandInit(args);
    case "version":
    case "--version":
      console.log(VERSION);
      return 0;
    case "help":
    case "--help":
      console.log(usage());
      return 0;
    default:
      console.error(`unknown command: ${args.command}\n\n${usage()}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    log.error(errorMessage(error));
    process.exitCode = 1;
  });
