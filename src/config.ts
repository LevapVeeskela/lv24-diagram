import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface DatabaseConfig {
  kind: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  schemas: string[];
  statementTimeoutMs: number;
  maxRows: number;
}

export interface DocsConfig {
  /** Directory that receives .mmd / .png / .svg and the README index. */
  dir: string;
  theme: string;
  backgroundColor: string;
}

export interface DrawioConfig {
  /** MCP endpoint of the shared draw.io server. */
  url: string;
  /** Editor URL a human opens to connect a document. */
  editorUrl: string;
}

export interface ArchConfig {
  /** Upper bound on files visited while scanning a repository. */
  maxFiles: number;
}

export interface BrainConfig {
  /** Best-effort sync with lv24-brain; never blocks diagram work. */
  enabled: boolean;
  /** Project id; when omitted brain resolves it from the working directory. */
  project?: string;
  /** Override the brain binary (default: $LV24_DIAGRAM_BRAIN_BIN or `brain`). */
  binary?: string;
}

export interface DiagramConfig {
  docs: DocsConfig;
  database?: DatabaseConfig;
  drawio: DrawioConfig;
  arch: ArchConfig;
  brain: BrainConfig;
  /** Absolute path of the config file that was loaded, when any. */
  sourcePath?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULTS: Omit<DiagramConfig, "sourcePath"> = {
  docs: { dir: "docs/architecture", theme: "default", backgroundColor: "#ffffff" },
  drawio: { url: "http://127.0.0.1:3214/mcp", editorUrl: "http://127.0.0.1:3214/" },
  arch: { maxFiles: 4000 },
  brain: { enabled: true },
};

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replaces ${VAR} with the environment value and fails loudly when it is missing. */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_PATTERN, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === "") {
      throw new ConfigError(
        `Environment variable ${name} is required by diagram.config.json but is not set.`,
      );
    }
    return resolved;
  });
}

function interpolateDeep(input: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof input === "string") return interpolateEnv(input, env);
  if (Array.isArray(input)) return input.map((item) => interpolateDeep(item, env));
  if (input && typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
      result[key] = interpolateDeep(raw, env);
    }
    return result;
  }
  return input;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function asNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a number`);
  }
  return value;
}

function asBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be a boolean`);
  return value;
}

function asStringArray(value: unknown, path: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${path} must be a non-empty array of strings`);
  }
  return value as string[];
}

function parseDatabase(raw: unknown): DatabaseConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = asRecord(raw, "database");
  const kind = asString(value.kind, "database.kind", "postgres");
  if (kind !== "postgres") {
    throw new ConfigError(`database.kind "${kind}" is not supported yet (only postgres)`);
  }
  const port = asNumber(value.port, "database.port", 5432);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError("database.port must be an integer between 1 and 65535");
  }
  return {
    kind,
    host: asString(value.host, "database.host", "127.0.0.1"),
    port,
    database: asString(value.database, "database.database", ""),
    user: asString(value.user, "database.user", ""),
    password: asString(value.password, "database.password", ""),
    ssl: asBoolean(value.ssl, "database.ssl", false),
    schemas: asStringArray(value.schemas, "database.schemas", ["public"]),
    statementTimeoutMs: asNumber(value.statementTimeoutMs, "database.statementTimeoutMs", 15_000),
    maxRows: asNumber(value.maxRows, "database.maxRows", 500),
  };
}

function mergeConfig(raw: unknown, sourcePath?: string): DiagramConfig {
  const root = raw === undefined ? {} : asRecord(raw, "config");
  const docs = asRecord(root.docs ?? {}, "docs");
  const drawio = asRecord(root.drawio ?? {}, "drawio");
  const arch = asRecord(root.arch ?? {}, "arch");
  const brain = asRecord(root.brain ?? {}, "brain");

  const config: DiagramConfig = {
    docs: {
      dir: asString(docs.dir, "docs.dir", DEFAULTS.docs.dir),
      theme: asString(docs.theme, "docs.theme", DEFAULTS.docs.theme),
      backgroundColor: asString(
        docs.backgroundColor,
        "docs.backgroundColor",
        DEFAULTS.docs.backgroundColor,
      ),
    },
    drawio: {
      url: asString(drawio.url, "drawio.url", DEFAULTS.drawio.url),
      editorUrl: asString(drawio.editorUrl, "drawio.editorUrl", DEFAULTS.drawio.editorUrl),
    },
    arch: {
      maxFiles: asNumber(arch.maxFiles, "arch.maxFiles", DEFAULTS.arch.maxFiles),
    },
    brain: {
      enabled: asBoolean(brain.enabled, "brain.enabled", true),
      ...(typeof brain.project === "string" && brain.project.trim() !== ""
        ? { project: brain.project }
        : {}),
      ...(typeof brain.binary === "string" && brain.binary.trim() !== ""
        ? { binary: brain.binary }
        : {}),
    },
  };

  const database = parseDatabase(root.database);
  if (database) config.database = database;
  if (sourcePath) config.sourcePath = sourcePath;
  return config;
}

export interface LoadConfigOptions {
  /** Explicit config path; skips discovery. */
  path?: string;
  /** Directory the relative docs dir and config discovery start from. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Discovery order: explicit path, $DIAGRAM_CONFIG, ./diagram.config.json, ~/.config/lv24-diagram/config.json. */
export function discoverConfigPath(options: LoadConfigOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.path) return resolve(cwd, options.path);
  const fromEnv = env.DIAGRAM_CONFIG;
  if (fromEnv) return resolve(cwd, fromEnv);
  const local = join(cwd, "diagram.config.json");
  if (existsSync(local)) return local;
  const user = join(homedir(), ".config", "lv24-diagram", "config.json");
  if (existsSync(user)) return user;
  return undefined;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<DiagramConfig> {
  const env = options.env ?? process.env;
  const path = discoverConfigPath(options);
  if (!path) return mergeConfig(undefined);
  if (!existsSync(path)) {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  let parsed: unknown;
  try {
    const raw = await readFile(path, "utf8");
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ConfigError(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return mergeConfig(interpolateDeep(parsed, env), path);
}

/** Resolves the docs directory against the config location, so tools work from any cwd. */
export function resolveDocsDir(config: DiagramConfig, cwd = process.cwd()): string {
  const base = config.sourcePath ? resolve(config.sourcePath, "..") : cwd;
  return isAbsolute(config.docs.dir) ? config.docs.dir : resolve(base, config.docs.dir);
}

export const CONFIG_TEMPLATE = {
  $schema: "https://raw.githubusercontent.com/LevapVeeskela/lv24-diagram/main/diagram.config.schema.json",
  docs: { dir: "docs/architecture", theme: "default", backgroundColor: "#ffffff" },
  drawio: { url: "http://127.0.0.1:3214/mcp", editorUrl: "http://127.0.0.1:3214/" },
  arch: { maxFiles: 4000 },
  brain: { enabled: true },
  database: {
    kind: "postgres",
    host: "127.0.0.1",
    port: 5432,
    database: "app",
    user: "readonly_user",
    password: "${DB_PASSWORD}",
    ssl: false,
    schemas: ["public"],
    statementTimeoutMs: 15000,
    maxRows: 500,
  },
};
